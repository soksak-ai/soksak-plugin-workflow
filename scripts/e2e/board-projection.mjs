#!/usr/bin/env node
// The loop's state, on a board — reached by contract, never by name.
//
// The ledger never says "kanban". It asks the core who implements soksak-spec-plugin-issue-board and
// projects onto whatever comes back. This run proves the card is really there (a human can see the
// issue, who holds it, what it carries, and that it finished) and that the ledger does not depend
// on the board existing at all.
//
// Gates: RED    — an issue on the ledger with no card yet
//        GREEN  — the card appears, and follows the issue: backlog → inprogress → done
//        reclaim — dropping the issue withdraws the card; no card survives a run
//        snapshot — the board showing the finished issue, refused if hollow
//
// Env: SOK = the sok binary (default: the pinned debug CLI). Requires the target app running.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import assert from "node:assert/strict";
import { join } from "node:path";

const SOK = process.env.SOK || "/Users/max/ai/cli/vsterm-tauri/src-tauri/target/debug/sok-debug";
const FIXTURE = join(homedir(), ".soksak-e2e", "board");
const REPO = join(FIXTURE, "repo");
const SNAP = join(FIXTURE, "snapshot-board.png");

const WF = "plugin.soksak-plugin-workflow";
const WF_ID = "soksak-plugin-workflow";
const CONTRACT = "soksak-spec-plugin-issue-board";

const ISSUE = "board-1";
// A fixed owner: this issue is this test's own, and a run must always be able to reclaim what a
// crashed predecessor left leased — a pid-keyed owner would lock the fixture until the lease expired.
const OWNER = "board-e2e";
const SHA = "0dc2d14";

function sok(cmd, params, opts = {}) {
  const args = [];
  if (opts.window) args.push("--window", opts.window);
  args.push(cmd);
  if (params !== undefined) args.push(JSON.stringify(params));
  const r = spawnSync(SOK, args, { encoding: "utf8", timeout: 40_000 });
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`sok ${cmd} — non-JSON output: ${r.stdout || r.stderr}`);
  }
}
function must(r, what) {
  assert.ok(r?.ok, `${what} failed: ${r?.code} ${r?.message}`);
  return r.data;
}
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

// Read the board back through the SAME discovery the ledger uses. Asking kanban by name here would
// let the harness pass while the projection quietly pinned an implementer the contract never
// promised — the test has to be as ignorant of the board as the code it tests.
function boardId(win) {
  const d = must(sok("plugin.implementers", { contract: CONTRACT }, { window: win }), "plugin.implementers");
  const found = (d.implementers || []).find((i) => i.status === "enabled");
  assert.ok(found, `nothing enabled implements ${CONTRACT} — the projection has nowhere to go`);
  return found.id;
}
function cards(win, board) {
  return (must(sok(`plugin.${board}.node.list`, { search: ISSUE }, { window: win }), "node.list").nodes || []).filter(
    (n) => n.title === ISSUE,
  );
}

async function main() {
  step("setup", "app up + a project window (a contract is discovered where plugins live, not in the control plane)");
  assert.ok(sok("window.list", undefined, { window: "main" }).ok, `app not reachable via ${SOK}`);
  if (!existsSync(REPO)) mkdirSync(REPO, { recursive: true });

  sok("window.open", { root: REPO }, { window: "main" });
  let win = null;
  for (let i = 0; i < 40 && !win; i++) {
    const projects = sok("window.projects", undefined, { window: "main" }).data?.projects || [];
    win = projects.find((p) => p.root === REPO)?.window || null;
    if (!win) await sleep(500);
  }
  assert.ok(win?.startsWith("w-"), "no window hosts the fixture (cold-boot self-sufficiency)");
  for (let i = 0; i < 40; i++) {
    const pl = sok("plugin.list", undefined, { window: win });
    if (pl.ok && (pl.data?.plugins || []).some((p) => p.id === WF_ID && p.status === "enabled")) break;
    await sleep(500);
  }

  step("discover", `who implements ${CONTRACT}? — the ledger asks this and so does this test`);
  const board = boardId(win);
  console.log(`      board: ${board} (discovered, not named)`);

  step("pre-clean", "drop the issue and any card it left behind");
  sok(`${WF}.lease.release`, { issue: ISSUE, owner: OWNER }, { window: win });
  sok(`${WF}.entry.remove`, { issue: ISSUE, owner: OWNER }, { window: win });
  for (const c of cards(win, board)) sok(`plugin.${board}.node.remove`, { node: c.id }, { window: win });
  await sleep(600);
  for (const v of viewsOf(win)) if (v.plugin === board || v.plugin === WF_ID) sok("view.close", { view: v.id }, { window: win });
  await sleep(600);
  const baseline = viewsOf(win).length;
  assert.equal(cards(win, board).length, 0, "a card for this issue survived the pre-clean");

  // ── RED → GREEN: the card follows the issue ─────────────────────────────────
  step("RED", "the issue does not exist yet, so no card may exist for it");
  assert.equal(cards(win, board).length, 0);

  step("backlog", "put it on the ledger — a card appears, and nobody is on it");
  must(sok(`${WF}.entry.add`, { issue: ISSUE, branch: "loop/board-1" }, { window: win }), "entry.add");
  await sleep(1200);
  let found = cards(win, board);
  assert.equal(found.length, 1, `expected exactly one card, got ${found.length}`);
  assert.equal(found[0].status, "backlog", `a card for an unheld issue must sit in backlog, not ${found[0].status}`);

  step("inprogress", "take the lease — the same card moves, and says who has it");
  must(sok(`${WF}.lease.acquire`, { issue: ISSUE, owner: OWNER, branch: "loop/board-1" }, { window: win }), "lease.acquire");
  await sleep(1200);
  found = cards(win, board);
  assert.equal(found.length, 1, "a status change must move the card, never add a second one");
  assert.equal(found[0].status, "inprogress");
  assert.match(found[0].description || "", new RegExp(OWNER), "the card must say who is holding it");

  step("done", "receipt it and pass the gate — the card lands in done, carrying its evidence");
  must(sok(`${WF}.receipt.add`, { issue: ISSUE, kind: "commit", value: SHA }, { window: win }), "receipt.add");
  must(sok(`${WF}.gate.transition`, { issue: ISSUE }, { window: win }), "gate.transition");
  await sleep(1200);
  found = cards(win, board);
  assert.equal(found.length, 1);
  assert.equal(found[0].status, "done", "the issue finished, so the card must show it finished");
  assert.match(found[0].description || "", /receipt/, "the card must carry the evidence that earned the done");
  assert.match(found[0].description || "", new RegExp(SHA), "the commit a human would re-check must be on the card");

  // ── snapshot — the board, showing the finished issue ────────────────────────
  // A capture of the whole board proves nothing: it is shared, and this issue would be one row among
  // hundreds of somebody else's. Focus the board on the ledger's own group and put it in card mode,
  // so the frame shows exactly what this gate claims — and refuse to shoot if it does not.
  step("snapshot", `focus the board on the ledger group, in card mode → ${SNAP}`);
  const root = must(sok(`${WF}.board.sync`, {}, { window: win }), "board.sync").root;
  assert.ok(root, "the projection made no group card to focus on");
  const view = must(sok("plugin.view.open", { view: `${board}.kanban`, placement: "content" }, { window: win }), "plugin.view.open");
  const boardView = view.viewId;
  must(sok("view.activate", { view: boardView }, { window: win }), "view.activate");
  await sleep(1200);
  must(sok(`plugin.${board}.focus.set`, { node: root, view: "board" }, { window: win }), "focus.set(ledger group, board)");
  // A board lays its statuses out in columns. At the default width the done column sits off the
  // right edge, so the capture would show two empty columns and call it evidence — widen the window
  // until the column this gate is about is actually in the frame.
  must(sok("window.resize", { w: 3400, h: 1400 }, { window: win }), "window.resize");
  await sleep(2000);

  const shown = cards(win, board);
  assert.ok(
    shown.length === 1 && shown[0].status === "done",
    `refusing a hollow snapshot: the board does not show the finished issue: ${JSON.stringify(shown)}`,
  );
  assert.match(shown[0].description || "", new RegExp(SHA), "refusing a hollow snapshot: the card carries no evidence");
  must(sok("window.focus", undefined, { window: win }), "window.focus");
  await sleep(1800);
  must(sok("window.snapshot", { path: SNAP }, { window: win }), "snapshot");

  // ── reclaim ────────────────────────────────────────────────────────────────
  step("teardown", "drop the issue — its card must go with it, or every run leaves one behind");
  must(sok(`${WF}.lease.release`, { issue: ISSUE, owner: OWNER }, { window: win }), "lease.release");
  must(sok(`${WF}.entry.remove`, { issue: ISSUE, owner: OWNER }, { window: win }), "entry.remove");
  await sleep(1200);
  assert.equal(cards(win, board).length, 0, "the issue is gone from the ledger but its card is still on someone's board");

  sok("window.resize", { w: 1600, h: 1200 }, { window: win }); // give the window back the size it had
  sok(`plugin.${board}.focus.set`, { node: "root", view: "outline" }, { window: win }); // the board is shared — put it back
  sok("view.close", { view: boardView }, { window: win });
  await sleep(800);
  assert.equal(viewsOf(win).length, baseline, "surface not back to baseline");

  console.log(`\nBOARD PROJECTION PASSED (via ${CONTRACT} → ${board}). snapshot: ${SNAP}`);
}

main().catch((e) => {
  console.error(`\nE2E FAILED: ${e.message}`);
  process.exit(1);
});
