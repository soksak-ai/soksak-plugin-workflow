# 완결 헌장 (한글 번역본 — 정본은 COMPLETION.md)

build-directives 작업의 범위와 완료 정의의 단일 진실입니다. 목록 밖을 완료라 부르지 않고,
목록 안을 조용히 건너뛰지 않습니다. 임계 약화는 원칙 6 위반입니다.

## 1. 개발 대상
| # | 산출물 | 위치 |
|---|---|---|
| D1 | 지시어 스위트: design(통합 한턴)·plan(모든 파일 슈도 유닛)·body(파일별 실코드+PROOF)·검증 템플릿 3종 | workflows/research.doc.json |
| D2 | issuerize 재정의: 확정 o 유닛 → 파일별 실코드화 body task | main.js |
| D3 | 방법론 대회: 변형 doc 2종+러너+지표 | e2e/methodologies·tools |
| D4 | CLI 실행 표면: next/submit + 사용법 스킬(claude -p 없이 외부 LLM 이 pull-수행-제출, v1=검증 노드) | main.js·plugin.json·스킬 |
| D5 | run catalog(원시 스트림 보존) | src/provider.rs (완료) |
| D6 | code export(확정 코드의 실파일 기록) | main.js |

## 2. 완료 정의 — C1~C5 전부, 각각 증거
- **C1 실보드 무인 완주**: run 1회 후 개입 0으로 요건→인증(badge o)→research→design→plan→
  issuerize→전 code 노드 확정. 시뮬 원장 0. 증거: 보드 전수 스냅샷+run catalog.
- **C2 CLI 멱등** ✅ (2026-07-08): 실보드 검수전 item 을 next→submit 으로 badge o 확정(동일
  파이프), 재제출 ALREADY_DONE 거부 실증. 증거: 커맨드 응답+node.get 전이.
- **C2b export**: 확정 code 노드 전부 파일로, 파일 수=노드 수. 증거: 파일 목록.
- **C3 대회 판정** ✅ (2026-07-08): M-C 는 재현 결정성 실패(58↔19, 2회차 criterion 0 —
  정상 종결이라 잘림 아닌 실제 변동), M-A(병렬)는 커버리지 최강이나 이음새 CONFIRMED 6건의
  체계적 상호 모순(빌드 불가 — 병렬의 구조적 귀결), M-B(체인)는 이음새 글자 단위 정합 +
  국소적·교정 가능한 커버리지 공백. **채택: M-B 체인(interface→domain→criteria)** + 처방
  2건(1:1 판정 커버리지 강제·dangling 참조 금지)을 정본 doc 에 커밋. 증거: 지표 표+2렌즈
  적대 패널.
- **C4 검증 스텝 실측**: 검증 3종 각 ≥1회 실 LLM oxf 산출 — C1 이전 필수.
- **C5 결정적 게이트 전량 GREEN**: cargo+node 전량+doc validate.

## 3. 명시적 범위 밖 (완료 보고에 잔여 기재)
- PROOF 실행(빌드/테스트): 샌드박스 설계가 필요한 별도 축 — 실행 전까지 "동작"은 미증명.
- stage task 의 CLI 수행(v2): 발행 부수효과의 제출 계약 별도 설계.
- 대회의 앱-경유 재실측: 대회는 동결 입력이 생명 — 확정 방법론은 C1 에서 앱 실증.

(정정 기록: 사용법 스킬과 export 는 감사 결과 미루기로 판정, D4/D6 승격 — 2026-07-08.)

## 4. 현재 상태 (2026-07-08 — 갱신 의무)
- D1 조립·유닛 GREEN, 생성 3스텝 CLI 단발 실측(시뮬 원장), **검증 3스텝 실측 0(C4 미충족)**
- D2 유닛만 · D3 진행 중 · D4 구현 완료(next/submit/export·lease·스킬·유닛 GREEN — 라이브 증명 C2 대기) · D5 완료 · D6 구현 완료(유닛 GREEN — C2b 대기)
- C1~C5 전부 미충족 — 완료 아님.
