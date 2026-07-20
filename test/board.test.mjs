// The board projection. The ledger must reach a board it does not know the name of — and must not
// care when there is none.
import test from "node:test";
import assert from "node:assert/strict";
import { cardOf, makeBoard, acceptable, pickImplementer, BOARD_CONTRACT, PROMPT_CONTRACT, LEDGER_CARD } from "../js/board.js";

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

test("the human title the producer wrote survives a re-projection — the card is not renamed to its id", () => {
  const c = cardOf(entry({ issue: "kb-7", title: "실코드화: parser.rs" }), "absent");
  assert.equal(c.title, "실코드화: parser.rs", "an adopted card keeps the title a human reads, not the raw issue id");
});

// ── the seam: which board nodes the ledger accepts ───────────────────────────
// Issuerize fans out unlocked work tasks under a done Draft. The JS ledger accepts exactly those:
// kind=task, unlocked, parent chunk done. A spec frame (locked), a task under an unfinished chunk,
// or a non-task node is left alone — accepting them would pull half-built spec into the run.

const node = (o = {}) => ({ id: "n", title: "t", status: "todo", ...o });
const doneDraft = { id: "d", title: "Draft", status: "done", kind: "chunk" };

test("an unlocked work task under a done Draft is accepted, keyed and adopted by the board's own id", () => {
  const picks = acceptable([doneDraft, node({ id: "t1", title: "실코드화: a.rs", kind: "task", locked: false, parentId: "d" })]);
  assert.deepEqual(picks, [{ issue: "t1", nodeId: "t1", title: "실코드화: a.rs" }], "the issue id is the board node id, and the human title rides along");
});

test("a task under a chunk that is not done is left alone — half-built spec must not enter the run", () => {
  const picks = acceptable([{ id: "d", status: "review", kind: "chunk" }, node({ id: "t1", kind: "task", locked: false, parentId: "d" })]);
  assert.deepEqual(picks, []);
});

test("a locked node is a spec frame, never a work task — the ledger never adopts it", () => {
  const picks = acceptable([doneDraft, node({ id: "t1", kind: "task", locked: true, parentId: "d" })]);
  assert.deepEqual(picks, []);
});

test("a non-task node under a done Draft is not work — chunks, groups, facts are passed over", () => {
  const picks = acceptable([doneDraft, node({ id: "g", kind: "group", locked: false, parentId: "d" }), node({ id: "f", kind: "fact", locked: false, parentId: "d" })]);
  assert.deepEqual(picks, []);
});

test("a task with no parent, or a parent not on the board, is not under any done Draft", () => {
  const picks = acceptable([node({ id: "orphan", kind: "task", locked: false }), node({ id: "lost", kind: "task", locked: false, parentId: "ghost" })]);
  assert.deepEqual(picks, []);
});

test("a board that answers node.list with only the contract fields yields nothing — the axis to filter on is absent", () => {
  // The contract guarantees only {id,title,status,description}. Without kind/locked/parentId there is
  // no way to tell a work task from a spec frame, so the honest answer is to accept nothing.
  const picks = acceptable([{ id: "a", title: "실코드화: a.rs", status: "done", description: "" }]);
  assert.deepEqual(picks, [], "no kind/locked/parent axis means no basis to accept — never a guess");
});

// ── discovery + upsert ──────────────────────────────────────────────────────

// `stores` = who implements the prompt store. It defaults to the same plugins that implement the
// board, which is the ordinary case: one plugin holds the cards and the text the cards point at.
function harness({ implementers = [{ id: "some-board", status: "enabled" }], stores = implementers, nodeGetOk = true, removeOk = true } = {}) {
  const calls = [];
  const map = new Map();
  const app = {
    commands: {
      async execute(name, params) {
        calls.push({ name, params });
        if (name === "plugin.implementers") {
          return { ok: true, data: { implementers: params.id === PROMPT_CONTRACT ? stores : implementers } };
        }
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
  assert.equal(calls[0].params.id, BOARD_CONTRACT);
  assert.ok(
    calls.some((c) => c.name === "plugin.a-completely-different-board.node.add"),
    "the projection must address the implementer discovery returned, not a board it had in mind",
  );
});

// ── the implementer must satisfy both contracts ─────────────────────────────
// A card carries the address of the prompt its node runs. If the cards went to one plugin and the
// prompts to another, the card would name an address the board it sits on has never heard of.

test("the pick is the intersection — a board that is not also a prompt store is not this loop's board", () => {
  const boards = [{ id: "board-only", status: "enabled" }, { id: "both", status: "enabled" }];
  const stores = [{ id: "both", status: "enabled" }, { id: "store-only", status: "enabled" }];
  assert.equal(pickImplementer(boards, stores), "both", "the first board found is not automatically the right one");
});

test("no implementer satisfies both — the pick is nothing, never a half-fitting board", () => {
  assert.equal(
    pickImplementer([{ id: "board-only", status: "enabled" }], [{ id: "store-only", status: "enabled" }]),
    null,
  );
});

test("a disabled plugin cannot satisfy either contract", () => {
  assert.equal(pickImplementer([{ id: "b", status: "disabled" }], [{ id: "b", status: "enabled" }]), null);
  assert.equal(pickImplementer([{ id: "b", status: "enabled" }], [{ id: "b", status: "disabled" }]), null);
});

test("a decoy board that holds no prompts is passed over for the one that does", async () => {
  const { board, calls } = harness({
    implementers: [{ id: "decoy-board", status: "enabled" }, { id: "real-board", status: "enabled" }],
    stores: [{ id: "real-board", status: "enabled" }],
  });
  const r = await board.project(entry(), "absent");
  assert.equal(r.projected, true);
  assert.ok(
    calls.some((c) => c.name === "plugin.real-board.node.add"),
    "the projection must go to the implementer that can also hold the prompts its cards point at",
  );
  assert.equal(named(calls, ".node.add").filter((c) => c.name.includes("decoy")).length, 0, "nothing may reach the decoy");
});

test("a board exists but none of them holds prompts — that is a misconfiguration, and it is said out loud", async () => {
  const { board, calls } = harness({
    implementers: [{ id: "board-only", status: "enabled" }],
    stores: [],
  });
  const r = await board.project(entry(), "absent");
  assert.equal(r.projected, false);
  assert.equal(r.code, "UNAVAILABLE", "a board that cannot run the loop is not the lawful 'no board' state");
  assert.match(r.reason, /soksak-spec-plugin-prompt-store/, "the refusal must name the contract nobody implements");
  assert.equal(named(calls, ".node.add").length, 0);
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
