// The blocking gates. RED baseline: a dispatch that proceeds without a live lease, a transition
// that passes on a claim instead of a receipt, a fabricated receipt that goes unnoticed, a "done"
// whose branch was never merged. Every gate must refuse — never warn-and-pass.
import test from "node:test";
import assert from "node:assert/strict";
import {
  leaseState, checkDispatch, checkRenew, receiptVerifiable, checkEvidence, detectDrift,
  LEASE_STALE, LEASE_HELD, EVIDENCE_REQUIRED,
} from "../js/gate.js";

const lease = (owner, expiresAt) => ({ owner, expiresAt });
const commit = (value) => ({ kind: "commit", value, at: 1 });
const testReceipt = (value, passed) => ({ kind: "test", value, passed, at: 1 });

// ── lease ───────────────────────────────────────────────────────────────────

test("leaseState — at the expiry instant the lease is already gone", () => {
  assert.equal(leaseState(null, 100), "absent");
  assert.equal(leaseState(lease("a", 200), 100), "live");
  assert.equal(leaseState(lease("a", 200), 200), "expired");
  assert.equal(leaseState(lease("a", 200), 201), "expired");
});

test("dispatch without a lease refuses LEASE_STALE", () => {
  const r = checkDispatch(null, "agent-1", 100);
  assert.equal(r.ok, false);
  assert.equal(r.code, LEASE_STALE);
});

test("dispatch on an expired lease refuses LEASE_STALE", () => {
  const r = checkDispatch(lease("agent-1", 100), "agent-1", 100);
  assert.equal(r.code, LEASE_STALE);
  assert.match(r.message, /expired/);
});

test("dispatch by a second agent refuses LEASE_HELD — two agents, one issue is the accident", () => {
  const r = checkDispatch(lease("agent-1", 500), "agent-2", 100);
  assert.equal(r.code, LEASE_HELD);
  assert.match(r.message, /agent-1/);
});

test("dispatch by the live owner passes", () => {
  assert.equal(checkDispatch(lease("agent-1", 500), "agent-1", 100).ok, true);
});

test("renew — owner only, and only while still live (an expired lease cannot be revived)", () => {
  assert.equal(checkRenew(lease("agent-1", 500), "agent-1", 100).ok, true);
  assert.equal(checkRenew(lease("agent-1", 500), "agent-2", 100).code, LEASE_HELD);
  assert.equal(checkRenew(lease("agent-1", 100), "agent-1", 100).code, LEASE_STALE);
  assert.equal(checkRenew(null, "agent-1", 100).code, LEASE_STALE);
});

// ── evidence ────────────────────────────────────────────────────────────────

test("a receipt must be checkable by a third party", () => {
  assert.ok(receiptVerifiable(commit("0dc2d14")));
  assert.ok(receiptVerifiable(commit("0dc2d14632f9933a44a230da3b23d6d41f351db2")));
  assert.ok(!receiptVerifiable(commit("i-did-the-work")), "a non-sha is not a commit receipt");
  assert.ok(!receiptVerifiable(commit("abc")), "too short to be a sha");
  assert.ok(receiptVerifiable(testReceipt("cargo test", true)));
  assert.ok(!receiptVerifiable({ kind: "test", value: "cargo test" }), "a test with no verdict proves nothing");
  assert.ok(!receiptVerifiable(testReceipt("", true)), "a verdict with no command is unverifiable");
});

test("transition without evidence refuses EVIDENCE_REQUIRED", () => {
  assert.equal(checkEvidence([]).code, EVIDENCE_REQUIRED);
});

test("an unverifiable receipt is not evidence — a claim in receipt's clothes must not open the gate", () => {
  assert.equal(checkEvidence([commit("i-did-the-work")]).code, EVIDENCE_REQUIRED);
});

test("a failing test refuses — it is evidence AGAINST the transition, not for it", () => {
  const r = checkEvidence([commit("0dc2d14"), testReceipt("cargo test", false)]);
  assert.equal(r.code, EVIDENCE_REQUIRED);
  assert.match(r.message, /failed/);
});

test("a verifiable receipt opens the gate", () => {
  assert.equal(checkEvidence([commit("0dc2d14")]).ok, true);
  assert.equal(checkEvidence([testReceipt("cargo test", true)]).ok, true);
});

// ── drift (the OUTSIDE check: ledger vs repository) ─────────────────────────

const actual = (o) => ({ branchExists: true, commitsPresent: [], branchMerged: true, worktreeExists: true, ...o });

test("a consistent record has no drift", () => {
  const d = detectDrift(
    { branch: "feat/x", commits: ["0dc2d14"], done: true },
    actual({ commitsPresent: ["0dc2d14"] }),
  );
  assert.deepEqual(d, []);
});

test("a claimed branch the repository does not have is drift", () => {
  const d = detectDrift({ branch: "feat/ghost", commits: [], done: false }, actual({ branchExists: false }));
  assert.equal(d.length, 1);
  assert.equal(d[0].field, "branch");
});

test("a receipt naming a commit the repository lacks is drift — a fabricated receipt", () => {
  const d = detectDrift({ branch: "feat/x", commits: ["deadbee"], done: false }, actual({ commitsPresent: [] }));
  assert.equal(d.length, 1);
  assert.equal(d[0].field, "commit");
  assert.equal(d[0].claimed, "deadbee");
});

test("done without any commit receipt is drift", () => {
  const d = detectDrift({ branch: "feat/x", commits: [], done: true }, actual());
  assert.equal(d.length, 1);
  assert.equal(d[0].field, "done");
});

test("the ledger says done but the branch was never merged — drift", () => {
  const d = detectDrift(
    { branch: "feat/x", commits: ["0dc2d14"], done: true },
    actual({ commitsPresent: ["0dc2d14"], branchMerged: false }),
  );
  assert.equal(d.length, 1);
  assert.equal(d[0].field, "merged");
  assert.match(d[0].actual, /not merged/);
});

test("work is leased but the worktree was already reclaimed — drift", () => {
  const d = detectDrift({ branch: "feat/x", commits: [], done: false, leaseLive: true }, actual({ worktreeExists: false }));
  assert.equal(d.length, 1);
  assert.equal(d[0].field, "worktree");
});

test("a lease taken before any branch exists is not worktree drift — no crying wolf on a fresh issue", () => {
  const d = detectDrift({ branch: null, commits: [], done: false, leaseLive: true }, actual({ branchExists: false, worktreeExists: false }));
  assert.deepEqual(d, []);
});

test("drift is reported, never repaired in place", () => {
  const claim = { branch: "feat/ghost", commits: ["deadbee"], done: true };
  const before = JSON.parse(JSON.stringify(claim));
  const d = detectDrift(claim, actual({ branchExists: false, commitsPresent: [] }));
  assert.deepEqual(claim, before, "the claim must not be rewritten to match reality");
  assert.equal(d.length, 2, "both the absent branch and the fabricated commit are reported");
});
