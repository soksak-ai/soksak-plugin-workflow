#!/usr/bin/env node
// classify stage exec-stage 입력 조립 — generate DraftDoc(요건)에서 ledger 를 만들어 classify args 로.
// 사용: node classify-input.mjs <doc.json(workflow-doc@0.0.1)> <stage.jsonl(generate DraftDoc)> <idea.txt> → stdout(exec-stage 입력 JSON)
import { readFileSync } from "node:fs";
const [skPath, stPath, ideaPath] = process.argv.slice(2);
if (!skPath || !stPath || !ideaPath) {
  console.error("사용: node classify-input.mjs <doc.json> <stage.jsonl> <idea.txt>");
  process.exit(1);
}
const skeleton = JSON.parse(readFileSync(skPath, "utf8"));
const doc = JSON.parse(readFileSync(stPath, "utf8"));
const directive = readFileSync(ideaPath, "utf8").trim();
// ledger = 완성 요건(hunt 후를 모사 — 여기선 generate 산출). classify 는 [id] 로 배정하므로 id/title/badge 만.
const ledger = (doc.requirements || []).map((r) => ({ id: r.id, title: r.title, badge: r.badge || "검수전" }));
// doc 단일 경로(M5e): 첫 인자는 workflow-doc@0.0.1(doc.json) — 레거시 skeleton 은 명시 거부(fail-loud).
if (skeleton.spec !== "workflow-doc@0.0.1") {
  console.error("classify-input: workflow-doc@0.0.1 필요(레거시 skeleton 경로 제거됨)");
  process.exit(1);
}
process.stdout.write(
  JSON.stringify({ skeleton, stage: "classify", args: { directive, ledger, chunkRef: "chunk" } }),
);
