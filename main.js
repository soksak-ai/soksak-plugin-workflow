// js/gate.js
var LEASE_STALE = "LEASE_STALE";
var LEASE_HELD = "LEASE_HELD";
var EVIDENCE_REQUIRED = "EVIDENCE_REQUIRED";
var refuse = (code, detail, message) => ({ ok: false, code, detail, message });
var pass = () => ({ ok: true });
function leaseState(lease, nowMs) {
  if (!lease || typeof lease.expiresAt !== "number") return "absent";
  return lease.expiresAt <= nowMs ? "expired" : "live";
}
function checkDispatch(lease, owner, nowMs) {
  switch (leaseState(lease, nowMs)) {
    case "absent":
      return refuse(LEASE_STALE, { kind: "absent" }, "no lease \u2014 acquire one before dispatch");
    case "expired":
      return refuse(
        LEASE_STALE,
        { kind: "expired", owner: lease.owner, expiresAt: lease.expiresAt },
        `lease expired at ${lease.expiresAt} (was held by ${lease.owner})`
      );
    default:
      return lease.owner === owner ? pass() : refuse(
        LEASE_HELD,
        { kind: "held", owner: lease.owner, expiresAt: lease.expiresAt },
        `issue is leased by ${lease.owner} until ${lease.expiresAt}`
      );
  }
}
function checkRenew(lease, owner, nowMs) {
  switch (leaseState(lease, nowMs)) {
    case "absent":
      return refuse(LEASE_STALE, { kind: "absent" }, "no lease to renew");
    case "expired":
      return refuse(
        LEASE_STALE,
        { kind: "expired", owner: lease.owner, expiresAt: lease.expiresAt },
        `lease expired at ${lease.expiresAt} \u2014 acquire a new one`
      );
    default:
      return lease.owner === owner ? pass() : refuse(LEASE_HELD, { kind: "held", owner: lease.owner, expiresAt: lease.expiresAt }, `lease is held by ${lease.owner}`);
  }
}
function isSha(s) {
  return typeof s === "string" && s.length >= 7 && s.length <= 40 && /^[0-9a-fA-F]+$/.test(s);
}
function receiptVerifiable(r) {
  if (!r) return false;
  if (r.kind === "commit") return isSha(r.value);
  if (r.kind === "test") return typeof r.value === "string" && r.value.trim() !== "" && typeof r.passed === "boolean";
  return false;
}
function checkEvidence(receipts) {
  const verifiable = (receipts || []).filter(receiptVerifiable);
  if (verifiable.length === 0) {
    return refuse(EVIDENCE_REQUIRED, { kind: "none" }, "no verifiable receipt \u2014 a commit sha or a test result is required");
  }
  const failed = verifiable.find((r) => r.kind === "test" && r.passed === false);
  if (failed) return refuse(EVIDENCE_REQUIRED, { kind: "failed", value: failed.value }, `a test receipt failed: ${failed.value}`);
  return pass();
}
function detectDrift(claim, actual) {
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
      out.push({ field: "commit", claimed: sha, actual: "absent" });
    }
  }
  if (c.done && commits.length === 0) {
    out.push({ field: "done", claimed: "done", actual: "no commit receipt" });
  }
  if (c.done && c.branch && a.branchExists && a.branchMerged === false) {
    out.push({ field: "merged", claimed: "done", actual: `${c.branch} is not merged into base` });
  }
  if (c.leaseLive && c.branch && a.worktreeExists === false) {
    out.push({ field: "worktree", claimed: "leased (work in progress)", actual: "worktree reclaimed" });
  }
  return out;
}

// js/git.js
var ENV = Object.freeze({ LC_ALL: "C", LANG: "C", GIT_OPTIONAL_LOCKS: "0" });
var TIMEOUT_MS = 3e4;
function makeGit(processApi) {
  function run(cwd, args) {
    return new Promise((resolve, reject) => {
      const dec = new TextDecoder();
      let out = "";
      let err = "";
      let done = false;
      let timer = null;
      processApi.spawn("git", args, { cwd, env: { ...ENV } }).then((handle) => {
        const subs = [];
        const finish = (fn, v) => {
          if (done) return;
          done = true;
          if (timer) clearTimeout(timer);
          for (const s of subs) s.dispose();
          fn(v);
        };
        timer = setTimeout(() => {
          void processApi.kill(handle);
          finish(reject, new Error(`git ${args[0] ?? ""} timeout`));
        }, TIMEOUT_MS);
        subs.push(
          processApi.onData(handle, (b) => out += dec.decode(b, { stream: true })),
          processApi.onStderr(handle, (b) => err += new TextDecoder().decode(b)),
          processApi.onExit(handle, (code) => finish(resolve, { code, stdout: out, stderr: err.trim() }))
        );
      }).catch((e) => {
        if (!done) {
          done = true;
          if (timer) clearTimeout(timer);
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
    });
  }
  return {
    run,
    async root(cwd) {
      const r = await run(cwd, ["rev-parse", "--show-toplevel"]);
      return r.code === 0 ? r.stdout.trim() : null;
    },
    // What the repository actually shows about a claim. Every fact is observed, never assumed.
    async probe({ repoRoot, branch, commits = [], base = "main" }) {
      const branchExists = branch ? (await run(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0 : false;
      const commitsPresent = [];
      for (const sha of commits) {
        if ((await run(repoRoot, ["cat-file", "-e", `${sha}^{commit}`])).code === 0) commitsPresent.push(sha);
      }
      let branchMerged = true;
      if (branch && branchExists) {
        branchMerged = (await run(repoRoot, ["merge-base", "--is-ancestor", branch, base])).code === 0;
      }
      const wl = await run(repoRoot, ["worktree", "list", "--porcelain"]);
      const worktreeExists = branch ? wl.stdout.includes(`branch refs/heads/${branch}`) : false;
      return { branchExists, commitsPresent, branchMerged, worktreeExists };
    }
  };
}

// js/index.js
var COLL = "entry";
var SCOPE = "index";
var DEFAULT_TTL_MS = 30 * 60 * 1e3;
function h(tag, style, text) {
  const el = document.createElement(tag);
  if (style) el.style.cssText = style;
  if (text !== void 0) el.textContent = text;
  return el;
}
function nodeKey(id) {
  const k = String(id).toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  return /^[a-z0-9]/.test(k) ? k : `i-${k}`;
}
var index_default = {
  activate(ctx) {
    const app = ctx.app;
    const err = (code, message) => ({ ok: false, code, message });
    const msg = (en, ko) => (typeof app.locale === "function" ? app.locale() : "en") === "ko" ? ko : en;
    const refusal = (v) => {
      const d = v.detail || {};
      switch (d.kind) {
        case "absent":
          return err(v.code, msg("no lease \u2014 acquire one before dispatch", "\uB9AC\uC2A4 \uC5C6\uC74C \u2014 \uB514\uC2A4\uD328\uCE58 \uC804\uC5D0 \uCDE8\uB4DD\uD558\uB77C"));
        case "expired":
          return err(v.code, msg(`lease expired at ${d.expiresAt} (was held by ${d.owner})`, `\uB9AC\uC2A4 \uB9CC\uB8CC(${d.owner} \uBCF4\uC720\uBD84) \u2014 \uC0C8\uB85C \uCDE8\uB4DD\uD558\uB77C`));
        case "held":
          return err(v.code, msg(`issue is leased by ${d.owner}`, `${d.owner} \uAC00 \uC810\uC720 \uC911`));
        case "none":
          return err(v.code, msg("no verifiable receipt \u2014 a commit sha or a test result is required", "\uAC80\uC99D \uAC00\uB2A5\uD55C \uC99D\uC801 \uC5C6\uC74C \u2014 \uCEE4\uBC0B sha \uB610\uB294 \uD14C\uC2A4\uD2B8 \uACB0\uACFC \uD544\uC694"));
        case "failed":
          return err(v.code, msg(`a test receipt failed: ${d.value}`, `\uD14C\uC2A4\uD2B8 \uC99D\uC801 \uC2E4\uD328: ${d.value}`));
        default:
          return err(v.code, v.message);
      }
    };
    const reg = (name, spec) => ctx.subscriptions.push(app.commands.register(name, spec));
    const git = makeGit(app.process);
    const now = () => Date.now();
    void app.data.define(COLL, { indexes: ["issue", "owner", "done", "updatedAt"] });
    const load = async (issue) => await app.data.get(COLL, String(issue), { scope: SCOPE }) || null;
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
    const view = (e) => ({
      issue: e.issue,
      lease: e.lease,
      leaseState: leaseState(e.lease, now()),
      branch: e.branch ?? null,
      receipts: e.receipts || [],
      done: !!e.done
    });
    const repoPath = (p) => (typeof p.path === "string" && p.path ? p.path : void 0) ?? app.project?.current?.()?.root ?? void 0;
    reg("entry.add", {
      description: "Put an issue on the ledger, unleased and unreceipted. This is where an issue enters the loop: it exists, nobody holds it, and it carries no evidence \u2014 so a dispatch of it refuses LEASE_STALE and a completion of it refuses EVIDENCE_REQUIRED until someone earns both. Idempotent \u2014 re-adding an issue already on the ledger returns it untouched.",
      triggers: { ko: "\uC774\uC288 \uC6D0\uC7A5 \uB4F1\uB85D \uC0DD\uC131" },
      params: {
        issue: { type: "string", description: "Issue id", required: true },
        branch: { type: "string", description: "Branch the work is expected on (recorded for drift)" }
      },
      returns: "{ issue, lease:null, leaseState:'absent', branch, receipts:[], done:false }",
      examples: [`sok plugin.soksak-plugin-workflow.entry.add '{"issue":"i-42","branch":"feat/x"}'`],
      message: (d) => msg(`${d.issue} is on the ledger`, `${d.issue} \uC6D0\uC7A5 \uB4F1\uB85D`),
      handler: async (p) => {
        const issue = String(p.issue ?? "").trim();
        if (!issue) return err("INVALID_PARAMS", msg("issue is required", "issue \uD544\uC694"));
        const existing = await load(issue);
        if (existing) return view(existing);
        const e = blank(issue);
        if (typeof p.branch === "string" && p.branch) e.branch = p.branch;
        return view(await save(e));
      }
    });
    reg("lease.acquire", {
      description: "Take the dispatch lease on an issue: an owner and an expiry. A live lease held by someone else refuses (LEASE_HELD) \u2014 two agents on one issue is the accident this prevents. An absent or expired lease is free to take. Idempotent for the same owner (re-acquiring extends).",
      triggers: { ko: "\uC774\uC288 \uB9AC\uC2A4 \uCDE8\uB4DD \uC810\uC720 \uC18C\uC720" },
      params: {
        issue: { type: "string", description: "Issue id to lease", required: true },
        owner: { type: "string", description: "Who takes it (agent/person id)", required: true },
        branch: { type: "string", description: "Branch the work happens on (recorded for drift)" },
        ttlMs: { type: "number", description: `Lease lifetime in ms (default ${DEFAULT_TTL_MS})` }
      },
      returns: "{ issue, lease:{owner,expiresAt}, leaseState, branch, receipts, done }",
      examples: [`sok plugin.soksak-plugin-workflow.lease.acquire '{"issue":"i-42","owner":"agent-1","branch":"feat/x"}'`],
      message: (d) => msg(`${d.owner ?? d.lease?.owner} holds ${d.issue}`, `${d.lease?.owner} \uAC00 ${d.issue} \uC810\uC720`),
      handler: async (p) => {
        const issue = String(p.issue ?? "").trim();
        const owner = String(p.owner ?? "").trim();
        if (!issue || !owner) return err("INVALID_PARAMS", msg("issue and owner are required", "issue\xB7owner \uD544\uC694"));
        const e = await load(issue) || blank(issue);
        if (leaseState(e.lease, now()) === "live" && e.lease.owner !== owner) {
          return err("LEASE_HELD", msg(`issue is leased by ${e.lease.owner} until ${e.lease.expiresAt}`, `${e.lease.owner} \uAC00 \uC810\uC720 \uC911`));
        }
        const ttl = Number(p.ttlMs) > 0 ? Number(p.ttlMs) : DEFAULT_TTL_MS;
        e.lease = { owner, expiresAt: now() + ttl };
        if (typeof p.branch === "string" && p.branch) e.branch = p.branch;
        return view(await save(e));
      }
    });
    reg("lease.renew", {
      description: "Extend a lease you still hold. Only the owner may renew, and only while the lease is still live \u2014 reviving an expired lease would let a forgotten agent silently reclaim an issue someone else may already hold (LEASE_STALE).",
      triggers: { ko: "\uB9AC\uC2A4 \uAC31\uC2E0 \uC5F0\uC7A5" },
      params: {
        issue: { type: "string", description: "Issue id", required: true },
        owner: { type: "string", description: "The current owner", required: true },
        ttlMs: { type: "number", description: `Additional lifetime in ms (default ${DEFAULT_TTL_MS})` }
      },
      returns: "{ issue, lease, leaseState, ... }",
      examples: [`sok plugin.soksak-plugin-workflow.lease.renew '{"issue":"i-42","owner":"agent-1"}'`],
      message: (d) => msg(`renewed ${d.issue}`, `${d.issue} \uB9AC\uC2A4 \uAC31\uC2E0`),
      handler: async (p) => {
        const e = await load(p.issue);
        const v = checkRenew(e?.lease, String(p.owner ?? ""), now());
        if (!v.ok) return refusal(v);
        const ttl = Number(p.ttlMs) > 0 ? Number(p.ttlMs) : DEFAULT_TTL_MS;
        e.lease = { owner: e.lease.owner, expiresAt: now() + ttl };
        return view(await save(e));
      }
    });
    reg("lease.release", {
      description: "Give up a lease you hold. Only the owner may release it. Idempotent \u2014 releasing an absent lease is a no-op.",
      triggers: { ko: "\uB9AC\uC2A4 \uD574\uC81C \uBC18\uB0A9" },
      params: {
        issue: { type: "string", description: "Issue id", required: true },
        owner: { type: "string", description: "The current owner", required: true }
      },
      returns: "{ issue, lease:null, leaseState, ... }",
      examples: [`sok plugin.soksak-plugin-workflow.lease.release '{"issue":"i-42","owner":"agent-1"}'`],
      message: (d) => msg(`released ${d.issue}`, `${d.issue} \uB9AC\uC2A4 \uD574\uC81C`),
      handler: async (p) => {
        const owner = String(p.owner ?? "");
        const e = await load(p.issue);
        if (!e || !e.lease) return view(e || blank(p.issue));
        if (leaseState(e.lease, now()) === "live" && e.lease.owner !== owner) {
          return err("LEASE_HELD", msg(`lease is held by ${e.lease.owner}`, `${e.lease.owner} \uAC00 \uC810\uC720 \uC911`));
        }
        e.lease = null;
        return view(await save(e));
      }
    });
    reg("lease.list", {
      description: "List every ledger entry with its computed lease state (live/expired/absent), branch, receipts, and done flag \u2014 the same rows the Ledger view shows.",
      triggers: { ko: "\uC6D0\uC7A5 \uBAA9\uB85D \uB9AC\uC2A4 \uC0C1\uD0DC \uC870\uD68C" },
      params: {},
      returns: "{ entries: [{issue, lease, leaseState, branch, receipts, done}] }",
      examples: ["sok plugin.soksak-plugin-workflow.lease.list"],
      message: (d) => msg(`${(d.entries ?? []).length} entries`, `\uC6D0\uC7A5 ${(d.entries ?? []).length}\uAC74`),
      handler: async () => ({ entries: (await all()).map(view) })
    });
    reg("receipt.add", {
      description: "Record evidence against an issue: a commit (a hex sha) or a test (the command plus its verdict). An unverifiable receipt is refused at the door (INVALID_RECEIPT) \u2014 a claim wearing a receipt's clothes must never become the thing that opens a gate.",
      triggers: { ko: "\uC99D\uC801 \uC601\uC218\uC99D \uCD94\uAC00 \uCEE4\uBC0B \uD14C\uC2A4\uD2B8" },
      params: {
        issue: { type: "string", description: "Issue id", required: true },
        kind: { type: "string", description: "commit | test", required: true },
        value: { type: "string", description: "commit \u2192 the hex sha; test \u2192 the command that ran", required: true },
        passed: { type: "boolean", description: "test \u2192 the verdict (required for kind=test)" }
      },
      returns: "{ issue, receipts, ... }",
      examples: [
        `sok plugin.soksak-plugin-workflow.receipt.add '{"issue":"i-42","kind":"commit","value":"0dc2d14"}'`,
        `sok plugin.soksak-plugin-workflow.receipt.add '{"issue":"i-42","kind":"test","value":"cargo test","passed":true}'`
      ],
      message: (d) => msg(`${(d.receipts ?? []).length} receipt(s) on ${d.issue}`, `${d.issue} \uC99D\uC801 ${(d.receipts ?? []).length}\uAC74`),
      handler: async (p) => {
        const issue = String(p.issue ?? "").trim();
        if (!issue) return err("INVALID_PARAMS", msg("issue is required", "issue \uD544\uC694"));
        const r = { kind: p.kind, value: p.value, ...typeof p.passed === "boolean" ? { passed: p.passed } : {}, at: now() };
        if (!receiptVerifiable(r)) {
          return err("INVALID_RECEIPT", msg("not verifiable \u2014 a commit needs a sha, a test needs its verdict", "\uAC80\uC99D \uBD88\uAC00 \u2014 commit \uC740 sha, test \uB294 \uD310\uC815 \uD544\uC694"));
        }
        const e = await load(issue) || blank(issue);
        e.receipts = [...e.receipts || [], r];
        return view(await save(e));
      }
    });
    reg("entry.remove", {
      description: "Drop a ledger entry and everything recorded on it \u2014 the lease, the receipts, the branch. Refuses while someone still holds a live lease (LEASE_HELD): dropping an entry out from under a working agent would erase the record that agent is about to be judged on. Release it first.",
      triggers: { ko: "\uC6D0\uC7A5 \uD56D\uBAA9 \uC0AD\uC81C \uC81C\uAC70" },
      params: {
        issue: { type: "string", description: "Issue id to drop", required: true },
        owner: { type: "string", description: "Required to drop an entry whose lease is still live" }
      },
      returns: "{ issue, removed: true }",
      examples: [`sok plugin.soksak-plugin-workflow.entry.remove '{"issue":"i-42"}'`],
      message: (d) => msg(`dropped ${d.issue}`, `${d.issue} \uC0AD\uC81C`),
      handler: async (p) => {
        const issue = String(p.issue ?? "").trim();
        if (!issue) return err("INVALID_PARAMS", msg("issue is required", "issue \uD544\uC694"));
        const e = await load(issue);
        if (!e) return { issue, removed: false };
        if (leaseState(e.lease, now()) === "live" && e.lease.owner !== String(p.owner ?? "")) {
          return err("LEASE_HELD", msg(`issue is leased by ${e.lease.owner} \u2014 release it first`, `${e.lease.owner} \uAC00 \uC810\uC720 \uC911 \u2014 \uBA3C\uC800 \uD574\uC81C`));
        }
        await app.data.delete(COLL, issue, { scope: SCOPE });
        return { issue, removed: true };
      }
    });
    reg("gate.dispatch", {
      description: "The gate the loop must pass before dispatching an issue: the caller must be the owner of a live lease. No lease or an expired one refuses LEASE_STALE; someone else's live lease refuses LEASE_HELD. There is no warn-and-continue.",
      triggers: { ko: "\uB514\uC2A4\uD328\uCE58 \uAC8C\uC774\uD2B8 \uAC80\uC0AC \uB9AC\uC2A4" },
      params: {
        issue: { type: "string", description: "Issue id about to be dispatched", required: true },
        owner: { type: "string", description: "Who wants to dispatch it", required: true }
      },
      returns: "{ passed: true } or a refusal { ok:false, code: LEASE_STALE|LEASE_HELD }",
      examples: [`sok plugin.soksak-plugin-workflow.gate.dispatch '{"issue":"i-42","owner":"agent-1"}'`],
      message: () => msg("dispatch allowed", "\uB514\uC2A4\uD328\uCE58 \uD5C8\uC6A9"),
      handler: async (p) => {
        const e = await load(p.issue);
        const v = checkDispatch(e?.lease, String(p.owner ?? ""), now());
        return v.ok ? { passed: true, issue: String(p.issue) } : refusal(v);
      }
    });
    reg("gate.transition", {
      description: "Carry an issue to done \u2014 and the only way to get there. The issue must hold at least one verifiable receipt, and a failing test receipt refuses (EVIDENCE_REQUIRED): a failing test is evidence against the transition, not for it. done is written by this handler alone, so an issue cannot be finished on a claim; the receipt is checked in the same breath that marks it.",
      triggers: { ko: "\uC644\uB8CC \uC804\uC774 \uAC8C\uC774\uD2B8 \uC99D\uC801 \uAC80\uC0AC" },
      params: { issue: { type: "string", description: "Issue id to carry to done", required: true } },
      returns: "{ passed: true, done: true } or a refusal { ok:false, code: EVIDENCE_REQUIRED }",
      examples: [`sok plugin.soksak-plugin-workflow.gate.transition '{"issue":"i-42"}'`],
      message: (d) => msg(`${d.issue} is done`, `${d.issue} \uC644\uB8CC`),
      handler: async (p) => {
        const issue = String(p.issue ?? "").trim();
        const e = await load(issue);
        const v = checkEvidence(e?.receipts || []);
        if (!v.ok) return refusal(v);
        e.done = true;
        await save(e);
        return { passed: true, done: true, issue };
      }
    });
    reg("drift.check", {
      description: "Compare what the ledger records against what the repository actually shows: a branch it never had, a receipt naming a commit that does not exist (a fabricated receipt), a done with no commit, a done whose branch was never merged, a lease still held on a worktree already reclaimed. Reported loud and never repaired \u2014 a ledger that quietly rewrites itself to match reality can never catch reality lying. Checks one issue, or every entry when issue is omitted.",
      triggers: { ko: "\uB4DC\uB9AC\uD504\uD2B8 \uAC80\uCD9C \uC6D0\uC7A5 \uC2E4\uC81C \uB300\uC870 \uC5B4\uAE0B\uB0A8" },
      params: {
        issue: { type: "string", description: "Issue id (omit = check every entry)" },
        path: { type: "string", description: "Repository directory (defaults to the active project root)" },
        base: { type: "string", description: "Base branch a done issue must be merged into (default main)" }
      },
      returns: "{ checked, drifted, drifts: [{issue, field, claimed, actual}] }",
      examples: ["sok plugin.soksak-plugin-workflow.drift.check", `sok plugin.soksak-plugin-workflow.drift.check '{"issue":"i-42"}'`],
      message: (d) => (d.drifts ?? []).length === 0 ? msg(`no drift across ${d.checked} entries`, `\uB4DC\uB9AC\uD504\uD2B8 \uC5C6\uC74C(${d.checked}\uAC74 \uAC80\uC0AC)`) : msg(`${d.drifts.length} drift(s) across ${d.checked} entries`, `\uB4DC\uB9AC\uD504\uD2B8 ${d.drifts.length}\uAC74`),
      handler: async (p) => {
        const cwd = repoPath(p);
        if (!cwd) return err("NO_PATH", msg("no repository path \u2014 pass path or open a project", "\uC800\uC7A5\uC18C \uACBD\uB85C \uC5C6\uC74C"));
        const root = await git.root(cwd);
        if (!root) return err("NOT_REPO", msg("not a git repository", "git \uC800\uC7A5\uC18C\uAC00 \uC544\uB2D9\uB2C8\uB2E4"));
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
      }
    });
    const cleanups = /* @__PURE__ */ new Map();
    ctx.subscriptions.push(
      app.ui.registerView("ledger", {
        mount(container, vctx) {
          const report = (code, message) => vctx.setStatus?.(code ? { code, message } : null);
          container.replaceChildren();
          const wrap = h("div", "display:flex;flex-direction:column;height:100%;min-height:0;font-size:12px;color:var(--fg);background:var(--bg)");
          const bar = h("div", "display:flex;align-items:center;justify-content:space-between;gap:10px;padding:4px 10px;border-bottom:1px solid var(--bd);flex:0 0 auto;min-height:28px;box-sizing:border-box");
          const title = h("span", "color:var(--fg2)", msg("Ledger", "\uC6D0\uC7A5"));
          const right = h("div", "display:flex;align-items:center;gap:6px");
          const driftBtn = h("button", "cursor:pointer;border:1px solid var(--bd);background:var(--inset);color:var(--fg2);border-radius:4px;padding:2px 8px;font-size:11px");
          driftBtn.textContent = msg("Check drift", "\uB4DC\uB9AC\uD504\uD2B8");
          driftBtn.dataset.node = "check";
          const refreshBtn = h("button", "display:inline-flex;align-items:center;justify-content:center;width:24px;height:22px;padding:0;cursor:pointer;border:1px solid var(--bd);background:var(--inset);color:var(--fg2);border-radius:4px");
          refreshBtn.textContent = "\u27F3";
          refreshBtn.title = msg("Refresh", "\uC0C8\uB85C\uACE0\uCE68");
          refreshBtn.dataset.node = "refresh";
          right.append(driftBtn, refreshBtn);
          bar.append(title, right);
          const listEl = h("div", "flex:1 1 auto;min-height:0;overflow:auto;padding:5px 0");
          const driftEl = h("div", "flex:0 0 auto;max-height:35%;overflow:auto;border-top:1px solid var(--bd);padding:4px 0;display:none");
          wrap.append(bar, listEl, driftEl);
          container.append(wrap);
          async function render() {
            listEl.replaceChildren();
            report("loading", msg("Loading\u2026", "\uBD88\uB7EC\uC624\uB294 \uC911\u2026"));
            const entries = (await all()).map(view);
            if (entries.length === 0) {
              listEl.append(h("div", "padding:6px 12px;color:var(--fg3)", msg("No issues in the ledger", "\uC6D0\uC7A5\uC5D0 \uC774\uC288 \uC5C6\uC74C")));
              report("empty", msg("No issues", "\uC774\uC288 \uC5C6\uC74C"));
              return;
            }
            const held = entries.filter((e) => e.leaseState === "live").length;
            report("active", msg(`${entries.length} issues, ${held} leased`, `\uC774\uC288 ${entries.length} \xB7 \uC810\uC720 ${held}`));
            const frag = document.createDocumentFragment();
            for (const e of entries) {
              const row = h("div", "display:flex;align-items:center;gap:8px;padding:4px 12px");
              row.dataset.node = `entry/${nodeKey(e.issue)}`;
              row.title = `${e.issue}${e.branch ? ` \xB7 ${e.branch}` : ""}`;
              const dot = { live: "var(--ok)", expired: "var(--danger)", absent: "var(--fg3)" }[e.leaseState];
              row.append(h("span", `flex:0 0 auto;color:${dot}`, e.leaseState === "live" ? "\u25CF" : e.leaseState === "expired" ? "\u25D0" : "\u25CB"));
              row.append(h("span", "flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fg)", e.issue));
              row.append(h("span", "flex:0 0 auto;color:var(--fg3);font-size:11px", e.lease ? e.lease.owner : msg("unleased", "\uBBF8\uC810\uC720")));
              row.append(h("span", "flex:0 0 auto;color:var(--fg2);font-size:11px", msg(`${e.receipts.length} rcpt`, `\uC99D\uC801 ${e.receipts.length}`)));
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
              driftEl.append(h("div", "padding:4px 12px;color:var(--ok);font-size:11px", msg("No drift", "\uB4DC\uB9AC\uD504\uD2B8 \uC5C6\uC74C")));
              return;
            }
            for (const d of drifts) {
              const row = h("div", "display:flex;gap:8px;padding:3px 12px;font-size:11px");
              row.dataset.node = `drift/${nodeKey(d.issue)}`;
              row.append(h("span", "flex:0 0 auto;color:var(--danger)", "\u26A0"));
              row.append(h("span", "flex:0 0 auto;color:var(--fg2)", d.issue));
              row.append(h("span", "flex:1 1 auto;color:var(--fg2)", `${d.field}: ${msg("claims", "\uC8FC\uC7A5")} ${d.claimed} \u2014 ${msg("actual", "\uC2E4\uC81C")} ${d.actual}`));
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
        }
      })
    );
  },
  deactivate() {
  }
};
export {
  index_default as default
};
