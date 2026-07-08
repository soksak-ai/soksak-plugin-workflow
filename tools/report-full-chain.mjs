#!/usr/bin/env node
// report-full-chain — 독립 완주(C1a)의 증거 리포트. board.json(전 판정)과 run catalog(원시 스트림)를
// 걸어 잠근 스냅샷 + 사람이 읽는 요약(markdown)으로 산출한다. 완주 여부 판정도 동일 게이트로 재계산.
import { readFileSync, writeFileSync, readdirSync, statSync, copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "../e2e/out/full-chain");
const b = JSON.parse(readFileSync(join(OUT, "board.json"), "utf8"));
const EV = join(OUT, "evidence");
mkdirSync(EV, { recursive: true });

const by = (kind) => b.nodes.filter((n) => n.kind === kind);
const dist = (ns) => ns.reduce((m, n) => ((m[n.badge ?? "미확정"] = (m[n.badge ?? "미확정"] || 0) + 1), m), {});
const runsDir = join(OUT, "runs");
let runs = [];
try { runs = readdirSync(runsDir).filter((f) => f.endsWith(".jsonl") && f !== "latest.jsonl"); } catch {}

const items = by("item"), facts = by("fact"), units = by("plan-unit"), codes = by("code");
const oUnits = units.filter((n) => n.badge === "o");
const oCodes = codes.filter((n) => n.badge === "o");
const pending = b.nodes.filter((n) => !["o", "x", "f"].includes(n.badge)).length;
const complete = pending === 0 && b.chunk.badge === "o" && oUnits.length > 0 && oCodes.length > 0
  && oUnits.every((u) => codes.some((c) => c.category === u.category && c.badge === "o"));

const md = `# C1a 독립 완주 증거 — ${new Date().toISOString()}

**판정: ${complete ? "완주" : "미완"}** (미확정 ${pending} | chunk ${b.chunk.badge} | o유닛 ${oUnits.length} | o코드 ${oCodes.length})

| 층 | 총 | 판정 분포 |
|---|---|---|
| 요건(item) | ${items.length} | ${JSON.stringify(dist(items))} |
| fact(research+design) | ${facts.length} | ${JSON.stringify(dist(facts))} |
| 파일 유닛(plan) | ${units.length} | ${JSON.stringify(dist(units))} |
| 실코드(code) | ${codes.length} | ${JSON.stringify(dist(codes))} |

- audit 인증: chunk badge **${b.chunk.badge}** (라운드 ${b.auditRounds ?? 1}) / plan-audit 라운드 ${b.planAuditRounds ?? 0}
- run catalog: ${runs.length}개 스트림(원시 이벤트 전문 — ${runsDir})
- 판정 전문: board.json 각 노드 result 필드(실 LLM oxf + 근거)
- 생성 파일 목록:
${oCodes.map((c) => `  - ${c.title}`).join("\n")}
`;
writeFileSync(join(EV, "REPORT.md"), md);
copyFileSync(join(OUT, "board.json"), join(EV, "board.snapshot.json"));
console.log(md.split("\n").slice(0, 12).join("\n"));
console.log(`증거 → ${EV}/ (REPORT.md + board.snapshot.json)`);
process.exit(complete ? 0 : 2);
