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

// {ev:"result",value:{…}} 라인 → 스테이지 return 값(removals 등). 없으면 {}.
function resultOf(text) {
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let o;
    try { o = JSON.parse(t); } catch { continue; }
    if (o.ev === "result") return o.value || {};
  }
  return {};
}

// 합의 루프 하나 — 같은 review 스테이지를 이견0(add·remove 둘 다 0)까지 반복 호출. 종료는 수렴이 정상.
// 낮은 상한이 정당한 발견을 끊으면 안 되므로 여유(하드 20) + 라운드 10 초과부터 reviewer 에 횟수 압박
// (한 번에 소진하라, {{round}} 로 전달). 20 에서 하드 스톱. draft·research·design 재사용.
function reviewLoop({ stage, onConverge, addKind, buildArgs, apply, outPrefix }) {
  const HARD = 20, WARN = 10;
  for (let round = 1; round <= HARD; round++) {
    const out = execStage(buildArgs(round), `${outPrefix}-r${round}.jsonl`);
    const added = nodes(out, addKind);
    const removals = resultOf(out).removals || [];
    const nextStages = nodes(out).filter((n) => n.kind === "task").map((n) => n.stage);
    apply(added, removals);
    log(`   ${stage} R${round}: +${added.length} 추가 · −${removals.length} 제거${round >= WARN ? "  ⚠횟수압박" : ""}`);
    added.forEach((a) => log(`      + ${a.title}`));
    removals.forEach((r) => log(`      − 제거 [${r.id}]: ${r.reason}`));
    if (nextStages.includes(onConverge)) { log(`      ⇒ 이견0 수렴(${round}R) → ${onConverge}`); break; }
    if (round === HARD) { log(`      ⇒ 하드 상한 ${HARD} 도달 — 강제 진행 → ${onConverge}`); break; }
    log(`      ⇒ 이견 잔존 → 재검(R${round + 1})`);
  }
}

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

log("③ draft-review (완전성 합의 루프 — hunt+audit 대체)");
reviewLoop({
  stage: "draft-review", onConverge: "classify", addKind: "item", outPrefix: "02-draft-review",
  buildArgs: (round) => ({ skeleton: draftDoc, stage: "draft-review", args: { directive, ledger: requirements, round, chunkRef: "chunk" } }),
  apply: (added, removals) => {
    requirements = requirements.concat(added.map((a) => ({ id: a.id, title: a.title, badge: "o" })));
    const rem = new Map(removals.map((r) => [r.id, r.reason]));
    // 제거는 삭제 아님 — badge x 로 원장에 남겨 다음 라운드 reviewer 가 [x] 로 봄(진동 차단).
    requirements = requirements.map((r) => (rem.has(r.id) ? { ...r, badge: "x", result: rem.get(r.id) } : r));
  },
});
const liveReq = requirements.filter((r) => r.badge !== "x");
log(`   요건(수렴 후, x 제외) ${liveReq.length}개`);

log("④ classify stage");
execStage({ skeleton: draftDoc, stage: "classify", args: { directive, ledger: liveReq, chunkRef: "chunk" } }, "03-classify.jsonl");

log("⑤ audit stage (완결 인증 seal)");
const auditOut = execStage({ skeleton: draftDoc, stage: "audit", args: { directive, ledger: liveReq, chunkRef: "chunk" } }, "04-audit.jsonl");
log(`   audit 산출 ${auditOut.length}B`);
requirements = liveReq; // downstream(research/design/plan)은 수렴한 live 요건만

// ── PLAN: research → research-audit 수렴루프 → design(if/dom/crit) → plan ──
log("⑥ research stage");
const researchOut = execStage({ workflow: "research", stage: "research", args: { directive, ledger: requirements, chunkRef: "chunk" } }, "05-research.jsonl");
let facts = factsLedger(researchOut);
log(`   research fact ${facts.length}개`);

// research-audit 합의 루프 (동일 헬퍼 재사용). add=fact 누적, remove=회수 + removed 히스토리 주입.
let removed = [];
reviewLoop({
  stage: "research-audit", onConverge: "design-interface", addKind: "fact", outPrefix: "06-research-audit",
  buildArgs: (round) => ({ workflow: "research", stage: "research-audit", args: { directive, facts, removed, round, chunkRef: "chunk" } }),
  apply: (added, removals) => {
    facts = facts.concat(added.map((a) => ({ id: a.id, title: a.title, description: a.description, badge: "o", category: a.category })));
    const rem = new Set(removals.map((r) => r.id));
    removed = removed.concat(removals.map((r) => ({ id: r.id, title: (facts.find((f) => f.id === r.id) || {}).title || "", reason: r.reason })));
    facts = facts.filter((f) => !rem.has(f.id));
  },
});

log("⑦ design (interface/domain/criteria)");
for (const s of ["design-interface", "design-domain", "design-criteria"]) {
  const dOut = execStage({ workflow: "research", stage: s, args: { directive, ledger: requirements, facts, chunkRef: "chunk" } }, `07-${s}.jsonl`);
  facts = facts.concat(factsLedger(dOut));
  log(`   ${s}: 누적 fact ${facts.length}개`);
}

// design-audit 합의 루프 (동일 헬퍼 재사용) — 이견0이면 plan.
let removedD = [];
reviewLoop({
  stage: "design-audit", onConverge: "plan", addKind: "fact", outPrefix: "07b-design-audit",
  buildArgs: (round) => ({ workflow: "research", stage: "design-audit", args: { directive, facts, removed: removedD, round, chunkRef: "chunk" } }),
  apply: (added, removals) => {
    facts = facts.concat(added.map((a) => ({ id: a.id, title: a.title, description: a.description, badge: "o", category: a.category })));
    const rem = new Set(removals.map((r) => r.id));
    removedD = removedD.concat(removals.map((r) => ({ id: r.id, title: (facts.find((f) => f.id === r.id) || {}).title || "", reason: r.reason })));
    facts = facts.filter((f) => !rem.has(f.id));
  },
});

log("⑧ plan stage");
const planOut = execStage({ workflow: "research", stage: "plan", args: { directive, ledger: requirements, facts, chunkRef: "chunk" } }, "08-plan.jsonl");
const planUnits = nodes(planOut, "plan-unit");
log(`   plan-unit ${planUnits.length}개`);

log(`DONE — 요건 ${requirements.length} · fact ${facts.length} · plan-unit ${planUnits.length}. 산출: ${OUT}`);
