export const meta = {
  name: 'draft',
  description: 'DRAFT 워크플로 — 아이디어(DIRECTIVE)를 백로그 덩어리로 구체화. (Y) exec-stage: stage 별로 호출(generate/hunt/audit). generate 가 genPrompt 실행→트리→그룹/항목 NodeEvent 발행(항목 body=verifyPrompt). 항목 검증=exec-one(verifyPrompt→oxf), 누락=hunt, 완결성=audit. f≥1 → 덩어리 폐기 → 복제 재제출.',
}

// 통합 모델 (Y) skeleton-emit + exec-stage 동적 발행 (규칙 C — 발행≠실행):
//   호스트: exec-stage 가 이 워크플로를 ClaudeEmitHost 로 stage 별 호출. agent(prompt, opts) 의 opts.publish 로 분기:
//     - opts.publish 없음 → claude 실행(genPrompt/huntPrompt/auditPrompt = 진짜 LLM).
//     - opts.publish:true → claude 안 돌리고 NodeEvent::Add 발행만(stub 반환, 데이터흐름 유지). main.js relay→node.add.
//   트리 중첩 = opts.nodeId(자기 id) + opts.parent(부모 ref). chunkRef=기존 덩어리 kanban id(exec-stage args). blockedBy=opts.blockedBy(→ev.blockedBy, main.js keyOf 해석).
//   규칙 B 3축: title(요건명)=opts.title / description(요건설명)=opts.description / body(exec 입력)=agent 1번째 인자.
//     → 항목(kind:item) NodeEvent: title→node.title, description→node.description(표시), prompt(verifyPrompt)→node.body(exec-one 입력). verifyPrompt 단일진실(draft.js).
//     → stage 노드(kind:task) 의 stage = opts.stage('generate'|'hunt'|'audit') → ev.stage 필드 → main.js 가 {skeleton,stage,args} task body 임베드(draft.js 무관여). prompt 는 비운다.
//   흐름: --emit 골격(덩어리 isDraft + Generate 노드 kind:task) → reconcile(kind:task)→exec-stage(generate) → 그룹/항목 + Hunt/Audit task 노드 발행
//         → 각 항목 reconcile(kind:item)→exec-one(verifyPrompt)→badge=oxf → Hunt/Audit reconcile→exec-stage(hunt/audit, ledger=main.js materialize).
//   클론 서브셋: ForOf+While 만(C-style for 금지), 정규식 금지, schema named const, Date.now/Math.random 금지.

// ── 검증 배지(규칙 D) — Phase 2 칸반 Badge 와 동일 값. 검수전(기본) → o/x/f. status 축과 별개.
const PENDING = '검수전'   // 검증 배지 초기값(드래프트 항목). o/x/f 는 검증(exec-one)이 매김.

// ── 입력 DIRECTIVE — args 우선(string | {directive|DIRECTIVE|IDEA}), 없으면 표준 샘플(약국 SaaS, e2e 검증용).
const SAMPLE_DIRECTIVE = `방문자가 방문을 하면 병원을 생성할수있다. 병원을 생성하고 약 보관함(오프라인)를 온라인 약 보관함(캐니스터)를 생성을 하고 오프라인의 약갯수와 캐니스터의 약 보관상태를 동기화 시키고 관리할수있게 하는 서비스다. 하나의 캐니스터에는 한 종류의 약이 들어간다. 약은 같은 약이라도 제형, 용량, 용법 등에 따라서도 다른 약으로 취급한다. 쪼개쓰는 약도 존재하므로 단위를 1/2 1/4 1/12까지 설정가능하도록 하되 기본은 1이다. 캐니스터(약 보관함)를 생성하면 기본 100개의 슬롯이 세팅된다. 수정하면 200개 슬롯까지 가능하다. 캐니스터에 들어가지 못하는 약은 창고에 있고 창고도 연결가능해야한다. 같은 약이 창고에 있을수도 캐니스터에 나눠져있을수도 있다. 재고 숫자는 수기로 세어서 업데이트한다. 재고를 아는게 목적이다. 권한자만 구매요청 가능, 자기 거래처(약 도매상)를 스스로 등록한다. 비급여는 구매자(병원)가 가격을 모름(거래를 한번하면 그 가격으로 재구매). 거래처로 구매내역 전송→푸시/알림톡→판매자 주문확인·패키지변경·약값 보정 후 컨펌 요청. 재고 수정시 누가 어떤 이유로 수정했는지 대장(문서)로 확인, 권한자 승인(감사 증빙), PDF 다운로드. SaaS, MVP 넘어 엔터프라이즈급.`

// ── SHARED CONCEPTS (verbatim) — 무엇이 REQUIREMENT/MAKE-OR-BREAK 인가, EXPERT STANCE, BACK-SIDE, GROUNDING, INVARIANTS.
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

// ── 입력 해석 + 복제 계보(parentDraftId, 덩어리 수준만 — 개선본 재제출 시 args 로 주입).
let DIRECTIVE = ''
if (args && args.split) DIRECTIVE = args
else if (args && args.directive) DIRECTIVE = args.directive
else if (args && args.DIRECTIVE) DIRECTIVE = args.DIRECTIVE
else if (args && args.IDEA) DIRECTIVE = args.IDEA
if (!DIRECTIVE) DIRECTIVE = SAMPLE_DIRECTIVE
const parentDraftId = (args && args.parentDraftId) || null

// ── 스키마 (named top-level const — 클론 서브셋 요구) ──
// GEN: Generate 가 전체 드래프트 트리를 낸다. main.js 발행 매핑: title→덩어리.title / raw=DIRECTIVE→덩어리.body / isDraft=true,
//      groups[].category→그룹노드.title / groups[].items[]→항목노드{title, body=description, badge=검수전, origin}.
const GEN_SCHEMA = { type:'object', required:['title','groups'], properties:{
  title:{type:'string'}, titleOrigin:{type:'string', enum:['user','agent']},
  groups:{ type:'array', items:{ type:'object', required:['category','items'], properties:{
    category:{type:'string'},
    items:{ type:'array', items:{ type:'object', required:['title','description','origin'], properties:{
      title:{type:'string'}, description:{type:'string'}, origin:{type:'string', enum:['user','agent']} } } } } } } } }
// VERIFY: exec-one 항목 노드 1개 산출(oxf 판정 문서). 필드명 oxf — exec_one.extract_oxf 가 oxf|verdict 에서 배지 추출 → node.edit(badge).
const VERIFY_SCHEMA = { type:'object', required:['oxf','origin'], properties:{
  oxf:{type:'string', enum:['o','x','f']}, origin:{type:'string', enum:['user','agent','search']},
  verified_value:{type:'string'}, sources:{type:'array', items:{type:'string'}}, reason:{type:'string'} } }
// HUNT: exec-one 누락 탐색 노드 산출 — 추가 항목(검수전 → 다시 검증).
const HUNT_SCHEMA = { type:'object', required:['additions'], properties:{ additions:{ type:'array', items:{ type:'object', required:['title','description','category','origin'], properties:{
  title:{type:'string'}, description:{type:'string'}, category:{type:'string'}, origin:{type:'string', enum:['agent','search']}, reason:{type:'string'} } } } } }
// AUDIT: exec-one 부모 감사 노드 산출 — 전체 완결성 인증.
const AUDIT_SCHEMA = { type:'object', required:['complete','verdict'], properties:{
  complete:{type:'boolean'}, gaps:{type:'array', items:{type:'string'}}, contradictions:{type:'array', items:{type:'string'}}, sufficiency:{type:'string'}, verdict:{type:'string'} } }

const ledgerView = (items) => items.map(t => `- [${t.badge||PENDING}] (${t.category||'미분류'}) ${t.title}${t.verified_value ? ' | 근거: '+t.verified_value : ''}`).join('\n')

// ── 프롬프트 ──
// [Generate 노드] 전체 드래프트 트리 산출 — 덩어리 제목(추출/생성) + 기능 generous 도출 + category 사후 군집.
const genPrompt = `${COMMON}

YOUR ROLE — GENERATOR: turn the directive into a BACKLOG CHUNK (덩어리) — a title for the whole + the full set of REQUIREMENTS, clustered into categories.

1) CHUNK TITLE: if the directive states or clearly implies a name for the whole, EXTRACT it (titleOrigin "user"); else GENERATE a short faithful title from its real intent (titleOrigin "agent"). One short noun phrase in the directive's language — the name a practitioner files this backlog under.
2) REQUIREMENTS — **INTERPRET, do NOT echo.** Read the directive's real intent; never pass surface phrasing through verbatim. A terse directive bundles several DISTINCT requirements in one run-on clause — split each into its OWN atomic item (title = the imperative requirement in 입력 언어, description = one line of what it must do / why make-or-break). ATOMIC: split bundled DISTINCT requirements; never split ONE requirement into its implementation beats.
   **GENERATION IS GENEROUS — cast WIDE.** Include EVERY plausible make-or-break (content, structural/craft, operational, regulated, the back-side). Generosity is SAFE: the per-item verifier grounds each and rejects (x) any that does not hold — better to slightly OVER-include than to miss one. No cap, no stinginess; this set must be COMPLETE. Obey the INVARIANTS. origin = "user" if the directive states/implies it, "agent" if you derive it as a make-or-break the directive never stated. You cannot search here. There is NO optional tier — a nice-to-have is NOT a requirement.
3) CATEGORY is a POST-HOC LABEL — **cluster AFTER generating, never pre-classify.** First generate requirements generously; THEN read THIS domain as the senior practitioner and INVENT the classification dimension that fits it (a system: 기능 영역; a novel: 막/장; a plan: 국면; a climb: 구간 — you decide the dimension and labels from the directive, never a fixed taxonomy). Pre-classifying prunes topics outside the frame and breaks completeness — generate first, group second. Emit groups[] where each group = {category, items[]}; every requirement lands in exactly one group.

Directive: "${DIRECTIVE}"`

// [Ground 노드 — exec-one per 항목] 한 요건의 oxf 판정. 노드 1개 = 요건 1개. self-contained(전체 원장 없이 그 요건만 판정).
const verifyPrompt = (item) => `${COMMON}

YOUR ROLE — VERIFIER (hostile). Verify ONE requirement — judge whether it is a real, grounded make-or-break. Do NOT propose new ones (a separate step).

REQUIREMENT:
- (${item.category||'미분류'}) ${item.title} — ${item.description||''}

Pick the method by GROUNDING (SHARED CONCEPTS): could you be WRONG from memory → WebSearch the specific (verified_value = fact + source); reliably know it → verify by REASONING (necessary AND sound? verified_value = why required/sound).
Then judge the OUTCOME — YOU decide the severity (field "oxf"):
- holds AND is a real requirement → oxf "o" + origin + verified_value + sources + reason.
- NOT a real requirement (wrong / unnecessary / out-of-scope / a duty the directive disclaims) → "x" + reason — a minor, LEGITIMATE off, NOT a failure (the result still stands without it; the node is KEPT, badge x, not removed).
- CRITICAL break — the directive is self-contradictory or rests on an impossible premise, OR this core make-or-break is fundamentally unverifiable AND fatal so the whole result cannot stand → "f" + reason. Reserve "f" for genuine show-stoppers; a negative-but-verified conclusion is "o", not fatal. (Chunk-level f≥1 → discard is decided later by the audit, not here.)
Set ORIGIN to how it is BACKED, record that backing in verified_value: "user" (directive states/implies it → its own words) / "agent" (you reasoned it → the knowledge basis, WHY required/sound) / "search" (grounded externally → fact + quoted passage, sources = URLs).
"x" ≠ a failed search: if a NEEDED WebSearch ERRORS/empty (529), retry — do NOT "x".

Directive: "${DIRECTIVE}"

Do any needed search first (only if fact-hinged). FINAL message = ONLY this JSON.`

// [Hunt 노드 — exec-one] 전체 원장에서 누락 make-or-break 도출(certify-whole lens). 추가 항목 → 검수전 → 재검증.
const huntPrompt = (all) => `${COMMON}

YOUR ROLE — VERIFIER (hostile). CERTIFY THE WHOLE, not the parts. A part-by-part "o" does NOT mean the result works — certify the ASSEMBLED set delivers the goal. The generator is an LLM; DISTRUST the list. Run ALL FIVE checks; request what each surfaces (→ additions, each a new requirement: title + description + category):
  - GOAL-REACH: state, in your reasoning, what the result must ACHIEVE for the requester beneath the surface, then check the ledger reaches it. If the core outcome rests on an impossible/unverified premise, VERIFY it (search if external) and request the feasibility precondition. Never assume the premise holds.
  - CONTRADICTION: mentally BUILD the whole toward that goal. Where two requirements conflict so a builder is BLOCKED until one is overruled, request the requirement that RESOLVES which wins.
  - SEAM: where the JOIN between two requirements is owned by neither and a builder must GUESS a make-or-break decision, request the rule that OWNS the join.
  - DEPTH: apply EXPERT STANCE + LEGAL LENS to every named/regulated requirement — does it state the SPECIFIC obligation/trigger the law compels, or stop at the category? If only the category, request the specific one.
  - DOMAIN-FAILURE: as the senior practitioner, put the result as-built into ACTUAL use over time — beyond logical reach, what FAILS in PRACTICE that a part-by-part check misses? Request the make-or-break that prevents it. Stay inside the directive's stated scope.
Do NOT request nice-to-haves. Do NOT re-request what the ledger covers (NO DUPLICATE — by MEANING). Tag each addition with the SAME category dimension the generator used. ZERO additions is the correct, expected answer for a complete ledger — a forced requirement is worse than none. Over-enumeration is failure.

Full ledger (propose ONLY missing make-or-breaks; do NOT re-verify these):
${ledgerView(all)}

Directive: "${DIRECTIVE}"

Do any needed search first. FINAL message = ONLY this JSON.`

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
// (Y) exec-stage 디스패치 — exec-stage 가 stage 별로 이 워크플로를 호출한다.
const STAGE = (args && args.stage) || ''
const CHUNK_REF = (args && args.chunkRef) || 'chunk'   // 기존 덩어리 kanban id(skeleton 에서 발행됨; exec-stage args 로 주입)
const LEDGER = (args && args.ledger) || []             // exec-stage 가 칸반 상태(검증된 항목)에서 materialize → hunt/audit 에 주입

// ── stage: generate — genPrompt 실행 → 트리. 그룹/항목 발행 + Hunt/Audit task 노드 발행(blockedBy=항목 검증). ──
if (STAGE === 'generate') {
  const tree = await agent(genPrompt, { label: '요건 도출', schema: GEN_SCHEMA })   // 실행(claude; publish 없음)
  const groups = (tree && tree.groups) || []
  const itemIds = []   // 발행한 항목 nodeId — Hunt/Audit blockedBy(전 항목 검증 후 실행)
  let gi = 0
  for (const g of groups) {
    if (g && g.category) {
      const gid = 'g' + gi
      await agent('', { publish: true, kind: 'group', nodeId: gid, parent: CHUNK_REF, title: g.category, category: g.category })   // 발행(그룹)
      let ii = 0
      for (const it of (g.items || [])) {
        if (it && it.title) {
          const iid = gid + 'i' + ii
          await agent(verifyPrompt(it), { publish: true, kind: 'item', nodeId: iid, parent: gid,
            title: it.title, description: it.description || '', category: g.category, badge: PENDING, schema: VERIFY_SCHEMA })   // 발행(항목 — body=verifyPrompt)
          itemIds.push(iid)
        }
        ii = ii + 1
      }
    }
    gi = gi + 1
  }
  // Hunt/Audit task 노드 발행 — stage=opts.stage(→ev.stage 필드→task body.stage). prompt 는 비운다. blockedBy 로 순서(Hunt=항목 검증 후, Audit=항목+Hunt 후).
  await agent('', { publish: true, kind: 'task', stage: 'hunt', nodeId: 'hunt', parent: CHUNK_REF, title: '누락 탐색', blockedBy: itemIds })
  await agent('', { publish: true, kind: 'task', stage: 'audit', nodeId: 'audit', parent: CHUNK_REF, title: '부모 감사', blockedBy: itemIds.concat(['hunt']) })
  return { chunkTitle: (tree && tree.title) || '', titleOrigin: (tree && tree.titleOrigin) || 'agent' }   // reconcileStage: chunkTitle → 덩어리 title 갱신
}

// ── stage: hunt — huntPrompt(ledger) 실행 → 누락 항목. 추가 항목 발행(검수전 → 같은 verifyPrompt). ──
if (STAGE === 'hunt') {
  const r = await agent(huntPrompt(LEDGER), { label: '누락 탐색', schema: HUNT_SCHEMA })   // 실행
  const additions = (r && r.additions) || []
  let ai = 0
  for (const a of additions) {
    if (a && a.title) {
      await agent(verifyPrompt(a), { publish: true, kind: 'item', nodeId: 'add' + ai, parent: CHUNK_REF,
        title: a.title, description: a.description || '', category: a.category || '미분류', badge: PENDING, schema: VERIFY_SCHEMA })   // 발행
    }
    ai = ai + 1
  }
  // 추가 항목은 CHUNK_REF 직속 발행(children) — main.js 가 category 로 기존 그룹 합류/새 그룹. return 은 무관(reconcileStage 가 children relay).
  return {}
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
return { emitted: 'skeleton', chunk: CHUNK_REF }
