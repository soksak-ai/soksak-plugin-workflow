# research 역할 워크플로 저작 지시 (soksak — workflow-doc@0.0.1) — 초안

> **상태: 초안.** 골격·계약(kind='fact'·stage 체인·plan task 발행)은 확정이나, RESEARCH 프롬프트 원문과
> FACT_VERIFY 템플릿 원문은 사용자 확정 대상이다(cc2 soksak-researcher 정의를 원재료로 다듬는다:
> ~/.claude/agents/soksak/soksak-researcher.md — evidence dossier·confidence 부여·read-only 계약).

너는 soksak 의 **research 역할** 워크플로를 workflow-doc@0.0.1 JSON 문서로 저작한다. research 는 **인증된
드래프트 덩어리(audit badge='o')** 를 입력으로, 실제 개발이 딛고 설 **기초지식을 확정하는 상태**로
워크플로를 태운다: 프레임워크 선정, 개발방법론, 도메인 기초지시 — 각각 근거·출처를 달고 draft 와
동형의 검증 파이프(badge 검수전 → exec-one 검증 → o/x/f)를 통과해야 "확정"이다.

## 계약 (확정)

- 산출 노드 kind = **`fact`** — draft 요건(kind=item)과 원장이 섞이지 않는다(buildLedger 는 kind 필터).
  fact 는 badge 축으로 검증된다(검수전 → o/x/f — isDone 이 badge 보유 노드를 badge 로 판정).
- research 는 **기존 덩어리에 붙는다** — skeleton stage("") 는 research task 를 `args.chunkRef` 밑에 발행
  (새 chunk 를 만들지 않는다). 발행은 `workflow.run { skeleton: <이 doc>, args: {chunkRef, directive} }`.
- research stage 끝에 **plan task**(stage='plan', blockedBy=[factIds])를 발행한다 — plan(한턴 슈도코드화,
  plan-skill.md)이 fact 검증 완료 후 자동으로 이어진다.
- fact 검증 프롬프트는 draft 와 같은 정규화(3수준): FACT_VERIFY 템플릿 1행(registerPromptsOnce) +
  directive(varRefs) + 항목 vars(title/description).

## 골격 (stages — 이 구조 그대로)

```json
{
  "spec": "workflow-doc@0.0.1",
  "meta": { "name": "research", "description": "인증 덩어리의 기초지식(프레임워크·방법론·기초지시) 확정 — fact 발굴·검증 → plan 연결." },
  "args": {
    "directive": { "from": ["directive", "DIRECTIVE"], "default": "<드래프트 덩어리의 directive>" },
    "chunkRef": { "from": ["chunkRef"], "default": "chunk" }
  },
  "values": {
    "PENDING": "검수전",
    "RESEARCH_COMMON": "<확정 대상 — 근거 기준(GROUNDING: 기억으로 틀릴 수 있으면 WebSearch)·confidence·no-fabrication 불변>",
    "FACT_VERIFY_TMPL": { "concat": [ {"$": "values.RESEARCH_COMMON"}, "<확정 대상 — 한 fact 의 출처/근거를 적대 검증(oxf): o=근거 확정, x=불필요/부정확(보존), f=치명(전제 붕괴). {{title}}/{{description}}/{{directive}} 마커>" ] },
    "RESEARCH_SCHEMA": { "type": "object", "required": ["facts"], "properties": { "facts": { "type": "array", "items": {
      "type": "object", "required": ["title", "description", "origin", "area"], "properties": {
        "title": { "type": "string" }, "description": { "type": "string" },
        "origin": { "type": "string", "enum": ["agent", "search"] },
        "area": { "type": "string", "enum": ["framework", "methodology", "directive"] } } } } } },
    "VERIFY_SCHEMA": { "type": "object", "required": ["oxf", "origin"], "properties": {
      "oxf": { "type": "string", "enum": ["o", "x", "f"] }, "origin": { "type": "string", "enum": ["user", "agent", "search"] },
      "verified_value": { "type": "string" }, "sources": { "type": "array", "items": { "type": "string" } }, "reason": { "type": "string" } } }
  },
  "prompts": {
    "research": "<확정 대상 — {{RESEARCH_COMMON}} + 역할: directive({{directive}})와 요건 원장({{ledger}})을 senior practitioner 로 읽고, 개발이 딛고 설 기초지식을 발굴하라: framework(스택/라이브러리 선정 — 이 도메인 make-or-break 기준으로), methodology(개발방법론 — 검증·배포·품질 게이트), directive(도메인 기초지시 — 법/규정/불변). 각 fact = title(명령형 확정) + description(근거 요지) + area + origin. 과잉 열거 금지 — make-or-break 만.>"
  },
  "stages": {
    "": [
      { "op": "publish", "node": { "id": "research", "kind": "task", "stage": "research", "parent": { "$": "args.chunkRef" }, "title": "기초지식 확정" } }
    ],
    "research": [
      { "op": "agent", "prompt": "research", "schema": "RESEARCH_SCHEMA", "label": "기초지식 발굴", "bind": "r" },
      { "op": "forEach", "in": "r.facts", "when": "item.title", "collect": "factIds", "do": [
        { "op": "publish", "node": { "id": { "auto": "fact" }, "kind": "fact", "parent": { "$": "args.chunkRef", "or": "chunk" },
            "title": { "$": "item.title" }, "description": { "$": "item.description", "or": "" },
            "origin": { "$": "item.origin" }, "category": { "$": "item.area" }, "badge": { "$": "values.PENDING" },
            "schema": "VERIFY_SCHEMA", "promptRole": "fact-verify",
            "vars": { "title": { "$": "item.title" }, "description": { "$": "item.description", "or": "" } },
            "varRefs": { "directive": "directive" },
            "registerPromptsOnce": { "fact-verify": { "$": "values.FACT_VERIFY_TMPL" }, "directive": { "$": "args.directive" } } } }
      ] },
      { "op": "publish", "node": { "id": "plan", "kind": "task", "stage": "plan", "parent": { "$": "args.chunkRef", "or": "chunk" },
          "title": "슈도코드화", "blockedBy": [ { "$": "factIds" } ] } },
      { "op": "return", "value": {} }
    ]
  }
}
```

- research stage 의 `{{ledger}}` 는 reconcile 이 주입하는 draft 요건 원장이다 — research task 는
  hunt/classify/audit 와 같은 주입 대상이 아니므로, 발행 시 task body args 에 원장이 없어도
  `{{ledger}}` 는 빈 문자열로 렌더된다(요건 참조가 필요하면 reconcile 주입 stage 목록에 research 를
  추가하는 후속 배선이 필요 — 확정 시 결정).
- fact 검증(exec-one)은 draft 항목과 동일 파이프: pickReady 가 badge=검수전 leaf 를 선별하고,
  FACT_VERIFY 템플릿이 promptRole 로 조립된다. 검증 완료(전 fact o/x/f)가 plan task 의 blockedBy 를 푼다.

## 출력 계약

순수 JSON(workflow-doc@0.0.1)만 출력. 스키마 검증(fail-loud) 통과 필수.
