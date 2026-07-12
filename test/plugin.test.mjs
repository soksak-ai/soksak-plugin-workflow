// The plugin as the app sees it: what the manifest declares must be exactly what activate()
// registers, and the gates must refuse through the command surface — not only in gate.js.
//
// The manifest declares two kinds of command. The eight bind:"service" ones are answered by the
// Rust service; the JS entry must register the other eight and no more. Registering a command the
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
  assert.equal(serviceCommands.length, 8, "the eight existing service commands are still declared");
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
