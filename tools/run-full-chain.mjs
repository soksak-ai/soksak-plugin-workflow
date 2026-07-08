#!/usr/bin/env node
// run-full-chain — 독립(앱 0) 전 체인 러너. 파일-보드 위에서 reconcile 의 CLI 미러로
// verify→hunt→classify→audit 인증→research→design 체인→plan→파일별 body 까지, 전 판정 = 실 LLM oxf.
// 멱등: e2e/out/full-chain/board.json 이 단일 상태 — 재실행은 이어서 진행. 529 는 transient 텀 재시도,
// 결정적 실패는 즉시 중단(§2). 산출 스트림은 사이드카 run catalog 가 보존.
//
//   SOKSAK_CLAUDE_WRAPPER=ccglm zsh e2e/run-e2e.zsh full-chain   (권장 — 인증 캡처 경유)
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildLedger, validateDraftDoc } from "../main.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const BIN = join(ROOT, "target/release/soksak-sidecar-workflow");
const OUT = join(ROOT, "e2e/out/full-chain");
const BOARD = join(OUT, "board.json");
const RESEARCH_DOC = JSON.parse(readFileSync(join(ROOT, "workflows/research.doc.json"), "utf8"));
const DRAFT_DOC = JSON.parse(readFileSync(join(ROOT, "workflows/draft.doc.json"), "utf8"));
const DIRECTIVE = readFileSync(join(ROOT, "e2e/idea.txt"), "utf8").trim();
mkdirSync(join(OUT), { recursive: true });
process.env.SOKSAK_SIDECAR_WORKFLOW_RUNS = join(OUT, "runs");

const log = (...a) => console.log(new Date().toTimeString().slice(0, 8), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── doc values 조성(concat 접기 — doc_exec resolved_values 등가) ──
function docValues(doc) {
  const values = {};
  for (const [k, v] of Object.entries(doc.values || {})) if (!(v && typeof v === "object" && v.concat)) values[k] = v;
  for (const [k, v] of Object.entries(doc.values || {})) {
    if (v && typeof v === "object" && Array.isArray(v.concat)) {
      values[k] = v.concat.map((p) => (typeof p === "string" ? p : values[(p.$ || "").replace(/^values\./, "")] || "")).join("");
    }
  }
  return values;
}
const RV = docValues(RESEARCH_DOC);
const DV = docValues(DRAFT_DOC);

// ── 보드(파일) ──
function loadBoard() {
  if (existsSync(BOARD)) return JSON.parse(readFileSync(BOARD, "utf8"));
  return { phase: "init", nodes: [], chunk: { badge: null, result: null } };
}
function save(b) { writeFileSync(BOARD, JSON.stringify(b, null, 1)); }
const confirmed = (n) => n.badge === "o" || n.badge === "x" || n.badge === "f";

// ── 사이드카 호출(동기 spawn — 러너 자체가 순차) ──
function callSidecar(args, stdinObj) {
  for (let n = 0; ; n++) {
    const r = spawnSync(BIN, args, { input: JSON.stringify(stdinObj), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.status === 0) return r.stdout;
    const err = (r.stderr || "").slice(-400);
    if (!/529|overloaded|temporarily|wait longer|timeout/i.test(err)) {
      throw new Error(`결정적 실패: ${args[0]} — ${err}`);
    }
    if (n >= 8) throw new Error(`transient 8회 소진: ${args[0]}`);
    log(`transient — 5분 재시도(${n + 1}/8): ${args[0]}`);
    spawnSync("sleep", ["300"]);
  }
}

// ── 검증(exec-one) — kind→템플릿 매핑, vars 치환(런타임 resolve 계약 미러) ──
function verifyTemplate(node) {
  if (node.kind === "item") return DV.VERIFY_TMPL;
  if (node.kind === "plan-unit") return RV.PLAN_VERIFY_TMPL;
  if (node.kind === "code") return RV.BODY_VERIFY_TMPL;
  if (node.kind === "fact") {
    return ["interface", "domain-model", "criterion"].includes(node.category) ? RV.DESIGN_VERIFY_TMPL : RV.FACT_VERIFY_TMPL;
  }
  throw new Error(`검증 템플릿 미정의 kind: ${node.kind}`);
}
function verifyNode(node) {
  const vars = { ...(node.vars || {}), title: node.title || "", description: node.description || "", category: node.category || "", directive: DIRECTIVE };
  const prompt = verifyTemplate(node).replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] != null ? vars[k] : `{{${k}}}`));
  const leftover = prompt.match(/\{\{\w+\}\}/g);
  if (leftover) throw new Error(`미해석 플레이스홀더 ${leftover} (kind=${node.kind})`);
  const out = JSON.parse(callSidecar(["exec-one", "--lang", "ko", "--model", MODEL], { prompt, schema: RV.VERIFY_SCHEMA }));
  if (!["o", "x", "f"].includes(out.oxf)) throw new Error(`무판정(oxf=${out.oxf}) — ${node.title}`);
  node.badge = out.oxf;
  node.result = JSON.stringify(out.result ?? null);
  return out.oxf;
}
function verifyAllPending(b, kinds) {
  const pending = b.nodes.filter((n) => kinds.includes(n.kind) && !confirmed(n));
  for (let i = 0; i < pending.length; i++) {
    const n = pending[i];
    const oxf = verifyNode(n);
    save(b);
    log(`verify [${n.kind}] ${String(n.title).slice(0, 40)} → ${oxf} (${i + 1}/${pending.length})`);
  }
}

// ── 스테이지 실행(exec-stage) → add 이벤트를 보드 노드로 ──
function runStage(doc, stage, args) {
  const raw = callSidecar(["exec-stage", "--lang", "ko", "--model", MODEL], { skeleton: doc, stage, args });
  const lines = raw.split("\n").filter((l) => l.trim().startsWith("{"));
  const evs = lines.map((l) => JSON.parse(l));
  return { adds: evs.filter((e) => e.ev === "add"), result: (evs.find((e) => e.ev === "result") || {}).value };
}
function addNodes(b, adds, kinds) {
  let added = 0;
  for (const ev of adds) {
    if (!kinds.includes(ev.kind)) continue; // task 이벤트는 파일-보드에선 러너가 오케스트레이션 — 미기록
    b.nodes.push({ id: `${ev.kind}-${b.nodes.length}`, kind: ev.kind, title: ev.title, description: ev.description || "",
      category: ev.category || "", origin: ev.origin || "", badge: null, vars: ev.vars || undefined });
    added++;
  }
  save(b);
  return added;
}
const ledgerOf = (b, kind, onlyO = false) => buildLedger(b.nodes.map((n) => ({ ...n, parentId: "chunk" })).concat([{ id: "chunk", kind: "chunk" }]), "chunk", kind)
  .filter((e) => !onlyO || e.badge === "o"); // ground("verified facts")·구현 원장의 의미 = o 확정만(f=치명, x=반려 유지)

const MODEL = process.env.MODEL || "glm-5.2";

// ── 체인 ──
const b = loadBoard();
log(`시작 — phase=${b.phase}, nodes=${b.nodes.length}`);

if (b.phase === "init") {
  // 요건 60 — 동결 입력(stage.jsonl = generate 산출 DraftDoc) 재사용.
  const ddoc = JSON.parse(readFileSync(join(ROOT, "e2e/out/stage.jsonl"), "utf8"));
  const viol = validateDraftDoc(ddoc);
  if (viol.length) throw new Error(`DraftDoc 검증 실패: ${viol[0]}`);
  for (const r of ddoc.requirements) {
    b.nodes.push({ id: r.id, kind: "item", title: r.title, description: r.description, category: "", origin: r.origin, badge: null });
  }
  b.phase = "verify";
  save(b);
  log(`init — 요건 ${ddoc.requirements.length}개 적재`);
}

if (b.phase === "verify") { verifyAllPending(b, ["item"]); b.phase = "hunt"; save(b); }

if (b.phase === "hunt") {
  const { adds } = runStage(DRAFT_DOC, "hunt", { directive: DIRECTIVE, chunkRef: "chunk", ledger: ledgerOf(b, "item") });
  const n = addNodes(b, adds, ["item"]);
  log(`hunt — 추가 ${n}건`);
  verifyAllPending(b, ["item"]);
  b.phase = "classify"; save(b);
}

if (b.phase === "classify") {
  const ledger = ledgerOf(b, "item");
  const { result } = runStage(DRAFT_DOC, "classify", { directive: DIRECTIVE, chunkRef: "chunk", ledger });
  const as = result && Array.isArray(result.assignments) ? result.assignments : null;
  if (!as) throw new Error("classify 결과에 assignments 없음");
  const ids = new Set(ledger.map((e) => e.id)); const seen = new Set();
  for (const a of as) {
    if (!ids.has(a.id) || seen.has(a.id) || !a.category) throw new Error(`classify 배정 검증 실패: ${JSON.stringify(a)}`);
    seen.add(a.id);
  }
  for (const id of ids) if (!seen.has(id)) throw new Error(`classify 미배정: ${id}`);
  for (const a of as) { const n = b.nodes.find((x) => x.id === a.id); if (n) n.category = a.category; }
  b.chunk.dimension = result.dimension || "";
  b.phase = "audit"; save(b);
  log(`classify — ${as.length}건 전수 배정(차원: ${b.chunk.dimension})`);
}

while (b.phase === "audit") {
  const ledger = ledgerOf(b, "item");
  const { result } = runStage(DRAFT_DOC, "audit", { directive: DIRECTIVE, chunkRef: "chunk", ledger });
  if (!result || typeof result !== "object") throw new Error("audit 결과 없음");
  const f = ledger.filter((e) => e.badge === "f").length;
  const pass = result.complete === true && f === 0;
  b.chunk.result = result.verdict || "";
  b.auditRounds = (b.auditRounds || 0) + 1;
  log(`audit(라운드 ${b.auditRounds}) — complete=${result.complete}, f=${f}`);
  if (pass) { b.chunk.badge = "o"; b.phase = "research"; save(b); break; }
  // 부결 보정 루프 — 감사의 gaps 를 요건 후보로 기계 투입(변환 LLM 0), 기존 verify 가 분별(가짜=x),
  // 재감사. 상한 2회(수렴 강제 — §2 fail-loud: 상한 도달 시 폐기 확정). gaps 소비자 부재 공백의 해소.
  const gaps = Array.isArray(result.gaps) ? result.gaps.filter((g) => typeof g === "string" && g.trim()) : [];
  if (b.auditRounds >= 3 || gaps.length === 0) {
    b.chunk.badge = "f"; b.phase = "discarded"; save(b);
    log(`폐기 확정(라운드 ${b.auditRounds}, gaps ${gaps.length}): ${b.chunk.result.slice(0, 200)}`);
    process.exit(2);
  }
  log(`부결 — gaps ${gaps.length}건을 요건 후보로 투입(검증이 분별)`);
  for (const g of gaps) {
    b.nodes.push({ id: `gap-${b.nodes.length}`, kind: "item", title: g.slice(0, 80), description: g, category: "", origin: "agent", badge: null });
  }
  save(b);
  verifyAllPending(b, ["item"]);
  save(b); // 재감사(같은 phase 루프)
}

if (b.phase === "research") {
  const { adds } = runStage(RESEARCH_DOC, "research", { directive: DIRECTIVE, chunkRef: "chunk", ledger: ledgerOf(b, "item") });
  log(`research — fact ${addNodes(b, adds, ["fact"])}건`);
  verifyAllPending(b, ["fact"]);
  b.phase = "design-interface"; save(b);
}

for (const stage of ["design-interface", "design-domain", "design-criteria"]) {
  if (b.phase === stage) {
    const { adds } = runStage(RESEARCH_DOC, stage, { directive: DIRECTIVE, chunkRef: "chunk", ledger: ledgerOf(b, "item", true), facts: ledgerOf(b, "fact", true) });
    log(`${stage} — design fact ${addNodes(b, adds, ["fact"])}건`);
    verifyAllPending(b, ["fact"]); // 체인 계약: 다음 스테이지 전 확정
    b.phase = stage === "design-criteria" ? "plan" : (stage === "design-interface" ? "design-domain" : "design-criteria");
    save(b);
  }
}

while (b.phase === "plan") {
  const { adds } = runStage(RESEARCH_DOC, "plan", { directive: DIRECTIVE, chunkRef: "chunk", ledger: ledgerOf(b, "item", true), facts: ledgerOf(b, "fact", true) });
  log(`plan — 유닛 ${addNodes(b, adds, ["plan-unit"])}건`);
  verifyAllPending(b, ["plan-unit"]);
  // plan 산출 게이트(fail-loud): o 유닛 0 = 계획 실패 — 재시도 1회, 그래도면 명시 종료(완주 위장 금지).
  const oUnits = b.nodes.filter((n) => n.kind === "plan-unit" && n.badge === "o").length;
  b.planRounds = (b.planRounds || 0) + 1;
  if (oUnits === 0) {
    if (b.planRounds >= 2) { log("FAIL: plan 2회 모두 o 유닛 0 — 계획 실패"); save(b); process.exit(2); }
    log("plan 산출 부실(o 유닛 0) — 부실 유닛 제거 후 재시도");
    b.nodes = b.nodes.filter((n) => n.kind !== "plan-unit");
    save(b);
  } else {
    b.phase = "plan-audit"; save(b);
  }
}

while (b.phase === "plan-audit") {
  const units = b.nodes.filter((n) => n.kind === "plan-unit" && n.badge === "o");
  const ledger = units.map((u) => ({ id: u.id, title: `${u.title} — file: ${u.category}`, badge: "o" }));
  const { result } = runStage(RESEARCH_DOC, "plan-audit", { directive: DIRECTIVE, chunkRef: "chunk", ledger });
  if (!result || typeof result !== "object") throw new Error("plan-audit 결과 없음");
  b.planAuditRounds = (b.planAuditRounds || 0) + 1;
  log(`plan-audit(라운드 ${b.planAuditRounds}) — complete=${result.complete} | ${String(result.verdict || "").slice(0, 150)}`);
  if (result.complete === true) { b.phase = "body"; save(b); break; }
  const gaps = Array.isArray(result.gaps) ? result.gaps.filter((g) => typeof g === "string" && g.trim()) : [];
  if (b.planAuditRounds >= 3 || gaps.length === 0) { log("FAIL: plan-audit 수렴 실패"); save(b); process.exit(2); }
  log(`부결 — 누락 표면 ${gaps.length}건을 plan-patch(증분 저작)에 위임`);
  // gap 산문은 슈도코드가 아니다(실측: 기계 투입 유닛이 ONE FILE·자족성 위반 f) — 저작은 LLM 몫(§11).
  const { adds } = runStage(RESEARCH_DOC, "plan-patch", { directive: DIRECTIVE, chunkRef: "chunk",
    gaps: gaps.map((g) => `- ${g}`).join("\n"),
    ledger: b.nodes.filter((n) => n.kind === "plan-unit" && n.badge === "o").map((u) => ({ id: u.id, title: `${u.title} — file: ${u.category}`, badge: "o" })) });
  log(`plan-patch — 유닛 ${addNodes(b, adds, ["plan-unit"])}건`);
  verifyAllPending(b, ["plan-unit"]);
  save(b);
}

if (b.phase === "body") {
  const units = b.nodes.filter((n) => n.kind === "plan-unit" && n.badge === "o");
  const done = new Set(b.nodes.filter((n) => n.kind === "code").map((n) => n.category));
  for (const u of units) {
    if (done.has(u.category)) continue; // 멱등 — 같은 파일 code 존재 시 스킵
    const { adds } = runStage(RESEARCH_DOC, "body", { directive: DIRECTIVE, chunkRef: "chunk",
      title: u.title, file_path: u.category, pseudocode: u.description });
    addNodes(b, adds, ["code"]);
    log(`body — ${u.category}`);
    verifyAllPending(b, ["code"]);
  }
  b.phase = "done"; save(b);
}

if (b.phase === "done") {
  const stat = {};
  for (const n of b.nodes) {
    const k = `${n.kind}:${n.badge}`;
    stat[k] = (stat[k] || 0) + 1;
  }
  const pending = b.nodes.filter((n) => !confirmed(n)).length;
  const oUnits = b.nodes.filter((n) => n.kind === "plan-unit" && n.badge === "o").length;
  const oCodes = b.nodes.filter((n) => n.kind === "code" && n.badge === "o").length;
  const complete = pending === 0 && b.chunk.badge === "o" && oUnits > 0 && oCodes > 0;
  log(`═══ ${complete ? "완주" : "미완(완주 위장 금지)"} — chunk=${b.chunk.badge} | 미확정 ${pending} | o유닛 ${oUnits} | o코드 ${oCodes} | ${JSON.stringify(stat)}`);
  process.exit(complete ? 0 : 2);
}
