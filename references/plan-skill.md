# plan 역할 지시 (soksak — 한턴 슈도코드화) — 초안

> **상태: 초안.** 계약(단일 stage 1턴·kind='plan-unit'·PLAN_SCHEMA 형태)은 확정이나, PLAN 프롬프트
> 원문은 사용자 확정 대상이다(cc2 soksak-planner 정의를 원재료로 다듬는다:
> ~/.claude/agents/soksak/soksak-planner.md — phase 구조·proof contract·acceptance criteria 채널).

plan 은 **워크플로가 아니라 한 턴이다** — research 가 확정한 기초지식({{facts}})과 드래프트 요건
원장({{ledger}})을 받아 **한 번의 agent 호출로 슈도코드화**한다. 산출 = 실제 개발 업무의 단위가 될
plan-unit 노드들(잠긴 채 덩어리 밑) — 이슈라이즈(workflow.issuerize)가 이것을 unlock 개발 이슈로
승격한다.

## 계약 (확정)

- plan task 는 research stage 가 발행한다(stage='plan', blockedBy=[factIds] — research-skill.md).
  reconcile 이 plan stage 실행 시 **요건 원장(args.ledger)과 기초지식 원장(args.facts)을 주입**한다.
- 산출 노드 kind = **`plan-unit`** — badge 없음(검증 파이프 비대상), locked(덩어리 응집 유지),
  title=업무 단위명, description=**슈도코드 전문**(+대상 요건 id·근거 fact 참조를 본문에 명시).
- 한 unit = 한 개발 업무 단위: 개발자가(또는 빌더 에이전트가) 이 unit 하나만 보고 착수할 수 있게
  self-contained 로 쓴다.

## 골격 (research-doc 의 stages 에 추가되는 stage — 이 구조 그대로)

```json
"plan": [
  { "op": "agent", "prompt": "plan", "schema": "PLAN_SCHEMA", "label": "슈도코드화", "bind": "p" },
  { "op": "forEach", "in": "p.units", "when": "item.title", "do": [
    { "op": "publish", "node": { "id": { "auto": "unit" }, "kind": "plan-unit", "parent": { "$": "args.chunkRef", "or": "chunk" },
        "title": { "$": "item.title" }, "description": { "$": "item.pseudocode" } } }
  ] },
  { "op": "return", "value": {} }
]
```

```json
"PLAN_SCHEMA": { "type": "object", "required": ["units"], "properties": { "units": { "type": "array", "items": {
  "type": "object", "required": ["title", "pseudocode"], "properties": {
    "title": { "type": "string" },
    "pseudocode": { "type": "string", "description": "슈도코드 전문 — 대상 요건([id])과 근거 fact([factN])를 본문에 인용, 착수 가능 수준" } } } } } }
```

```json
"prompts": { "plan": "<확정 대상 — 역할: 요건 원장({{ledger}})과 확정 기초지식({{facts}})을 받아, directive({{directive}})의 목표를 달성하는 실행 계획을 **슈도코드 단위**로 분해하라. 단위 = 한 사람이 착수 가능한 개발 업무 1개(파일/모듈 경계 존중, 검증 방법 포함). 각 단위의 pseudocode 는 대상 요건 id 와 딛고 선 fact 를 인용해 self-contained 로.>" }
```

## 이슈라이즈 연결 (구현 완료 — workflow.issuerize)

`workflow.issuerize {chunk}` 게이트: 덩어리 badge='o'(audit 인증) ∧ fact 전부 검증(o/x/f) ∧ plan-unit ≥1
∧ 미승격(계보 issue 없음 — 멱등). 승격: 각 plan-unit → unlock 이슈 노드(kind='issue',
parentDraftId=덩어리, 본문=슈도코드+o 확정 배경지식 동반). 실제 개발 실행은 이슈 소비자 몫.
