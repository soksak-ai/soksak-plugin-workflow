#!/usr/bin/env node
// 방법론 대회 지표(결정적 축) — M-C(1·2회)/M-A(병렬)/M-B(체인)의 design fact 산출 비교.
//   node score-tournament.mjs <mc1.jsonl> <tournament-dir>
// 지표: fact 수 · 카테고리 분포 · 인용율([..] 포함) · 제목 중복(정규화) · duration 합(result 이벤트)
//       · 재현 안정성(M-C 1↔2회: fact 수·분포 편차). 적대 축(이음새·커버리지)은 별도 패널.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const [mc1Path, dir] = process.argv.slice(2);
const parse = (p) => readFileSync(p, "utf8").split("\n").filter((l) => l.trim().startsWith("{")).map((l) => JSON.parse(l));
const facts = (evs) => evs.filter((e) => e.ev === "add" && e.kind === "fact");

function metrics(evs) {
  const fs = facts(evs);
  const cats = {};
  for (const f of fs) cats[f.category] = (cats[f.category] || 0) + 1;
  const cited = fs.filter((f) => /\[[^\]]+\]/.test(f.description || "")).length;
  const norm = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9가-힣]+/g, "");
  const seen = new Set();
  let dup = 0;
  for (const f of fs) {
    const k = norm(f.title);
    if (seen.has(k)) dup += 1;
    seen.add(k);
  }
  return { count: fs.length, cats, citedPct: fs.length ? Math.round((100 * cited) / fs.length) : 0, dup };
}
function durationOf(runsDir, files) {
  // run catalog 의 result 이벤트 duration_ms 합 — files 는 산출 jsonl 과 짝이 안 맞으므로 총합만 참고 축.
  let total = 0;
  try {
    for (const f of readdirSync(runsDir)) {
      if (!f.endsWith(".jsonl") || f === "latest.jsonl") continue;
      for (const e of parse(join(runsDir, f))) if (e.type === "result" && e.duration_ms) total += e.duration_ms;
    }
  } catch {}
  return total;
}

const rows = [];
const mc1 = metrics(parse(mc1Path));
rows.push(["M-C(1회)", mc1]);
const mc2 = metrics(parse(join(dir, "mc2.jsonl")));
rows.push(["M-C(2회)", mc2]);
const merge = (names) => names.flatMap((n) => parse(join(dir, n)));
rows.push(["M-A(병렬 합산)", metrics(merge(["ma-domain.jsonl", "ma-interface.jsonl", "ma-criteria.jsonl"]))]);
rows.push(["M-B(체인 합산)", metrics(merge(["mb-interface.jsonl", "mb-domain.jsonl", "mb-criteria.jsonl"]))]);

console.log("| 방법론 | facts | 카테고리 분포 | 인용율 | 제목중복 |");
console.log("|---|---|---|---|---|");
for (const [name, m] of rows) {
  console.log(`| ${name} | ${m.count} | ${JSON.stringify(m.cats)} | ${m.citedPct}% | ${m.dup} |`);
}
const drift = Math.abs(mc1.count - mc2.count);
console.log(`\n재현 안정성(M-C 1↔2회): fact 수 편차 ${drift} (${mc1.count}→${mc2.count})`);
console.log(`대회 run catalog duration 합: ${Math.round(durationOf(join(dir, "runs"), []) / 1000)}s`);
