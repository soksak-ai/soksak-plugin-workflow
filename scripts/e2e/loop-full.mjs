#!/usr/bin/env node
// The full P2 loop, end to end, driven only through registry commands (sok).
//
// One issue goes the whole way: onto the ledger → leased → a worktree → dispatched to a REAL claude
// agent that writes code and commits → receipted → reviewed → the review returns into the agent's
// own terminal → redispatched, and the agent fixes what the review asked for → approved → merged →
// the worktree reclaimed → done on the ledger, with no drift against the repository.
//
// Nothing here is simulated. The agent is a real `claude` process in a real pane; the commits are
// real commits, and the harness reads them back out of git. If the agent does not actually commit,
// this fails — the assertion is on the repository, never on the agent's own account of itself.
//
// The gates are proved by making them refuse first, on the same live issue:
//   LEASE_STALE          — dispatch an issue nobody leased
//   EVIDENCE_REQUIRED    — finish an issue that carries no receipt
//   NOT_APPROVED         — merge what no one approved
//   UNRESOLVED_COMMENTS  — merge over an open review comment
//
// Env: SOK = the sok binary (default: the pinned debug CLI). Requires the target app running.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import assert from "node:assert/strict";
import { join } from "node:path";

const SOK = process.env.SOK || "/Users/max/ai/cli/vsterm-tauri/src-tauri/target/debug/sok-debug";
const FIXTURE = join(homedir(), ".soksak-e2e", "full");
const REPO = join(FIXTURE, "repo");
const SNAP_REVIEW = join(FIXTURE, "snapshot-review.png");
const SNAP_LEDGER = join(FIXTURE, "snapshot-ledger.png");

const WF = "plugin.soksak-plugin-workflow";
const WS = "plugin.soksak-plugin-git-workspace";
const RV = "plugin.soksak-plugin-git-review";
const WF_ID = "soksak-plugin-workflow";
const RV_ID = "soksak-plugin-git-review";
const TERM_ID = "soksak-plugin-terminal-xterm";

const ISSUE = "full-1";
const NAME = "loop/full-1"; // the workspace name — worktree.open derives the branch from it verbatim
const BRANCH = NAME;
// One owner per process. Two loops that call themselves the same owner are, to the ledger, the same
// agent — so its lease waves the second one through, and the two silently write over each other's
// issue. A distinct identity is what lets the ledger refuse the collision it was built to refuse.
const OWNER = `agent-claude-${process.pid}`;
const AGENT_WAIT_MS = 240_000; // a real LLM turn: minutes, not seconds
const POLL_MS = 3000;

function sok(cmd, params, opts = {}) {
  const args = [];
  if (opts.window) args.push("--window", opts.window);
  args.push(cmd);
  if (params !== undefined) args.push(JSON.stringify(params));
  const r = spawnSync(SOK, args, { encoding: "utf8", timeout: 60_000 });
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`sok ${cmd} — non-JSON output: ${r.stdout || r.stderr}`);
  }
}
// Every call that is supposed to succeed goes through this. Reading .data off a refused envelope
// throws a TypeError about undefined properties, which says nothing about what actually went wrong
// — the command's own code and message do. Negative cases still read the raw envelope on purpose.
function must(r, what) {
  assert.ok(r?.ok, `${what} failed: ${r?.code} ${r?.message}`);
  assert.ok(r.data !== undefined, `${what} returned no data: ${JSON.stringify(r)}`);
  return r.data;
}

// A negative case proves a gate refuses. It can only prove that if the situation it refuses over is
// actually the situation set up — an issue with no receipt, a target with no approval. When that
// premise is false the run must die in its own voice, because a poisoned fixture failing here looks
// exactly like a gate that does not exist, and that misreading costs an investigation.
function premise(ok, why) {
  if (!ok) throw new Error(`POISONED PREMISE (not a gate failure — the fixture was not clean): ${why}`);
}

const git = (args, cwd = REPO) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
const head = (cwd) => git(["rev-parse", "HEAD"], cwd).stdout.trim();
const step = (n, s) => console.log(`\n[${n}] ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const addrs = (win) => {
  const t = sok("ui.tree", undefined, { window: win });
  return ((t.data?.nodes || t.data || []).map((n) => (typeof n === "string" ? n : n.address))).filter((a) => typeof a === "string");
};
function viewsOf(win) {
  const t = sok("state.tree", undefined, { window: win });
  return (t.data?.projects || []).flatMap((p) => (p.spaces || []).flatMap((s) => (s.panels || []).flatMap((pn) => pn.views || [])));
}

// The fixture repo, and the permissions the dispatched agent works under. The agent is allowed to
// edit files and run git in this sandbox and nothing else — an agent that had to stop and ask could
// never be dispatched unattended, and one allowed everything would not be a sandbox.
function ensureFixture() {
  if (!existsSync(join(REPO, ".git"))) {
    mkdirSync(join(REPO, ".claude"), { recursive: true });
    for (const a of [["init", "-b", "main"], ["config", "user.email", "e2e@soksak.test"], ["config", "user.name", "e2e"]]) git(a);
    writeFileSync(join(REPO, "README.md"), "hello\n");
    git(["add", "README.md"]);
    git(["commit", "-q", "-m", "init"]);
    git(["tag", "base"]);
  }
  mkdirSync(join(REPO, ".claude"), { recursive: true });
  writeFileSync(
    join(REPO, ".claude", "settings.local.json"),
    JSON.stringify({ permissions: { allow: ["Edit", "Write", "Read", "Bash(git:*)"] } }, null, 2),
  );
  if (git(["rev-parse", "-q", "--verify", "refs/tags/base"]).status !== 0) {
    const root = git(["rev-list", "--max-parents=0", "HEAD"]).stdout.trim();
    if (root) git(["tag", "base", root]);
  }
}

// Dispatch a real agent into the worktree's own terminal and wait for it to actually commit.
// The wait is a retry regime, not a weaker assertion: the loop asks git, and if no commit ever
// lands the gate fails. An agent that reports success without committing has not done the work.
async function dispatchAgent(win, pane, wt, task, label) {
  const before = head(wt);
  const prompt =
    `TASK (dispatched by an automated loop — no human is watching, never ask for confirmation): ${task} ` +
    `Then run: git add -A  and then: git commit -m "${label}". ` +
    `You are NOT done until git log -1 shows your commit — verify it yourself with git log before you finish. ` +
    `Do not stop to ask permission or confirmation.`;
  const cmd = `claude -p ${JSON.stringify(prompt)} --permission-mode acceptEdits`;
  const r = sok("term.exec", { pane, cmd }, { window: win });
  assert.ok(r.ok, `term.exec (dispatch): ${r.code} ${r.message}`);

  const deadline = Date.now() + AGENT_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const now = head(wt);
    if (now && now !== before) {
      console.log(`      agent committed ${now.slice(0, 7)} (${Math.round((AGENT_WAIT_MS - (deadline - Date.now())) / 1000)}s)`);
      return now;
    }
  }
  const tail = sok("term.read", { pane, lines: 20 }, { window: win }).data?.text || "";
  throw new Error(`the dispatched agent never committed within ${AGENT_WAIT_MS / 1000}s. pane tail:\n${tail}`);
}

// The fixture — the repository, the ledger row, the review store — is shared by whoever runs this.
// Before touching any of it, ask the ledger whether someone else is holding the issue right now,
// and if so refuse: reclaiming under a live run destroys its worktree and poisons its store, and
// the victim's next gate then appears to be the thing that is broken.
function refuseToStompALiveRun(win) {
  const rows = sok(`${WF}.lease.list`, {}, { window: win });
  assert.ok(rows.ok, `lease.list: ${rows.code} ${rows.message}`);
  const e = (rows.data.entries || []).find((x) => x.issue === ISSUE);
  if (e && e.leaseState === "live" && e.lease.owner !== OWNER) {
    throw new Error(
      `${ISSUE} is leased right now by ${e.lease.owner} — another full loop is running against this fixture. ` +
        `Refusing to start: reclaiming its worktree and ledger row would corrupt a live run. ` +
        `If that run is dead, release it: sok ${WF}.lease.release '{"issue":"${ISSUE}","owner":"${e.lease.owner}"}'`,
    );
  }
}

// Reclaim every axis this run touches. Called before AND after: a run that cannot clean up after
// itself is not idempotent, and a run that trusts the last one's cleanup is measuring its leftovers.
function reclaim(win) {
  sok(`${WS}.worktree.close`, { name: NAME }, { window: win });
  for (const c of sok(`${RV}.comment.list`, { target: BRANCH }, { window: win }).data?.comments || []) {
    sok(`${RV}.comment.remove`, { id: c.id }, { window: win });
  }
  sok(`${RV}.approve.revoke`, { target: BRANCH }, { window: win });
  sok(`${WF}.lease.release`, { issue: ISSUE, owner: OWNER }, { window: win });
  sok(`${WF}.entry.remove`, { issue: ISSUE, owner: OWNER }, { window: win });

  git(["checkout", "-q", "-f", "main"]);
  git(["reset", "--hard", "-q", "base"]);
  git(["worktree", "prune"]);
  git(["branch", "-D", BRANCH]);
}

async function main() {
  step("setup", "app up (control plane) + fixture repo + the window that hosts it");
  assert.ok(sok("window.list", undefined, { window: "main" }).ok, `app not reachable via ${SOK}`);
  ensureFixture();

  sok("window.open", { root: REPO }, { window: "main" });
  let win = null;
  for (let i = 0; i < 40 && !win; i++) {
    const projects = sok("window.projects", undefined, { window: "main" }).data?.projects || [];
    win = projects.find((p) => p.root === REPO)?.window || null;
    if (!win) await sleep(500);
  }
  assert.ok(win?.startsWith("w-"), "no window hosts the fixture repo (cold-boot self-sufficiency)");
  for (let i = 0; i < 40; i++) {
    const pl = sok("plugin.list", undefined, { window: win });
    const on = (id) => (pl.data?.plugins || []).some((p) => p.id === id && p.status === "enabled");
    if (pl.ok && on(WF_ID) && on(RV_ID) && on("soksak-plugin-git-workspace")) break;
    await sleep(500);
  }

  step("pre-clean", "reclaim ledger, comments, approval, worktree, git — before anything is measured");
  refuseToStompALiveRun(win); // ask before reclaiming — never destroy a live run's state
  reclaim(win);
  for (const v of viewsOf(win)) {
    if ([WF_ID, RV_ID, TERM_ID].includes(v.plugin)) sok("view.close", { view: v.id }, { window: win });
  }
  await sleep(800);
  const baseline = viewsOf(win).length;
  assert.equal((must(sok(`${WF}.lease.list`, {}, { window: win }), "lease.list").entries || []).filter((e) => e.issue === ISSUE).length, 0, "ledger not clean");

  // ── the issue enters the loop ───────────────────────────────────────────────
  step("1.issue", "put the issue on the ledger — it exists, but it has earned nothing yet");
  const added = sok(`${WF}.entry.add`, { issue: ISSUE, branch: BRANCH }, { window: win });
  assert.ok(added.ok, `entry.add: ${added.code} ${added.message}`);
  assert.equal(added.data.leaseState, "absent");

  step("RED.lease", "dispatch it with no lease → LEASE_STALE (the issue exists; existing is not earning)");
  // A negative case must first prove its own premise. Without this, a dirty store (a leftover lease
  // from another run) would make the gate look broken — or, worse, make a broken gate look fine.
  premise(added.data.leaseState === "absent", `the issue must start unleased, but it is ${added.data.leaseState}`);
  const stale = sok(`${WF}.gate.dispatch`, { issue: ISSUE, owner: OWNER }, { window: win });
  assert.equal(stale.ok, false, "an unleased issue must not be dispatchable");
  assert.equal(stale.code, "LEASE_STALE", `expected LEASE_STALE, got ${stale.code}`);

  step("2.lease", "take the lease, and now the same dispatch is allowed");
  assert.ok(sok(`${WF}.lease.acquire`, { issue: ISSUE, owner: OWNER, branch: BRANCH }, { window: win }).ok);
  assert.equal(must(sok(`${WF}.gate.dispatch`, { issue: ISSUE, owner: OWNER }, { window: win }), "gate.dispatch (leased)").passed, true);

  // ── the workspace ───────────────────────────────────────────────────────────
  step("3.worktree", "open the worktree workspace (branch + worktree + project + a terminal at its cwd)");
  const wt = sok(`${WS}.worktree.open`, { name: NAME, path: REPO, base: "main" }, { window: win });
  assert.ok(wt.ok, `worktree.open: ${wt.code} ${wt.message}`);
  const WTDIR = wt.data.worktreeDir;
  assert.equal(wt.data.branch, BRANCH, `unexpected branch ${wt.data.branch}`);
  assert.ok(existsSync(join(WTDIR, ".git")), "no worktree on disk");
  await sleep(2500);

  // the terminal the workspace opened at the worktree's cwd — this is the agent's workspace, and
  // later it is where the review comes back to.
  const pane = viewsOf(win).find((v) => v.plugin === TERM_ID)?.id;
  assert.ok(pane, "the worktree workspace opened no terminal pane");

  // ── dispatch: a real agent, real code, a real commit ────────────────────────
  step("4.dispatch", "dispatch a real claude into that terminal — it must write code and commit");
  const sha1 = await dispatchAgent(
    win,
    pane,
    WTDIR,
    "Create a file greet.sh containing a bash function greet() that echoes hello.",
    "agent: add greet",
  );
  assert.ok(existsSync(join(WTDIR, "greet.sh")), "the agent's file is not on disk");
  assert.equal(git(["status", "--porcelain"], WTDIR).stdout.trim(), "", "the agent left the worktree dirty");

  step("RED.evidence", "finish it now, with the work done but nothing receipted → EVIDENCE_REQUIRED");
  // The premise IS the whole test: this gate can only be shown to hold if the issue truly carries
  // no receipt. One stray receipt — from a crashed run, or from another loop writing the same issue
  // — and the gate would open legitimately while looking like a gate that does not exist.
  const beforeReceipt = await entry(win, ISSUE);
  premise(
    beforeReceipt.receipts.length === 0,
    `the issue must carry no receipt yet, but it already has ${beforeReceipt.receipts.length} ` +
      `(${JSON.stringify(beforeReceipt.receipts)}) — the store is poisoned, so this gate cannot be judged`,
  );
  premise(beforeReceipt.done === false, "the issue must not already be done");
  const noEvidence = sok(`${WF}.gate.transition`, { issue: ISSUE }, { window: win });
  assert.equal(noEvidence.ok, false, "work that has not been receipted is not evidence");
  assert.equal(noEvidence.code, "EVIDENCE_REQUIRED");

  step("5.receipt", "record the agent's real commit as the receipt — a sha the repository can vouch for");
  const rec = sok(`${WF}.receipt.add`, { issue: ISSUE, kind: "commit", value: sha1 }, { window: win });
  assert.ok(rec.ok, `receipt.add: ${rec.code} ${rec.message}`);

  // ── review ──────────────────────────────────────────────────────────────────
  step("6.review", "the reviewer sees the agent's diff and leaves a comment demanding a change");
  const files = sok(`${RV}.diff.files`, { target: BRANCH, path: REPO }, { window: win });
  assert.ok(files.ok, `diff.files: ${files.code} ${files.message}`);
  assert.ok(files.data.files.some((f) => f.path === "greet.sh"), `the review does not see the agent's file: ${JSON.stringify(files.data.files)}`);
  const DEMAND = "greet must take a name argument and echo hello NAME, not a bare hello";
  const c = sok(`${RV}.comment.add`, { target: BRANCH, file: "greet.sh", line: 1, body: DEMAND }, { window: win });
  assert.ok(c.ok && c.data.id, "comment.add failed");

  step("RED.approval", "merge it with nobody's approval → NOT_APPROVED");
  // premise: nothing has approved this target. A stale approval left by a crashed run would let the
  // merge through and this gate would look absent.
  premise(must(sok(`${RV}.approve.revoke`, { target: BRANCH }, { window: win }), "approve.revoke").revoked === false, "an approval already existed before anyone approved");
  const unapproved = sok(`${RV}.merge`, { target: BRANCH, path: REPO }, { window: win });
  assert.equal(unapproved.code, "NOT_APPROVED", `expected NOT_APPROVED, got ${unapproved.code}`);

  step("RED.unresolved", "approve it, then merge over the open comment → UNRESOLVED_COMMENTS");
  assert.ok(must(sok(`${RV}.approve`, { target: BRANCH, author: "reviewer" }, { window: win }), "approve").approved);
  // premise: there IS an open comment to be blocked by — otherwise this merge would (correctly)
  // succeed and prove nothing at all.
  const openNow = must(sok(`${RV}.comment.list`, { target: BRANCH, status: "open" }, { window: win }), "comment.list").comments || [];
  premise(openNow.length >= 1, "there must be an open comment for this gate to refuse over");
  const unresolved = sok(`${RV}.merge`, { target: BRANCH, path: REPO }, { window: win });
  assert.equal(unresolved.code, "UNRESOLVED_COMMENTS", `expected UNRESOLVED_COMMENTS, got ${unresolved.code}`);
  assert.equal(head(REPO), git(["rev-parse", "base"]).stdout.trim(), "a refused merge must not have moved main");

  // ── the review returns to the agent's terminal ──────────────────────────────
  step("7.return", "send the open comments into the agent's own terminal, and read them back out of it");
  const sent = sok(`${RV}.comment.send`, { target: BRANCH, pane }, { window: win });
  assert.ok(sent.ok, `comment.send: ${sent.code} ${sent.message}`);
  await sleep(1500);
  const buf = must(sok("term.read", { pane, lines: 14 }, { window: win }), "term.read").text;
  const norm = (s) => String(s).replace(/\s+/g, "");
  assert.ok(norm(buf).includes(norm("take a name argument")), `the review did not reach the agent's terminal:\n${buf}`);

  // ── snapshot A: the review surface, populated ───────────────────────────────
  step("8.snapshot", `capture the review surface (files, the open comment, the approve control) → ${SNAP_REVIEW}`);
  const rvOpen = sok("plugin.view.open", { view: `${RV_ID}.view`, placement: "content" }, { window: win });
  assert.ok(rvOpen.ok, `plugin.view.open(review): ${rvOpen.message}`);
  const reviewView = rvOpen.data.viewId;
  sok("view.activate", { view: reviewView }, { window: win });
  await sleep(700);
  const rf = addrs(win).find((a) => a.endsWith("/node/refresh") && a.includes("git-review"));
  if (rf) sok("ui.input.click", { address: rf }, { window: win });
  await sleep(1200);
  const rvAddrs = addrs(win);
  assert.ok(rvAddrs.some((a) => a.includes("/node/file/")), "refusing a hollow snapshot: the review shows no files");
  assert.ok(rvAddrs.some((a) => a.includes("/node/comment/")), "refusing a hollow snapshot: the review shows no comment");
  assert.ok(sok("window.snapshot", { path: SNAP_REVIEW }, { window: win }).ok, "review snapshot failed");

  // ── redispatch: the agent addresses the review ──────────────────────────────
  step("9.redispatch", "dispatch the agent again, carrying the review's demand — it must actually fix it");
  const open = must(sok(`${RV}.comment.list`, { target: BRANCH, status: "open" }, { window: win }), "comment.list").comments;
  assert.ok(open.length >= 1, "no open comment to hand back to the agent");
  const sha2 = await dispatchAgent(
    win,
    pane,
    WTDIR,
    `A reviewer left this comment on greet.sh: "${open.map((x) => x.body).join(" ")}". Address it in the code.`,
    "agent: address review",
  );
  assert.notEqual(sha2, sha1, "the redispatch produced no new commit");
  // the fix is judged by the file, not by the agent's summary of itself
  const greet = readFileSync(join(WTDIR, "greet.sh"), "utf8");
  assert.match(greet, /\$\{?1\}?/, `the agent did not make greet take a name argument:\n${greet}`);

  step("10.resolve", "the reviewer's demand is met, so the comment resolves — and the receipt is recorded");
  assert.equal(must(sok(`${RV}.comment.resolve`, { id: open[0].id }, { window: win }), "comment.resolve").status, "resolved");
  assert.ok(sok(`${WF}.receipt.add`, { issue: ISSUE, kind: "commit", value: sha2 }, { window: win }).ok);
  assert.ok(sok(`${WF}.receipt.add`, { issue: ISSUE, kind: "test", value: "bash -n greet.sh", passed: true }, { window: win }).ok);

  // ── merge ───────────────────────────────────────────────────────────────────
  step("11.merge", "now, and only now, the merge is allowed — a real merge commit on main");
  const merged = sok(`${RV}.merge`, { target: BRANCH, path: REPO }, { window: win });
  assert.ok(merged.ok && merged.data.merged, `merge: ${merged.code} ${merged.message}`);
  const parents = git(["show", "--no-patch", "--format=%P", "HEAD"]).stdout.trim().split(/\s+/);
  assert.equal(parents.length, 2, `main's head is not a merge commit (parents: ${parents})`);
  assert.ok(existsSync(join(REPO, "greet.sh")), "the merge did not bring the agent's work into main");
  assert.match(readFileSync(join(REPO, "greet.sh"), "utf8"), /\$\{?1\}?/, "main did not receive the reviewed version");

  // ── the ledger closes the loop ──────────────────────────────────────────────
  step("12.done", "carry the issue to done — the gate opens only because the receipts are real");
  const done = sok(`${WF}.gate.transition`, { issue: ISSUE }, { window: win });
  assert.ok(done.ok && done.data.done, `gate.transition: ${done.code} ${done.message}`);

  step("13.drift", "the ledger's story and the repository's facts agree — no drift");
  const drift = sok(`${WF}.drift.check`, { issue: ISSUE, path: REPO, base: "main" }, { window: win });
  assert.ok(drift.ok, `drift.check: ${drift.code} ${drift.message}`);
  assert.deepEqual(drift.data.drifts, [], `the finished loop drifts: ${JSON.stringify(drift.data.drifts)}`);

  // ── snapshot B: the ledger, showing the finished issue ──────────────────────
  step("14.snapshot", `capture the ledger showing the issue done, with its receipts → ${SNAP_LEDGER}`);
  const lgOpen = sok("plugin.view.open", { view: `${WF_ID}.ledger`, placement: "content" }, { window: win });
  assert.ok(lgOpen.ok, `plugin.view.open(ledger): ${lgOpen.message}`);
  const ledgerView = lgOpen.data.viewId;
  sok("view.activate", { view: ledgerView }, { window: win });
  await sleep(700);
  const lrf = addrs(win).find((a) => a.endsWith("/node/refresh") && a.includes(WF_ID));
  if (lrf) sok("ui.input.click", { address: lrf }, { window: win });
  await sleep(1200);
  const lgAddrs = addrs(win);
  assert.ok(lgAddrs.some((a) => a.includes("/node/entry/")), "refusing a hollow snapshot: the ledger shows no issue");
  const shown = must(sok(`${WF}.lease.list`, {}, { window: win }), "lease.list").entries.find((e) => e.issue === ISSUE);
  assert.ok(shown?.done && shown.receipts.length >= 3, `the ledger does not show a finished, receipted issue: ${JSON.stringify(shown)}`);
  assert.ok(sok("window.snapshot", { path: SNAP_LEDGER }, { window: win }).ok, "ledger snapshot failed");

  // ── reclaim ─────────────────────────────────────────────────────────────────
  step("15.close", "close the workspace — the worktree is reclaimed, the merged branch's work survives in main");
  const closed = sok(`${WS}.worktree.close`, { name: NAME }, { window: win });
  assert.ok(closed.ok && closed.data.closed, `worktree.close: ${closed.code} ${closed.message}`);
  assert.ok(!existsSync(join(WTDIR, ".git")), "the worktree was not reclaimed from disk");

  step("teardown", "every axis back to where this run found it: git, the ledger, the review store, the surface");
  reclaim(win);
  sok("view.close", { view: reviewView }, { window: win });
  sok("view.close", { view: ledgerView }, { window: win });
  await sleep(800);
  const after = viewsOf(win);
  assert.equal(after.length, baseline, `surface not back to baseline (${after.length} vs ${baseline})`);
  assert.equal(head(REPO), git(["rev-parse", "base"]).stdout.trim(), "git not back to base");
  assert.equal((must(sok(`${WF}.lease.list`, {}, { window: win }), "lease.list").entries || []).filter((e) => e.issue === ISSUE).length, 0, "ledger row survived");
  assert.equal((must(sok(`${RV}.comment.list`, { target: BRANCH }, { window: win }), "comment.list").comments || []).length, 0, "comments survived");

  console.log(`\nFULL LOOP PASSED. snapshots: ${SNAP_REVIEW} , ${SNAP_LEDGER}`);
}

async function entry(win, issue) {
  const rows = must(sok(`${WF}.lease.list`, {}, { window: win }), "lease.list").entries || [];
  const e = rows.find((r) => r.issue === issue);
  assert.ok(e, `no ledger entry for ${issue}`);
  return e;
}

main().catch((e) => {
  console.error(`\nFULL LOOP FAILED: ${e.message}`);
  process.exit(1);
});
