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
const OUT = join(HERE, process.env.FC_OUT || "e2e/out/full-chain");
mkdirSync(OUT, { recursive: true });
const directive = readFileSync(IDEA_FILE, "utf8").trim();
// FC_RESUME: 기존 OUT의 doc.json+01-generate+02-draft-review-r*.jsonl 로 문서를 복원해 다음 라운드부터 이어감.
// generate-skeleton/generate 를 건너뛰므로 프로바이더를 교체(codex→glm 등)해 draft-review 를 완주시킬 수 있다.
const RESUME = !!process.env.FC_RESUME;

const ts = () => new Date().toISOString().slice(11, 19);
const log = (m) => console.log(`[fc ${ts()}] ${m}`);

// exec-stage 한 번 실행 → 산출 텍스트(저장) 반환.
function execStage(input, outName) {
  const res = execFileSync(BIN, ["exec-stage", "--lang", LANG, "--model", MODEL], {
    input: JSON.stringify(input),
    maxBuffer: 128 * 1024 * 1024,
    // 시간 제한 없음 — codex ultra 리뷰는 라운드당 25분+ 소요, 품질우선 effort 유지 위해 무제한 대기.
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

// 확정 문서 규약 — items(id, state, title, description, history[]) 를 ledger 로 넘겨 {{document}} 로 읽히고,
// reviewer 가 changes[{op,id?,title?,description?,reason}] 를 낸다. changes 비면 수렴, 있으면 자기재발행.
// 상한 20 + 라운드 10 초과부터 횟수 압박(자초 무한 방지). draft·research·design 재사용.
let nextId = 0;
function applyChanges(items, changes, round) {
  for (const c of changes) {
    if (c.op === "add") {
      if (!c.title) continue;
      items.push({ id: `a${nextId++}`, state: "o", title: c.title, description: c.description || "",
        history: [{ round, action: "add", reason: c.reason || "" }] });
    } else if (c.op === "remove" || c.op === "reraise") {
      const it = items.find((x) => x.id === c.id);
      if (!it) continue;
      const from = c.op === "remove" ? "o" : "x", to = c.op === "remove" ? "x" : "o";
      if (it.state !== from) continue; // 전이 불일치 방어
      it.state = to;
      it.history.push({ round, action: c.op, reason: c.reason || "" });
    }
  }
}
function reviewLoop({ stage, onConverge, items, buildArgs, outPrefix, startRound = 1 }) {
  const HARD = 20, WARN = 10;
  for (let round = startRound; round <= HARD; round++) {
    const out = execStage(buildArgs(round), `${outPrefix}-r${round}.jsonl`);
    const changes = resultOf(out).changes || [];
    applyChanges(items, changes, round);
    const n = (op) => changes.filter((c) => c.op === op).length;
    log(`   ${stage} R${round}: +${n("add")} · -${n("remove")} · ^${n("reraise")}${round >= WARN ? "  [횟수압박]" : ""}`);
    changes.forEach((c) => log(`      ${c.op === "add" ? "+" : c.op === "remove" ? "-" : "^"} ${c.title || c.id}: ${c.reason}`));
    if (changes.length === 0) { log(`      => 이견0 수렴(${round}R) -> ${onConverge}`); break; }
    if (round === HARD) { log(`      => 하드 상한 ${HARD} -> ${onConverge}`); break; }
    log(`      => 이견 잔존 -> 재검(R${round + 1})`);
  }
}
const live = (items) => items.filter((i) => i.state === "o");

// -- DRAFT: generate -> draft-review(합의 루프) -> classify -> audit(seal) --
log(`START — idea: ${directive.slice(0, 40)}… | model ${MODEL}${RESUME ? " | RESUME" : ""}`);
let draftDoc, draftItems, startRound = 1;
if (RESUME) {
  log("(resume) doc.json + 01-generate + 02-draft-review-r* 복원");
  draftDoc = JSON.parse(readFileSync(join(OUT, "doc.json"), "utf8"));
  draftItems = (JSON.parse(readFileSync(join(OUT, "01-generate.jsonl"), "utf8")).requirements || []).map((r) => ({ id: r.id, state: "o", title: r.title, description: r.description || "", history: [{ round: 0, action: "add", reason: "generate" }] }));
  for (let r = 1; r <= 20; r++) {
    const p = join(OUT, `02-draft-review-r${r}.jsonl`);
    if (!existsSync(p)) break;
    applyChanges(draftItems, resultOf(readFileSync(p, "utf8")).changes || [], r);
    startRound = r + 1;
  }
  log(`   복원 완료: 전체 ${draftItems.length}개(live ${live(draftItems).length}) · R${startRound}부터 재개`);
} else {
  log("(1) generate-skeleton (LLM 저작)");
  const docJson = execFileSync(BIN, ["generate-skeleton", "--idea", directive, "--model", MODEL, "--lang", LANG, "--gen-out", join(OUT, "authored.txt")], { maxBuffer: 64 * 1024 * 1024 }).toString();
  writeFileSync(join(OUT, "doc.json"), docJson);
  draftDoc = JSON.parse(docJson);

  log("(2) generate stage -> 요건 items");
  const genOut = execStage({ skeleton: draftDoc, stage: "generate", args: { directive } }, "01-generate.jsonl");
  draftItems = (JSON.parse(genOut).requirements || []).map((r) => ({ id: r.id, state: "o", title: r.title, description: r.description || "", history: [{ round: 0, action: "add", reason: "generate" }] }));
  log(`   요건 ${draftItems.length}개`);
}

log("(3) draft-review (완전성 합의 루프)");
reviewLoop({
  stage: "draft-review", onConverge: "classify", items: draftItems, outPrefix: "02-draft-review", startRound,
  buildArgs: (round) => ({ skeleton: draftDoc, stage: "draft-review", args: { directive, ledger: draftItems, round, chunkRef: "chunk" } }),
});
const reqLedger = live(draftItems).map((i) => ({ id: i.id, title: i.title, badge: "o" }));
log(`   요건(수렴 후, live) ${reqLedger.length}개`);

log("(4) classify stage");
execStage({ skeleton: draftDoc, stage: "classify", args: { directive, ledger: reqLedger, chunkRef: "chunk" } }, "03-classify.jsonl");
log("(5) audit stage (seal)");
execStage({ skeleton: draftDoc, stage: "audit", args: { directive, ledger: reqLedger, chunkRef: "chunk" } }, "04-audit.jsonl");
// 수렴한 draft 문서를 clean 산출물로(비교용) — live 항목만.
writeFileSync(join(OUT, "draft-document.json"), JSON.stringify(live(draftItems), null, 2));
log(`   draft 문서 저장 → draft-document.json (live ${reqLedger.length}개)`);
if (process.env.FC_DRAFT_ONLY) { log(`DRAFT DONE — 요건 ${reqLedger.length}개. 산출: ${OUT}`); process.exit(0); }

// -- PLAN: research -> research-audit -> design -> design-audit -> plan --
log("(6) research stage");
const researchOut = execStage({ workflow: "research", stage: "research", args: { directive, ledger: reqLedger, chunkRef: "chunk" } }, "05-research.jsonl");
const factItems = nodes(researchOut, "fact").map((f) => ({ id: f.id, state: "o", title: f.title, description: f.description || "", category: f.category, history: [{ round: 0, action: "add", reason: "research" }] }));
log(`   research fact ${factItems.length}개`);

log("(7) research-audit (합의 루프)");
reviewLoop({
  stage: "research-audit", onConverge: "design-interface", items: factItems, outPrefix: "06-research-audit",
  buildArgs: (round) => ({ workflow: "research", stage: "research-audit", args: { directive, ledger: factItems, round, chunkRef: "chunk" } }),
});

const factLedger = () => live(factItems).map((i) => ({ id: i.id, title: i.title, description: i.description, badge: "o", category: i.category }));
log("(8) design (interface/domain/criteria)");
for (const s of ["design-interface", "design-domain", "design-criteria"]) {
  const dOut = execStage({ workflow: "research", stage: s, args: { directive, ledger: reqLedger, facts: factLedger(), chunkRef: "chunk" } }, `07-${s}.jsonl`);
  nodes(dOut, "fact").forEach((f) => factItems.push({ id: f.id, state: "o", title: f.title, description: f.description || "", category: f.category, history: [{ round: 0, action: "add", reason: s }] }));
  log(`   ${s}: 누적 fact ${live(factItems).length}개`);
}

log("(9) design-audit (합의 루프)");
reviewLoop({
  stage: "design-audit", onConverge: "plan", items: factItems, outPrefix: "07b-design-audit",
  buildArgs: (round) => ({ workflow: "research", stage: "design-audit", args: { directive, ledger: factItems, round, chunkRef: "chunk" } }),
});

log("(10) plan stage");
const planOut = execStage({ workflow: "research", stage: "plan", args: { directive, ledger: reqLedger, facts: factLedger(), chunkRef: "chunk" } }, "08-plan.jsonl");
const planUnits = nodes(planOut, "plan-unit");
log(`   plan-unit ${planUnits.length}개`);

log(`DONE — 요건 ${reqLedger.length} · fact ${live(factItems).length} · plan-unit ${planUnits.length}. 산출: ${OUT}`);
