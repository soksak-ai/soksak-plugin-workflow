// The issue ledger and its blocking gates.
//
// This is the JS half of the plugin; the Rust service half (run/reconcile/next/submit/…) is
// untouched and keeps its own state. The ledger lives in the core data store, so it survives a
// restart — a dispatch lease that evaporated when the app bounced would let a second agent take an
// issue the first one still holds, which is the very accident the lease exists to prevent.
//
// This ISSUE lease is a different thing from the reconcile DAG lease (in-memory, node-scoped, reset
// on restart, no owner). Only the expiry boundary is shared. They never share a name or a command.
//
// The gates return refusal codes; they never warn-and-pass. Callers (the loop) must route through
// gate.dispatch / gate.transition — a gate nobody has to call is decoration.
import {
  leaseState, checkDispatch, checkRenew, receiptVerifiable, checkEvidence, detectDrift,
} from "./gate.js";
import { makeGit } from "./git.js";

const COLL = "entry"; // one ledger entry per issue
const SCOPE = "index";
const DEFAULT_TTL_MS = 30 * 60 * 1000; // a dispatch lease outlives a normal agent turn, not a nap

function h(tag, style, text) {
  const el = document.createElement(tag);
  if (style) el.style.cssText = style;
  if (text !== undefined) el.textContent = text;
  return el;
}
// A stable, address-safe node key derived from the issue id (never a counter).
function nodeKey(id) {
  const k = String(id).toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  return /^[a-z0-9]/.test(k) ? k : `i-${k}`;
}

const index_default = {
  activate(ctx) {
    const app = ctx.app;
    const err = (code, message) => ({ ok: false, code, message });
    const msg = (en, ko) => ((typeof app.locale === "function" ? app.locale() : "en") === "ko" ? ko : en);

    // Render a gate's refusal in the caller's language. The gates are pure and speak one language;
    // the command surface is where a refusal must be readable by whoever it refuses.
    const refusal = (v) => {
      const d = v.detail || {};
      switch (d.kind) {
        case "absent":
          return err(v.code, msg("no lease — acquire one before dispatch", "리스 없음 — 디스패치 전에 취득하라"));
        case "expired":
          return err(v.code, msg(`lease expired at ${d.expiresAt} (was held by ${d.owner})`, `리스 만료(${d.owner} 보유분) — 새로 취득하라`));
        case "held":
          return err(v.code, msg(`issue is leased by ${d.owner}`, `${d.owner} 가 점유 중`));
        case "none":
          return err(v.code, msg("no verifiable receipt — a commit sha or a test result is required", "검증 가능한 증적 없음 — 커밋 sha 또는 테스트 결과 필요"));
        case "failed":
          return err(v.code, msg(`a test receipt failed: ${d.value}`, `테스트 증적 실패: ${d.value}`));
        default:
          return err(v.code, v.message);
      }
    };
    const reg = (name, spec) => ctx.subscriptions.push(app.commands.register(name, spec));
    const git = makeGit(app.process);
    const now = () => Date.now();

    void app.data.define(COLL, { indexes: ["issue", "owner", "done", "updatedAt"] });

    const load = async (issue) => (await app.data.get(COLL, String(issue), { scope: SCOPE })) || null;
    const all = async () => {
      const rows = await app.data.query(COLL, { scope: SCOPE, order: "updatedAt" });
      return Array.isArray(rows) ? rows : [];
    };
    const blank = (issue) => ({ issue: String(issue), lease: null, owner: null, branch: null, receipts: [], done: false, updatedAt: 0 });
    const save = async (e) => {
      const rec = { ...e, owner: e.lease?.owner ?? null, updatedAt: now() };
      await app.data.put(COLL, rec, { scope: SCOPE, id: rec.issue });
      return rec;
    };
    // The public shape of an entry — the lease's live/expired verdict is computed, never stored, so
    // it can never go stale in the record itself.
    const view = (e) => ({
      issue: e.issue,
      lease: e.lease,
      leaseState: leaseState(e.lease, now()),
      branch: e.branch ?? null,
      receipts: e.receipts || [],
      done: !!e.done,
    });
    const repoPath = (p) => (typeof p.path === "string" && p.path ? p.path : undefined) ?? app.project?.current?.()?.root ?? undefined;

    // ── lease ───────────────────────────────────────────────────────────────
    reg("lease.acquire", {
      description:
        "Take the dispatch lease on an issue: an owner and an expiry. A live lease held by someone else refuses (LEASE_HELD) — two agents on one issue is the accident this prevents. An absent or expired lease is free to take. Idempotent for the same owner (re-acquiring extends).",
      triggers: { ko: "이슈 리스 취득 점유 소유" },
      params: {
        issue: { type: "string", description: "Issue id to lease", required: true },
        owner: { type: "string", description: "Who takes it (agent/person id)", required: true },
        branch: { type: "string", description: "Branch the work happens on (recorded for drift)" },
        ttlMs: { type: "number", description: `Lease lifetime in ms (default ${DEFAULT_TTL_MS})` },
      },
      returns: "{ issue, lease:{owner,expiresAt}, leaseState, branch, receipts, done }",
      examples: ['sok plugin.soksak-plugin-workflow.lease.acquire \'{"issue":"i-42","owner":"agent-1","branch":"feat/x"}\''],
      message: (d) => msg(`${d.owner ?? d.lease?.owner} holds ${d.issue}`, `${d.lease?.owner} 가 ${d.issue} 점유`),
      handler: async (p) => {
        const issue = String(p.issue ?? "").trim();
        const owner = String(p.owner ?? "").trim();
        if (!issue || !owner) return err("INVALID_PARAMS", msg("issue and owner are required", "issue·owner 필요"));
        const e = (await load(issue)) || blank(issue);
        if (leaseState(e.lease, now()) === "live" && e.lease.owner !== owner) {
          return err("LEASE_HELD", msg(`issue is leased by ${e.lease.owner} until ${e.lease.expiresAt}`, `${e.lease.owner} 가 점유 중`));
        }
        const ttl = Number(p.ttlMs) > 0 ? Number(p.ttlMs) : DEFAULT_TTL_MS;
        e.lease = { owner, expiresAt: now() + ttl };
        if (typeof p.branch === "string" && p.branch) e.branch = p.branch;
        return view(await save(e));
      },
    });

    reg("lease.renew", {
      description:
        "Extend a lease you still hold. Only the owner may renew, and only while the lease is still live — reviving an expired lease would let a forgotten agent silently reclaim an issue someone else may already hold (LEASE_STALE).",
      triggers: { ko: "리스 갱신 연장" },
      params: {
        issue: { type: "string", description: "Issue id", required: true },
        owner: { type: "string", description: "The current owner", required: true },
        ttlMs: { type: "number", description: `Additional lifetime in ms (default ${DEFAULT_TTL_MS})` },
      },
      returns: "{ issue, lease, leaseState, ... }",
      examples: ['sok plugin.soksak-plugin-workflow.lease.renew \'{"issue":"i-42","owner":"agent-1"}\''],
      message: (d) => msg(`renewed ${d.issue}`, `${d.issue} 리스 갱신`),
      handler: async (p) => {
        const e = await load(p.issue);
        const v = checkRenew(e?.lease, String(p.owner ?? ""), now());
        if (!v.ok) return refusal(v);
        const ttl = Number(p.ttlMs) > 0 ? Number(p.ttlMs) : DEFAULT_TTL_MS;
        e.lease = { owner: e.lease.owner, expiresAt: now() + ttl };
        return view(await save(e));
      },
    });

    reg("lease.release", {
      description: "Give up a lease you hold. Only the owner may release it. Idempotent — releasing an absent lease is a no-op.",
      triggers: { ko: "리스 해제 반납" },
      params: {
        issue: { type: "string", description: "Issue id", required: true },
        owner: { type: "string", description: "The current owner", required: true },
      },
      returns: "{ issue, lease:null, leaseState, ... }",
      examples: ['sok plugin.soksak-plugin-workflow.lease.release \'{"issue":"i-42","owner":"agent-1"}\''],
      message: (d) => msg(`released ${d.issue}`, `${d.issue} 리스 해제`),
      handler: async (p) => {
        const owner = String(p.owner ?? "");
        const e = await load(p.issue);
        if (!e || !e.lease) return view(e || blank(p.issue)); // no-op
        if (leaseState(e.lease, now()) === "live" && e.lease.owner !== owner) {
          return err("LEASE_HELD", msg(`lease is held by ${e.lease.owner}`, `${e.lease.owner} 가 점유 중`));
        }
        e.lease = null;
        return view(await save(e));
      },
    });

    reg("lease.list", {
      description: "List every ledger entry with its computed lease state (live/expired/absent), branch, receipts, and done flag — the same rows the Ledger view shows.",
      triggers: { ko: "원장 목록 리스 상태 조회" },
      params: {},
      returns: "{ entries: [{issue, lease, leaseState, branch, receipts, done}] }",
      examples: ["sok plugin.soksak-plugin-workflow.lease.list"],
      message: (d) => msg(`${(d.entries ?? []).length} entries`, `원장 ${(d.entries ?? []).length}건`),
      handler: async () => ({ entries: (await all()).map(view) }),
    });

    // ── evidence ────────────────────────────────────────────────────────────
    reg("receipt.add", {
      description:
        "Record evidence against an issue: a commit (a hex sha) or a test (the command plus its verdict). An unverifiable receipt is refused at the door (INVALID_RECEIPT) — a claim wearing a receipt's clothes must never become the thing that opens a gate.",
      triggers: { ko: "증적 영수증 추가 커밋 테스트" },
      params: {
        issue: { type: "string", description: "Issue id", required: true },
        kind: { type: "string", description: "commit | test", required: true },
        value: { type: "string", description: "commit → the hex sha; test → the command that ran", required: true },
        passed: { type: "boolean", description: "test → the verdict (required for kind=test)" },
      },
      returns: "{ issue, receipts, ... }",
      examples: [
        'sok plugin.soksak-plugin-workflow.receipt.add \'{"issue":"i-42","kind":"commit","value":"0dc2d14"}\'',
        'sok plugin.soksak-plugin-workflow.receipt.add \'{"issue":"i-42","kind":"test","value":"cargo test","passed":true}\'',
      ],
      message: (d) => msg(`${(d.receipts ?? []).length} receipt(s) on ${d.issue}`, `${d.issue} 증적 ${(d.receipts ?? []).length}건`),
      handler: async (p) => {
        const issue = String(p.issue ?? "").trim();
        if (!issue) return err("INVALID_PARAMS", msg("issue is required", "issue 필요"));
        const r = { kind: p.kind, value: p.value, ...(typeof p.passed === "boolean" ? { passed: p.passed } : {}), at: now() };
        if (!receiptVerifiable(r)) {
          return err("INVALID_RECEIPT", msg("not verifiable — a commit needs a sha, a test needs its verdict", "검증 불가 — commit 은 sha, test 는 판정 필요"));
        }
        const e = (await load(issue)) || blank(issue);
        e.receipts = [...(e.receipts || []), r];
        return view(await save(e));
      },
    });

    reg("entry.remove", {
      description:
        "Drop a ledger entry and everything recorded on it — the lease, the receipts, the branch. Refuses while someone still holds a live lease (LEASE_HELD): dropping an entry out from under a working agent would erase the record that agent is about to be judged on. Release it first.",
      triggers: { ko: "원장 항목 삭제 제거" },
      params: {
        issue: { type: "string", description: "Issue id to drop", required: true },
        owner: { type: "string", description: "Required to drop an entry whose lease is still live" },
      },
      returns: "{ issue, removed: true }",
      examples: ['sok plugin.soksak-plugin-workflow.entry.remove \'{"issue":"i-42"}\''],
      message: (d) => msg(`dropped ${d.issue}`, `${d.issue} 삭제`),
      handler: async (p) => {
        const issue = String(p.issue ?? "").trim();
        if (!issue) return err("INVALID_PARAMS", msg("issue is required", "issue 필요"));
        const e = await load(issue);
        if (!e) return { issue, removed: false }; // idempotent — an absent entry is already gone
        if (leaseState(e.lease, now()) === "live" && e.lease.owner !== String(p.owner ?? "")) {
          return err("LEASE_HELD", msg(`issue is leased by ${e.lease.owner} — release it first`, `${e.lease.owner} 가 점유 중 — 먼저 해제`));
        }
        await app.data.delete(COLL, issue, { scope: SCOPE });
        return { issue, removed: true };
      },
    });

    // ── the gates (blocking-or-nothing) ─────────────────────────────────────
    reg("gate.dispatch", {
      description:
        "The gate the loop must pass before dispatching an issue: the caller must be the owner of a live lease. No lease or an expired one refuses LEASE_STALE; someone else's live lease refuses LEASE_HELD. There is no warn-and-continue.",
      triggers: { ko: "디스패치 게이트 검사 리스" },
      params: {
        issue: { type: "string", description: "Issue id about to be dispatched", required: true },
        owner: { type: "string", description: "Who wants to dispatch it", required: true },
      },
      returns: "{ passed: true } or a refusal { ok:false, code: LEASE_STALE|LEASE_HELD }",
      examples: ['sok plugin.soksak-plugin-workflow.gate.dispatch \'{"issue":"i-42","owner":"agent-1"}\''],
      message: () => msg("dispatch allowed", "디스패치 허용"),
      handler: async (p) => {
        const e = await load(p.issue);
        const v = checkDispatch(e?.lease, String(p.owner ?? ""), now());
        return v.ok ? { passed: true, issue: String(p.issue) } : refusal(v);
      },
    });

    reg("gate.transition", {
      description:
        "Carry an issue to done — and the only way to get there. The issue must hold at least one verifiable receipt, and a failing test receipt refuses (EVIDENCE_REQUIRED): a failing test is evidence against the transition, not for it. done is written by this handler alone, so an issue cannot be finished on a claim; the receipt is checked in the same breath that marks it.",
      triggers: { ko: "완료 전이 게이트 증적 검사" },
      params: { issue: { type: "string", description: "Issue id to carry to done", required: true } },
      returns: "{ passed: true, done: true } or a refusal { ok:false, code: EVIDENCE_REQUIRED }",
      examples: ['sok plugin.soksak-plugin-workflow.gate.transition \'{"issue":"i-42"}\''],
      message: (d) => msg(`${d.issue} is done`, `${d.issue} 완료`),
      handler: async (p) => {
        const issue = String(p.issue ?? "").trim();
        const e = await load(issue);
        const v = checkEvidence(e?.receipts || []);
        if (!v.ok) return refusal(v);
        e.done = true;
        await save(e);
        return { passed: true, done: true, issue };
      },
    });

    // ── drift (the OUTSIDE check) ───────────────────────────────────────────
    reg("drift.check", {
      description:
        "Compare what the ledger records against what the repository actually shows: a branch it never had, a receipt naming a commit that does not exist (a fabricated receipt), a done with no commit, a done whose branch was never merged, a lease still held on a worktree already reclaimed. Reported loud and never repaired — a ledger that quietly rewrites itself to match reality can never catch reality lying. Checks one issue, or every entry when issue is omitted.",
      triggers: { ko: "드리프트 검출 원장 실제 대조 어긋남" },
      params: {
        issue: { type: "string", description: "Issue id (omit = check every entry)" },
        path: { type: "string", description: "Repository directory (defaults to the active project root)" },
        base: { type: "string", description: "Base branch a done issue must be merged into (default main)" },
      },
      returns: "{ checked, drifted, drifts: [{issue, field, claimed, actual}] }",
      examples: ["sok plugin.soksak-plugin-workflow.drift.check", 'sok plugin.soksak-plugin-workflow.drift.check \'{"issue":"i-42"}\''],
      message: (d) =>
        (d.drifts ?? []).length === 0
          ? msg(`no drift across ${d.checked} entries`, `드리프트 없음(${d.checked}건 검사)`)
          : msg(`${d.drifts.length} drift(s) across ${d.checked} entries`, `드리프트 ${d.drifts.length}건`),
      handler: async (p) => {
        const cwd = repoPath(p);
        if (!cwd) return err("NO_PATH", msg("no repository path — pass path or open a project", "저장소 경로 없음"));
        const root = await git.root(cwd);
        if (!root) return err("NOT_REPO", msg("not a git repository", "git 저장소가 아닙니다"));
        const base = typeof p.base === "string" && p.base ? p.base : "main";
        const entries = p.issue ? [await load(p.issue)].filter(Boolean) : await all();
        const drifts = [];
        for (const e of entries) {
          const commits = (e.receipts || []).filter((r) => r.kind === "commit").map((r) => r.value);
          const actual = await git.probe({ repoRoot: root, branch: e.branch, commits, base });
          const claim = { branch: e.branch, commits, done: !!e.done, leaseLive: leaseState(e.lease, now()) === "live" };
          for (const d of detectDrift(claim, actual)) drifts.push({ issue: e.issue, ...d });
        }
        return { checked: entries.length, drifted: new Set(drifts.map((d) => d.issue)).size, drifts };
      },
    });

    // ── the ledger view (DOM) ───────────────────────────────────────────────
    const cleanups = new Map();
    ctx.subscriptions.push(
      app.ui.registerView("ledger", {
        mount(container, vctx) {
          const report = (code, message) => vctx.setStatus?.(code ? { code, message } : null);
          container.replaceChildren();
          const wrap = h("div", "display:flex;flex-direction:column;height:100%;min-height:0;font-size:12px;color:var(--fg);background:var(--bg)");
          const bar = h("div", "display:flex;align-items:center;justify-content:space-between;gap:10px;padding:4px 10px;border-bottom:1px solid var(--bd);flex:0 0 auto;min-height:28px;box-sizing:border-box");
          const title = h("span", "color:var(--fg2)", msg("Ledger", "원장"));
          const right = h("div", "display:flex;align-items:center;gap:6px");
          const driftBtn = h("button", "cursor:pointer;border:1px solid var(--bd);background:var(--inset);color:var(--fg2);border-radius:4px;padding:2px 8px;font-size:11px");
          driftBtn.textContent = msg("Check drift", "드리프트");
          driftBtn.dataset.node = "check";
          const refreshBtn = h("button", "display:inline-flex;align-items:center;justify-content:center;width:24px;height:22px;padding:0;cursor:pointer;border:1px solid var(--bd);background:var(--inset);color:var(--fg2);border-radius:4px");
          refreshBtn.textContent = "⟳";
          refreshBtn.title = msg("Refresh", "새로고침");
          refreshBtn.dataset.node = "refresh";
          right.append(driftBtn, refreshBtn);
          bar.append(title, right);

          const listEl = h("div", "flex:1 1 auto;min-height:0;overflow:auto;padding:5px 0");
          const driftEl = h("div", "flex:0 0 auto;max-height:35%;overflow:auto;border-top:1px solid var(--bd);padding:4px 0;display:none");
          wrap.append(bar, listEl, driftEl);
          container.append(wrap);

          async function render() {
            listEl.replaceChildren();
            report("loading", msg("Loading…", "불러오는 중…"));
            const entries = (await all()).map(view);
            if (entries.length === 0) {
              listEl.append(h("div", "padding:6px 12px;color:var(--fg3)", msg("No issues in the ledger", "원장에 이슈 없음")));
              report("empty", msg("No issues", "이슈 없음"));
              return;
            }
            const held = entries.filter((e) => e.leaseState === "live").length;
            report("active", msg(`${entries.length} issues, ${held} leased`, `이슈 ${entries.length} · 점유 ${held}`));
            const frag = document.createDocumentFragment();
            for (const e of entries) {
              const row = h("div", "display:flex;align-items:center;gap:8px;padding:4px 12px");
              row.dataset.node = `entry/${nodeKey(e.issue)}`;
              row.title = `${e.issue}${e.branch ? ` · ${e.branch}` : ""}`;
              const dot = { live: "var(--ok)", expired: "var(--danger)", absent: "var(--fg3)" }[e.leaseState];
              row.append(h("span", `flex:0 0 auto;color:${dot}`, e.leaseState === "live" ? "●" : e.leaseState === "expired" ? "◐" : "○"));
              row.append(h("span", "flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fg)", e.issue));
              row.append(h("span", "flex:0 0 auto;color:var(--fg3);font-size:11px", e.lease ? e.lease.owner : msg("unleased", "미점유")));
              row.append(h("span", "flex:0 0 auto;color:var(--fg2);font-size:11px", msg(`${e.receipts.length} rcpt`, `증적 ${e.receipts.length}`)));
              if (e.done) row.append(h("span", "flex:0 0 auto;color:var(--ok);font-size:11px", "done"));
              frag.append(row);
            }
            listEl.append(frag);
          }

          async function showDrift() {
            driftEl.replaceChildren();
            driftEl.style.display = "block";
            const out = await app.commands.execute("plugin.soksak-plugin-workflow.drift.check", {});
            if (!out.ok) {
              driftEl.append(h("div", "padding:4px 12px;color:var(--danger);font-size:11px", `${out.code}: ${out.message}`));
              return;
            }
            const drifts = out.data?.drifts ?? [];
            if (drifts.length === 0) {
              driftEl.append(h("div", "padding:4px 12px;color:var(--ok);font-size:11px", msg("No drift", "드리프트 없음")));
              return;
            }
            for (const d of drifts) {
              const row = h("div", "display:flex;gap:8px;padding:3px 12px;font-size:11px");
              row.dataset.node = `drift/${nodeKey(d.issue)}`;
              row.append(h("span", "flex:0 0 auto;color:var(--danger)", "⚠"));
              row.append(h("span", "flex:0 0 auto;color:var(--fg2)", d.issue));
              row.append(h("span", "flex:1 1 auto;color:var(--fg2)", `${d.field}: ${msg("claims", "주장")} ${d.claimed} — ${msg("actual", "실제")} ${d.actual}`));
              driftEl.append(row);
            }
          }

          refreshBtn.onclick = () => void render();
          driftBtn.onclick = () => void showDrift();
          void render();

          const sub = app.data.watch(COLL, { scope: SCOPE }, () => void render());
          cleanups.set(container, () => sub.dispose());
        },
        unmount(container) {
          cleanups.get(container)?.();
          cleanups.delete(container);
          container.replaceChildren();
        },
      }),
    );
  },

  deactivate() {},
};

export { index_default as default };
