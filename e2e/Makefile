# soksak-workflow 테스트/e2e — 재현 가능 명령(임시 스크립트 폐지)
#
#   make test          결정적: cargo test + node --test(reconcile). LLM 미호출.
#   make build         cargo build --release (soksak-workflow 바이너리)
#   make e2e           아이디어 → gen.js(LLM 저작) → skeleton → --emit 발행 스모크. (self-contained)
#   make exec-stage    make e2e 의 skeleton 으로 generate stage 실행(LLM) → 평탄 DraftDoc(요건/hunt/classify/audit) 관찰.
#   make emit-replay   커밋 fixtures/gen.$(SLUG).skeleton.json → --emit → 노드 모양(결정적, LLM 0).
#   make commit-fixture  make e2e 산출(out/gen.js·skeleton.json)을 fixtures/gen.$(SLUG).* 로 복사(검토 후 git add).
#
# 인증은 절대 하드코딩하지 않는다 — 주입된 ambient env(ANTHROPIC_*/OAUTH)를 auth_env 가 판별.
#   ★ 인증 e2e 는 반드시 이 러너로(임시 스크립트 재발명 금지): e2e/run-e2e.zsh [target ...]
#     인증 env 자동 주입(토큰 미출력) + cargo PATH + make. 예) run-e2e.zsh e2e exec-stage
#   (수동: 인증 env 를 export 한 셸에서 make e2e)
# 변수 교체: IDEA_FILE MODEL LANG SLUG. (references·파서는 플러그인 번들 — REFS override 만 원하면 REFS=... make e2e)

SHELL     := /bin/bash
HERE      := $(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))
SOKSAK    := $(abspath $(HERE)/..)
BIN       := $(SOKSAK)/target/release/soksak-workflow
REFS      := $(SOKSAK)/references
OUT       := $(HERE)/out
IDEA_FILE ?= $(HERE)/idea.txt
MODEL     ?= glm-5.2
OUT_LANG  ?= ko
SLUG      ?= pharmacy

.PHONY: test build e2e exec-stage emit-replay commit-fixture check clean

build:
	cd $(SOKSAK) && cargo build --release --bin soksak-workflow

# test — 결정적 단위/통합(플러그인 self-contained). LLM 미호출.
test:
	cd $(SOKSAK) && cargo test
	cd $(SOKSAK) && node --test reconcile.test.mjs

# e2e — LLM 저작(인증 env 주입식). idea → gen.js → skeleton → 발행 스모크(chunk + generate task 확인).
e2e: build
	@mkdir -p $(OUT)
	$(BIN) generate-skeleton --idea "$$(cat $(IDEA_FILE))" --model $(MODEL) --lang $(OUT_LANG) \
	    --gen-out $(OUT)/gen.js > $(OUT)/skeleton.json
	@test -s $(OUT)/skeleton.json || { echo "skeleton 비어있음 — 인증(env)·모델 확인"; exit 1; }
	$(BIN) $(OUT)/skeleton.json --emit --lang $(OUT_LANG) > $(OUT)/emit.jsonl
	@node -e 'const fs=require("fs");const L=fs.readFileSync("$(OUT)/emit.jsonl","utf8").trim().split("\n").filter(Boolean).map(s=>JSON.parse(s)); \
	  const k={};for(const e of L)if(e.ev==="add")k[e.kind]=(k[e.kind]||0)+1; \
	  console.log("[e2e] 발행 kinds:",JSON.stringify(k)); \
	  const chunk=L.find(e=>e.kind==="chunk"); if(!chunk){console.error("[e2e] FAIL: chunk 없음");process.exit(1)} \
	  console.log("[e2e] chunk:",JSON.stringify(chunk.title),"| is_draft:",chunk.is_draft); \
	  const gen=L.find(e=>e.kind==="task"&&e.stage==="generate"); if(!gen){console.error("[e2e] FAIL: generate task 없음");process.exit(1)} \
	  console.log("[e2e] OK — chunk + generate task 발행. gen.js:",("$(OUT)/gen.js"),"| 다음: make exec-stage");'

# exec-stage — generate stage 실행(LLM) → 평탄 DraftDoc(categories 0·requirements·hunt/classify/audit) 관찰. skeleton 은 make e2e 산출.
exec-stage: build
	@test -s $(OUT)/skeleton.json || { echo "먼저 make e2e (skeleton.json 필요)"; exit 1; }
	@node -e 'const fs=require("fs");const sk=JSON.parse(fs.readFileSync("$(OUT)/skeleton.json","utf8")); \
	  process.stdout.write(JSON.stringify({skeleton:{program:sk.program},stage:"generate",args:{directive:fs.readFileSync("$(IDEA_FILE)","utf8").trim()}}));' \
	  | $(BIN) exec-stage --lang $(OUT_LANG) --model $(MODEL) > $(OUT)/stage.jsonl
	@node -e 'const fs=require("fs");const d=JSON.parse(fs.readFileSync("$(OUT)/stage.jsonl","utf8")); \
	  if(d.kind!=="draft-chunk"){console.error("[exec-stage] FAIL: DraftDoc(draft-chunk) 아님");process.exit(1)} \
	  const reqs=d.requirements||[],cats=d.categories||[]; \
	  const byOrigin=reqs.reduce((a,r)=>{a[r.origin||"?"]=(a[r.origin||"?"]||0)+1;return a},{}); \
	  console.log("[exec-stage] DraftDoc — categories:",cats.length,"| requirements:",reqs.length,"| tasks:",(d.tasks||[]).map(t=>t.stage).join(",")); \
	  console.log("[exec-stage] origin:",JSON.stringify(byOrigin),"| initialBadge:",d.verify_contract&&d.verify_contract.initial_badge,"| schema keys:",d.verify_contract&&d.verify_contract.schema?Object.keys(d.verify_contract.schema).length:0); \
	  const bad=reqs.filter(r=>("schema"in r)||("directive"in r)||("category"in r)||("vars"in r)||("promptRole"in r)); \
	  if(bad.length){console.error("[exec-stage] FAIL: 요건에 군더더기 인라인",bad.length);process.exit(1)} \
	  console.log("[exec-stage] 요건 군더더기(schema/directive/category/vars 인라인): 0 ✓ | 크기:",fs.statSync("$(OUT)/stage.jsonl").size,"B");'

# emit-replay — 커밋된 gen.$(SLUG).skeleton.json 으로 발행(결정적, LLM 0).
emit-replay: build
	@test -s $(SOKSAK)/fixtures/gen.$(SLUG).skeleton.json || { echo "fixtures/gen.$(SLUG).skeleton.json 없음 — make e2e 후 make commit-fixture"; exit 1; }
	$(BIN) $(SOKSAK)/fixtures/gen.$(SLUG).skeleton.json --emit --lang $(OUT_LANG)

# commit-fixture — make e2e 산출을 결정적 replay fixture 로 승격(수동 검토 후 git add).
commit-fixture:
	@test -s $(OUT)/gen.js && test -s $(OUT)/skeleton.json || { echo "먼저 make e2e"; exit 1; }
	cp $(OUT)/gen.js $(SOKSAK)/fixtures/gen.$(SLUG).js
	cp $(OUT)/skeleton.json $(SOKSAK)/fixtures/gen.$(SLUG).skeleton.json
	@echo "→ fixtures/gen.$(SLUG).js·skeleton.json 복사됨. 검토 후: git add fixtures/gen.$(SLUG).*"

check:
	@test -x $(BIN) && echo "soksak-workflow: OK" || echo "soksak-workflow: make build 필요"
	@test -f $(SOKSAK)/tools/parse-cli.mjs && echo "번들 파서: OK" || echo "번들 파서: 없음 (tools/parse-cli.mjs)"
	@test -f $(SOKSAK)/tools/vendor/acorn.mjs && echo "vendored acorn: OK" || echo "vendored acorn: 없음"
	@test -f $(REFS)/draft-skill.md && echo "draft-skill.md(번들): OK" || echo "draft-skill.md: 없음 ($(REFS))"
	@command -v node >/dev/null && echo "node: OK" || echo "node: 없음"
	@echo "self-contained: 추출기 런타임 불요. 인증 e2e = run-e2e.zsh"

clean:
	rm -f $(OUT)/gen.js $(OUT)/skeleton.json $(OUT)/emit.jsonl $(OUT)/stage.jsonl
