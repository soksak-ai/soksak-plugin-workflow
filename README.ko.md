# soksak-plugin-workflow

한 개의 soksak 플러그인, 서로 아무것도 공유하지 않는 두 런타임. 플러그인은 워크플로
엔진을 **노출**하고 이슈 실행 원장을 **구현**한다; 둘의 유일한 이음새는 `issuerize`.

- **워크플로 엔진** — 내용·검증 런타임. 명령
  (`run`/`reconcile`/`next`/`submit`/`research`/`issuerize`/`export`/`proof`/`ping`)은 상주
  사이드카 서비스에 바인딩되고(`bind: "service"`), 코어가 사이드카 repo
  `soksak-sidecar-workflow` 에서 스폰해 라우팅한다. 이 repo 는 명령을 선언만 할 뿐
  구현하지 않는다.
- **JS 반쪽** — 이슈 실행 원장과 그 차단 게이트, 이 repo 의 실제 코드(`js/`, `main.js`
  로 번들). issuerize 이후 각 이슈의 삶을 소유한다: 리스, 증적, 두 게이트, 드리프트 검출.

전체 설계는 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 참조.

## 엔진 동작

1. **발행** — `run` 이 아이디어를(`research` 는 질문을) 받아 LLM 이 워크플로 골격을
   저작하고, 칸반 보드에 노드 DAG 로 발행한다: item(단건 검증), task(stage 실행),
   `blockedBy` 의존 간선.
2. **실행** — 코어 스케줄러의 `reconcile` 트리거가 ready 노드를 집어 실행한다.
   item 은 `exec-one` 검증 한 번으로 판정 배지(o/x/f)를 남기고, task 는
   `exec-stage`(generate / classify / audit)로 돌며 draft-review 합의 루프를 거쳐
   자식을 보드에 발행한다.
3. **추적** — 각 stage 는 실행 중 진행 델타를 활동 피드로 흘리고, 결과는 노드
   배지로 보드에 남는다.

여정은 단일 Draft 덩어리 위를 한 방향으로 흐른다 — `DRAFT → RESEARCH → DESIGN → PLAN` —
그 뒤 `issuerize` 가 완성된 플랜을 파일별 실작업으로 팬아웃한다. 워크플로 문서는
언어중립 JSON(`workflow-doc@0.0.1`)이며 사이드카 repo 에 번들된다. agent 실행은
`claude -p` 로 위임하며, 인증 env(`ANTHROPIC_*` 또는 OAuth)는 호출자 또는 시크릿
볼트에서 온다.

## 명령 (CLI / MCP)

`sok plugin.soksak-plugin-workflow.<명령>` 또는 MCP 로 호출한다.

### 워크플로 명령 (노출; 사이드카에서 실행)

| 명령 | 설명 |
|---|---|
| `run` | 아이디어를 정련해 인증 드래프트 노드 DAG 로 발행 |
| `research` | 인증 덩어리(badge 'o')에 research→design→plan 체인 발행 |
| `issuerize` | 확정 플랜 유닛을 파일별 실코드화 task 로 전환(실코드 산출) |
| `next` | CLI 실행자 pull — ready 검증 노드의 실행 패키지 발급(lease) |
| `submit` | CLI 실행자 제출 — 판정을 동일 badge 파이프로(멱등) |
| `export` | 확정 code 노드를 실제 파일 트리로 기록(PROOF 는 노드에 유지) |
| `proof` | 확정 덩어리의 PROOF 명령을 실행해 노드 `proof` 필드에 pass/fail 기록(실행 축; `SOKSAK_PROOF_EXEC` 없으면 게이트 오프) |
| `reconcile` | ready 워크플로 노드 실행(스케줄러 트리거 — 자동 실행) |
| `ping` | provider 헬스 프로브 — 고정 미니 프롬프트를 실경로로 왕복 |

### 원장 명령 (이 repo 의 JS 반쪽)

| 명령 | 설명 |
|---|---|
| `entry.add` | 이슈를 원장에 등록 — 미점유·무증적 |
| `lease.acquire` | 디스패치 리스 취득(소유자+만료); 타인의 라이브 리스는 거부 |
| `lease.renew` / `lease.release` / `lease.list` | 갱신 / 반납 / 목록 |
| `receipt.add` | 검증 가능한 증적 기록 — 커밋 sha 또는 판정을 지닌 테스트 명령 |
| `gate.dispatch` | 호출자가 라이브 리스 소유자가 아니면 디스패치 차단 |
| `gate.transition` | 검증 가능한 증적이 있어야만 `done` 으로 전이 |
| `drift.check` | 원장을 저장소와 대조 감사 — 보고만, 수정 없음 |
| `board.sync` | 원장을 이슈 보드에 투영(계약으로 발견) |
| `board.accept` | 보드를 관찰해 done Draft 밑 unlocked 작업 task 를 원장 항목으로 수용(멱등 — issuerize 가 원장으로 여는 이음새) |
| `entry.remove` | 원장 항목 삭제(라이브 리스 중이면 거부) |

## 이슈 원장 (JS 반쪽)

`issuerize` 가 플랜을 작업 아이템으로 팬아웃한 뒤, JS 반쪽이 각 아이템의 삶을 소유한다.
이는 엔진의 의도된 병렬 — 같은 보드, 다른 일 — 이며 엔진과 이름·명령·상태 셀을 하나도
공유하지 않는다.

- **entry + lease** — 이슈는 미점유로 원장에 진입한다; `lease.acquire` 가 한정된 시간
  동안 단일 소유자를 주어, 두 agent 가 한 이슈를 붙잡는 일이 없다.
- **증적(receipts)** — `receipt.add` 는 검증 가능한 증적만 기록한다: 커밋 sha, 또는
  판정을 지닌 테스트 명령. 영수증 옷을 걸친 주장은 문턱에서 거부된다.
- **게이트(차단 아니면 무의미)** — `gate.dispatch` 는 호출자가 라이브 리스 소유자가
  아니면 거부하고, `gate.transition` 은 통과 증적 없이는 `done` 을 거부한다. 말로
  통과시킬 수 있는 게이트는 게이트가 아니다.
- **드리프트** — `drift.check` 는 원장을 실제 저장소와 대조한다(조작된 커밋 증적,
  머지된 적 없는 `done`, 회수된 워크트리 위의 리스) — 크게 보고할 뿐, 제자리에서
  수정하지 않는다.
- **board.sync** — issue-board 와 prompt-store 계약을 함께 구현하는 플러그인에 원장을
  투영한다(발견할 뿐, 명명하지 않음); 보드 없음도 합법 상태다.

원장은 코어 데이터 스토어에 살아 재시작을 견디며, Ledger 뷰가 이를 렌더한다.

## 구성

- `plugin.json` — 매니페스트: 워크플로 명령은 상주 사이드카 서비스에 바인딩되고
  (`bind: "service"`), 원장 명령과 Ledger 뷰는 이 repo 의 엔트리에 바인딩된다
  (`entry: main.js`)
- `js/` — JS 반쪽(소스): 원장(`index.js`), 차단 게이트(`gate.js`), 보드 투영
  (`board.js`), git 프로브(`git.js`)
- `main.js` — 번들된 JS 엔트리, `build.mjs` 가 `js/` 에서 빌드
- `build.mjs` — esbuild 번들(`js/` → `main.js`)
- `test/` — JS 반쪽 테스트(`node --test`)
- `docs/` — 설계·원칙(`ARCHITECTURE.md`, `PRINCIPLES.md`, `COMPLETION.md`)
- `skill/` — 실행자 스킬(`SKILL.md`)

워크플로 엔진(Rust), 번들 워크플로 문서, stage 스킬 텍스트, e2e 하니스는 이 repo 가
아니라 사이드카 repo `soksak-sidecar-workflow` 에 있다.

## 요구사항

- 플러그인 플랫폼을 갖춘 soksak (권한: `service`, `sidecar`, `commands`,
  `commands:destructive`, `schedule`, `secrets`, `data`, `ui`, `process`)
- agent 실행용 `claude` CLI(PATH 등록), 인증 env 는 export 또는 볼트 저장
- JS 반쪽 빌드용 Node.js(`npm run build` → `main.js`; `npm test`)

---

English guide: [README.md](README.md).

## Pull 모드 (LLM spawn 0)

저작 턴도 pull 가능: `run {idea, pull:true}` → 수행 → `run {idea, refined}`; 이후 `next`/`submit` 루프 — stage task 는 패키지로 발급되고 산출은 동일 발행 파이프로 재생된다. `skill/SKILL.md` 참조.
