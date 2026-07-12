// The issue loop's blocking gates, as pure decisions over values.
//
// Blocking-or-nothing: every check answers pass or refuse. There is no warn-and-continue — a gate
// that can be talked past is not a gate.
//
// Pure: no store, no git, no clock. The caller supplies `nowMs` and the observed repository facts,
// so every judgement here is reproducible from its inputs (and testable without an app).
//
// This lease is the ISSUE lease — an owner holding an issue for a bounded time. It is a different
// thing from the reconcile DAG lease (in-memory, node-scoped, reset on restart), which stays as it
// is; only the expiry boundary is shared: a lease at or past its expiry is not live.

export const LEASE_STALE = "LEASE_STALE";
export const LEASE_HELD = "LEASE_HELD";
export const EVIDENCE_REQUIRED = "EVIDENCE_REQUIRED";

// A refusal carries a code, a structured detail, and an English message. The detail is what the
// command layer renders in the caller's language — a gate that hard-codes one language would make
// the plugin answer half its refusals in the wrong one.
const refuse = (code, detail, message) => ({ ok: false, code, detail, message });
const pass = () => ({ ok: true });

// ── lease ───────────────────────────────────────────────────────────────────

/** "absent" | "live" | "expired" — at the expiry instant the lease is already gone. */
export function leaseState(lease, nowMs) {
  if (!lease || typeof lease.expiresAt !== "number") return "absent";
  return lease.expiresAt <= nowMs ? "expired" : "live";
}

// An issue may be dispatched only by the owner of a live lease on it. No lease and an expired lease
// both refuse: proceeding on a lease nobody currently holds is the exact accident (two agents, one
// issue) this gate exists to prevent.
export function checkDispatch(lease, owner, nowMs) {
  switch (leaseState(lease, nowMs)) {
    case "absent":
      return refuse(LEASE_STALE, { kind: "absent" }, "no lease — acquire one before dispatch");
    case "expired":
      return refuse(
        LEASE_STALE,
        { kind: "expired", owner: lease.owner, expiresAt: lease.expiresAt },
        `lease expired at ${lease.expiresAt} (was held by ${lease.owner})`,
      );
    default:
      return lease.owner === owner
        ? pass()
        : refuse(
            LEASE_HELD,
            { kind: "held", owner: lease.owner, expiresAt: lease.expiresAt },
            `issue is leased by ${lease.owner} until ${lease.expiresAt}`,
          );
  }
}

// Renewing is the owner's right alone, and only while the lease is still live — reviving an expired
// lease would let a forgotten agent silently reclaim an issue someone else may already hold.
export function checkRenew(lease, owner, nowMs) {
  switch (leaseState(lease, nowMs)) {
    case "absent":
      return refuse(LEASE_STALE, { kind: "absent" }, "no lease to renew");
    case "expired":
      return refuse(
        LEASE_STALE,
        { kind: "expired", owner: lease.owner, expiresAt: lease.expiresAt },
        `lease expired at ${lease.expiresAt} — acquire a new one`,
      );
    default:
      return lease.owner === owner
        ? pass()
        : refuse(LEASE_HELD, { kind: "held", owner: lease.owner, expiresAt: lease.expiresAt }, `lease is held by ${lease.owner}`);
  }
}

// ── evidence ────────────────────────────────────────────────────────────────

export function isSha(s) {
  return typeof s === "string" && s.length >= 7 && s.length <= 40 && /^[0-9a-fA-F]+$/.test(s);
}

// A receipt only counts if a third party can re-check it: a commit sha must look like one, a test
// must carry its verdict. An unverifiable receipt is a claim wearing a receipt's clothes.
export function receiptVerifiable(r) {
  if (!r) return false;
  if (r.kind === "commit") return isSha(r.value);
  if (r.kind === "test") return typeof r.value === "string" && r.value.trim() !== "" && typeof r.passed === "boolean";
  return false;
}

// A review-pass or completion transition requires at least one verifiable receipt, and a test
// receipt that failed refuses: a failing test is evidence AGAINST the transition, not for it.
export function checkEvidence(receipts) {
  const verifiable = (receipts || []).filter(receiptVerifiable);
  if (verifiable.length === 0) {
    return refuse(EVIDENCE_REQUIRED, { kind: "none" }, "no verifiable receipt — a commit sha or a test result is required");
  }
  const failed = verifiable.find((r) => r.kind === "test" && r.passed === false);
  if (failed) return refuse(EVIDENCE_REQUIRED, { kind: "failed", value: failed.value }, `a test receipt failed: ${failed.value}`);
  return pass();
}

// ── drift ───────────────────────────────────────────────────────────────────

// Drift is the OUTSIDE check: what the ledger records against what the repository actually shows.
// (The draft loop's validate_ledger checks a record against its own history — that is inside
// consistency, a different question, and it stays where it is.)
//
// Reported, never repaired in place: a ledger that quietly rewrites itself to match reality can
// never catch reality lying to it.
//
//   claim  = { branch, commits: [sha], done }         — what the ledger says
//   actual = { branchExists, commitsPresent: [sha], branchMerged, worktreeExists } — what git says
export function detectDrift(claim, actual) {
  const c = claim || {};
  const a = actual || {};
  const commits = c.commits || [];
  const present = a.commitsPresent || [];
  const out = [];

  if (c.branch && !a.branchExists) {
    out.push({ field: "branch", claimed: c.branch, actual: "absent" });
  }
  for (const sha of commits) {
    if (!present.includes(sha)) {
      // a receipt naming a commit the repository does not have — a fabricated receipt
      out.push({ field: "commit", claimed: sha, actual: "absent" });
    }
  }
  if (c.done && commits.length === 0) {
    out.push({ field: "done", claimed: "done", actual: "no commit receipt" });
  }
  if (c.done && c.branch && a.branchExists && a.branchMerged === false) {
    out.push({ field: "merged", claimed: "done", actual: `${c.branch} is not merged into base` });
  }
  // Only once a branch is claimed: an issue leased but not yet branched has nowhere to keep a
  // worktree, and calling that drift would cry wolf on every freshly taken issue.
  if (c.leaseLive && c.branch && a.worktreeExists === false) {
    out.push({ field: "worktree", claimed: "leased (work in progress)", actual: "worktree reclaimed" });
  }
  return out;
}
