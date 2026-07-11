# 완결 헌장 (한글 번역본 — 정본은 COMPLETION.md)

build-directives 작업의 범위와 완료 정의의 단일 진실입니다. 목록 밖을 완료라 부르지 않고,
목록 안을 조용히 건너뛰지 않습니다. 임계 약화는 원칙 6 위반입니다.

## 1. 개발 대상
| # | 산출물 | 위치 |
|---|---|---|
| D1 | 지시어 스위트: design(통합 한턴)·plan(모든 파일 슈도 유닛)·body(파일별 실코드+PROOF)·검증 템플릿 3종 | workflows/research.doc.json |
| D2 | issuerize 재정의: 확정 o 유닛 → 파일별 실코드화 body task | 서비스 |
| D3 | 방법론 대회: 변형 doc 2종+러너+지표 | e2e/methodologies·tools |
| D4 | CLI 실행 표면: next/submit + 사용법 스킬(claude -p 없이 외부 LLM 이 pull-수행-제출, v1=검증 노드) | 서비스·plugin.json·스킬 |
| D5 | run catalog(원시 스트림 보존) | src/provider.rs (완료) |
| D6 | code export(확정 코드의 실파일 기록) | 서비스 |

## 2. 완료 정의 — C1~C5 전부, 각각 증거
- **C1a 독립 완주** ✅ (2026-07-10): 러너가 앱 없이 전 체인 완주 — 요건 63 개별 verify(o60/
  x3)→hunt(+3)→classify→audit 인증(부결→재감사 1회)→fact 111(research+design 체인)→plan 51
  유닛→plan-audit 조립 인증(부결→patch 2라운드로 파일 38→48 성장 — 운영 표면 보강)→파일별
  body+재작업 루프(반려 사유 주입 재생성 5/5 성공)→**48/48 파일 확정**. 전 판정 실 LLM oxf,
  강화 게이트(o 유닛마다 o 코드) 통과. 증거 잠금: evidence/(REPORT+스냅샷)+run catalog+
  export 파일 트리 48개.
- **C1b 앱 연결** ✅ (2026-07-08): 접속 절차(창 발견→ping 재주입→reconcile poke)가 라이브
  전이(o 6→7)를 만들었고 확정 노드에 판정 전문(oxf=o·origin·구체 근거) — 스케줄러 spawn
  경로의 끝까지 전진. 관찰 사이 자율 전진 4건(2→6)은 무인 지속성 증거. 증거: 보드 카운트+
  node.get 판정.
- **C2 CLI 멱등** ✅ (2026-07-08): 실보드 검수전 item 을 next→submit 으로 badge o 확정(동일
  파이프), 재제출 ALREADY_DONE 거부 실증. 증거: 커맨드 응답+node.get 전이.
- **C2b export**: 확정 code 노드 전부 파일로, 파일 수=노드 수. 증거: 파일 목록.
- **C3 대회 판정** ✅ (2026-07-08): M-C 는 재현 결정성 실패(58↔19, 2회차 criterion 0 —
  정상 종결이라 잘림 아닌 실제 변동), M-A(병렬)는 커버리지 최강이나 이음새 CONFIRMED 6건의
  체계적 상호 모순(빌드 불가 — 병렬의 구조적 귀결), M-B(체인)는 이음새 글자 단위 정합 +
  국소적·교정 가능한 커버리지 공백. **채택: M-B 체인(interface→domain→criteria)** + 처방
  2건(1:1 판정 커버리지 강제·dangling 참조 금지)을 정본 doc 에 커밋. 증거: 지표 표+2렌즈
  적대 패널.
- **C4 검증 스텝 실측** ✅ (2026-07-08): design o · plan o · body **x** — x 가 핵심 증거:
  코드의 슈도 구현은 인정하되 PROOF 명령 결함(conkey)을 지적하며 반려 — 검증기가 도장
  기계가 아니라 분별함을 실증. (이 라운드가 하네스 결함 2건도 잡아 수정: 템플릿 소비 계약
  위반·재시도의 결정적 실패 은폐.)
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

## 축 2 — pull 실행 (2026-07-10 구현, 실증 대기)

모든 LLM 턴(정련·stage·검증)을 TUI 실행자가 당겨 수행하고 제출한다 — LLM spawn 0:
exec-stage `--assemble`/`--with-output`, generate-skeleton `--assemble`/`--with-refined`,
`run {pull|refined}`, `next`/`submit` 의 stage 확장(스케줄러와 조립·소비 파이프 공유).
실증 성립(2026-07-11): idea→정련→발행→요건 12 검증→hunt/classify/audit 인증→research→
design 체인→plan→issuerize→파일별 실코드화(실행-증거 재작업 루프 2회)→export 전 구간을
TUI 실행자(오케스트레이터+팬아웃 서브에이전트의 next/submit)만으로 완주 — claude -p/
codex exec 프로세스 0. export 트리는 실동작(CLI 전 경로+다중 프로세스 스트레스 pass).
이 완주가 파이프 결함 3건(issuerize 재작업 의미론·category 매핑·body 멱등 마커)을 적발·
수정했고, 텍스트 검증이 못 잡는 이음새를 실행이 두 번 잡아 PROOF 실행 게이트가 다음
프런티어임을 확정했다.
codex 대칭(2026-07-11): codex TUI(gpt-5.5)에 자연어 한 줄 — 에이전트가 스킬을 자가 로드하고
새 아이디어의 전 파이프를 pull 로 완주(정련→요건 14→인증→fact 23→설계→유닛 5→code 5),
자기 리뷰 서브에이전트로 symlink escape 결함을 발견해 RED→GREEN 으로 수정, export 트리는
실동작(pass 7/0, 수동 smoke 독립 재현). 보드 경유 전수 확인 — 게이트 우회 없음.
