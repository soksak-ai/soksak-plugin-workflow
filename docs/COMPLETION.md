# 완결 작업 헌장 — 무엇을 개발하고, 무엇이 되면 완료인가

이 문서는 feat/build-directives 작업의 범위와 완료 임계의 단일 진실이다. 여기 없는 것을
완료라 부르지 않고, 여기 있는 것을 빼고 완료라 부르지 않는다. 임계 약화는 PRINCIPLES §6
위반이다 — 임계가 틀렸으면 이 문서를 고치는 명시적 커밋으로 정정한다.

## 1. 개발 대상 (무엇을 만드는가)

| # | 산출물 | 실체 |
|---|---|---|
| D1 | **지시어 스위트** — design(도메인모델/인터페이스/수용기준 통합 한턴) · plan(모든 파일의 슈도코드 유닛) · body(파일별 실코드+PROOF) · 검증 템플릿 3종(design/plan/body-verify) | `workflows/research.doc.json` (stages: research→design→plan / body) |
| D2 | **issuerize 재정의** — 인증·검증 완료 덩어리의 o 유닛들을 파일별 실코드화 body task 로 승격(기존 "unlock 이슈" 폐기) | `main.js` issuerizeTick + 게이트·멱등 |
| D3 | **방법론 대회 자산** — 분해 변형 doc 2종(병렬/체인) + 대회 러너 + 지표 산출 | `e2e/methodologies/` + `tools/run-tournament.zsh` + 지표 스크립트 |
| D4 | **CLI 실행 표면** — `next`(ready 검증 노드의 실행 패키지: 조립 프롬프트+스키마) / `submit`(산출 제출→동일 badge 파이프) **+ 사용법 스킬**(next→수행→submit 루프 교육 — "사용법을 알려주고 명령을 제공"의 절반). claude -p 호출 없이 외부 LLM 이 pull-수행-제출. 1차 범위 = 검증 노드(stage task 는 spawn 소유 유지) | `main.js` nextTick/submitTick + 커맨드 2종 + `plugin.json` 선언 + 스킬 동봉 |
| D5 | **run catalog** — agent 호출별 원시 이벤트 스트림 보존 + latest 심링크 | `src/provider.rs` (완료) |
| D6 | **code export** — 인증(badge 확정)된 code 노드들을 실제 파일 트리로 내보내는 커맨드(대상 디렉토리 명시, 확정 코드만) — "실제 동작하는 코드"의 파일 실체화 | `main.js` export 커맨드 |

## 2. 완료 임계 (전부 성립해야 완료 — 각각 증거 필수)

- **C1 실보드 무인 연속 완주**: 앱 실보드에서 `run`(약국 SaaS 아이디어) 1회 호출 후 사람 개입 0으로
  스케줄러가 완주: 요건 발굴 → 전 요건 badge 확정 → hunt → classify → audit **badge='o'** →
  research 전 fact 확정 → design 전 design-fact 확정 → plan 전 유닛 확정 → issuerize →
  **전 파일 code 노드 badge 확정**. 시뮬 원장 0 · 하네스의 개별 스텝 실행 0(관찰만).
  증거: 칸반 전수 상태 스냅샷 + run catalog.
- **C2 CLI 멱등 증명**: C1 보드의 검수전 노드 ≥1 을 `next`→`submit` 경로로 badge 확정(spawn 경로와
  동일 계약), 확정 노드 재제출 시 ALREADY_DONE 거부. 증거: 커맨드 응답 + 보드 전이.
- **C2b export 실증**: C1 완주 보드의 확정 code 노드들을 export 로 실제 파일 트리에 기록 —
  파일 수 = code 노드 수. 증거: 파일 목록.
- **C3 대회 판정 확정**: M-C(통합, 2회 — 재현 안정성 포함)·M-A(병렬)·M-B(체인) 실측 → 지표 표
  (파일 커버리지/이음새 결함/추적성/비용/안정성) → §10 심판 규칙(baseline 결정적 통과 시 분해
  불채택) 적용 → 기본 방법론 확정 커밋. 증거: 지표 표 + 판정 근거.
- **C4 검증 스텝 실측**: design-verify/plan-verify/body-verify 각각 실 LLM(exec-one)으로 ≥1회
  oxf 판정 산출. C1 이전에 통과해야 한다(검증 지시어가 실측 0인 채 완주 선언 금지).
- **C5 결정적 게이트 전량 GREEN**: cargo 전량 + node 전량(`make test-unit`) + 번들 doc validate.

## 3. 명시적 범위 밖 (완료 보고에 잔여로 기재 — 각 항목에 근거)

- **PROOF 실행(빌드/테스트 — BUILD_TEST 축)**: 임의 명령 실행은 환경·샌드박스 설계가 필요한
  별도 축(cc2 선례에서도 빌더는 별도 스테이지). 따라서 "동작 증명"은 PROOF 실행 전까지 미완이며
  완료 보고에 그렇게 기재한다 — body-verify 의 정적 판정이 동작 증명을 대신하지 않는다.
- **stage task 의 CLI 수행(v2)**: 발행 부수효과(children)의 제출 계약이 별도 설계. 멱등 증명(C2)은
  검증 노드로 성립한다.
- **방법론 대회의 앱-경유 재실측**: 대회의 생명은 변인 통제(동결 입력) — 앱 경유는 통제를 해친다.
  확정 방법론은 C1(실보드 완주)에서 앱 경유로 실증된다.

(정정 기록: TUI 사용법 스킬과 code export 는 당초 여기 있었으나 재검토 결과 미루기로 판정 —
D4·D6 으로 범위 내 승격, 2026-07-08.)

## 4. 현재 상태 (2026-07-08 기준 — 갱신 의무)

- D1 조립·유닛 GREEN / 생성 3스텝(design·plan·body) CLI 단발 실측 통과(시뮬 원장) / **검증 3스텝 실측 0(C4 미충족)**
- D2 유닛 GREEN, 실측 0 / D3 대회 실측 진행 중(7턴 중 1턴) / D4 **미구현** / D5 완료
- C1~C5 전부 미충족 — 완료 아님.
