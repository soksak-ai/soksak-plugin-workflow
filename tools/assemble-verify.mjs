#!/usr/bin/env node
// exec-one 검증 입력 조립(e2e 하네스) — 산출 스트림의 노드 1개에 그 노드의 VERIFY 템플릿을 렌더해
// {prompt, schema} 를 만든다. 런타임에선 kanban prompt.resolve 가 하는 조립의 CLI 등가(동일 치환 규칙).
//   node assemble-verify.mjs <design|plan|body> <산출.jsonl> <doc.json> <directive.txt>
import { readFileSync } from "node:fs";

const [kind, outPath, docPath, dirPath] = process.argv.slice(2);
if (!kind || !outPath || !docPath || !dirPath) {
  console.error("사용: node assemble-verify.mjs <design|plan|body> <산출.jsonl> <doc.json> <directive.txt>");
  process.exit(1);
}
const doc = JSON.parse(readFileSync(docPath, "utf8"));
const directive = readFileSync(dirPath, "utf8").trim();

// doc values 조성(concat 접기 — doc_exec resolved_values 등가 최소형: values.* 참조만).
const values = {};
for (const [k, v] of Object.entries(doc.values || {})) if (!(v && typeof v === "object" && v.concat)) values[k] = v;
for (const [k, v] of Object.entries(doc.values || {})) {
  if (v && typeof v === "object" && Array.isArray(v.concat)) {
    values[k] = v.concat.map((p) => (typeof p === "string" ? p : values[(p.$ || "").replace(/^values\./, "")] || "")).join("");
  }
}
const TMPL = { design: "DESIGN_VERIFY_TMPL", plan: "PLAN_VERIFY_TMPL", body: "BODY_VERIFY_TMPL" }[kind];
const KINDS = { design: "fact", plan: "plan-unit", body: "code" };
const tmpl = values[TMPL];
if (typeof tmpl !== "string" || !tmpl) {
  console.error(`doc values.${TMPL} 없음`);
  process.exit(1);
}
const lines = readFileSync(outPath, "utf8").split("\n").filter((l) => l.trim().startsWith("{"));
const node = lines.map((l) => JSON.parse(l)).find((e) => e.ev === "add" && e.kind === KINDS[kind]);
if (!node) {
  console.error(`${KINDS[kind]} 노드 없음: ${outPath}`);
  process.exit(1);
}
// 런타임 resolve 계약 미러: 노드 필드(title/description/category) ∪ 노드 body 의 publish vars ∪ directive.
const vars = { ...(node.vars || {}), title: node.title || "", description: node.description || "", category: node.category || "", directive };
const prompt = tmpl.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] != null ? vars[k] : `{{${k}}}`));
if (/\{\{\w+\}\}/.test(prompt)) {
  console.error("미해석 플레이스홀더 잔존:", prompt.match(/\{\{\w+\}\}/g));
  process.exit(1);
}
process.stdout.write(JSON.stringify({ prompt, schema: values.VERIFY_SCHEMA }));
