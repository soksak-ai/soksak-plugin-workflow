#!/usr/bin/env node
// classify stage 산출 검증 — {ev:result, value:{dimension, assignments}}. 전 요건이 정확히 1회, 존재하는 id 로만 배정됐는지.
// 사용: node verify-classify.mjs <classify.jsonl> <stage.jsonl(generate DraftDoc)>  (실패=exit1)
import { readFileSync } from "node:fs";
const [cfPath, stPath] = process.argv.slice(2);
const lines = readFileSync(cfPath, "utf8").trim().split("\n").filter(Boolean).map((s) => JSON.parse(s));
const res = lines.find((l) => l.ev === "result");
if (!res || !res.value) {
  console.error("[exec-classify] FAIL: {ev:result} 없음");
  process.exit(1);
}
const dim = res.value.dimension;
const asg = res.value.assignments || [];
const doc = JSON.parse(readFileSync(stPath, "utf8"));
const reqIds = (doc.requirements || []).map((r) => r.id);
const reqSet = new Set(reqIds);
const asgIds = asg.map((a) => a.id);
const cats = [...new Set(asg.map((a) => a.category))];
const missing = reqIds.filter((id) => !asgIds.includes(id));
const dup = asgIds.filter((id, i) => asgIds.indexOf(id) !== i);
const unknown = asgIds.filter((id) => !reqSet.has(id));
console.log("[exec-classify] dimension:", JSON.stringify(dim));
console.log("[exec-classify] 요건", reqIds.length, "→ 배정", asgIds.length, "| 카테고리", cats.length, ":", JSON.stringify(cats));
if (!dim) {
  console.error("[exec-classify] FAIL: dimension 발명 안 됨");
  process.exit(1);
}
if (missing.length) {
  console.error("[exec-classify] FAIL: 미배정 요건", missing.length, missing.slice(0, 5));
  process.exit(1);
}
if (dup.length) {
  console.error("[exec-classify] FAIL: 중복 배정 id", [...new Set(dup)].slice(0, 5));
  process.exit(1);
}
if (unknown.length) {
  console.error("[exec-classify] FAIL: 존재않는 id 배정", unknown.slice(0, 5));
  process.exit(1);
}
console.log("[exec-classify] ✓ 전", reqIds.length, "요건 정확히 1회 배정 · unknown/dup 0 · dimension 발명 · 카테고리", cats.length, "개");
