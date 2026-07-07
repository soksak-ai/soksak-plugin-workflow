#!/usr/bin/env node
// exec-stage 입력 조립(e2e 하네스) — generate DraftDoc(stage.jsonl)의 요건으로 badge 시뮬 원장을 만들어
// hunt/audit/plan 입력을, --workflow research 로 research 입력을 만든다. 발행 없이 CLI 단에서 각 stage 를
// 실측하기 위한 도구(런타임에선 reconcile 이 칸반에서 materialize).
//
//   node assemble-ledger.mjs <stage> <stage.jsonl> <idea-or-directive.txt> [facts.jsonl ...]
//     stage ∈ hunt|audit|research|design|plan. badge 는 전부 o 로 시뮬(항목 검증 완료 상태 모사).
//     design/plan 은 facts.jsonl(exec-research/exec-design 산출 스트림, 복수 허용)에서 fact 원장을 함께
//     조립 — plan 의 ground 는 research fact + design fact 합집합(같은 kind=fact 원장).
import { readFileSync } from "node:fs";

const [stage, stPath, dirPath, ...factsPaths] = process.argv.slice(2);
if (!stage || !stPath || !dirPath) {
  console.error("사용: node assemble-ledger.mjs <hunt|audit|research|design|plan> <stage.jsonl> <directive.txt> [facts.jsonl ...]");
  process.exit(1);
}
const doc = JSON.parse(readFileSync(stPath, "utf8"));
const directive = readFileSync(dirPath, "utf8").trim();
// 요건 원장 — 항목 검증 완료(badge o) 시뮬. classify 전이라 category 는 빈 값.
const ledger = (doc.requirements || []).map((r) => ({ id: r.id, title: r.title, badge: "o" }));

const args = { directive, ledger, chunkRef: "chunk" };
if (stage === "design" || stage === "plan") {
  if (factsPaths.length === 0) {
    console.error(`${stage} 은 facts.jsonl(exec-research/exec-design 산출) 필요`);
    process.exit(1);
  }
  // 산출 스트림({ev:add} fact 라인들, 복수 파일 합집합)에서 fact 원장 조립 — 검증 완료(badge o) 시뮬.
  const facts = [];
  for (const fp of factsPaths) {
    for (const line of readFileSync(fp, "utf8").split("\n")) {
      const t = line.trim();
      if (!t.startsWith("{")) continue;
      let ev;
      try {
        ev = JSON.parse(t);
      } catch {
        continue;
      }
      if (ev.ev === "add" && ev.kind === "fact") {
        facts.push({ id: ev.id, title: ev.title, description: ev.description, badge: "o", category: ev.category });
      }
    }
  }
  if (facts.length === 0) {
    console.error("facts.jsonl 에 fact 이벤트 없음 — make exec-research 먼저");
    process.exit(1);
  }
  args.facts = facts;
}

// research/plan 은 번들 정본 참조(workflow 이름), hunt/audit 는 draft doc 임베드(e2e 산출 doc.json 은
// exec-stage 호출부가 skeleton 슬롯으로 넣는다 — 여기선 stage/args 만).
process.stdout.write(JSON.stringify({ stage, args }));
