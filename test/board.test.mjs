// The board projection. The ledger must reach a board it does not know the name of — and must not
// care when there is none.
import test from "node:test";
import assert from "node:assert/strict";
import { cardOf, makeBoard, BOARD_CONTRACT, LEDGER_CARD } from "../js/board.js";

const entry = (o = {}) => ({ issue: "i-42", lease: null, branch: null, receipts: [], done: false, ...o });
const commit = (v) => ({ kind: "commit", value: v, at: 1 });

// ── the card ────────────────────────────────────────────────────────────────

test("an issue nobody holds sits in backlog", () => {
  const c = cardOf(entry(), "absent");
  assert.equal(c.status, "backlog");
  assert.equal(c.title, "i-42");
  assert.match(c.description, /unheld/);
});

test("a live lease is work in progress, and the card says who has it", () => {
  const c = cardOf(entry({ lease: { owner: "agent-1", expiresAt: 9 }, branch: "feat/x" }), "live");
  assert.equal(c.status, "inprogress");
  assert.match(c.description, /held by agent-1/);
  assert.match(c.description, /feat\/x/);
});

test("a lapsed lease is not work in progress — nobody is actually on it", () => {
  const c = cardOf(entry({ lease: { owner: "agent-1", expiresAt: 1 } }), "expired");
  assert.equal(c.status, "backlog");
  assert.match(c.description, /lapsed/);
});

test("done, with the receipts that earned it visible on the card", () => {
  const c = cardOf(entry({ done: true, receipts: [commit("0dc2d14abc"), { kind: "test", value: "cargo test", passed: true }] }), "absent");
  assert.equal(c.status, "done");
  assert.match(c.description, /2 receipts/);
  assert.match(c.description, /0dc2d14/, "a commit receipt is worth showing — it is what a human re-checks");
});

// ── discovery + upsert ──────────────────────────────────────────────────────

function harness({ implementers = [{ id: "some-board", status: "enabled" }], nodeGetOk = true, removeOk = true } = {}) {
  const calls = [];
  const map = new Map();
  const app = {
    commands: {
      async execute(name, params) {
        calls.push({ name, params });
        if (name === "plugin.implementers") return { ok: true, data: { implementers } };
        if (name.endsWith(".node.add")) return { ok: true, data: { nodeId: "n-1" } };
        if (name.endsWith(".node.edit")) return { ok: true, data: {} };
        if (name.endsWith(".node.get")) return nodeGetOk ? { ok: true, data: {} } : { ok: false, code: "NOT_FOUND" };
        if (name.endsWith(".node.remove")) return removeOk ? { ok: true, data: {} } : { ok: false, code: "PERMISSION_DENIED", message: "destructive" };
        return { ok: false, code: "UNKNOWN_COMMAND" };
      },
    },
  };
  const store = {
    get: async (k) => map.get(k) ?? null,
    put: async (k, v) => void map.set(k, v),
    del: async (k) => void map.delete(k),
  };
  return { board: makeBoard(app, store), calls, map };
}
const named = (calls, suffix) => calls.filter((c) => c.name.endsWith(suffix));
// The group card is not an issue card — counting it as one would hide a card-per-update leak.
const issueAdds = (calls) => named(calls, ".node.add").filter((c) => c.params.title !== LEDGER_CARD);
const groupAdds = (calls) => named(calls, ".node.add").filter((c) => c.params.title === LEDGER_CARD);

test("the board is found by contract, and addressed by whatever id that discovery returned", async () => {
  const { board, calls } = harness({ implementers: [{ id: "a-completely-different-board", status: "enabled" }] });
  const r = await board.project(entry(), "absent");
  assert.equal(r.projected, true);
  assert.equal(calls[0].name, "plugin.implementers");
  assert.equal(calls[0].params.contract, BOARD_CONTRACT);
  assert.ok(
    calls.some((c) => c.name === "plugin.a-completely-different-board.node.add"),
    "the projection must address the implementer discovery returned, not a board it had in mind",
  );
});

test("a disabled implementer is not a board — projecting into it would go nowhere", async () => {
  const { board, calls } = harness({ implementers: [{ id: "some-board", status: "disabled" }] });
  const r = await board.project(entry(), "absent");
  assert.equal(r.projected, false);
  assert.equal(named(calls, ".node.add").length, 0);
});

test("no board at all is a lawful state — the ledger keeps working, unprojected", async () => {
  const { board, calls } = harness({ implementers: [] });
  const r = await board.project(entry(), "absent");
  assert.equal(r.projected, false);
  assert.match(r.reason, /no board/);
  assert.equal(named(calls, ".node.add").length, 0, "nothing may be sent to a board that does not exist");
});

test("a withdrawal the board refuses is reported, not swallowed — a stranded card must be accountable", async () => {
  const { board, map } = harness({ removeOk: false });
  await board.project(entry(), "absent");
  const r = await board.unproject("i-42");
  assert.equal(r.withdrawn, false);
  assert.match(r.reason, /PERMISSION_DENIED/);
  assert.equal(map.size, 2, "the mapping is kept — forgetting it would strand the card with nothing pointing at it");
});

test("projecting twice edits the same card — a board that gains a card per update is a leak", async () => {
  const { board, calls } = harness();
  await board.project(entry(), "absent");
  await board.project(entry({ done: true }), "absent");
  assert.equal(issueAdds(calls).length, 1, "the second projection must not create a second card");
  assert.equal(named(calls, ".node.edit").length, 1);
  assert.equal(named(calls, ".node.edit")[0].params.status, "done");
});

test("issues hang under one group card — a board is shared, and scattered cards cannot be read", async () => {
  const { board, calls } = harness();
  await board.project(entry(), "absent");
  await board.project(entry({ issue: "i-43" }), "absent");
  assert.equal(groupAdds(calls).length, 1, "the group is made once, not once per issue");
  const parents = issueAdds(calls).map((c) => c.params.parentId);
  assert.deepEqual(parents, ["n-1", "n-1"], "every issue card hangs under the same group card");
});

test("a card a human deleted is re-created, not silently lost", async () => {
  const { board, calls } = harness({ nodeGetOk: false });
  await board.project(entry(), "absent");
  await board.project(entry({ done: true }), "absent");
  assert.equal(issueAdds(calls).length, 2, "the mapping was stale, so a fresh card must be made");
  assert.equal(named(calls, ".node.edit").length, 0);
});

test("dropping an issue withdraws its card and forgets the mapping", async () => {
  const { board, calls, map } = harness();
  await board.project(entry(), "absent");
  assert.equal(map.size, 2, "the issue's card and the group it hangs under");
  const r = await board.unproject("i-42");
  assert.equal(r.withdrawn, true);
  assert.equal(named(calls, ".node.remove")[0].params.node, "n-1", "cards are addressed by the id the board issued");
  assert.equal(map.size, 1, "the issue's mapping is gone; the group card stays for the issues still on it");
  assert.equal((await board.unproject("i-42")).withdrawn, false, "withdrawing twice is a no-op");
});
