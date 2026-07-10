# soksak-plugin-workflow

드래프트 파이프라인 soksak 플러그인: 아이디어가 들어오면 LLM 저작 워크플로가 그것을
칸반 노드 DAG 로 발행하고, 코어 스케줄러가 노드 하나하나를 실행·추적한다.

## 동작

1. **발행** — `run` 이 아이디어를(`research` 는 질문을) 받아 LLM 이 워크플로 골격을
   저작하고, 칸반 보드에 노드 DAG 로 발행한다: item(단건 검증), task(stage 실행),
   `blockedBy` 의존 간선.
2. **실행** — 코어 스케줄러의 `reconcile` 트리거가 ready 노드를 집어 실행한다.
   item 은 `exec-one` 검증 한 번으로 판정 배지(o/x/f)를 남기고, task 는
   `exec-stage`(generate / hunt / classify / audit)로 돌며 자식을 보드에 발행한다.
3. **추적** — 각 stage 는 실행 중 진행 델타를 활동 피드로 흘리고, 결과는 노드
   배지로 보드에 남는다.

워크플로 문서는 언어중립 JSON(`workflow-doc@0.0.1`, 번들 정본은 `workflows/`)이다.
agent 실행은 `claude -p` 로 위임하며, 인증 env(`ANTHROPIC_*` 또는 OAuth)는
호출자 또는 시크릿 볼트에서 온다.

## 명령 (CLI / MCP)

`sok plugin.soksak-plugin-workflow.<명령>` 또는 MCP 로 호출한다.

| 명령 | 설명 |
|---|---|
| `run` | 아이디어를 정련해 인증 드래프트 노드 DAG 로 발행 |
| `research` | 인증 덩어리(badge 'o')에 research→design→plan 체인 발행 |
| `issuerize` | 확정 플랜 유닛을 파일별 실코드화 task 로 전환(실코드 산출) |
| `next` | CLI 실행자 pull — ready 검증 노드의 실행 패키지 발급(lease) |
| `submit` | CLI 실행자 제출 — 판정을 동일 badge 파이프로(멱등) |
| `export` | 확정 code 노드를 실제 파일 트리로 기록(PROOF 는 노드에 유지) |
| `reconcile` | ready 워크플로 노드 실행(스케줄러 트리거 — 자동 실행) |
| `ping` | provider 헬스 프로브 — 고정 미니 프롬프트를 실경로로 왕복 |

## 구성

- `main.js` — 플러그인 어댑터: 명령, 발행 relay, 스케줄러 배선
- `src/` — 실행 런타임(Rust): 문서 실행, exec-one/exec-stage, provider
- `workflows/` — 번들 정본 워크플로 문서(`workflow-doc@0.0.1`)
- `references/` — 저작 프롬프트가 임베드하는 stage 스킬 텍스트
- `e2e/` — 재현 가능 하니스(`e2e/run-e2e.zsh`, `make -C e2e help`)
- `docs/PRINCIPLES.md` — 런타임이 강제하는 개발 원칙

## 요구사항

- 플러그인 플랫폼을 갖춘 soksak (권한: `process`, `commands`, `schedule`, `secrets`)
- agent 실행용 `claude` CLI(PATH 등록), 인증 env 는 export 또는 볼트 저장

---

English guide: [README.md](README.md).

## Pull 모드 (LLM spawn 0)

저작 턴도 pull 가능: `run {idea, pull:true}` → 수행 → `run {idea, refined}`; 이후 `next`/`submit` 루프 — stage task 는 패키지로 발급되고 산출은 동일 발행 파이프로 재생된다. `skill/SKILL.md` 참조.
