# soksak-plugin-workflow 개발 원칙

이 문서의 규칙은 이 저장소의 모든 구현·변경을 구속한다. 규칙이 먼저고 코드는 규칙을 지킨다.
규칙과 코드가 어긋나면 코드를 고친다. 규칙 자체가 틀렸으면 조용히 완화하지 말고 이 문서를 정정하는
커밋으로 문제를 제기한다.

## 1. directive 단일 진실

저작 게이트(generate-skeleton validate)를 통과한 **정련본이 정본**이다. 사람이 보는 표면(칸반 덩어리
description)과 기계가 쓰는 검증 기준(exec-one/exec-stage 에 주입되는 directive)은 **같은 문자열**이어야
한다 — 의미가 바뀌면 결과가 바뀐다. 유일한 예외는 사용자가 명시로 준 `directive` 파라미터(직접 지정이
최상위 정본). 구현: `resolveDirective` (main.js) — 명시 > doc 정련본 > raw 폴백.

## 2. fail-loud

게이트 실패는 발행/완료 거부다. 침묵 폴백·빈-성공(agent 실패를 빈 산출로 접어 done 처리) 금지.
방어 파서(관용 JSON 파싱 등 흡수층)는 유지하되, 계약 위반은 stderr/에러 반환으로 관찰 가능해야 한다.
검증 지점: 저작(validate) · --emit(validate) · exec-stage(validate + DraftDoc validate) · relay
(validateDraftDoc·classify 원장 대조) — 어느 층도 제거하지 않는다.

## 3. 정규화 3수준

전역 템플릿(콘텐츠 주소 1행, byte-stable) / 청크 공유값(directive 1행, varRefs 참조) / 노드 고유값
(title·description 등 작은 vars)만. 노드에 공유 텍스트 인라인 복붙 금지 — DraftDoc validator(④⑨)와
doc 스키마가 강제한다. 템플릿·프롬프트 원문의 byte 안정성이 sha256 dedup 의 전제다: 원문을 "다듬는"
변경은 전 드래프트의 dedup 을 깨는 변경이며, 의도적일 때만 한다.

## 4. 두 축 분리

**검증 축 = badge**(검수전 → o/x/f; badge 보유 노드의 done 판정은 badge), **완료 축 = status**
(stage task·컨테이너). 혼용 금지. 새 검증 대상 kind(예: research 의 fact)는 badge 축을 재사용한다 —
별도 완료 메커니즘을 만들지 않는다.

## 5. 이슈라이즈 게이트

드래프트는 이슈 분해가 아니다. 개별 개발 노드(unlock 이슈)는 오직 `workflow.issuerize` 를 통해서만
생기고, 그 게이트는 **badge='o'(audit 인증) ∧ research fact 전부 검증 ∧ plan-unit 존재 ∧ 미승격(멱등)**
이다. 우회 경로(수동 unlock, 게이트 생략 플래그)를 만들지 않는다.

## 6. 기준 약화 금지

테스트·검증 기준에 미달하면 구현·픽스처를 고친다 — 기준을 낮추지 않는다. 단언을 느슨하게 바꾸는
diff, skip/ignore 추가, 임계값 완화는 전부 이 위반이다. 기준 자체가 잘못이라 판단되면 이 문서와
해당 테스트를 함께 고치는 명시적 커밋으로 정정한다.

## 7. 불필요한 LLM 단계 금지

LLM 은 **정련(저작)·발굴(generate/hunt/research)·판정(verify/classify/audit)** 에만 쓴다. 이미 정련된
입력을 재정련하는 저작 단계를 만들지 않는다 — research/plan 이 canonical doc(workflows/) 정적
인스턴스화인 이유다. 결정적으로 계산 가능한 것(원장 조립, id 매핑, 게이트 판정)을 LLM 에 맡기지 않는다.

## 부록 — 확정 결정 기록

- **표현 수단 = workflow-doc@0.0.1 단일 경로**: JS(gen.js)/ESTree interp 경로는 doc 경로의 전 체인 실측
  GREEN 이후 backup/ 으로 이동(M5e). NodeEvent wire 가 경로 불변의 계약이다.
- **research/plan 은 저작 LLM 불참**(원칙 7): 정본 = `workflows/research.doc.json`. references/ 의
  role md 는 설명서이지 정본이 아니다.
- **폴링 금지**: 트리거는 발행 poke·self-poke·kanban:changed·activate 부팅 poke. 주기 폴링을 추가하지
  않는다.
