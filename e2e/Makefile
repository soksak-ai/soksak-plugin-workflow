# soksak-workflow 테스트/e2e — 재현 가능 명령(임시 스크립트 폐지)
#
#   make test          결정적: cargo test + node --test(reconcile). LLM 미호출.
#   make build         cargo build --release (soksak-workflow 바이너리)
#   make e2e           아이디어 → gen.js(LLM 저작) → skeleton → --emit 발행 스모크. (self-contained)
#   make exec-stage    make e2e 의 skeleton 으로 generate stage 실행(LLM) → 평탄 DraftDoc(요건/hunt/classify/audit) 관찰.
#   make exec-classify make exec-stage 의 요건으로 classify stage 실행(LLM) → {dimension, assignments}. 전 요건 정확히 1회 배정 검증.
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
BIN       := $(SOKSAK)/target/release/soksak-sidecar-workflow
REFS      := $(SOKSAK)/references
OUT       := $(HERE)/out
# run catalog — 사이드카가 원시 stream(띵킹 포함)을 여기 보존(latest.jsonl 심링크로 tail -f 모니터링).
export SOKSAK_SIDECAR_WORKFLOW_RUNS := $(OUT)/runs
IDEA_FILE ?= $(HERE)/idea.txt
MODEL     ?= glm-5.2
OUT_LANG  ?= ko
SLUG      ?= pharmacy

.PHONY: test build e2e exec-stage exec-classify emit-replay commit-fixture check clean

build:
	cd $(SOKSAK) && cargo build --release --bin soksak-sidecar-workflow

# test — 결정적 단위/통합(플러그인 self-contained). LLM 미호출.
# reconcile.test.mjs(main.js JS 유닛)는 소멸했다 — 로직은 Rust(reconcile tick 63케이스)가 소유한다.
test:
	cd $(SOKSAK) && cargo test

# e2e — LLM 저작(인증 env 주입식). idea → workflow-doc(JSON) → 발행 스모크(chunk + generate task 확인).
e2e: build
	@mkdir -p $(OUT)
	$(BIN) generate-skeleton --idea "$$(cat $(IDEA_FILE))" --model $(MODEL) --lang $(OUT_LANG) \
	    --gen-out $(OUT)/authored.txt > $(OUT)/doc.json
	@test -s $(OUT)/doc.json || { echo "doc 비어있음 — 인증(env)·모델 확인"; exit 1; }
	$(BIN) $(OUT)/doc.json --emit --lang $(OUT_LANG) > $(OUT)/emit.jsonl
	@node -e 'const fs=require("fs");const L=fs.readFileSync("$(OUT)/emit.jsonl","utf8").trim().split("\n").filter(Boolean).map(s=>JSON.parse(s)); \
	  const k={};for(const e of L)if(e.ev==="add")k[e.kind]=(k[e.kind]||0)+1; \
	  console.log("[e2e] 발행 kinds:",JSON.stringify(k)); \
	  const chunk=L.find(e=>e.kind==="chunk"); if(!chunk){console.error("[e2e] FAIL: chunk 없음");process.exit(1)} \
	  console.log("[e2e] chunk:",JSON.stringify(chunk.title),"| is_draft:",chunk.is_draft); \
	  const gen=L.find(e=>e.kind==="task"&&e.stage==="generate"); if(!gen){console.error("[e2e] FAIL: generate task 없음");process.exit(1)} \
	  console.log("[e2e] OK — chunk + generate task 발행. doc:",("$(OUT)/doc.json"),"| 다음: make exec-stage");'

# exec-stage — generate stage 실행(LLM) → 평탄 DraftDoc(requirements·hunt/classify/audit) 관찰. doc 은 make e2e 산출.
exec-stage: build
	@test -s $(OUT)/doc.json || { echo "먼저 make e2e (doc.json 필요)"; exit 1; }
	@node -e 'const fs=require("fs");const doc=JSON.parse(fs.readFileSync("$(OUT)/doc.json","utf8")); \
	  process.stdout.write(JSON.stringify({skeleton:doc,stage:"generate",args:{directive:fs.readFileSync("$(IDEA_FILE)","utf8").trim()}}));' \
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

# exec-verify — verify(항목 검증) 실측(LLM): 요건 1개를 exec-one 으로 — 소비 시점 조립(템플릿 {{}} 치환) 후 oxf 판정.
exec-verify: build
	@test -s $(OUT)/stage.jsonl || { echo "먼저 make exec-stage"; exit 1; }
	@node -e 'const fs=require("fs");const d=JSON.parse(fs.readFileSync("$(OUT)/stage.jsonl","utf8")); \
	  const vc=d.verify_contract, r=d.requirements[0]; \
	  const prompt=vc.template.replaceAll("{{title}}",r.title).replaceAll("{{description}}",r.description||"").replaceAll("{{directive}}",vc.directive); \
	  if(/{{\w+}}/.test(prompt)){console.error("[exec-verify] FAIL: 마커 잔존");process.exit(1)} \
	  process.stdout.write(JSON.stringify({prompt,schema:vc.schema}));' \
	  | $(BIN) exec-one --lang $(OUT_LANG) --model $(MODEL) > $(OUT)/verify.json
	@node -e 'const fs=require("fs");const o=JSON.parse(fs.readFileSync("$(OUT)/verify.json","utf8")); \
	  if(!["o","x","f"].includes(o.oxf)){console.error("[exec-verify] FAIL: oxf 판정 없음:",JSON.stringify(o).slice(0,200));process.exit(1)} \
	  console.log("[exec-verify] OK — oxf:",o.oxf,"| origin:",(o.result&&o.result.origin)||"?");'

# exec-hunt — hunt stage 실측(LLM): 요건 badge=o 시뮬 원장 → 누락 발굴(additions 0 도 정답).
# exec-hunt-canon — 번들 정본(draft.doc.json)의 hunt 지시어를 인증 원장에 단발 실측(지시어 개정 검증용).
exec-hunt-canon: build
	@test -s $(OUT)/stage.jsonl || { echo "먼저 make e2e && make exec-stage"; exit 1; }
	@node -e 'const fs=require("fs");const doc=JSON.parse(fs.readFileSync("$(SOKSAK)/workflows/draft.doc.json","utf8")); \
	  const inp=JSON.parse(require("child_process").execSync("node $(SOKSAK)/tools/assemble-ledger.mjs hunt $(OUT)/stage.jsonl $(IDEA_FILE)").toString()); \
	  inp.skeleton=doc; process.stdout.write(JSON.stringify(inp));' \
	  | $(BIN) exec-stage --lang $(OUT_LANG) --model $(MODEL) > $(OUT)/hunt-canon.jsonl
	@node -e 'const fs=require("fs");const L=fs.readFileSync("$(OUT)/hunt-canon.jsonl","utf8").trim().split("\n").filter(Boolean).map(s=>JSON.parse(s)); \
	  const adds=L.filter(e=>e.ev==="add"&&e.kind==="item"); \
	  console.log(`[exec-hunt-canon] additions ${adds.length}:`); for(const a of adds) console.log("  -", a.title);'

exec-hunt: build
	@test -s $(OUT)/doc.json && test -s $(OUT)/stage.jsonl || { echo "먼저 make e2e && make exec-stage"; exit 1; }
	@node -e 'const fs=require("fs");const doc=JSON.parse(fs.readFileSync("$(OUT)/doc.json","utf8")); \
	  const inp=JSON.parse(require("child_process").execSync("node $(SOKSAK)/tools/assemble-ledger.mjs hunt $(OUT)/stage.jsonl $(IDEA_FILE)").toString()); \
	  inp.skeleton=doc; process.stdout.write(JSON.stringify(inp));' \
	  | $(BIN) exec-stage --lang $(OUT_LANG) --model $(MODEL) > $(OUT)/hunt.jsonl
	@node -e 'const fs=require("fs");const L=fs.readFileSync("$(OUT)/hunt.jsonl","utf8").trim().split("\n").filter(Boolean).map(s=>JSON.parse(s)); \
	  const adds=L.filter(e=>e.ev==="add"&&e.kind==="item"); \
	  const bad=adds.filter(a=>!a.title||!a.prompt_role); \
	  if(bad.length){console.error("[exec-hunt] FAIL: 추가항목 계약 위반(제목/정규화)",bad.length);process.exit(1)} \
	  console.log("[exec-hunt] OK — additions:",adds.length,"(0=완결 원장 정답) | 정규화 위반 0");'

# exec-audit — audit stage 실측(LLM): 요건 badge=o 시뮬 원장 → {verdict, complete} 인증 판정.
exec-audit: build
	@test -s $(OUT)/doc.json && test -s $(OUT)/stage.jsonl || { echo "먼저 make e2e && make exec-stage"; exit 1; }
	@node -e 'const fs=require("fs");const doc=JSON.parse(fs.readFileSync("$(OUT)/doc.json","utf8")); \
	  const inp=JSON.parse(require("child_process").execSync("node $(SOKSAK)/tools/assemble-ledger.mjs audit $(OUT)/stage.jsonl $(IDEA_FILE)").toString()); \
	  inp.skeleton=doc; process.stdout.write(JSON.stringify(inp));' \
	  | $(BIN) exec-stage --lang $(OUT_LANG) --model $(MODEL) > $(OUT)/audit.jsonl
	@node -e 'const fs=require("fs");const L=fs.readFileSync("$(OUT)/audit.jsonl","utf8").trim().split("\n").filter(Boolean).map(s=>JSON.parse(s)); \
	  const r=L.find(e=>e.ev==="result"); \
	  if(!r||!r.value){console.error("[exec-audit] FAIL: result 없음");process.exit(1)} \
	  if(typeof r.value.complete!=="boolean"){console.error("[exec-audit] FAIL: complete 불리언 아님(인증 상태 기계 입력)");process.exit(1)} \
	  if(!r.value.verdict){console.error("[exec-audit] FAIL: verdict 없음");process.exit(1)} \
	  console.log("[exec-audit] OK — complete:",r.value.complete,"| verdict:",r.value.verdict.slice(0,120));'

# exec-research — research stage 실측(LLM): 번들 정본(--workflow research) 로 기초지식 발굴 → fact+plan task.
exec-research: build
	@test -s $(OUT)/stage.jsonl || { echo "먼저 make exec-stage (요건 원장 필요)"; exit 1; }
	$(BIN) --workflow research --emit --lang $(OUT_LANG) --args-json "{\"chunkRef\":\"chunk\",\"directive\":\"smoke\"}" > /dev/null
	@node $(SOKSAK)/tools/assemble-ledger.mjs research $(OUT)/stage.jsonl $(IDEA_FILE) \
	  | node -e 'const fs=require("fs");let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const inp=JSON.parse(s);inp.workflow="research";process.stdout.write(JSON.stringify(inp))});' \
	  | $(BIN) exec-stage --lang $(OUT_LANG) --model $(MODEL) > $(OUT)/research.jsonl
	@node -e 'const fs=require("fs");const L=fs.readFileSync("$(OUT)/research.jsonl","utf8").trim().split("\n").filter(Boolean).map(s=>JSON.parse(s)); \
	  const facts=L.filter(e=>e.ev==="add"&&e.kind==="fact"); const plan=L.find(e=>e.ev==="add"&&e.kind==="task"&&e.stage==="plan"); \
	  if(!facts.length){console.error("[exec-research] FAIL: fact 0");process.exit(1)} \
	  const noReg=facts[0].register_prompts?0:1; const inlined=facts.filter(f=>f.vars&&JSON.stringify(f.vars).length>500); \
	  if(noReg){console.error("[exec-research] FAIL: 첫 fact 에 registerPrompts 없음(정규화)");process.exit(1)} \
	  if(inlined.length){console.error("[exec-research] FAIL: vars 에 큰 값 인라인",inlined.length);process.exit(1)} \
	  if(!plan){console.error("[exec-research] FAIL: plan task 없음");process.exit(1)} \
	  if(!plan.blocked_by||plan.blocked_by.length!==facts.length){console.error("[exec-research] FAIL: plan.blockedBy ≠ 전 fact");process.exit(1)} \
	  const areas=facts.reduce((a,f)=>{a[f.category||"?"]=(a[f.category||"?"]||0)+1;return a},{}); \
	  console.log("[exec-research] OK — facts:",facts.length,"| areas:",JSON.stringify(areas),"| plan.blockedBy =",plan.blocked_by.length);'

# exec-plan — plan stage 실측(LLM): 요건 원장 + research fact 원장 → 슈도코드 단위(plan-unit).
exec-design: build
	@test -s $(OUT)/stage.jsonl && test -s $(OUT)/research.jsonl || { echo "먼저 make exec-stage && make exec-research"; exit 1; }
	@node $(SOKSAK)/tools/assemble-ledger.mjs design $(OUT)/stage.jsonl $(IDEA_FILE) $(OUT)/research.jsonl \
	  | node -e 'const fs=require("fs");let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const inp=JSON.parse(s);inp.workflow="research";inp.stage="design";process.stdout.write(JSON.stringify(inp))});' \
	  | $(BIN) exec-stage --lang $(OUT_LANG) --model $(MODEL) > $(OUT)/design.jsonl
	@node -e 'const fs=require("fs");const L=fs.readFileSync("$(OUT)/design.jsonl","utf8").trim().split("\n").filter(Boolean).map(s=>JSON.parse(s)); \
	  const facts=L.filter(e=>e.ev==="add"&&e.kind==="fact"); const plan=L.find(e=>e.ev==="add"&&e.kind==="task"&&e.stage==="plan"); \
	  if(!facts.length){console.error("[exec-design] FAIL: design fact 0");process.exit(1)} \
	  const KINDS=new Set(["domain-model","interface","criterion"]); const bad=facts.filter(f=>!KINDS.has(f.category)); \
	  if(bad.length){console.error("[exec-design] FAIL: category 이탈",bad.map(f=>f.category));process.exit(1)} \
	  if(!facts[0].register_prompts){console.error("[exec-design] FAIL: 첫 design fact 에 registerPrompts 없음(정규화)");process.exit(1)} \
	  const inlined=facts.filter(f=>f.vars&&JSON.stringify(f.vars).length>4000); \
	  if(inlined.length){console.error("[exec-design] FAIL: vars 과대 인라인",inlined.length);process.exit(1)} \
	  if(!plan){console.error("[exec-design] FAIL: plan task 없음");process.exit(1)} \
	  if(!plan.blocked_by||plan.blocked_by.length!==facts.length){console.error("[exec-design] FAIL: plan.blockedBy ≠ 전 design fact");process.exit(1)} \
	  const cats=facts.reduce((a,f)=>{a[f.category]=(a[f.category]||0)+1;return a},{}); \
	  console.log("[exec-design] OK — design facts:",facts.length,JSON.stringify(cats));'

exec-body: build
	@test -s $(OUT)/plan.jsonl || { echo "먼저 make exec-plan (유닛 필요)"; exit 1; }
	@node -e 'const fs=require("fs"); \
	  const L=fs.readFileSync("$(OUT)/plan.jsonl","utf8").trim().split("\n").filter(Boolean).map(s=>JSON.parse(s)); \
	  const u=L.find(e=>e.ev==="add"&&e.kind==="plan-unit"); if(!u){console.error("plan-unit 없음");process.exit(1)} \
	  const directive=fs.readFileSync("$(IDEA_FILE)","utf8").trim(); \
	  process.stdout.write(JSON.stringify({workflow:"research",stage:"body",args:{title:u.title,file_path:u.category,pseudocode:u.description,chunkRef:"chunk",directive}}));' \
	  | $(BIN) exec-stage --lang $(OUT_LANG) --model $(MODEL) > $(OUT)/body.jsonl
	@node -e 'const fs=require("fs");const L=fs.readFileSync("$(OUT)/body.jsonl","utf8").trim().split("\n").filter(Boolean).map(s=>JSON.parse(s)); \
	  const code=L.filter(e=>e.ev==="add"&&e.kind==="code"); \
	  if(code.length!==1){console.error("[exec-body] FAIL: code 노드",code.length);process.exit(1)} \
	  const c=code[0]; const d=c.description||""; \
	  if(!d.includes("---- PROOF ----")){console.error("[exec-body] FAIL: PROOF 블록 없음");process.exit(1)} \
	  const src=d.split("---- PROOF ----")[0]; \
	  if(src.trim().length<200){console.error("[exec-body] FAIL: 코드 빈약("+src.trim().length+"자)");process.exit(1)} \
	  if(/\bTODO\b|\.\.\.[^)]|<생략|omitted/i.test(src)){console.error("[exec-body] FAIL: 슈도/생략 흔적");process.exit(1)} \
	  if(c.badge!=="검수전"){console.error("[exec-body] FAIL: badge 검수전 아님");process.exit(1)} \
	  if(c.title!==c.category){console.error("[exec-body] FAIL: title≠category(파일경로)");process.exit(1)} \
	  console.log("[exec-body] OK — file:",c.title,"| 코드",src.trim().length+"자");'

exec-plan: build
	@test -s $(OUT)/stage.jsonl && test -s $(OUT)/research.jsonl && test -s $(OUT)/design.jsonl || { echo "먼저 make exec-stage && make exec-research && make exec-design"; exit 1; }
	@node $(SOKSAK)/tools/assemble-ledger.mjs plan $(OUT)/stage.jsonl $(IDEA_FILE) $(OUT)/research.jsonl $(OUT)/design.jsonl \
	  | node -e 'const fs=require("fs");let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const inp=JSON.parse(s);inp.workflow="research";process.stdout.write(JSON.stringify(inp))});' \
	  | $(BIN) exec-stage --lang $(OUT_LANG) --model $(MODEL) > $(OUT)/plan.jsonl
	@node -e 'const fs=require("fs");const L=fs.readFileSync("$(OUT)/plan.jsonl","utf8").trim().split("\n").filter(Boolean).map(s=>JSON.parse(s)); \
	  const units=L.filter(e=>e.ev==="add"&&e.kind==="plan-unit"); \
	  if(!units.length){console.error("[exec-plan] FAIL: plan-unit 0");process.exit(1)} \
	  const empty=units.filter(u=>!u.description||u.description.length<40); \
	  if(empty.length){console.error("[exec-plan] FAIL: 슈도코드 빈약(40자 미만)",empty.length);process.exit(1)} \
	  const cited=units.filter(u=>/\[[^\]]+\]/.test(u.description)); \
	  if(!cited.length){console.error("[exec-plan] FAIL: 원장 인용([id]) 있는 unit 0 — self-contained 계약 위반");process.exit(1)} \
	  const noFile=units.filter(u=>!u.category||!u.category.includes("/")&&!u.category.includes(".")); \
	  if(noFile.length){console.error("[exec-plan] FAIL: file_path(category) 없는 unit",noFile.length);process.exit(1)} \
	  const noBadge=units.filter(u=>u.badge!=="검수전"); \
	  if(noBadge.length){console.error("[exec-plan] FAIL: badge 검수전 아닌 unit(검증 파이프 이탈)",noBadge.length);process.exit(1)} \
	  console.log("[exec-plan] OK — units:",units.length,"| 인용:",cited.length+"/"+units.length,"| files:",new Set(units.map(u=>u.category)).size);'

# e2e-full — 전 체인 실측(LLM): 저작→발행→generate→hunt→classify→audit→research→plan.
e2e-full: e2e exec-stage exec-verify exec-hunt exec-classify exec-audit exec-research exec-plan
	@echo "[e2e-full] 전 체인 통과 — 저작→발행→generate→verify→hunt→classify→audit→research→plan"

# emit-replay — 커밋 fixture 발행(결정적, LLM 0): doc(workflow-doc@0.0.1) + 번들 정본(research).
emit-replay: build
	@test -s $(SOKSAK)/fixtures/gen.$(SLUG).doc.json || { echo "fixtures/gen.$(SLUG).doc.json 없음"; exit 1; }
	$(BIN) $(SOKSAK)/fixtures/gen.$(SLUG).doc.json --emit --lang $(OUT_LANG)
	$(BIN) --workflow research --emit --lang $(OUT_LANG) --args-json "{\"chunkRef\":\"chunk\",\"directive\":\"replay\"}"

# commit-fixture — make e2e 산출을 결정적 replay fixture 로 승격(수동 검토 후 git add).
commit-fixture:
	@test -s $(OUT)/doc.json || { echo "먼저 make e2e"; exit 1; }
	cp $(OUT)/doc.json $(SOKSAK)/fixtures/gen.$(SLUG).doc.json
	@echo "→ fixtures/gen.$(SLUG).doc.json 복사됨. 검토 후: git add fixtures/gen.$(SLUG).doc.json"

check:
	@test -x $(BIN) && echo "soksak-workflow: OK" || echo "soksak-workflow: make build 필요"
	@test -f $(SOKSAK)/workflows/research.doc.json && echo "번들 정본(research): OK" || echo "번들 정본: 없음 (workflows/research.doc.json)"
	@test -f $(REFS)/draft-skill.md && echo "draft-skill.md(번들): OK" || echo "draft-skill.md: 없음 ($(REFS))"
	@command -v node >/dev/null && echo "node: OK" || echo "node: 없음"
	@echo "self-contained: 외부 런타임 불요(doc 단일 경로). 인증 e2e = run-e2e.zsh"

clean:
	rm -f $(OUT)/gen.js $(OUT)/skeleton.json $(OUT)/doc.json $(OUT)/authored.txt $(OUT)/emit.jsonl $(OUT)/stage.jsonl $(OUT)/classify.jsonl $(OUT)/verify.json $(OUT)/hunt.jsonl $(OUT)/audit.jsonl $(OUT)/research.jsonl $(OUT)/plan.jsonl

# exec-classify — classify stage(LLM): make exec-stage 요건 → {dimension, assignments}. 전 요건 정확히 1회 배정 검증.
exec-classify: build
	@test -s $(OUT)/doc.json && test -s $(OUT)/stage.jsonl || { echo "run make exec-stage first"; exit 1; }
	@node $(SOKSAK)/tools/classify-input.mjs $(OUT)/doc.json $(OUT)/stage.jsonl $(IDEA_FILE) | $(BIN) exec-stage --lang $(OUT_LANG) --model $(MODEL) > $(OUT)/classify.jsonl
	@node $(SOKSAK)/tools/verify-classify.mjs $(OUT)/classify.jsonl $(OUT)/stage.jsonl

# ── 앱 실경로 e2e(PLUGIN-CONTRACT §5: 완결 판정은 레지스트리 커맨드 경유) ──
# 사용: zsh e2e/run-e2e.zsh app-e2e|app-observe|app-ping (인증 env 캡처 포함)
app-e2e:
	node $(HERE)/app-e2e.mjs run

app-observe:
	node $(HERE)/app-e2e.mjs observe

app-ping:
	node $(HERE)/app-e2e.mjs ping

# C4 — 검증 지시어 3종의 실 LLM 실측(각 산출 노드 1개에 oxf 판정).
exec-verify-design exec-verify-plan exec-verify-body: exec-verify-%: build
	@node $(SOKSAK)/tools/assemble-verify.mjs $* $(OUT)/$*.jsonl $(SOKSAK)/workflows/research.doc.json $(IDEA_FILE) \
	  | $(BIN) exec-one --lang $(OUT_LANG) --model $(MODEL) > $(OUT)/verify-$*.json
	@node -e 'const r=JSON.parse(require("fs").readFileSync("$(OUT)/verify-$*.json","utf8")); \
	  if(!["o","x","f"].includes(r.oxf)){console.error("[exec-verify-$*] FAIL: oxf 없음",JSON.stringify(r).slice(0,200));process.exit(1)} \
	  console.log("[exec-verify-$*] OK — oxf:",r.oxf,"| origin:",r.result&&r.result.origin);'

full-chain: build
	node $(SOKSAK)/tools/run-full-chain.mjs

tournament:
	zsh $(SOKSAK)/tools/run-tournament.zsh $(OUT)/tournament

app-status:
	node $(HERE)/app-e2e.mjs status
