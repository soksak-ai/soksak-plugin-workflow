#!/usr/bin/env node
// End-to-end gate for the workflow ledger, driven only through registry commands (sok).
//
// The claim under test: the loop cannot advance on a claim. So every gate here is proved by first
// making it REFUSE (a negative fixture), and only then making it pass. A gate that is never seen to
// refuse has not been shown to be a gate.
//
// Gates: ① LEASE_STALE — dispatch refused with no lease, with an expired lease, with someone else's
//        ② EVIDENCE_REQUIRED — completion refused with no receipt, a fabricated one, a failing test
//        ③ drift — the ledger checked against the repository it claims to describe (real git)
//        ④ conformance + the service no-regression probe (the eight Rust commands still answer)
//        ⑤ idempotency — reclaimed on all three axes: git, the ledger store, the UI surface
//        ⑥ snapshot — the ledger view, front and populated; a hollow frame is refused
//
// Env: SOK = the sok binary (default: the pinned debug CLI). Requires the target app running.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import assert from "node:assert/strict";
import { join } from "node:path";

const SOK = process.env.SOK || "/Users/max/ai/cli/vsterm-tauri/src-tauri/target/debug/sok-debug";
const FIXTURE = join(homedir(), ".soksak-e2e", "workflow");
const REPO = join(FIXTURE, "repo");
const SNAP = join(FIXTURE, "snapshot.png");
const PLUGIN = "plugin.soksak-plugin-workflow";
const PLUGIN_ID = "soksak-plugin-workflow";

const TARGET = "loop/target"; // a real branch, with a real commit, in a real worktree
const GHOST = "loop/ghost"; // a branch the ledger will claim and the repository will never have
const WT = join(FIXTURE, "wt-target");
const FABRICATED = "deadbee"; // a plausible-looking sha that names no commit

// The issues this run owns. Every one is dropped again at teardown — the store must come back
// exactly as it was found, or run N+1 is measuring run N's leftovers.
const ISSUES = ["e2e-dispatch", "e2e-evidence", "e2e-ghost", "e2e-fabricated", "e2e-done"];

function sok(cmd, params, opts = {}) {
  const args = [];
  if (opts.window) args.push("--window", opts.window);
  args.push(cmd);
  if (params !== undefined) args.push(JSON.stringify(params));
  const r = spawnSync(SOK, args, { encoding: "utf8", timeout: 30000 });
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`sok ${cmd} — non-JSON output: ${r.stdout || r.stderr}`);
  }
}
const git = (args, cwd = REPO) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
const step = (n, s) => console.log(`\n[${n}] ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uiTreeAddrs = (tree) =>
  ((tree.data?.nodes || tree.data || []).map((n) => (typeof n === "string" ? n : n.address))).filter((a) => typeof a === "string");
function viewsOf(win) {
  const t = sok("state.tree", undefined, { window: win });
  const pr = (t.data?.projects || []).find((p) => p.active) || {};
  return (pr.spaces || []).flatMap((s) => (s.panels || []).flatMap((pn) => pn.views || []));
}

// Reclaim the ledger rows this run owns. Idempotent: an absent entry is already gone, and a live
// lease is released first so the entry is never dropped out from under an owner.
function purgeLedger(win) {
  for (const issue of ISSUES) {
    sok(`${PLUGIN}.lease.release`, { issue, owner: ownerOf(issue) }, { window: win });
    sok(`${PLUGIN}.entry.remove`, { issue, owner: ownerOf(issue) }, { window: win });
  }
}
const ownerOf = () => "agent-1";

function ensureFixture() {
  if (!existsSync(join(REPO, ".git"))) {
    mkdirSync(REPO, { recursive: true });
    for (const a of [["init", "-b", "main"], ["config", "user.email", "e2e@soksak.test"], ["config", "user.name", "e2e"]]) git(a);
    writeFileSync(join(REPO, "README.md"), "hello\n");
    git(["add", "README.md"]);
    git(["commit", "-q", "-m", "init"]);
    git(["tag", "base"]);
  }
  if (git(["rev-parse", "-q", "--verify", "refs/tags/base"]).status !== 0) {
    const root = git(["rev-list", "--max-parents=0", "HEAD"]).stdout.trim();
    if (root) git(["tag", "base", root]);
  }
}

async function main() {
  step("setup", "app up (control plane) + a fixture repo whose facts the ledger can be checked against");
  assert.ok(sok("window.list", undefined, { window: "main" }).ok, `app not reachable via ${SOK}`);
  ensureFixture();

  // ── git axis: back to a known state, every run ─────────────────────────────
  git(["checkout", "-q", "-f", "main"]);
  git(["reset", "--hard", "-q", "base"]);
  git(["worktree", "remove", "--force", WT]);
  git(["worktree", "prune"]);
  git(["branch", "-D", TARGET]);
  git(["branch", "-D", GHOST]); // must NOT exist — ③ depends on the repository never having it
  assert.equal(git(["show-ref", "--verify", "--quiet", `refs/heads/${GHOST}`]).status, 1, "the ghost branch must not exist");

  // a real branch with a real commit, checked out in a real worktree (as the loop's worker would)
  assert.equal(git(["worktree", "add", "-q", "-b", TARGET, WT, "base"]).status, 0, "worktree add failed");
  writeFileSync(join(WT, "feature.txt"), "the work\n");
  git(["add", "feature.txt"], WT);
  git(["commit", "-q", "-m", "the work"], WT);
  const SHA = git(["rev-parse", "HEAD"], WT).stdout.trim();
  assert.match(SHA, /^[0-9a-f]{40}$/, "no commit sha from the fixture");
  assert.notEqual(SHA.slice(0, 7), FABRICATED, "the fixture accidentally produced the fabricated sha");

  step("window", "open the repo's window (the JS commands live in the window's registry, not in main)");
  sok("window.open", { root: REPO }, { window: "main" });
  let win = null;
  for (let i = 0; i < 40 && !win; i++) {
    const projects = sok("window.projects", undefined, { window: "main" }).data?.projects || [];
    win = projects.find((p) => p.root === REPO)?.window || null;
    if (!win) await sleep(500);
  }
  assert.ok(win && win.startsWith("w-"), "no workspace window hosts the fixture repo (cold-boot self-sufficiency)");
  for (let i = 0; i < 40; i++) {
    const pl = sok("plugin.list", undefined, { window: win });
    if (pl.ok && (pl.data?.plugins || []).some((p) => p.id === PLUGIN_ID && p.status === "enabled")) break;
    await sleep(500);
  }

  step("pre-clean", "drop this run's ledger rows and reclaim leftover views — the three axes, before anything is measured");
  purgeLedger(win);
  const rows = sok(`${PLUGIN}.lease.list`, {}, { window: win });
  assert.ok(rows.ok, `lease.list: ${rows.code} ${rows.message} (is the JS entry loaded? a fresh command needs a manifest rescan)`);
  const mine = (rows.data.entries || []).filter((e) => ISSUES.includes(e.issue));
  assert.equal(mine.length, 0, `ledger not purged — ${mine.map((e) => e.issue)} survived, so this run would measure the last one's leftovers`);
  for (const v of viewsOf(win)) {
    if (v.plugin === PLUGIN_ID) sok("view.close", { view: v.id }, { window: win });
  }
  await sleep(600);
  const baseline = viewsOf(win).length;

  // ── GATE ① LEASE_STALE ──────────────────────────────────────────────────────
  step("①.lease", "RED: dispatch with no lease, an expired lease, someone else's lease — then GREEN");
  const D = "e2e-dispatch";

  const noLease = sok(`${PLUGIN}.gate.dispatch`, { issue: D, owner: "agent-1" }, { window: win });
  assert.equal(noLease.ok, false, "RED expected: an unleased issue must not dispatch");
  assert.equal(noLease.code, "LEASE_STALE", `expected LEASE_STALE, got ${noLease.code}`);

  const acq = sok(`${PLUGIN}.lease.acquire`, { issue: D, owner: "agent-1", ttlMs: 1500 }, { window: win });
  assert.ok(acq.ok && acq.data.leaseState === "live", `lease.acquire: ${acq.code} ${acq.message}`);
  assert.equal(sok(`${PLUGIN}.gate.dispatch`, { issue: D, owner: "agent-1" }, { window: win }).data.passed, true, "the live owner must dispatch");

  const held = sok(`${PLUGIN}.gate.dispatch`, { issue: D, owner: "agent-2" }, { window: win });
  assert.equal(held.code, "LEASE_HELD", "a second agent must not dispatch an issue someone else holds");

  await sleep(1800); // let it lapse — the real staleness, not a missing lease
  // Prove it is the EXPIRED path, not the absent one (both refuse LEASE_STALE): the entry still
  // carries its lease, and the ledger computes it expired. Asserting on the message text would be
  // asserting on prose — and prose is localized, while the code and the state are the contract.
  const lapsed = await entry(win, D);
  assert.ok(lapsed.lease, "the lapsed lease must still be on the record");
  assert.equal(lapsed.leaseState, "expired", `expected an expired lease, got ${lapsed.leaseState}`);
  const stale = sok(`${PLUGIN}.gate.dispatch`, { issue: D, owner: "agent-1" }, { window: win });
  assert.equal(stale.code, "LEASE_STALE", "an owner who let the lease lapse is not an owner");
  assert.ok(String(stale.message || "").length > 0, "a refusal must say why");
  // and the expired issue is free again — that is what an expiry is for
  assert.ok(sok(`${PLUGIN}.lease.acquire`, { issue: D, owner: "agent-2" }, { window: win }).data.leaseState === "live");
  assert.equal(sok(`${PLUGIN}.gate.dispatch`, { issue: D, owner: "agent-2" }, { window: win }).data.passed, true);
  sok(`${PLUGIN}.lease.release`, { issue: D, owner: "agent-2" }, { window: win });

  // ── GATE ② EVIDENCE_REQUIRED ────────────────────────────────────────────────
  step("②.evidence", "RED: done with no receipt, with a claim dressed as one, with a failing test — then GREEN");
  const E = "e2e-evidence";
  sok(`${PLUGIN}.lease.acquire`, { issue: E, owner: "agent-1" }, { window: win });

  const noEvidence = sok(`${PLUGIN}.gate.transition`, { issue: E }, { window: win });
  assert.equal(noEvidence.ok, false, "RED expected: an issue with no receipt must not complete");
  assert.equal(noEvidence.code, "EVIDENCE_REQUIRED");

  const claim = sok(`${PLUGIN}.receipt.add`, { issue: E, kind: "commit", value: "i-did-the-work" }, { window: win });
  assert.equal(claim.code, "INVALID_RECEIPT", "a claim wearing a receipt's clothes must be refused at the door");

  sok(`${PLUGIN}.receipt.add`, { issue: E, kind: "test", value: "cargo test", passed: false }, { window: win });
  const failing = sok(`${PLUGIN}.gate.transition`, { issue: E }, { window: win });
  assert.equal(failing.code, "EVIDENCE_REQUIRED", "a failing test is evidence AGAINST completion");
  assert.equal((await entry(win, E)).done, false, "a refused gate must leave the issue open");

  sok(`${PLUGIN}.receipt.add`, { issue: E, kind: "commit", value: SHA }, { window: win });
  const passed = sok(`${PLUGIN}.gate.transition`, { issue: E }, { window: win });
  assert.equal(passed.ok, false, "a failing test receipt still on the record must keep the gate shut");
  assert.equal(passed.code, "EVIDENCE_REQUIRED");
  sok(`${PLUGIN}.lease.release`, { issue: E, owner: "agent-1" }, { window: win });

  // a clean issue: one real commit receipt, and the gate opens — and it is the gate that marks it done
  const DONE = "e2e-done";
  sok(`${PLUGIN}.lease.acquire`, { issue: DONE, owner: "agent-1", branch: TARGET }, { window: win });
  assert.equal((await entry(win, DONE)).done, false);
  sok(`${PLUGIN}.receipt.add`, { issue: DONE, kind: "commit", value: SHA }, { window: win });
  sok(`${PLUGIN}.receipt.add`, { issue: DONE, kind: "test", value: "cargo test --lib", passed: true }, { window: win });
  const green = sok(`${PLUGIN}.gate.transition`, { issue: DONE }, { window: win });
  assert.ok(green.ok && green.data.done, `GREEN expected: a verifiable receipt must open the gate — ${green.code} ${green.message}`);
  assert.equal((await entry(win, DONE)).done, true, "done is written by the gate that verified the receipt");

  // ── GATE ③ drift — the ledger against the repository ────────────────────────
  step("③.drift", "a branch that was never created, a receipt naming no commit, a done that never landed");

  // (a) a branch the ledger claims and the repository never had
  sok(`${PLUGIN}.lease.acquire`, { issue: "e2e-ghost", owner: "agent-1", branch: GHOST }, { window: win });
  sok(`${PLUGIN}.lease.release`, { issue: "e2e-ghost", owner: "agent-1" }, { window: win });
  const ghost = sok(`${PLUGIN}.drift.check`, { issue: "e2e-ghost", path: REPO }, { window: win });
  assert.ok(ghost.ok, `drift.check: ${ghost.code} ${ghost.message}`);
  assert.deepEqual(ghost.data.drifts.map((d) => d.field), ["branch"], `expected one branch drift, got ${JSON.stringify(ghost.data.drifts)}`);
  assert.equal(ghost.data.drifts[0].claimed, GHOST);

  // (b) a receipt naming a commit the repository does not have
  sok(`${PLUGIN}.lease.acquire`, { issue: "e2e-fabricated", owner: "agent-1", branch: TARGET }, { window: win });
  sok(`${PLUGIN}.receipt.add`, { issue: "e2e-fabricated", kind: "commit", value: FABRICATED }, { window: win });
  sok(`${PLUGIN}.lease.release`, { issue: "e2e-fabricated", owner: "agent-1" }, { window: win });
  const fab = sok(`${PLUGIN}.drift.check`, { issue: "e2e-fabricated", path: REPO }, { window: win });
  assert.deepEqual(fab.data.drifts.map((d) => d.field), ["commit"], `expected one commit drift, got ${JSON.stringify(fab.data.drifts)}`);
  assert.equal(fab.data.drifts[0].claimed, FABRICATED);

  // (c) the ledger says done, but the branch never landed in base — RED
  const unmerged = sok(`${PLUGIN}.drift.check`, { issue: DONE, path: REPO }, { window: win });
  assert.deepEqual(unmerged.data.drifts.map((d) => d.field), ["merged"], `expected a merged drift, got ${JSON.stringify(unmerged.data.drifts)}`);

  // land it for real, and the same claim stops drifting — GREEN
  assert.equal(git(["merge", "--no-ff", "-q", "-m", "land the work", TARGET]).status, 0, "merge failed");
  const landed = sok(`${PLUGIN}.drift.check`, { issue: DONE, path: REPO }, { window: win });
  assert.deepEqual(landed.data.drifts, [], `a landed, receipted, done issue must not drift: ${JSON.stringify(landed.data.drifts)}`);

  // the drift report never repairs the ledger — the false claim is still on the record to be seen
  assert.equal((await entry(win, "e2e-ghost")).branch, GHOST, "a self-healing ledger could never catch reality lying to it");

  // ── GATE ⑥ snapshot — the ledger view, front and populated ───────────────────
  step("⑥.snapshot", `bring the Ledger view to the front, render its rows and its drift report → ${SNAP}`);
  const vOpen = sok("plugin.view.open", { view: `${PLUGIN_ID}.ledger`, placement: "content" }, { window: win });
  assert.ok(vOpen.ok, `plugin.view.open: ${vOpen.code} ${vOpen.message}`);
  const ledgerView = vOpen.data.viewId;
  assert.ok(sok("view.activate", { view: ledgerView }, { window: win }).ok, "view.activate(ledger) failed");
  await sleep(800);

  let addrs = uiTreeAddrs(sok("ui.tree", undefined, { window: win }));
  assert.ok(
    addrs.some((a) => a.startsWith(`win/${win}/`)),
    `ui.tree did not target ${win} (got: ${[...new Set(addrs.map((a) => a.split("/")[1]))].join(",")})`,
  );
  const refresh = addrs.find((a) => a.endsWith("/node/refresh") && a.includes(PLUGIN_ID));
  assert.ok(refresh, "no refresh node on the ledger view");
  sok("ui.input.click", { address: refresh }, { window: win });
  await sleep(900);
  const check = uiTreeAddrs(sok("ui.tree", undefined, { window: win })).find((a) => a.endsWith("/node/check") && a.includes(PLUGIN_ID));
  assert.ok(check, "no drift-check node on the ledger view");
  assert.ok(sok("ui.input.click", { address: check }, { window: win }).ok, "drift check click failed");
  await sleep(1500);

  // A snapshot that does not show what this gate claims is not evidence. Refuse a hollow frame.
  addrs = uiTreeAddrs(sok("ui.tree", undefined, { window: win }));
  const entryRows = addrs.filter((a) => a.includes("/node/entry/"));
  const driftRows = addrs.filter((a) => a.includes("/node/drift/"));
  assert.ok(entryRows.length >= 3, `refusing a hollow snapshot: the ledger shows ${entryRows.length} entry rows`);
  assert.ok(driftRows.length >= 1, `refusing a hollow snapshot: the drift report shows nothing, but ${JSON.stringify(fab.data.drifts)} exists`);
  assert.ok(sok("window.snapshot", { path: SNAP }, { window: win }).ok, "snapshot failed");

  // ── GATE ④ conformance + the service no-regression probe ────────────────────
  step("④.conformance", "declared ≡ actual, and the eight Rust service commands still answer through the entry");
  const conf = sok("plugin.conformance", { id: PLUGIN_ID }, { window: win });
  assert.ok(conf.ok, `conformance: ${conf.message}`);
  const viol = (conf.data.commands?.missing || []).concat(conf.data.commands?.messagesMissing || []);
  assert.equal(viol.length, 0, `conformance violations: ${JSON.stringify(viol)}`);
  assert.equal((conf.data.nodes?.missing || []).length + (conf.data.nodes?.orphan || []).length, 0, `node conformance: ${JSON.stringify(conf.data.nodes)}`);

  // The JS entry must not have displaced the service: these are answered by the Rust sidecar, and
  // their envelopes are exactly what they were before the entry existed (routing intact, not a
  // COMMAND_NOT_FOUND or a spawn failure wearing an error's clothes).
  const ping = sok(`${PLUGIN}.ping`, undefined, { window: "main" });
  assert.equal(ping.code, "INTERNAL", `service routing broken — ping answered ${ping.code}: ${ping.message}`);
  const exported = sok(`${PLUGIN}.export`, undefined, { window: "main" });
  assert.equal(exported.code, "INVALID_PARAMS", `service routing broken — export answered ${exported.code}: ${exported.message}`);

  // ── GATE ⑤ idempotency — reclaim all three axes ─────────────────────────────
  step("⑤.reclaim", "drop the ledger rows, close the view, reset git — the next run must find no trace of this one");
  purgeLedger(win);
  const left = (sok(`${PLUGIN}.lease.list`, {}, { window: win }).data.entries || []).filter((e) => ISSUES.includes(e.issue));
  assert.equal(left.length, 0, `ledger rows survived teardown: ${left.map((e) => e.issue)}`);

  sok("view.close", { view: ledgerView }, { window: win });
  await sleep(600);
  const after = viewsOf(win);
  assert.equal(after.filter((v) => v.plugin === PLUGIN_ID).length, 0, "ledger view not reclaimed — views would accumulate one per run");
  assert.equal(after.length, baseline, `surface not back to baseline (${after.length} vs ${baseline})`);

  git(["checkout", "-q", "-f", "main"]);
  git(["reset", "--hard", "-q", "base"]);
  git(["worktree", "remove", "--force", WT]);
  git(["worktree", "prune"]);
  git(["branch", "-D", TARGET]);
  assert.equal(git(["rev-parse", "HEAD"]).stdout.trim(), git(["rev-parse", "base"]).stdout.trim(), "git not back to base");

  console.log(`\nALL GATES PASSED. snapshot: ${SNAP}`);
}

async function entry(win, issue) {
  const rows = sok(`${PLUGIN}.lease.list`, {}, { window: win }).data.entries || [];
  const e = rows.find((r) => r.issue === issue);
  assert.ok(e, `no ledger entry for ${issue}`);
  return e;
}

main().catch((e) => {
  console.error(`\nE2E FAILED: ${e.message}`);
  process.exit(1);
});
