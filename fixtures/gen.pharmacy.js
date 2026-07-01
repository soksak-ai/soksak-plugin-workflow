export const meta = {
  name: 'draft',
  description: 'DRAFT 워크플로 — 아이디어(DIRECTIVE)를 백로그 덩어리로 구체화. exec-stage 가 stage(generate/hunt/audit) 별로 호출. generate=genPrompt 실행→그룹/항목 발행(항목 body=verifyPrompt), 항목 검증=exec-one, 누락=hunt, 완결성=audit.',
}

// ── 입력 DIRECTIVE — args 우선(string | {directive|DIRECTIVE|IDEA}). 클론 VM: string 은 typeof 로 판정(member 접근 X).
const IDEA = `방문자가 방문을 하면 병원을 생성할수있다. 병원을 생성하고 약 보관함(오프라인)를 온라인 약 보관함(캐니스터)를 생성을 하고 오프라인의 약갯수와 캐니스터의 약 보관상태를 동기화 시키고 관리할수있게 하는 서비스다. 하나의 캐니스터에는 한 종류의 약이 들어간다. 약은 같은 약이라도 제형, 용량, 용법 등에 따라서도 다른 약으로 취급한다. 쪼개쓰는 약도 존재하므로 단위를 1/2 1/4 1/12까지 설정가능하도록 하되 기본은 1이다. 캐니스터(약 보관함)를 생성하면 기본 100개의 슬롯이 세팅된다. 수정하면 200개 슬롯까지 가능하다. 캐니스터에 들어가지 못하는 약은 창고에 있고 창고도 연결가능해야한다. 같은 약이 창고에 있을수도 캐니스터에 나눠져있을수도 있다. 재고 숫자는 수기로 세어서 업데이트한다. 재고를 아는게 목적이다. 캐니스터의 슬롯에 재고가 들어가는 개념이다(슬롯은 약을 담는 위치/약통일 뿐, 슬롯 수가 재고 수량을 제한하지 않는다). 캐니스터 상세보기 화면에서 해당 약의 다른 캐니스터 슬롯위치와 창고위치등에 있는 같은약도 일목요연하게 볼수있다. 캐니스터명은 수정 가능하다. 병원을 여러개 만들수있는건 유료 구독자다(회원 등급/권한 존재). 구매기능이 있으나 결제는 안한다. 권한자만 구매요청 가능, 자기 거래처(약 도매상)를 스스로 등록한다(전화번호/이름). 캐니스터에 약 세팅 후 구매페이지에서 세팅한 약들이 엑셀리스트처럼 보이고 수량 조절·약판매자 연결하면 거래처와 약품이 연결된다. 약은 정가/비급여가 있다. 비급여는 구매자(병원)가 판매자가 병원에 공급가로 정하므로 가격을 모름(거래를 한번하면 그 가격으로 재구매할수있으므로 결국엔 정확한 가격을 알게됨). 거래처로 구매내역 전송→푸시/알림톡 발송→판매자가 주문확인·패키지변경(10개*10개 또는 100개*1개)·약값 보정 후 구매자에게 컨펌 요청. 판매자가 대체 패키지 제안·품절 처리 가능. 구매자는 변동내역·개별가격·총가격 확인 후 승인/취소. 설정에서 대체의약품을 허가하지 않을수있고 품절의경우 주문이 취소된다. 승인시 판매자에 푸시/알림톡→배송·배송번호 입력 또는 자체배송 선택·승인→구매자 대기. 재고 수정시 누가 어떤 이유로 수정했는지 대장(문서)로 확인, 권한자 승인 기능(감사 증빙), PDF 다운로드. SaaS 시스템, MVP 넘어 엔터프라이즈급.`

// ③파생 도메인 힌트 — make-or-break 보조 맥락(강제 아님). generator 가 도메인 불변을 놓치지 않게.
const DOMAIN_HINTS = `

[파생 도메인 make-or-break 힌트 (webservice) — 이 도메인의 불변 후보, 강제 아님:
- 민감 변경(권한 변경·결제·데이터 삭제)에 감사 로그(누가·언제·무엇)를 남긴다 — 사후 추적·규정 준수의 단일 진실은 감사 로그다.
- 사용자 인증·세션 수명주기(로그인/로그아웃/만료/갱신)를 명시한다 — 인증 경계 없는 보호 리소스 노출 금지.
- 권한·역할 모델이 존재하면 권한별 어드민(운영자) 페이지를 필수로 제작한다 — 권한 부여/회수 UI 없는 권한 모델 출시 금지.
- 모든 외부 입력은 서버 측에서 검증한다 — 클라이언트 검증만으로 신뢰 금지.]`

let DIRECTIVE = ''
if (typeof args === 'string') DIRECTIVE = args
else if (args && args.directive) DIRECTIVE = args.directive
else if (args && args.DIRECTIVE) DIRECTIVE = args.DIRECTIVE
else if (args && args.IDEA) DIRECTIVE = args.IDEA
if (!DIRECTIVE) DIRECTIVE = IDEA + DOMAIN_HINTS   // 단독/스켈레톤 실행 시 사용자 아이디어+도메인 힌트를 기본 directive 로.
const parentDraftId = (args && args.parentDraftId) || null

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

const genPrompt = `${COMMON}

YOUR ROLE — GENERATOR: turn the directive into a BACKLOG CHUNK (덩어리) — a title for the whole + the full set of REQUIREMENTS, clustered into categories.

1) CHUNK TITLE: if the directive states or clearly implies a name for the whole, EXTRACT it (titleOrigin "user"); else GENERATE a short faithful title from its real intent (titleOrigin "agent"). One short noun phrase in the directive's language — the name a practitioner files this backlog under.
2) REQUIREMENTS — **INTERPRET, do NOT echo.** Read the directive's real intent; never pass surface phrasing through verbatim. A terse directive bundles several DISTINCT requirements in one run-on clause — split each into its OWN atomic item (title = the imperative requirement in 입력 언어, description = one line of what it must do / why make-or-break). ATOMIC: split bundled DISTINCT requirements; never split ONE requirement into its implementation beats.
   **GENERATION IS GENEROUS — cast WIDE.** Include EVERY plausible make-or-break (content, structural/craft, operational, regulated, the back-side). Generosity is SAFE: the per-item verifier grounds each and rejects (x) any that does not hold — better to slightly OVER-include than to miss one. No cap, no stinginess; this set must be COMPLETE. Obey the INVARIANTS. origin = "user" if the directive states/implies it, "agent" if you derive it as a make-or-break the directive never stated. You cannot search here. There is NO optional tier — a nice-to-have is NOT a requirement.
3) CATEGORY is a POST-HOC LABEL — **cluster AFTER generating, never pre-classify.** First generate requirements generously; THEN read THIS domain as the senior practitioner and INVENT the classification dimension that fits it (a system: 기능 영역; a novel: 막/장; a plan: 국면; a climb: 구간 — you decide the dimension and labels from the directive, never a fixed taxonomy). Pre-classifying prunes topics outside the frame and breaks completeness — generate first, group second. Emit groups[] where each group = {category, items[]}; every requirement lands in exactly one group.

Directive: "${DIRECTIVE}"`

// [Ground 노드 — exec-one per 항목] 한 요건의 oxf 판정. 노드 1개 = 요건 1개. self-contained(전체 원장 없이 그 요건만 판정).
// 프롬프트 정규화(콘텐츠 주소화): 클로저 대신 {{key}} 마커 템플릿 상수. COMMON·역할 본문은 고정(전 item 공유),
// 요건별 값(category/title/description)과 directive 는 vars 로 분리 → 템플릿은 draft·item 무관 완전 고정 = sha256 1 row.
// 소비 시점(kanban prompt.resolve)에 {{key}}→vars 치환. item 노드 body 엔 promptHash+vars 만(완성 프롬프트 안 박음).
const VERIFY_TMPL = `${COMMON}

YOUR ROLE — VERIFIER (hostile). Verify ONE requirement — judge whether it is a real, grounded make-or-break. Do NOT propose new ones (a separate step).

REQUIREMENT:
- ({{category}}) {{title}} — {{description}}

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
const verifyVars = (item) => ({ category: item.category || '미분류', title: item.title, description: item.description || '', directive: DIRECTIVE })

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

// ── stage 라우팅 — exec-stage 가 args.stage 주입. skeleton(--emit)은 stage 없음(''):
const STAGE = (args && args.stage) || ''
const CHUNK_REF = (args && args.chunkRef) || 'chunk'   // 기존 덩어리 kanban id(skeleton 발행분; exec-stage args 주입)
const LEDGER = (args && args.ledger) || []             // hunt/audit 원장(main.js materialize → args.ledger)

if (STAGE === 'generate') {
  const tree = await agent(genPrompt, { label: '요건 도출', schema: GEN_SCHEMA })   // 실행(claude; publish 없음)
  const groups = (tree && tree.groups) || []
  const itemIds = []   // 발행한 항목 nodeId — Hunt/Audit blockedBy(전 항목 검증 후 실행)
  // 프롬프트 정규화: verify 템플릿 등록(registerPrompts)을 첫 그룹 발행에 얹는다(별도 노드 없이 — 보드 오염 0).
  // main.js relay 가 sha256·dedup 후 role→hash 맵 채움 → 이후 item 이 promptRole:'verify' 로 참조. 1회만.
  let registered = false
  let gi = 0
  for (const g of groups) {
    if (g && g.category) {
      const gid = 'g' + gi
      const groupOpts = { publish: true, kind: 'group', nodeId: gid, parent: CHUNK_REF, title: g.category, category: g.category }
      if (!registered) { groupOpts.registerPrompts = { verify: VERIFY_TMPL }; registered = true }
      await agent('', groupOpts)   // 발행(그룹) — 첫 그룹에 verify 템플릿 등록 동봉
      let ii = 0
      for (const it of (g.items || [])) {
        if (it && it.title) {
          const iid = gid + 'i' + ii
          // 정규화 항목: 1번째 인자 빈 문자열(완성 프롬프트 안 박음). promptRole+vars 로 참조 — 소비 시점 조립.
          await agent('', { publish: true, kind: 'item', nodeId: iid, parent: gid,
            title: it.title, description: it.description || '', category: g.category, origin: it.origin, badge: PENDING, schema: VERIFY_SCHEMA,
            promptRole: 'verify', vars: verifyVars({ category: g.category, title: it.title, description: it.description }) })
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
  // hunt 추가항목도 verify 템플릿 참조(promptRole:'verify'). 템플릿은 generate 단계서 이미 등록(같은 sha256 → dedup, 재등록해도 무해).
  for (const a of additions) {
    if (a && a.title) {
      await agent('', { publish: true, kind: 'item', nodeId: 'add' + ai, parent: CHUNK_REF,
        title: a.title, description: a.description || '', category: a.category || '미분류', origin: a.origin, badge: PENDING, schema: VERIFY_SCHEMA,
        promptRole: 'verify', vars: verifyVars({ category: a.category, title: a.title, description: a.description }),
        registerPrompts: ai === 0 ? { verify: VERIFY_TMPL } : undefined })   // 첫 추가항목에 템플릿 재등록(hunt 단독 재실행 대비)
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