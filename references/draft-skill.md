# draft 역할 워크플로 작성 지시 (soksak)

너는 soksak 의 draft 역할 워크플로를 JS 코드로 작성한다. 산출물 = soksak-workflow interp 가 parse 해 실행하는 **완전한 워크플로 파일 1개**. 사용자 아이디어 → 백로그 요건 덩어리 → 칸반 노드 발행(agent opts.publish:true). 아래 원문(draft.js verbatim) COMMON·스키마·역할 프롬프트·발행 패턴을 그대로 써라.

**파일은 반드시 `export const meta = {...}` (순수 리터럴)로 시작한다** — 추출기 parse 의 계약이며, 없으면 "export const meta 없음" 으로 파싱 실패한다. 아래 「워크플로 골격」의 뼈대(export const meta → args/DIRECTIVE 추출 → 상수/스키마/프롬프트 → STAGE 추출 → if-STAGE 분기 → skeleton emit)를 그 순서 그대로 하나의 파일로 조립하라. 마크다운 펜스·설명 없이 순수 JS 만 출력.

**프롬프트 정규화(콘텐츠 주소화) — 필수**: item 노드에 완성 프롬프트(COMMON+본문 ~8.7KB)를 통째 박지 마라. **3수준 분리**: (1) VERIFY_TMPL = {{key}} 마커 템플릿 상수(전역 공유, 모든 드래프트), (2) DIRECTIVE = 청크당 1개 큰 공유값(~1KB), (3) category/title/description = 항목당 작은 값(~100자). item agent 는 1번째 인자 빈 문자열('') + opts.promptRole:'verify' + opts.vars(**작은 값만**: category/title/description) + **opts.varRefs:{directive:'directive'}**(directive 를 콘텐츠 주소 참조). 첫 group 발행에 registerPrompts:{verify:VERIFY_TMPL, directive:DIRECTIVE} 로 **둘 다** 1회 등록(sha256 dedup). 소비 시점(kanban prompt.resolve)에 {{key}}→vars(인라인)/refs(hash deref) 치환. **directive 를 vars 에 넣지 마라 — 항목마다 1.1KB 복붙된다.**

## 워크플로 골격 (draft.js 원문 — 반드시 이 뼈대, `export const meta` 로 시작)
export const meta = {
  name: 'draft',
  description: 'DRAFT 워크플로 — 아이디어(DIRECTIVE)를 백로그 덩어리로 구체화. exec-stage 가 stage(generate/hunt/audit) 별로 호출. generate=genPrompt 실행→그룹/항목 발행(항목 body=verifyPrompt), 항목 검증=exec-one, 누락=hunt, 완결성=audit.',
}

// ── 입력 DIRECTIVE — args 우선(string | {directive|DIRECTIVE|IDEA}). 클론 VM: string 은 typeof 로 판정(member 접근 X).
let DIRECTIVE = ''
if (typeof args === 'string') DIRECTIVE = args
else if (args && args.directive) DIRECTIVE = args.directive
else if (args && args.DIRECTIVE) DIRECTIVE = args.DIRECTIVE
else if (args && args.IDEA) DIRECTIVE = args.IDEA
const parentDraftId = (args && args.parentDraftId) || null

// ↓↓ 그 다음: PENDING · COMMON · 스키마+ledgerView · 역할 프롬프트+VERIFY_TMPL+verifyVars (아래 원문 그대로) ↓↓
// ↓↓ 이어서 STAGE 라우팅 상수 + if-STAGE 분기 + skeleton emit(맨 끝) ↓↓

// ── stage 라우팅 — exec-stage 가 args.stage 주입. skeleton(--emit)은 stage 없음(''):
const STAGE = (args && args.stage) || ''
const CHUNK_REF = (args && args.chunkRef) || 'chunk'   // 기존 덩어리 kanban id(skeleton 발행분; exec-stage args 주입)
const LEDGER = (args && args.ledger) || []             // hunt/audit 원장(main.js materialize → args.ledger)
// (STAGE 상수는 프롬프트/스키마 정의 뒤, if-STAGE 분기 앞에 둔다 — 아래 「stage 발행 패턴」 참조.)

## PENDING / COMMON (draft.js 원문)
const PENDING = '검수전'   // 검증 배지 초기값(드래프트 항목). o/x/f 는 검증(exec-one)이 매김.

const COMMON = `SHARED CONCEPTS:
- A REQUIREMENT = an imperative the result must satisfy ("the system/plan/novel/work must …"): concrete and developable/executable — NOT a background fact, NOT a restatement of the directive. (Form: not "X regulations" but "the system must DO <Y> to satisfy <X>".)
- MAKE-OR-BREAK = its absence would make the result FAIL or be WRONG, not merely less polished. A genuine one is a DECISION two competent practitioners could resolve DIFFERENTLY — NOT a nice-to-have, NOT one methodology's enumerated beat-list, NOT the HOW / implementation-detail of another requirement (that is covered by its parent, not a separate requirement).
- EXPERT STANCE: read THIS directive as the SENIOR PRACTITIONER of its real domain (a pharmacist / compliance officer for a drug system, a novelist for a novel, an expedition leader for a climb). An expert never stops at the CATEGORY — "comply with the narcotics law" / "protect personal data" is NOT a requirement; it HIDES the concrete obligations the law compels, each its own make-or-break ("on a stock discrepancy, file the incident report to the authority within the statutory deadline"; "verify the vendor is a licensed wholesaler at registration"). Name the SPECIFIC trigger / deadline / check whoever builds, writes, or executes it must satisfy — a distinct requirement an expert knows, never an implementation beat. (Likewise outside law: a novel — not "a satisfying ending" but the specific turn that earns it; a plan — not "be safe" but the specific abort threshold.) A broad "support / comply with X" topic HIDES the gap, it does not cover it.
- THE BACK-SIDE: the requester is NOT a domain expert — they named the visible SURFACE (the easy 80%) and, even in a DETAILED directive, omit the make-or-break BACK-SIDE (the 20% that decides success) a senior practitioner / law / safety requires for the intent to actually work, be legal, be safe (the administrative, legal, financial, safety, contingency/failure-handling, oversight/who-administers substrate). DRAW IT OUT — adversarially ask of THIS intent: who actually OPERATES it, OVERSEES/administers it, PAYS FOR it, is kept SAFE/legal by it, and RECOVERS it when it fails or ends — and what does each REQUIRE that the requester never said? Don't be seduced by a polished, plausible surface: that polish IS the 80% trap. Then use the per-domain SHAPES below — the KIND to hunt; they COMPLEMENT the questions above (a minimal domain hint), never REPLACE them, and are NOT answers (search the real content; apply ONLY what genuinely fits THIS directive, never force a non-applicable category):
    · SYSTEM → operator/admin console per permission grade & oversight, data model, regulation (the SPECIFIC reporting/incident triggers, deadlines, and qualifications the governing law compels — kinds to hunt, not answers), security boundaries, monitoring, lifecycle/offboarding.
    · NOVEL → the avenger's corrosion, justice-vs-vengeance, antagonist depth, the delay engine, the payoff, the aftermath, POV/reveal-order, setting/world, reader complicity.
    · PLAN → go/no-go gates, per-step verification, contingency/rollback, failure modes, legal/safety preconditions (the SPECIFIC approvals, clearances, and qualifications required before an act may proceed — kinds to hunt, not answers), responsibility, exit criteria.
    · EVERYDAY (e.g. moving house) → registration, deposit/fee settlement, address changes, defect-check — not just the visible act.
- LEGAL LENS: wherever the intent's success turns on real-world LAW, RULE, or LEGITIMACY — to be COMPLIANT (a statutory duty it must satisfy), to be PERMITTED (an approval / license / qualification that gates an act or a participation), or to be ACCURATE (a work that portrays or relies on real law) — surface the binding obligations, approvals, triggers, and deadlines the real, current law actually compels, not just the functional surface (ground them by GROUNDING below). This is NOT only for regulated systems: a plan may need a clearance, a novel may need its law right. Apply ONLY where the intent genuinely turns on law; never force it onto one that does not.
- GROUNDING (when to SEARCH vs REASON — the one rule for any fact you rely on): the real test is "could you be WRONG from memory?" — info beyond your knowledge cutoff (a recent event, the CURRENT status of a law/program/standard), OR the SPECIFICS of a named statute/article/standard/figure/framework you could misremember, OR genuine uncertainty → WebSearch (put the current year in queries; NEVER assert such specifics from memory). A general principle or common design/craft choice you RELIABLY know → reason it; do NOT search what you reliably know (wasteful), and never re-search the settled.
- COMMON-SENSE DEFAULT: where the directive leaves a gap or ambiguity, resolve it with the SIMPLEST answer common reasoning reaches — what most competent people would call obvious. Do NOT invent an unusual, elaborate, or restrictive mechanism (a quantity cap, an enforcement, a control) the directive never asked for; a plain reading beats a clever one. The unusual must come from the directive — never from you.
- INVARIANTS — every requirement, whether GENERATED or ADDED: (1) ATOMIC — one subject, not bundled, not over-split; (2) NO DUPLICATE — not a restatement of another, judged by MEANING not wording (a narrower / re-angled / renamed / split version of an existing one is NOT new); (3) NO FORCING/FABRICATION — a genuine grounded make-or-break, never invented to seem thorough.`

## 스키마 + ledgerView (draft.js 원문)
// GEN: 생성은 **분류하지 않는다** — 평탄 요건만 발굴. 분류(카테고리)는 검토 절차(classify)가 종합해서 한다.
const GEN_SCHEMA = { type:'object', required:['title','requirements'], properties:{
  title:{type:'string'}, titleOrigin:{type:'string', enum:['user','agent']},
  requirements:{ type:'array', items:{ type:'object', required:['title','description','origin'], properties:{
    title:{type:'string'}, description:{type:'string'}, origin:{type:'string', enum:['user','agent']} } } } } }
// CLASSIFY: 생성이 아니라 **검토 절차(hunt 뒤)** — 완성된 전체 요건(원장)을 보고 분류 차원 하나를 발명 + 각 요건(id)에 카테고리 배정.
// 새 요건 X, 재배치 X — 이미 존재하는 항목에 카테고리 메타만 부여(node.edit). id 기준(원장의 [id]). 모든 id 정확히 1회.
const CLASSIFY_SCHEMA = { type:'object', required:['dimension','assignments'], properties:{
  dimension:{type:'string'},
  assignments:{ type:'array', items:{ type:'object', required:['id','category'], properties:{
    id:{type:'string'}, category:{type:'string'} } } } } }
// VERIFY: exec-one 항목 노드 1개 산출(oxf 판정 문서). 필드명 oxf — exec_one.extract_oxf 가 oxf|verdict 에서 배지 추출 → node.edit(badge).
const VERIFY_SCHEMA = { type:'object', required:['oxf','origin'], properties:{
  oxf:{type:'string', enum:['o','x','f']}, origin:{type:'string', enum:['user','agent','search']},
  verified_value:{type:'string'}, sources:{type:'array', items:{type:'string'}}, reason:{type:'string'} } }
// HUNT: exec-one 누락 탐색 노드 산출 — 추가 항목(검수전 → 다시 검증).
const HUNT_SCHEMA = { type:'object', required:['additions'], properties:{ additions:{ type:'array', items:{ type:'object', required:['title','description','origin'], properties:{
  title:{type:'string'}, description:{type:'string'}, origin:{type:'string', enum:['agent','search']}, reason:{type:'string'} } } } } }
// AUDIT: exec-one 부모 감사 노드 산출 — 전체 완결성 인증.
const AUDIT_SCHEMA = { type:'object', required:['complete','verdict'], properties:{
  complete:{type:'boolean'}, gaps:{type:'array', items:{type:'string'}}, contradictions:{type:'array', items:{type:'string'}}, sufficiency:{type:'string'}, verdict:{type:'string'} } }

// 원장 줄 = [id] [badge] (category?) title — classify 는 [id] 로 배정한다(category 는 classify 전엔 빈 칸).
const ledgerView = (items) => items.map(t => `- [${t.id}] [${t.badge||PENDING}]${t.category ? ' ('+t.category+')' : ''} ${t.title}${t.verified_value ? ' | 근거: '+t.verified_value : ''}`).join('\n')

## 역할 프롬프트 + VERIFY_TMPL(정규화 템플릿) + verifyVars (draft.js 원문)
const genPrompt = `${COMMON}

YOUR ROLE — GENERATOR: turn the directive into a BACKLOG CHUNK (덩어리) — a title for the whole + the full FLAT set of REQUIREMENTS. **You do NOT classify.** Categorization is a LATER review step (classify), run after the set is complete; here you only DISCOVER.

1) CHUNK TITLE: if the directive states or clearly implies a name for the whole, EXTRACT it (titleOrigin "user"); else GENERATE a short faithful title from its real intent (titleOrigin "agent"). One short noun phrase in the directive's language — the name a practitioner files this backlog under.
2) REQUIREMENTS — **INTERPRET, do NOT echo.** Read the directive's real intent; never pass surface phrasing through verbatim. A terse directive bundles several DISTINCT requirements in one run-on clause — split each into its OWN atomic item (title = the imperative requirement in 입력 언어, description = one line of what it must do / why make-or-break). ATOMIC: split bundled DISTINCT requirements; never split ONE requirement into its implementation beats.
   **GENERATION IS GENEROUS — cast WIDE.** Include EVERY plausible make-or-break (content, structural/craft, operational, regulated, the back-side). Generosity is SAFE: the per-item verifier grounds each and rejects (x) any that does not hold — better to slightly OVER-include than to miss one. No cap, no stinginess; this set must be COMPLETE. Obey the INVARIANTS. origin = "user" if the directive states/implies it, "agent" if you derive it as a make-or-break the directive never stated. You cannot search here. There is NO optional tier — a nice-to-have is NOT a requirement.
   **DO NOT group, do NOT invent a category dimension, do NOT prune to fit a frame.** Pre-classifying prunes topics outside the frame and breaks completeness — emit requirements[] FLAT. The classify step (after hunt completes the set) invents the dimension and assigns categories then.

Directive: "${DIRECTIVE}"`

// [Ground 노드 — exec-one per 항목] 한 요건의 oxf 판정. 노드 1개 = 요건 1개. self-contained(전체 원장 없이 그 요건만 판정).
// 프롬프트 정규화(콘텐츠 주소화): 클로저 대신 {{key}} 마커 템플릿 상수. COMMON·역할 본문은 고정(전 item 공유),
// 요건별 값(category/title/description)과 directive 는 vars 로 분리 → 템플릿은 draft·item 무관 완전 고정 = sha256 1 row.
// 소비 시점(kanban prompt.resolve)에 {{key}}→vars 치환. item 노드 body 엔 promptHash+vars 만(완성 프롬프트 안 박음).
const VERIFY_TMPL = `${COMMON}

YOUR ROLE — VERIFIER (hostile). Verify ONE requirement — judge whether it is a real, grounded make-or-break. Do NOT propose new ones (a separate step).

REQUIREMENT:
- {{title}} — {{description}}

Pick the method by GROUNDING (SHARED CONCEPTS): could you be WRONG from memory → WebSearch the specific (verified_value = fact + source); reliably know it → verify by REASONING (necessary AND sound? verified_value = why required/sound).
Then judge the OUTCOME — YOU decide the severity (field "oxf"):
- holds AND is a real requirement → oxf "o" + origin + verified_value + sources + reason.
- NOT a real requirement (wrong / unnecessary / out-of-scope / a duty the directive disclaims) → "x" + reason — a minor, LEGITIMATE off, NOT a failure (the result still stands without it; the node is KEPT, badge x, not removed).
- CRITICAL break — the directive is self-contradictory or rests on an impossible premise, OR this core make-or-break is fundamentally unverifiable AND fatal so the whole result cannot stand → "f" + reason. Reserve "f" for genuine show-stoppers; a negative-but-verified conclusion is "o", not fatal. (Chunk-level f≥1 → discard is decided later by the audit, not here.)
Set ORIGIN to how it is BACKED, record that backing in verified_value: "user" (directive states/implies it → its own words) / "agent" (you reasoned it → the knowledge basis, WHY required/sound) / "search" (grounded externally → fact + quoted passage, sources = URLs).
"x" ≠ a failed search: if a NEEDED WebSearch ERRORS/empty (529), retry — do NOT "x".

Directive: "{{directive}}"

Do any needed search first (only if fact-hinged). FINAL message = ONLY this JSON.`
// item vars 헬퍼 — 옛 클로저의 fallback(||'미분류', ||'') 를 미리 계산해 vars 로(소비 시점 치환 결과가 옛 렌더와 byte 동일).
const verifyVars = (item) => ({ title: item.title, description: item.description || '' })   // category 없음(검증 시점엔 미분류). directive 는 vars 아님 — varRefs 로 콘텐츠 주소 참조(청크당 1행). {{directive}} 는 소비 시점 deref.

// [Hunt 노드 — exec-one] 전체 원장에서 누락 make-or-break 도출(certify-whole lens). 추가 항목 → 검수전 → 재검증.
const huntPrompt = (all) => `${COMMON}

YOUR ROLE — VERIFIER (hostile). CERTIFY THE WHOLE, not the parts. A part-by-part "o" does NOT mean the result works — certify the ASSEMBLED set delivers the goal. The generator is an LLM; DISTRUST the list. Run ALL FIVE checks; request what each surfaces (→ additions, each a new requirement: title + description + category):
  - GOAL-REACH: state, in your reasoning, what the result must ACHIEVE for the requester beneath the surface, then check the ledger reaches it. If the core outcome rests on an impossible/unverified premise, VERIFY it (search if external) and request the feasibility precondition. Never assume the premise holds.
  - CONTRADICTION: mentally BUILD the whole toward that goal. Where two requirements conflict so a builder is BLOCKED until one is overruled, request the requirement that RESOLVES which wins.
  - SEAM: where the JOIN between two requirements is owned by neither and a builder must GUESS a make-or-break decision, request the rule that OWNS the join.
  - DEPTH: apply EXPERT STANCE + LEGAL LENS to every named/regulated requirement — does it state the SPECIFIC obligation/trigger the law compels, or stop at the category? If only the category, request the specific one.
  - DOMAIN-FAILURE: as the senior practitioner, put the result as-built into ACTUAL use over time — beyond logical reach, what FAILS in PRACTICE that a part-by-part check misses? Request the make-or-break that prevents it. Stay inside the directive's stated scope.
Do NOT request nice-to-haves. Do NOT re-request what the ledger covers (NO DUPLICATE — by MEANING). Additions are FLAT requirements (title + description + origin) — do NOT categorize; the classify step (which runs AFTER you) invents the dimension over the COMPLETE set. ZERO additions is the correct, expected answer for a complete ledger — a forced requirement is worse than none. Over-enumeration is failure.

Full ledger (propose ONLY missing make-or-breaks; do NOT re-verify these):
${ledgerView(all)}

Directive: "${DIRECTIVE}"

Do any needed search first. FINAL message = ONLY this JSON.`

// [Classify 노드 — exec-one] 검토·분류: hunt 까지 완성된 전체 원장을 보고 분류 차원 발명 + 각 요건(id)에 카테고리 배정.
// 새 요건 X, reparent X — 기존 항목에 카테고리 메타만. reconcileStage 가 assignments 로 node.edit(category).
const classifyPrompt = (all) => `${COMMON}

YOUR ROLE — CLASSIFIER (검토·분류). 생성·누락탐색이 끝났다 — 아래 원장이 **완성된 전체 요건**이다. 새 요건을 만들지 마라(그건 hunt 몫). 전체를 senior practitioner 로서 읽고, 이 도메인에 맞는 분류 차원 하나를 INVENT 한 뒤, 모든 요건을 정확히 한 카테고리로 배정한다.
  - DIMENSION: 이 도메인에 맞는 차원 하나를 발명(a system: 기능 영역; a novel: 막/장; a plan: 국면; a climb: 구간 — 고정 분류법 금지, directive 와 실제 요건들에서 도출). **집합이 이미 완성됐으니(hunt 후) 프레임 밖 토픽이 잘릴 위험이 없다 — 그래서 생성이 아니라 여기서 분류한다.**
  - ASSIGN: 원장의 모든 항목을 그 차원의 카테고리로. assignments[] 각 원소 = {id(원장 줄 맨 앞 [id]), category}. 모든 id 를 정확히 한 번씩, 정확히 한 카테고리로. category 는 짧은 명사구(입력 언어). 카테고리 수는 집합이 정하게 — 억지로 늘리거나 줄이지 마라.

완성된 전체 원장(각 줄 맨 앞 [id] 로 배정):
${ledgerView(all)}

Directive: "${DIRECTIVE}"

FINAL message = ONLY this JSON.`

// [Audit 노드 — exec-one] 부모 감사: 전체 집합 완결성 인증(부품 아닌 전체). 누락/모순/충분 → 한 verdict.
const auditPrompt = (all) => `${COMMON}

YOUR ROLE — AUDITOR (the backlog chunk's parent certification). The per-item badges are already set. Your job is NOT to re-judge items one by one — CERTIFY THE WHOLE ASSEMBLED SET (부품 아닌 전체): does this set, taken together, deliver the directive's goal completely and coherently? Judge three axes, give ONE verdict:
  - 누락 (gaps): any make-or-break MISSING that the goal cannot stand without? List each (empty if none).
  - 모순 (contradictions): any two requirements conflict so a builder is blocked until one is overruled? List each (empty if none).
  - 충분 (sufficiency): assembled, does the set REACH the goal — not just cover the surface? State plainly whether it suffices and why.
Set complete=true ONLY if no goal-breaking gaps, no unresolved contradictions, and the set genuinely suffices. verdict = one paragraph: what the assembled draft achieves and the single most important thing still missing or wrong (or "완결" if none). Do NOT pad. Stay inside the directive's stated scope.

Full ledger (CERTIFY this whole):
${ledgerView(all)}

Directive: "${DIRECTIVE}"

Do any needed search first. FINAL message = ONLY this JSON.`

// ════════════════════════════════════════════════════════════════════════════

## stage 발행 패턴 (draft.js 원문 — 정규화 promptRole+vars+registerPrompts)
if (STAGE === 'generate') {
  const tree = await agent(genPrompt, { label: '요건 도출', schema: GEN_SCHEMA })   // 실행(발굴만 — 분류 안 함)
  const reqs = (tree && tree.requirements) || []
  const itemIds = []   // 발행한 항목 nodeId — hunt/classify/audit blockedBy
  // 프롬프트 정규화: verify 템플릿 등록(registerPrompts)을 첫 항목 발행에 얹는다(별도 노드 없이 — 보드 오염 0).
  // main.js relay 가 sha256·dedup 후 role→hash 맵 채움 → 이후 item 이 promptRole:'verify' 로 참조. 1회만.
  let registered = false
  let ii = 0
  for (const it of reqs) {
    if (it && it.title) {
      const iid = 'i' + ii
      // 정규화 항목: 1번째 인자 빈 문자열. **CHUNK_REF 직속 — 그룹 없음, category 없음. 분류는 classify 가 나중에 node.edit 로.**
      const itemOpts = { publish: true, kind: 'item', nodeId: iid, parent: CHUNK_REF,
        title: it.title, description: it.description || '', origin: it.origin, badge: PENDING, schema: VERIFY_SCHEMA,
        promptRole: 'verify', vars: verifyVars({ title: it.title, description: it.description }), varRefs: { directive: 'directive' } }
      if (!registered) { itemOpts.registerPrompts = { verify: VERIFY_TMPL, directive: DIRECTIVE }; registered = true }
      await agent('', itemOpts)
      itemIds.push(iid)
    }
    ii = ii + 1
  }
  // task 노드 발행 — blockedBy 사슬로 순서: hunt(항목 검증 후) → classify(hunt 후 = 완성 집합) → audit(classify 후).
  await agent('', { publish: true, kind: 'task', stage: 'hunt', nodeId: 'hunt', parent: CHUNK_REF, title: '누락 탐색', blockedBy: itemIds })
  await agent('', { publish: true, kind: 'task', stage: 'classify', nodeId: 'classify', parent: CHUNK_REF, title: '분류', blockedBy: itemIds.concat(['hunt']) })
  await agent('', { publish: true, kind: 'task', stage: 'audit', nodeId: 'audit', parent: CHUNK_REF, title: '부모 감사', blockedBy: itemIds.concat(['hunt', 'classify']) })
  return { chunkTitle: (tree && tree.title) || '', titleOrigin: (tree && tree.titleOrigin) || 'agent' }   // reconcileStage: chunkTitle → 덩어리 title 갱신
}

// ── stage: hunt — huntPrompt(ledger) 실행 → 누락 항목. 추가 항목 발행(검수전 → 같은 verifyPrompt). ──
if (STAGE === 'hunt') {
  const r = await agent(huntPrompt(LEDGER), { label: '누락 탐색', schema: HUNT_SCHEMA })   // 실행
  const additions = (r && r.additions) || []
  let ai = 0
  // hunt 추가항목도 verify 템플릿 참조(promptRole:'verify'). 템플릿은 generate 단계서 이미 등록(같은 sha256 → dedup, 재등록해도 무해).
  for (const a of additions) {
    if (a && a.title) {
      await agent('', { publish: true, kind: 'item', nodeId: 'add' + ai, parent: CHUNK_REF,
        title: a.title, description: a.description || '', origin: a.origin, badge: PENDING, schema: VERIFY_SCHEMA,
        promptRole: 'verify', vars: verifyVars({ title: a.title, description: a.description }), varRefs: { directive: 'directive' },
        registerPrompts: ai === 0 ? { verify: VERIFY_TMPL, directive: DIRECTIVE } : undefined })   // 첫 추가항목에 verify+directive 재등록(hunt 단독 재실행 대비)
    }
    ai = ai + 1
  }
  // 추가 항목은 CHUNK_REF 직속(flat, category 없음) — 분류는 이후 classify stage 가 완성 집합 보고. return 무관(reconcileStage children relay).
  return {}
}

// ── stage: classify — classifyPrompt(ledger) 실행(hunt 후 완성 집합) → {dimension, assignments}. main.js reconcileStage 가 assignments 로 각 항목 node.edit(category). ──
if (STAGE === 'classify') {
  const r = await agent(classifyPrompt(LEDGER), { label: '분류', schema: CLASSIFY_SCHEMA })   // 검토(완성 집합 → 분류 차원 + id 배정)
  // reconcileStage: result.assignments([{id,category}]) → 각 항목 node.edit(category); dimension 은 덩어리 result 에.
  return { dimension: (r && r.dimension) || '', assignments: (r && r.assignments) || [] }
}

// ── stage: audit — auditPrompt(ledger) 실행 → 완결성 verdict. main.js 가 덩어리 result 에 기록. 폐기(f≥1)는 칸반 subValidation 이 badge 로 계산. ──
if (STAGE === 'audit') {
  const audit = await agent(auditPrompt(LEDGER), { label: '부모 감사', schema: AUDIT_SCHEMA })   // 실행
  // reconcileStage: result.verdict(top-level) → 덩어리 node.result. classifyResult: complete/verdict → audit.
  return { verdict: (audit && audit.verdict) || '(감사 결과 없음)', complete: !!(audit && audit.complete) }
}

// ── skeleton(--emit, claude 0): 덩어리(isDraft) + Generate 노드(kind:task, stage:'generate'). main.js 가 task body 에 skeleton+directive 임베드. ──
await agent('', { publish: true, kind: 'chunk', nodeId: CHUNK_REF, isDraft: true, parentDraftId: parentDraftId || '',
  title: (args && args.title) || '구체화 덩어리', description: DIRECTIVE })   // 발행(덩어리 — title 은 generate 가 갱신)
await agent('', { publish: true, kind: 'task', stage: 'generate', nodeId: 'gen', parent: CHUNK_REF, title: '요건 도출' })   // 발행(Generate 노드: stage='generate'→ev.stage 필드→task body.stage. skeleton/directive 는 main.js relay 가 임베드)

## 지시
위 원문(COMMON·스키마·역할 프롬프트·VERIFY_TMPL·발행)을 그대로 반영해, 사용자 아이디어(아래)를 draft 역할 JS 워크플로로 작성.
**절차는 5개**: generate(평탄 발굴) → verify(항목별 oxf) → hunt(누락 보강) → **classify(hunt 뒤, 완성 집합 분류)** → audit(전체 감사). **generate 는 category 를 정하지 않는다(그룹·category 필드 금지) — 항목은 CHUNK_REF 직속 flat.** 분류는 classify stage 가 완성 원장(id) 보고 배정.
**item agent 는 반드시 정규화 형태**: `agent('', {publish:true, kind:'item', nodeId, parent:CHUNK_REF, title, description, origin, badge:'검수전', schema:VERIFY_SCHEMA, promptRole:'verify', vars:verifyVars({title,description}), varRefs:{directive:'directive'}})` — **1번째 인자는 빈 문자열('')**. **category 를 항목에 넣지 마라(분류는 classify).** 완성 프롬프트를 body 에 박지 말고 promptRole+vars+varRefs 로 참조. VERIFY_TMPL 은 {{title}}/{{description}}/{{directive}} 마커 템플릿(category 없음). 첫 항목 발행에 registerPrompts:{verify:VERIFY_TMPL, directive:DIRECTIVE} 1회. **directive 는 vars 아님 — varRefs 로 콘텐츠 주소 참조(항목마다 1.1KB 복붙 방지).**
**절대 verifyPrompt(it) 를 1번째 인자로 넣지 마라(옛 방식 — 8.7KB 중복).** **절대 JSON.stringify(데이터)를 1번째 인자로 넣지 마라.** 순수 JS 본문만 출력(마크다운 펜스·설명 없이).
