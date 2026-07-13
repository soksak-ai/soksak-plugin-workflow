#!/usr/bin/env node
// full-chain — draft(generate→hunt→classify→audit) → plan(research→research-audit 수렴루프→design→plan) 전
// 체인을 exec-stage 하네스로 잇는다(앱 reconcile 없이 CLI 단). 각 스테이지 산출을 out/full-chain/<n>.jsonl 로
// 저장하고, 요건/사실/유닛 수와 수렴·발행을 로그한다. 검증(일치/중복/정확)은 산출을 별도 스크립트로 검사.
//
// 사용: node tools/full-chain.mjs [idea.txt] [model]
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(HERE, "target/release/soksak-sidecar-workflow");
const IDEA_FILE = process.argv[2] || join(HERE, "e2e/idea.txt");
const MODEL = process.argv[3] || "glm-5.2";
const LANG = "ko";
const OUT = join(HERE, "e2e/out/full-chain");
mkdirSync(OUT, { recursive: true });
const directive = readFileSync(IDEA_FILE, "utf8").trim();

const ts = () => new Date().toISOString().slice(11, 19);
const log = (m) => console.log(`[fc ${ts()}] ${m}`);

// exec-stage 한 번 실행 → 산출 텍스트(저장) 반환.
function execStage(input, outName) {
  const res = execFileSync(BIN, ["exec-stage", "--lang", LANG, "--model", MODEL], {
    input: JSON.stringify(input),
    maxBuffer: 128 * 1024 * 1024,
    timeout: 25 * 60 * 1000,
  });
  writeFileSync(join(OUT, outName), res);
  return res.toString();
}

// 이벤트 jsonl → 특정 kind 노드. (research/design/plan/hunt 산출은 {ev:"add",kind,...} 라인)
function nodes(text, kind) {
  const out = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let o;
    try { o = JSON.parse(t); } catch { continue; }
    if (o.ev === "add" && (!kind || o.kind === kind)) out.push(o);
  }
  return out;
}
const factsLedger = (text) => nodes(text, "fact").map((f) => ({ id: f.id, title: f.title, description: f.description, badge: "o", category: f.category }));

// ── DRAFT: generate(LLM 저작 skeleton) → generate stage(DraftDoc) → hunt → classify → audit ──
log(`START — idea: ${directive.slice(0, 40)}… | model ${MODEL}`);

log("① generate-skeleton (LLM 저작)");
const docJson = execFileSync(BIN, ["generate-skeleton", "--idea", directive, "--model", MODEL, "--lang", LANG, "--gen-out", join(OUT, "authored.txt")], { maxBuffer: 64 * 1024 * 1024, timeout: 25 * 60 * 1000 }).toString();
writeFileSync(join(OUT, "doc.json"), docJson);
const draftDoc = JSON.parse(docJson);

log("② generate stage → DraftDoc(요건)");
const genOut = execStage({ skeleton: draftDoc, stage: "generate", args: { directive } }, "01-generate.jsonl");
const draftChunk = JSON.parse(genOut);
let requirements = (draftChunk.requirements || []).map((r) => ({ id: r.id, title: r.title, badge: "o" }));
log(`   요건 ${requirements.length}개`);

log("③ hunt stage (누락 탐색 루프)");
const huntOut = execStage({ skeleton: draftDoc, stage: "hunt", args: { directive, ledger: requirements, chunkRef: "chunk" } }, "02-hunt.jsonl");
const huntAdds = nodes(huntOut, "item");
log(`   hunt 추가 요건 ${huntAdds.length}개`);
requirements = requirements.concat(huntAdds.map((a) => ({ id: a.id, title: a.title, badge: "o" })));

log("④ classify stage");
execStage({ skeleton: draftDoc, stage: "classify", args: { directive, ledger: requirements, chunkRef: "chunk" } }, "03-classify.jsonl");

log("⑤ audit stage (완결 인증)");
const auditOut = execStage({ skeleton: draftDoc, stage: "audit", args: { directive, ledger: requirements, chunkRef: "chunk" } }, "04-audit.jsonl");
log(`   audit 산출 ${auditOut.length}B`);

// ── PLAN: research → research-audit 수렴루프 → design(if/dom/crit) → plan ──
log("⑥ research stage");
const researchOut = execStage({ workflow: "research", stage: "research", args: { directive, ledger: requirements, chunkRef: "chunk" } }, "05-research.jsonl");
let facts = factsLedger(researchOut);
log(`   research fact ${facts.length}개`);

// research-audit 수렴 루프 — 이견(add·remove) 있으면 다음 자유 렌즈 라운드, 이견0이면 수렴(상한 5). fact 누적.
for (let round = 1; round <= 5; round++) {
  const stage = round === 1 ? "research-audit" : `research-audit-${round}`;
  const aOut = execStage({ workflow: "research", stage, args: { directive, facts, chunkRef: "chunk" } }, `06-audit-r${round}.jsonl`);
  const added = factsLedger(aOut);
  const nextTasks = nodes(aOut).filter((n) => n.kind === "task").map((n) => n.stage);
  facts = facts.concat(added);
  log(`   research 보완/감사 R${round}: ${added.length}개 발견`);
  added.forEach((a) => log(`      + [${a.category}] ${a.title}`));
  const proceed = !nextTasks.some((s) => s && s.startsWith("research-audit"));
  log(proceed ? `      ⇒ 수렴 — ${round}라운드로 종료 → design 진행` : `      ⇒ 갭 잔존 → R${round + 1} 재감사`);
  if (proceed) break;
}

log("⑦ design (interface/domain/criteria)");
for (const s of ["design-interface", "design-domain", "design-criteria"]) {
  const dOut = execStage({ workflow: "research", stage: s, args: { directive, ledger: requirements, facts, chunkRef: "chunk" } }, `07-${s}.jsonl`);
  facts = facts.concat(factsLedger(dOut));
  log(`   ${s}: 누적 fact ${facts.length}개`);
}

// design 보완/감사 수렴 루프 — design 이 낳은 갭을 잡고, 이견0이면 수렴 시 plan(상한 5).
for (let round = 1; round <= 5; round++) {
  const stage = round === 1 ? "design-audit" : `design-audit-${round}`;
  const aOut = execStage({ workflow: "research", stage, args: { directive, facts, chunkRef: "chunk" } }, `07b-design-audit-r${round}.jsonl`);
  const added = factsLedger(aOut);
  const nextTasks = nodes(aOut).filter((n) => n.kind === "task").map((n) => n.stage);
  facts = facts.concat(added);
  log(`   design 보완/감사 R${round}: ${added.length}개 발견`);
  added.forEach((a) => log(`      + [${a.category}] ${a.title}`));
  const proceed = !nextTasks.some((s) => s && s.startsWith("design-audit"));
  log(proceed ? `      ⇒ 수렴 — ${round}라운드로 종료 → plan 진행` : `      ⇒ 갭 잔존 → R${round + 1} 재감사`);
  if (proceed) break;
}

log("⑧ plan stage");
const planOut = execStage({ workflow: "research", stage: "plan", args: { directive, ledger: requirements, facts, chunkRef: "chunk" } }, "08-plan.jsonl");
const planUnits = nodes(planOut, "plan-unit");
log(`   plan-unit ${planUnits.length}개`);

log(`DONE — 요건 ${requirements.length} · fact ${facts.length} · plan-unit ${planUnits.length}. 산출: ${OUT}`);
