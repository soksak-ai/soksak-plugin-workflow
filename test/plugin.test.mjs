// The plugin as the app sees it: what the manifest declares must be exactly what activate()
// registers, and the gates must refuse through the command surface — not only in gate.js.
//
// The manifest declares two kinds of command. The nine bind:"service" ones are answered by the
// Rust service; the JS entry must register the rest and no more. Registering a command the
// manifest does not declare, or declaring one nothing answers, is the failure this checks.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import plugin from "../js/index.js";
import { mockApp, mockProcess } from "./helpers/mock-app.mjs";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("plugin.json", root), "utf8"));
const source = readFileSync(fileURLToPath(new URL("js/index.js", root)), "utf8");

const declared = manifest.contributes.commands;
const serviceCommands = declared.filter((c) => c.bind === "service").map((c) => c.name);
const jsCommands = declared.filter((c) => c.bind !== "service").map((c) => c.name);

function boot(opts = {}) {
  const m = mockApp(opts);
  plugin.activate(m.ctx);
  return m;
}
const run = (m, name, params = {}) => m.registered.get(name).handler(params);
const gitOk = () => mockProcess(() => ({ stdout: "", code: 0 }));

// ── conformance: declared ≡ actual ──────────────────────────────────────────

test("the JS entry registers exactly the commands the manifest declares for it", () => {
  const { registered } = boot();
  assert.deepEqual([...registered.keys()].sort(), [...jsCommands].sort());
});

test("the service commands stay the service's — the JS entry must not shadow them", () => {
  const { registered } = boot();
  assert.equal(serviceCommands.length, 9, "the nine existing service commands are still declared");
  for (const name of serviceCommands) {
    assert.ok(!registered.has(name), `${name} is answered by the service, not by JS`);
  }
});

test("the declared view is registered", () => {
  const { views } = boot();
  assert.deepEqual([...views.keys()], manifest.contributes.views.map((v) => v.id));
});

test("every node the view emits is declared, and every declared node is emitted", () => {
  const emitted = new Set([...source.matchAll(/dataset\.node = [`"]([a-z]+)/g)].map((m) => m[1]));
  const nodes = new Set(manifest.contributes.nodes.map((n) => n.id));
  assert.deepEqual([...emitted].sort(), [...nodes].sort());
});

test("every command the manifest declares for JS carries a description, params and a message", () => {
  const { registered } = boot();
  for (const [name, spec] of registered) {
    assert.ok(spec.description?.length > 20, `${name} needs a description`);
    assert.ok(spec.params, `${name} needs params`);
    assert.equal(typeof spec.message, "function", `${name} needs a message`);
  }
});

// ── the lease, through the command surface ──────────────────────────────────

test("acquire takes a free issue, and re-acquiring by the same owner extends it", async () => {
  const m = boot();
  const a = await run(m, "lease.acquire", { issue: "i-42", owner: "agent-1", branch: "feat/x" });
  assert.equal(a.leaseState, "live");
  assert.equal(a.lease.owner, "agent-1");
  const b = await run(m, "lease.acquire", { issue: "i-42", owner: "agent-1" });
  assert.equal(b.leaseState, "live");
  assert.equal(b.branch, "feat/x", "re-acquiring must not lose the recorded branch");
});

test("a second agent cannot take a live lease", async () => {
  const m = boot();
  await run(m, "lease.acquire", { issue: "i-42", owner: "agent-1" });
  const r = await run(m, "lease.acquire", { issue: "i-42", owner: "agent-2" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "LEASE_HELD");
});

test("an expired lease is free to take — that is what expiry is for", async () => {
  const m = boot();
  await run(m, "lease.acquire", { issue: "i-42", owner: "agent-1", ttlMs: 1 });
  await new Promise((r) => setTimeout(r, 5));
  const r = await run(m, "lease.acquire", { issue: "i-42", owner: "agent-2" });
  assert.equal(r.leaseState, "live");
  assert.equal(r.lease.owner, "agent-2");
});

test("release is the owner's alone, and releasing twice is a no-op", async () => {
  const m = boot();
  await run(m, "lease.acquire", { issue: "i-42", owner: "agent-1" });
  assert.equal((await run(m, "lease.release", { issue: "i-42", owner: "agent-2" })).code, "LEASE_HELD");
  assert.equal((await run(m, "lease.release", { issue: "i-42", owner: "agent-1" })).leaseState, "absent");
  assert.equal((await run(m, "lease.release", { issue: "i-42", owner: "agent-1" })).leaseState, "absent");
});

test("the lease survives in the store — the state is read back, never held in memory", async () => {
  const m = boot();
  await run(m, "lease.acquire", { issue: "i-42", owner: "agent-1" });
  const listed = await run(m, "lease.list");
  assert.equal(listed.entries.length, 1);
  assert.equal(listed.entries[0].lease.owner, "agent-1");
  assert.equal(listed.entries[0].leaseState, "live", "the state is computed on read, so it can never go stale");
});

test("an issue enters the loop unleased and unreceipted — and both gates still refuse it", async () => {
  const m = boot();
  const added = await run(m, "entry.add", { issue: "i-42", branch: "feat/x" });
  assert.equal(added.leaseState, "absent");
  assert.deepEqual(added.receipts, []);
  assert.equal(added.done, false);
  // existing on the ledger is not the same as earned: both gates must still refuse
  assert.equal((await run(m, "gate.dispatch", { issue: "i-42", owner: "agent-1" })).code, "LEASE_STALE");
  assert.equal((await run(m, "gate.transition", { issue: "i-42" })).code, "EVIDENCE_REQUIRED");
});

test("entry.add never clobbers what an issue already earned", async () => {
  const m = boot();
  await run(m, "lease.acquire", { issue: "i-42", owner: "agent-1", branch: "feat/x" });
  await run(m, "receipt.add", { issue: "i-42", kind: "commit", value: "0dc2d14" });
  const again = await run(m, "entry.add", { issue: "i-42", branch: "feat/other" });
  assert.equal(again.lease.owner, "agent-1", "a re-add must not drop a live lease");
  assert.equal(again.receipts.length, 1, "a re-add must not drop receipts");
  assert.equal(again.branch, "feat/x");
});

test("an entry can be dropped, and dropping it twice is a no-op", async () => {
  const m = boot();
  await run(m, "lease.acquire", { issue: "i-42", owner: "agent-1" });
  await run(m, "lease.release", { issue: "i-42", owner: "agent-1" });
  assert.equal((await run(m, "entry.remove", { issue: "i-42" })).removed, true);
  assert.equal((await run(m, "entry.remove", { issue: "i-42" })).removed, false);
  assert.equal((await run(m, "lease.list")).entries.length, 0, "the store must come back empty — a run that cannot reclaim its own rows is not idempotent");
});

test("an entry under a live lease cannot be dropped out from under its owner", async () => {
  const m = boot();
  await run(m, "lease.acquire", { issue: "i-42", owner: "agent-1" });
  assert.equal((await run(m, "entry.remove", { issue: "i-42" })).code, "LEASE_HELD");
  assert.equal((await run(m, "entry.remove", { issue: "i-42", owner: "agent-1" })).removed, true, "the owner may drop their own");
});

// ── LEASE_STALE: the dispatch gate (the ① negative fixture) ─────────────────

test("RED fixture — dispatching an issue nobody leased refuses LEASE_STALE", async () => {
  const m = boot();
  const r = await run(m, "gate.dispatch", { issue: "i-unleased", owner: "agent-1" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "LEASE_STALE");
});

test("RED fixture — dispatching on a lease that ran out refuses LEASE_STALE", async () => {
  const m = boot();
  await run(m, "lease.acquire", { issue: "i-42", owner: "agent-1", ttlMs: 1 });
  await new Promise((r) => setTimeout(r, 5));
  const r = await run(m, "gate.dispatch", { issue: "i-42", owner: "agent-1" });
  assert.equal(r.code, "LEASE_STALE", "an owner who let the lease lapse is not an owner");
});

test("GREEN — the owner of a live lease may dispatch", async () => {
  const m = boot();
  await run(m, "lease.acquire", { issue: "i-42", owner: "agent-1" });
  assert.equal((await run(m, "gate.dispatch", { issue: "i-42", owner: "agent-1" })).passed, true);
});

// ── EVIDENCE_REQUIRED: the transition gate (the ② negative fixture) ─────────

test("RED fixture — completing an issue with no receipt refuses EVIDENCE_REQUIRED", async () => {
  const m = boot();
  await run(m, "lease.acquire", { issue: "i-42", owner: "agent-1" });
  const r = await run(m, "gate.transition", { issue: "i-42" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "EVIDENCE_REQUIRED");
});

test("RED fixture — a receipt that is only a claim never reaches the ledger", async () => {
  const m = boot();
  const r = await run(m, "receipt.add", { issue: "i-42", kind: "commit", value: "i-did-the-work" });
  assert.equal(r.code, "INVALID_RECEIPT", "refused at the door, so the gate can trust what it reads");
  assert.equal((await run(m, "gate.transition", { issue: "i-42" })).code, "EVIDENCE_REQUIRED");
});

test("RED fixture — a failing test receipt keeps the gate shut", async () => {
  const m = boot();
  await run(m, "receipt.add", { issue: "i-42", kind: "test", value: "cargo test", passed: false });
  const r = await run(m, "gate.transition", { issue: "i-42" });
  assert.equal(r.code, "EVIDENCE_REQUIRED");
  assert.match(r.message, /failed/);
});

test("GREEN — a commit sha opens the transition gate, and the gate is what marks it done", async () => {
  const m = boot();
  await run(m, "receipt.add", { issue: "i-42", kind: "commit", value: "0dc2d14" });
  const r = await run(m, "gate.transition", { issue: "i-42" });
  assert.equal(r.passed, true);
  assert.equal(r.done, true);
  assert.equal((await run(m, "lease.list")).entries[0].done, true, "done is persisted by the gate that verified the receipt");
});

test("done is unreachable except through the gate — a refused transition leaves the issue open", async () => {
  const m = boot();
  await run(m, "lease.acquire", { issue: "i-42", owner: "agent-1" });
  assert.equal((await run(m, "gate.transition", { issue: "i-42" })).code, "EVIDENCE_REQUIRED");
  assert.equal((await run(m, "lease.list")).entries[0].done, false, "a refused gate must not leave the issue half-done");
});

test("a refusal is written in the caller's language — the gates are pure, the surface is not", async () => {
  const m = boot({ locale: "ko" });
  const stale = await run(m, "gate.dispatch", { issue: "i-42", owner: "agent-1" });
  const evidence = await run(m, "gate.transition", { issue: "i-42" });
  const receipt = await run(m, "receipt.add", { issue: "i-42", kind: "commit", value: "nope" });
  for (const r of [stale, evidence, receipt]) {
    assert.ok(/[가-힣]/.test(r.message), `a ko caller was refused in English: ${r.code} — ${r.message}`);
  }
  const en = boot({ locale: "en" });
  assert.ok(!/[가-힣]/.test((await run(en, "gate.dispatch", { issue: "i-42", owner: "a" })).message));
});

// ── the seam: accepting issuerized work tasks off the board ─────────────────
// The Rust sidecar publishes unlocked work tasks under a done Draft. The JS ledger observes the
// board through the contract path (node.list) and find-or-creates one entry per task — idempotent,
// so the same task accepted twice is still one entry.

const BOARD = "kb";
// A board whose node.list returns the fanned-out tree: a done Draft with two unlocked work tasks,
// plus a locked spec frame and a task under an unfinished chunk that must both be left alone.
function boardHost(nodes) {
  return (name, params) => {
    if (name === "plugin.implementers") return { ok: true, data: { implementers: [{ id: BOARD, status: "enabled" }] } };
    if (name === `plugin.${BOARD}.node.list`) return { ok: true, data: { nodes } };
    if (name === `plugin.${BOARD}.node.get`) return { ok: true, data: {} };
    if (name.startsWith(`plugin.${BOARD}.node.`)) return { ok: true, data: { nodeId: "new" } };
    return { ok: true, data: {} };
  };
}
const fanout = [
  { id: "d", title: "Draft", status: "done", kind: "chunk", locked: false },
  { id: "t1", title: "실코드화: a.rs", status: "todo", kind: "task", locked: false, parentId: "d" },
  { id: "t2", title: "실코드화: b.rs", status: "todo", kind: "task", locked: false, parentId: "d" },
  { id: "frame", title: "spec frame", status: "done", kind: "chunk", locked: true, parentId: "d" },
  { id: "unfinished", title: "Draft 2", status: "review", kind: "chunk", locked: false },
  { id: "t3", title: "실코드화: c.rs", status: "todo", kind: "task", locked: false, parentId: "unfinished" },
];

test("accepts each unlocked work task under a done Draft as a ledger entry, keyed by the board's id", async () => {
  const m = boot({ executeCommand: boardHost(fanout) });
  const r = await run(m, "board.accept");
  assert.equal(r.board, BOARD);
  assert.deepEqual(r.accepted.map((a) => a.issue).sort(), ["t1", "t2"], "only the two unlocked tasks under the done Draft");
  const entries = (await run(m, "lease.list")).entries.map((e) => e.issue).sort();
  assert.deepEqual(entries, ["t1", "t2"], "an entry exists for each accepted task, and for nothing else");
});

test("accepting is idempotent — the same task seen twice is still one entry", async () => {
  const m = boot({ executeCommand: boardHost(fanout) });
  await run(m, "board.accept");
  const second = await run(m, "board.accept");
  assert.equal((await run(m, "lease.list")).entries.length, 2, "a second pass must not double the ledger");
  assert.ok(second.accepted.every((a) => a.created === false), "the second pass creates nothing — it only re-adopts");
});

test("an accepted task lands unleased and unreceipted — both gates still refuse it", async () => {
  const m = boot({ executeCommand: boardHost(fanout) });
  await run(m, "board.accept");
  assert.equal((await run(m, "gate.dispatch", { issue: "t1", owner: "agent-1" })).code, "LEASE_STALE");
  assert.equal((await run(m, "gate.transition", { issue: "t1" })).code, "EVIDENCE_REQUIRED");
});

test("no board is a lawful answer — accept does nothing and refuses nothing", async () => {
  const m = boot({ executeCommand: () => ({ ok: true, data: { implementers: [] } }) });
  const r = await run(m, "board.accept");
  assert.equal(r.board, null);
  assert.deepEqual(r.accepted, []);
  assert.equal((await run(m, "lease.list")).entries.length, 0);
});

// ── drift: ledger vs repository ─────────────────────────────────────────────

const repo = "/repo";
// git as the repository actually is: branch feat/real exists and is unmerged, commit 0dc2d14 exists.
function realRepo(args) {
  const j = args.join(" ");
  if (j.startsWith("rev-parse")) return { stdout: `${repo}\n`, code: 0 };
  if (j === "show-ref --verify --quiet refs/heads/feat/real") return { code: 0 };
  if (j.startsWith("show-ref")) return { code: 1 };
  if (j === "cat-file -e 0dc2d14^{commit}") return { code: 0 };
  if (j.startsWith("cat-file")) return { code: 1 };
  if (j.startsWith("merge-base")) return { code: 1 }; // not merged
  if (j.startsWith("worktree list")) return { stdout: `worktree ${repo}\nbranch refs/heads/feat/real\n`, code: 0 };
  return { code: 0 };
}

test("drift — a branch the ledger claims and the repository never had is reported", async () => {
  const p = mockProcess(realRepo);
  const m = boot({ process: p.api, project: { root: repo } });
  await run(m, "lease.acquire", { issue: "i-ghost", owner: "agent-1", branch: "feat/ghost" });
  const r = await run(m, "drift.check", {});
  assert.equal(r.checked, 1);
  assert.equal(r.drifted, 1);
  assert.equal(r.drifts[0].field, "branch");
  assert.equal(r.drifts[0].claimed, "feat/ghost");
});

test("drift — a fabricated commit receipt is caught against the repository", async () => {
  const p = mockProcess(realRepo);
  const m = boot({ process: p.api, project: { root: repo } });
  await run(m, "lease.acquire", { issue: "i-42", owner: "agent-1", branch: "feat/real" });
  await run(m, "receipt.add", { issue: "i-42", kind: "commit", value: "deadbee" });
  const r = await run(m, "drift.check", { issue: "i-42" });
  assert.deepEqual(r.drifts.map((d) => d.field), ["commit"]);
  assert.equal(r.drifts[0].claimed, "deadbee");
});

test("drift — a real receipt on a real branch drifts only once it claims to be done unmerged", async () => {
  const p = mockProcess(realRepo);
  const m = boot({ process: p.api, project: { root: repo } });
  await run(m, "lease.acquire", { issue: "i-42", owner: "agent-1", branch: "feat/real" });
  await run(m, "receipt.add", { issue: "i-42", kind: "commit", value: "0dc2d14" });
  assert.deepEqual((await run(m, "drift.check", { issue: "i-42" })).drifts, [], "in-flight work is not drift");

  const e = await m.app.data.get("entry", "i-42", { scope: "index" });
  await m.app.data.put("entry", { ...e, done: true }, { scope: "index", id: "i-42" });
  const r = await run(m, "drift.check", { issue: "i-42" });
  assert.deepEqual(r.drifts.map((d) => d.field), ["merged"], "done, but the branch never landed in base");
});

test("drift reports without repairing — the ledger keeps its claim so the lie stays visible", async () => {
  const p = mockProcess(realRepo);
  const m = boot({ process: p.api, project: { root: repo } });
  await run(m, "lease.acquire", { issue: "i-ghost", owner: "agent-1", branch: "feat/ghost" });
  await run(m, "drift.check", {});
  const after = await run(m, "lease.list");
  assert.equal(after.entries[0].branch, "feat/ghost", "a self-healing ledger can never catch reality lying to it");
});

test("drift.check refuses when there is no repository to check against", async () => {
  const m = boot({ process: gitOk().api });
  const r = await run(m, "drift.check", {});
  assert.equal(r.ok, false);
  assert.equal(r.code, "NO_PATH", "no silent pass when the outside cannot be observed");
});
