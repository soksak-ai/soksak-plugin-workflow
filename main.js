// soksak-plugin-workflow — 워크플로 런타임(rust soksak-workflow)을 spawn 해 칸반에 노드 DAG 를 발행하고,
// 코어 스케줄러(reconcile)로 ready 노드를 exec-one 실행한다. 발행(--emit)과 실행(exec-one)은 분리(규칙 C).
//
// 발행: soksak-workflow --emit → stdout JSON line(노드 이벤트) → 칸반 node.add(locked, 드래프트 마커).
// 실행: app.scheduler.register({trigger: reconcile}) → 'workflow.reconcile' 가 칸반 ready 노드 1개를
//       exec-one(prompt/schema) 으로 검증 → node.edit(badge=oxf, result) → poke 로 다음 깨움.
//       트리거(폴링 0): ①발행 완료 poke ②완료 poke(handler 가 진척 시 self-poke) ③register 시 부팅 1회 스캔.
//       concurrency·lease·backoff(529)는 코어가 처리 — handler 는 ready 1개만 처리하고 poke.

const KANBAN = "plugin.soksak-plugin-kanban";
const SELF = "plugin.soksak-plugin-workflow";
const RECONCILE_CMD = SELF + ".workflow.reconcile";
const RECONCILE_ID = "workflow-reconcile";

// ── 순수 로직(테스트 가능 — app 의존 없음) ──

/** 노드 done 판정(미존재 의존=false, 안전).
 *  항목(kind=item)은 검증 시 badge(o/x/f)만 받고 status 는 영영 todo(execResultToEdit 가 badge 만 박음) —
 *  status 로 판정하면 hunt.blockedBy=[itemIds] 의 depsDone 이 영구 false 라 hunt/audit 가 영영 안 풀린다(deadlock).
 *  항목은 badge 확정(o/x/f)이 done. stage 작업/그룹/덩어리는 status="done" 이 done. */
export function isDone(node) {
  if (!node) return false;
  if (node.kind === "item") return node.badge === "o" || node.badge === "x" || node.badge === "f";
  return node.status === "done";
}

/** ready 노드 = blockedBy 전부 done 인 미완 실행 대상(결정2):
 *  - 드래프트 항목: badge="검수전" ∧ leaf(자식 없음) → exec-one 검증(→배지).
 *  - stage 작업(Generate/Hunt/Audit): kind="task" ∧ status≠done → exec-stage(claude+자식 emit).
 *    stage 노드는 덩어리 밖이라 badge 안 씀(집계 오염 0), status 로 미완 판정(exec 후 done → 재-pick 0).
 *  parallel=형제(blockedBy 없음)·pipeline=체인(blockedBy)은 노드 데이터로만 표현 — 여긴 그걸 읽어 판정. */
export function pickReady(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  const byId = new Map(list.map((n) => [n.id, n]));
  const hasChild = new Set();
  for (const n of list) if (n.parentId) hasChild.add(n.parentId);
  const depsDone = (n) => (n.blockedBy || []).every((b) => isDone(byId.get(b)));
  // #6 audit 게이트 — 부모 사슬로 chunkId 자손인가(buildLedger 와 동일 climb).
  const descends = (n, chunkId) => {
    let p = n.parentId;
    let guard = 0;
    while (p && guard++ < 100) {
      if (p === chunkId) return true;
      p = (byId.get(p) || {}).parentId;
    }
    return false;
  };
  const chunkHasPending = (chunkId) =>
    list.some((n) => n.kind === "item" && n.badge === "검수전" && descends(n, chunkId));
  const dependsOnTask = (n) => (n.blockedBy || []).some((b) => { const m = byId.get(b); return !!m && m.kind === "task"; });
  return list.filter((n) => {
    if (!depsDone(n)) return false;
    if (n.badge === "검수전" && !hasChild.has(n.id)) return true; // 항목 검증
    if (n.kind === "task" && n.status !== "done") {
      // #6: audit 류(다른 task 에 의존하는 후속 작업)는 정적 blockedBy 가 hunt 의 동적 추가항목(검수전)을
      // 못 봐서 미검증 ledger 로 완결 인증할 위험. 덩어리에 검수전 항목이 남아 있으면 not-ready 로 막는다.
      // generate(blockedBy 없음)·hunt(항목에만 의존)는 task 에 의존 안 해 게이트 비대상.
      if (n.parentId && dependsOnTask(n) && chunkHasPending(n.parentId)) return false;
      return true; // stage 작업 실행
    }
    return false;
  });
}

/** buildLedger — 덩어리(chunkId) 자손 항목(kind=item)을 ledger 엔트리로(hunt/classify/audit exec-stage args.ledger).
 *  부모 사슬로 자손 판정. **평탄** — 원장 항목에 id 포함(classify 가 id 로 배정). category = 항목 자신의 category 필드
 *  (부모 그룹 title 아님 — 평탄이라 그룹 없음; classify 전엔 없어서 빈 값). hunt 중복 회피·classify 배정·audit 완결성 인증에 씀. */
export function buildLedger(nodes, chunkId) {
  const list = Array.isArray(nodes) ? nodes : [];
  const byId = new Map(list.map((n) => [n.id, n]));
  const descends = (n) => {
    let p = n.parentId;
    let guard = 0;
    while (p && guard++ < 100) {
      if (p === chunkId) return true;
      p = (byId.get(p) || {}).parentId;
    }
    return false;
  };
  return list
    .filter((n) => n.kind === "item" && descends(n))
    .map((n) => ({ id: n.id, title: n.title, badge: n.badge, category: n.category }));
}

/** exec-one {oxf, result} → node.edit 필드. oxf 유효(o/x/f)면 badge 갱신. result 는 항상 기록.
 *  oxf 없으면(검증 아님/무판정) badge 미변경 — 진척 없음(reconcileTick 이 self-poke 안 함). */
export function execResultToEdit(execOut) {
  const oxf = execOut && execOut.oxf;
  const raw = execOut ? execOut.result : undefined;
  const result = typeof raw === "string" ? raw : JSON.stringify(raw ?? null);
  const valid = oxf === "o" || oxf === "x" || oxf === "f";
  return valid ? { badge: oxf, result } : { result };
}

/** reconcile 한 틱 — ready 1개를 처리(타임아웃 안전, 프로세스-생존). 진척 시 poke 로 다음 깨움.
 *  분기(모델 B): kind=task(Generate/Hunt/Audit) → exec-stage(claude+자식 노드 발행) / 그 외(항목) → exec-one(검증→배지).
 *  deps(의존 주입 — 테스트 가능): listNodes() · getNode(id) · editNode(id,fields) · execOne(body) · execStage(body) ·
 *  addNode(ev) · poke(). 반환 ok — 코어 재시도 판정(ok!=true → backoff). exec 실패는 throw 말고 ok:false(노드 미변경=멱등). */
export async function reconcileTick(deps) {
  const listed = await deps.listNodes();
  const nodes = (listed && listed.nodes) || [];
  const ready = pickReady(nodes);
  if (ready.length === 0) return { ok: true, processed: 0 };
  const target = ready[0]; // 한 틱 1개 — 발화 시간 상한 안. 나머지는 poke 로 이어 처리.
  const full = await deps.getNode(target.id);
  const node = (full && full.node) || {};
  const body = node.body || "";
  // kind=task → exec-stage 로 stage 실행 후 자식 노드 동적 발행(generate→그룹/항목, hunt→추가항목).
  if (target.kind === "task") {
    return reconcileStage(deps, target, body, nodes);
  }
  // 항목 검증 — exec-one(verifyPrompt) → 배지.
  // 정규화 item: body={promptHash,refs,schemaHash} → kanban prompt.resolve 로 완성 prompt 조립(소비 시점).
  // vars 는 body 에 복붙하지 않고 **노드 필드(title/description)** 에서 조립 — 항목마다 중복 저장 제거(정규화).
  // **평탄** — VERIFY_TMPL 에 {{category}} 없음(검증 시점엔 미분류; 분류는 classify 가 나중에). directive 는 refs(콘텐츠 주소).
  const fieldVars = {};
  if (node.title != null) fieldVars.title = node.title;
  if (node.description != null) fieldVars.description = node.description;
  const execBody = await resolveBody(body, deps, fieldVars);
  let execOut;
  try {
    execOut = await deps.execOne(execBody);
  } catch (e) {
    // 529 과부하·timeout 등 일시 실패 → ok:false. 노드 미변경(badge=검수전 유지) → 코어 backoff 재시도가 자연 복구.
    return { ok: false, processed: 0, id: target.id, error: String((e && e.message) || e) };
  }
  const edit = execResultToEdit(execOut);
  await deps.editNode(target.id, edit);
  // 진척(배지 확정)했을 때만 다음 틱 깨움 — 무판정으로 self-poke 하면 tight loop. 외부/부팅이 재시도.
  if (edit.badge) await deps.poke();
  return { ok: true, processed: 1, id: target.id, badge: edit.badge || null };
}

/** 발행 이벤트(ev) → 칸반 node.add 파라미터(공유 — 발행 relay·exec-stage 자식 relay 동일).
 *  세 축 분리 매핑(규칙 B): title(요건명) / description(요건 설명, 사람용) / body(exec 입력, 사람에 안 보임).
 *  parentId/blockedBy 는 호출자가 keyOf 로 미리 해결해 넘긴다. body:
 *  - kind=task(stage 작업): stage=ev.stage(NodeEvent.stage 필드 — prompt 아님). taskCtx{skeleton,directive} 있으면
 *    exec-stage 입력 {skeleton, stage, args{directive,chunkRef}}. chunkRef=부모(덩어리). main.js 가 skeleton 임베드 — draft.js 무관여.
 *    skeleton 없으면(방어적) {stage} 만. task 노드 prompt 는 비운다.
 *  - 정규화 항목 → {promptHash, vars, schema}(참조만 — 완성 프롬프트 안 박음). roleToHash 로 promptRole→hash 치환.
 *  - 그 외(항목) → exec-one 입력 {prompt(=verifyPrompt), schema}. prompt 없으면(그룹/덩어리) body 빈 문자열. (하위호환) */
export function buildAddParams(ev, parentId, blockedBy, taskCtx, roleToHash) {
  let body;
  if (ev.kind === "task") {
    const stage = ev.stage || "generate";
    body = JSON.stringify(
      taskCtx && taskCtx.skeleton
        ? { skeleton: taskCtx.skeleton, stage, args: { directive: taskCtx.directive, chunkRef: parentId } }
        : { stage }
    );
  } else if (ev.prompt_role || ev.promptRole) {
    // 정규화 item — 콘텐츠 주소화 참조. role→hash(roleToHash 는 이번 발행 배치의 registerPrompts 등록 결과).
    const role = ev.prompt_role || ev.promptRole;
    const hash = roleToHash && roleToHash.get ? roleToHash.get(role) : undefined;
    const vars = ev.vars || {};
    // varRefs: {{key}} → 등록 role 라벨 → hash. 큰 공유값(directive)은 prompts 저장소 1행, 노드는 hash 참조(항목마다 복붙 X).
    const varRefs = ev.var_refs || ev.varRefs;
    const refs = {};
    if (varRefs && roleToHash && roleToHash.get) {
      for (const [k, label] of Object.entries(varRefs)) {
        const h = roleToHash.get(label);
        if (h) refs[k] = h;
      }
    }
    const base = { promptHash: hash, vars };
    if (Object.keys(refs).length) base.refs = refs;
    // schema: schemaRef(콘텐츠 주소, 등록 role 라벨) 우선 → schemaHash. 없으면 인라인 schema(하위호환).
    const schemaRefLabel = ev.schema_ref || ev.schemaRef;
    const schemaHash = schemaRefLabel && roleToHash && roleToHash.get ? roleToHash.get(schemaRefLabel) : undefined;
    if (schemaHash) base.schemaHash = schemaHash;
    else if (ev.schema) base.schema = ev.schema;
    body = JSON.stringify(base);
  } else {
    body = ev.prompt
      ? JSON.stringify(ev.schema ? { prompt: ev.prompt, schema: ev.schema } : { prompt: ev.prompt })
      : "";
  }
  const params = {
    title: ev.title || ev.kind,
    parentId,
    body,
    blockedBy: blockedBy || [],
    locked: true,
    type: "task",
  };
  if (ev.kind) params.kind = ev.kind; // free-form — reconcile 가 stage 작업 식별에 씀
  if (ev.description) params.description = ev.description; // 규칙 B: 요건 설명(사람용 칸반 표시, body 와 별개 축)
  if (ev.origin) params.origin = ev.origin; // 규칙 D: 요건 출처(user/agent/search) 추적 — item 본질 메타
  if (ev.badge) params.badge = ev.badge;
  if (ev.is_draft) params.isDraft = true;
  if (ev.parent_draft_id) params.parentDraftId = ev.parent_draft_id;
  return params;
}

/** validateDraftDoc — DraftDoc(id 기반 정규형) 인증(Rust draft_doc::validate 미러, 규칙 1,2,3,4,5,7).
 *  **평탄** — category 개념 제거(그룹 없음, requirement.category_id 없음). 분류는 classify stage 가 나중에 node.edit.
 *  relay 입력 검증 — 위반 배열 반환(빈 배열=통과). 위반 문서는 발행 거부(fail-loud). 규칙 6(sha)은 kanban 담당.
 *  ① id 유일(requirements∪tasks) ② FK(task.blockedBy∈requirements∪tasks)
 *  ③ 완결(title·description 비지 않음 · origin∈{user,agent,search}) ④ 정규화 불변(요건 고유 필드만; 구조로 보장)
 *  ⑤ 트리(hunt.blockedBy=전 요건 · classify.blockedBy=전 요건∪{hunt} · audit.blockedBy=전 요건∪{hunt,classify}) ⑦ requirements≥1. */
export function validateDraftDoc(doc) {
  const v = [];
  if (!doc || typeof doc !== "object") return ["[문서] DraftDoc 객체 아님"];
  const requirements = Array.isArray(doc.requirements) ? doc.requirements : [];
  const tasks = Array.isArray(doc.tasks) ? doc.tasks : [];
  // ⑦ 비어있지 않음.
  if (requirements.length === 0) v.push("[⑦] requirements 비어있음(≥1 필요)");
  // ① id 유일.
  const seen = new Set();
  for (const id of [...requirements.map((r) => r.id), ...tasks.map((t) => t.id)]) {
    if (seen.has(id)) v.push(`[①] id 중복: ${JSON.stringify(id)}`);
    seen.add(id);
  }
  // ② FK — task.blockedBy ∈ requirements ∪ tasks. (category FK 규칙 제거 — 평탄.)
  const refTargets = new Set([...requirements.map((r) => r.id), ...tasks.map((t) => t.id)]);
  for (const t of tasks) {
    for (const b of t.blocked_by || []) {
      if (!refTargets.has(b)) v.push(`[②] task ${JSON.stringify(t.id)} blocked_by ${JSON.stringify(b)} 미존재(FK)`);
    }
  }
  // ③ 완결.
  const ORIGINS = new Set(["user", "agent", "search"]);
  for (const r of requirements) {
    if (!r.title || !String(r.title).trim()) v.push(`[③] requirement ${JSON.stringify(r.id)} title 비어있음`);
    if (!r.description || !String(r.description).trim()) v.push(`[③] requirement ${JSON.stringify(r.id)} description 비어있음`);
    if (!ORIGINS.has(r.origin)) v.push(`[③] requirement ${JSON.stringify(r.id)} origin ${JSON.stringify(r.origin)} ∉ {user,agent,search}`);
  }
  // ⑤ 트리 — hunt/classify/audit 존재 시.
  const reqIds = new Set(requirements.map((r) => r.id));
  const setEq = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
  const hunt = tasks.find((t) => t.stage === "hunt");
  const classify = tasks.find((t) => t.stage === "classify");
  if (hunt) {
    if (!setEq(new Set(hunt.blocked_by || []), reqIds)) v.push("[⑤] hunt.blocked_by ≠ 전 요건 id 집합");
  }
  if (classify) {
    if (!hunt) v.push("[⑤] classify 존재하나 hunt task 부재(분류는 hunt 후행)");
    else {
      const expected = new Set([...reqIds, hunt.id]);
      if (!setEq(new Set(classify.blocked_by || []), expected)) v.push("[⑤] classify.blocked_by ≠ 전 요건 ∪ {hunt}");
    }
  }
  const audit = tasks.find((t) => t.stage === "audit");
  if (audit) {
    if (!hunt) v.push("[⑤] audit 존재하나 hunt task 부재(감사는 hunt 후행)");
    else {
      const expected = new Set([...reqIds, hunt.id]);
      if (classify) expected.add(classify.id);
      if (!setEq(new Set(audit.blocked_by || []), expected)) v.push("[⑤] audit.blocked_by ≠ 전 요건 ∪ {hunt,classify}");
    }
  }
  return v;
}

/** applyDraftDoc — DraftDoc(정규형) 을 칸반에 반영(relay). exec-stage 스트림 대신 배치 문서 경로.
 *  **평탄** — generate 는 그룹을 안 낸다. requirements → item 노드는 CHUNK_REF 직속(parent=chunkKanbanId). 분류는 classify stage 가 나중에 node.edit.
 *  1) verify_contract 3값(template/directive/schema)을 kanban prompt.put → hT/hD/hS(콘텐츠 주소, 단일 sha 원천=kanban).
 *  2) requirements → node.add(kind:item, parent=chunkKanbanId, title/description/origin/badge,
 *     body={promptHash:hT, refs:{directive:hD}, schemaHash:hS}). 소비 시점(reconcileTick)에 vars=노드 필드로 조립.
 *  3) tasks → node.add(kind:task, stage, blockedBy=id→칸반 id 해석, taskCtx 로 skeleton 임베드).
 *  chunk_title 있으면 chunk_ref 노드 title 갱신. deps: putPrompt·addNode·editNode. 반환 = 발행 노드 수. */
export async function applyDraftDoc(deps, doc, chunkKanbanId, taskCtx) {
  const vc = doc.verify_contract || {};
  const putPrompt = deps.putPrompt;
  const put = async (value) => {
    if (value === undefined || value === null || value === "") return undefined;
    const r = await putPrompt(value);
    return r && r.hash;
  };
  const hT = await put(vc.template);
  const hD = await put(vc.directive);
  const hS = await put(vc.schema);
  const keyOf = new Map(); // DraftDoc id → 칸반 id (chunk_ref 는 이미 칸반 id).
  keyOf.set(doc.chunk_ref, chunkKanbanId);
  let published = 0;
  // requirements → item 노드(평탄: CHUNK_REF 직속). 정규화 body = 해시 3개뿐; vars 는 소비 시점 노드 필드에서.
  const initialBadge = vc.initial_badge || "검수전";
  for (const r of doc.requirements || []) {
    const base = { promptHash: hT };
    if (hD) base.refs = { directive: hD };
    if (hS) base.schemaHash = hS;
    const params = {
      title: r.title,
      parentId: chunkKanbanId, // 평탄: 항목은 덩어리 직속(그룹 없음)
      body: JSON.stringify(base),
      blockedBy: [],
      locked: true,
      type: "task",
      kind: "item",
      badge: r.badge || initialBadge,
    };
    if (r.description) params.description = r.description;
    if (r.origin) params.origin = r.origin;
    const id = await deps.addNode(params);
    if (id) keyOf.set(r.id, id);
    published += 1;
  }
  // tasks → task 노드(hunt/audit). blockedBy=DraftDoc id→칸반 id 해석. body=exec-stage 입력(skeleton 임베드).
  for (const t of doc.tasks || []) {
    const blockedBy = (t.blocked_by || []).map((id) => keyOf.get(id) || id).filter(Boolean);
    const body = JSON.stringify(
      taskCtx && taskCtx.skeleton
        ? { skeleton: taskCtx.skeleton, stage: t.stage, args: { directive: taskCtx.directive, chunkRef: chunkKanbanId } }
        : { stage: t.stage }
    );
    const params = { title: t.stage, parentId: chunkKanbanId, body, blockedBy, locked: true, type: "task", kind: "task" };
    const id = await deps.addNode(params);
    if (id) keyOf.set(t.id, id);
    published += 1;
  }
  // chunk_title → 덩어리 title 갱신.
  if (typeof doc.chunk_title === "string" && doc.chunk_title && deps.editNode) {
    await deps.editNode(chunkKanbanId, { title: doc.chunk_title });
  }
  return published;
}

/** registerPromptTemplates — registerPrompts({role:text}) 를 kanban prompt.put 으로 등록(sha256 dedup).
 *  role→hash 맵 반환(buildAddParams 가 item promptRole→promptHash 치환에 씀). putPrompt(text)→{hash}. */
export async function registerPromptTemplates(registerPrompts, putPrompt) {
  const roleToHash = new Map();
  for (const [role, text] of Object.entries(registerPrompts || {})) {
    // 값 그대로 전달 — 문자열(템플릿/directive)·객체(schema) 모두 kanban 이 sha256·네이티브 저장.
    const r = await putPrompt(text); // kanban prompt.put(value) → {ok,hash}
    if (r && r.hash) roleToHash.set(role, r.hash);
  }
  return roleToHash;
}

/** resolveBody — 정규화 item body({promptHash,vars,schema}) 를 완성 {prompt,schema} 로(소비 시점 조립).
 *  kanban prompt.resolve(hash,vars) 단일 조립기 사용. promptHash 없으면(하위호환) body 그대로. */
async function resolveBody(body, deps, extraVars) {
  let p;
  try {
    p = JSON.parse(body);
  } catch {
    return body;
  }
  if (!p || !p.promptHash) return body; // 하위호환: 기존 {prompt,schema} 그대로
  // vars = body.vars(하위호환) + extraVars(노드 필드: title/description/category). extraVars 우선.
  const vars = { ...(p.vars || {}), ...(extraVars || {}) };
  const res = deps.resolvePrompt ? await deps.resolvePrompt(p.promptHash, vars, p.refs || {}) : null;
  if (!res || !res.ok || res.prompt == null) return body; // 템플릿 미발견 → 그대로 → exec-one "prompt 없음" → ok:false backoff(안전 실패)
  // schema: schemaHash(콘텐츠 주소) deref → 네이티브 객체(stringify/parse 왕복 없음). 없으면 인라인 p.schema(하위호환).
  let schema = p.schema;
  if (p.schemaHash) {
    const sr = deps.getPrompt ? await deps.getPrompt(p.schemaHash) : null;
    const value = sr && sr.value !== undefined ? sr.value : sr;
    if (value == null || typeof value !== "object") return body; // schema 미발견/비객체 → 안전 실패(backoff)
    schema = value;
  }
  return JSON.stringify(schema ? { prompt: res.prompt, schema } : { prompt: res.prompt });
}

/** reconcileStage — kind=task 노드를 exec-stage 로 실행 → 자식 노드 발행 + 덩어리 갱신 + status=done(멱등) + poke.
 *  exec-stage 산출 = { children:[add 이벤트…], result:<워크플로 return> }. 실패는 ok:false(노드 미변경)→backoff.
 *  자식 부모 ref 해결: 배치 keyOf(로컬 emit id→칸반 id) / 기존 칸반 id(chunkRef)는 그대로. addNode(params)→칸반 id. */
async function reconcileStage(deps, target, body, nodes) {
  // hunt/audit 는 ledger(덩어리 자손 항목+배지) materialize 해 exec-stage args 에 주입(generate 는 불필요).
  let stageBody = body;
  let stageName;
  try { stageName = JSON.parse(body).stage; } catch { /* body 가 exec-stage 입력 아님 */ }
  // ② 멱등 가드 — 재진입(발행 완료 후 status=done commit 실패/크래시 → 재pick)에서 execStage 재실행·중복 발행 차단.
  // stage 별 "발행 완료 마커"(이미 발행됐음을 보이는 덩어리 자손)를 찾으면 execStage 안 돌리고 status=done 만 멱등 재확정.
  //  - generate: 발행 끝에 Hunt/Audit task 를 덩어리 자식으로 낸다 → 덩어리에 (이 노드 말고) 다른 task 자식이 마커.
  //  - hunt: 추가항목을 덩어리 *직속* item 으로 낸다(generate 항목은 그룹 밑이라 덩어리 직속 아님) → 덩어리 직속 item 자식이 마커.
  //  - audit: 노드 0개 발행(verdict 만 덩어리 result 로) → 재실행해도 중복 노드 0 → 가드 불필요.
  // 자식 멱등키는 둘 수 없다(kanban node.add 가 매번 새 id; 비결정 generate 는 콘텐츠 dedup 불가) — 발행-완료 마커로
  // 전량 재발행만 막는 설계. (남는 경계: 마커 발행 *전* 중간 크래시의 부분-발행 원자성 — kanban node.add 멱등키 필요. 후속.)
  if (Array.isArray(nodes) && target.parentId) {
    const published =
      stageName === "generate"
        ? nodes.some((n) => n && n.parentId === target.parentId && n.kind === "task" && n.id !== target.id)
        : stageName === "hunt"
          ? nodes.some((n) => n && n.parentId === target.parentId && n.kind === "item")
          : false;
    if (published) {
      await deps.editNode(target.id, { status: "done" });
      await deps.poke();
      return { ok: true, processed: 0, id: target.id, stage: true, published: 0, idempotent: true };
    }
  }
  // hunt/classify/audit 는 ledger(덩어리 자손 항목+id+배지) materialize 해 exec-stage args 에 주입(generate 는 불필요).
  // classify 는 완성 원장(hunt 후)을 보고 각 항목 id 에 category 를 배정하므로 hunt/audit 와 동일 주입 대상.
  if ((stageName === "hunt" || stageName === "classify" || stageName === "audit") && deps.materializeLedger && target.parentId) {
    try {
      const ledger = await deps.materializeLedger(target.parentId);
      const inp = JSON.parse(body);
      inp.args = { ...(inp.args || {}), ledger };
      stageBody = JSON.stringify(inp);
    } catch {
      /* materialize 실패 시 ledger 없이 진행(exec-stage 가 빈 ledger 다룸) */
    }
  }
  let staged;
  try {
    staged = await deps.execStage(stageBody);
  } catch (e) {
    return { ok: false, processed: 0, id: target.id, error: String((e && e.message) || e) };
  }
  // 자식 stage 노드(Hunt/Audit)에 skeleton 전파 — 이 task 입력 body 에서 추출(같은 워크플로 골격 재실행).
  let childCtx;
  try {
    const inp = JSON.parse(body);
    if (inp && inp.skeleton) childCtx = { skeleton: inp.skeleton, directive: inp.args && inp.args.directive };
  } catch {
    /* body 가 exec-stage 입력이 아니면 전파 없음(자식에 task 없을 때) */
  }
  // generate stage = DraftDoc(id 기반 정규형 1문서). validate(relay 입력 검증, 실패=거부) → applyDraftDoc 배치 발행.
  // 스트림 경로(children)와 감지 분기(하위호환): draftDoc 있으면 그 경로, 없으면 기존 줄단위 relay.
  if (staged && staged.draftDoc) {
    const violations = validateDraftDoc(staged.draftDoc);
    if (violations.length) {
      // 위반 문서 발행 거부 — 노드 미변경(status todo 유지) → 코어 backoff 재시도(안전 실패).
      return { ok: false, processed: 0, id: target.id, error: `DraftDoc 검증 실패(${violations.length}건): ${violations[0]}` };
    }
    let published;
    try {
      published = await applyDraftDoc(deps, staged.draftDoc, target.parentId, childCtx);
    } catch (e) {
      return { ok: false, processed: 0, id: target.id, error: String((e && e.message) || e) };
    }
    await deps.editNode(target.id, { status: "done" }); // stage 작업 done → 재-pick 0(멱등)
    await deps.poke(); // 발행된 항목(검수전)·후속 stage 깨움
    return { ok: true, processed: 1, id: target.id, stage: true, published };
  }
  const children = (staged && staged.children) || [];
  const keyOf = new Map();
  const roleToHash = new Map(); // 정규화: exec-stage 자식 발행의 registerPrompts → prompt.put → item 참조.
  for (const ev of children) {
    if (ev.register_prompts || ev.registerPrompts) {
      const reg = await registerPromptTemplates(ev.register_prompts || ev.registerPrompts, deps.putPrompt);
      for (const [role, hash] of reg) roleToHash.set(role, hash);
    }
    const parentId = ev.parent ? keyOf.get(ev.parent) || ev.parent : undefined;
    const blockedBy = (ev.blocked_by || ev.blockedBy || []).map((id) => keyOf.get(id) || id).filter(Boolean);
    const nodeId = await deps.addNode(buildAddParams(ev, parentId, blockedBy, childCtx, roleToHash));
    if (nodeId) keyOf.set(ev.id, nodeId);
  }
  // 덩어리 갱신: generate→title, audit→verdict(result), classify→dimension. 덩어리 = stage 노드의 parent.
  const res = staged && staged.result;
  // classify: result.assignments([{id,category}]) → 각 항목 node.edit(category). reparent 금지(워크플로 노드 이동 불가) —
  // 기존 항목에 category 메타만 부여. dimension 은 덩어리(chunk) result 에 기록.
  let assigned = 0;
  if (stageName === "classify" && res && typeof res === "object" && Array.isArray(res.assignments)) {
    for (const a of res.assignments) {
      if (a && typeof a.id === "string" && typeof a.category === "string" && a.category) {
        await deps.editNode(a.id, { category: a.category });
        assigned += 1;
      }
    }
  }
  if (res && typeof res === "object" && target.parentId) {
    const chunkEdit = {};
    if (typeof res.chunkTitle === "string" && res.chunkTitle) chunkEdit.title = res.chunkTitle;
    if (typeof res.verdict === "string" && res.verdict) chunkEdit.result = res.verdict;
    // classify: dimension 을 덩어리 result 에 기록(분류 차원 = 원장 종합 산출).
    if (stageName === "classify" && typeof res.dimension === "string" && res.dimension) chunkEdit.result = res.dimension;
    if (Object.keys(chunkEdit).length) await deps.editNode(target.parentId, chunkEdit);
  }
  await deps.editNode(target.id, { status: "done" }); // stage 작업 done → 재-pick 0(멱등)
  await deps.poke(); // 발행된 항목(검수전)·후속 stage 깨움
  return { ok: true, processed: 1, id: target.id, stage: true, published: children.length, assigned };
}

// ── app 연결(런타임) ──

/** genSkeletonArgs — generate-skeleton CLI 인자 조립(순수, 테스트 대상). idea 필수, 나머지 선택.
 *  아이디어 → gen.js(LLM 저작) → skeleton. --refs 는 references override(기본=플러그인 번들), --gen-out 은 gen.js 보존. */
export function genSkeletonArgs({ idea, model, refs, genOut, lang } = {}) {
  if (!idea) throw new Error("genSkeletonArgs: idea 필수");
  const args = ["generate-skeleton", "--idea", idea, "--lang", lang || "ko"];
  if (model) args.push("--model", model);
  if (refs) args.push("--refs", refs);
  if (genOut) args.push("--gen-out", genOut);
  return args;
}

/** generate-skeleton spawn — 아이디어 → gen.js(LLM 저작) → skeleton JSON(stdout 문자열 resolve).
 *  claude 호출 → env(인증 프로필) 필요(발행 spawn 과 다름). lease=프로세스-생존(onExit 까지 대기). idea 는 argv(stdin 아님). */
function genSkeleton(app, exe, env, spec) {
  return new Promise((resolve, reject) => {
    let out = "";
    const dec = new TextDecoder();
    const opts = env && typeof env === "object" ? { env } : {};
    Promise.resolve(app.process.spawn(exe, genSkeletonArgs(spec), opts))
      .then((handle) => {
        app.process.onData(handle, (b) => {
          out += dec.decode(b, { stream: true });
        });
        app.process.onExit(handle, (code) => {
          if (code !== 0) return reject(new Error(`generate-skeleton exit ${code}`));
          const t = out.trim();
          if (!t.startsWith("{")) return reject(new Error(`generate-skeleton 출력이 skeleton JSON 아님: ${t.slice(0, 200)}`));
          resolve(t);
        });
      })
      .catch(reject);
  });
}

/** exec-one spawn — stdin 에 {prompt, schema?} 쓰고 stdout {oxf, result} 파싱.
 *  lease=프로세스-생존: spawn → **onExit await → 그제야 resolve/reject**. 도는 중(검색 1시간이든)엔 reply 금지 —
 *  스케줄러가 lease 로 기다린다. heartbeat 발신 없음(폐기). 정상 exit+결과=resolve, 비정상/무결과=reject(→ok:false). */
function execOne(app, exe, env, body) {
  return new Promise((resolve, reject) => {
    let out = "";
    const dec = new TextDecoder();
    const opts = env && typeof env === "object" ? { env } : {};
    Promise.resolve(app.process.spawn(exe, ["exec-one", "--lang", "ko"], opts))
      .then(async (handle) => {
        app.process.onData(handle, (b) => {
          out += dec.decode(b, { stream: true });
        });
        app.process.onExit(handle, (code) => {
          if (code !== 0) return reject(new Error(`exec-one exit ${code}`));
          try {
            resolve(JSON.parse(out.trim()));
          } catch {
            reject(new Error(`exec-one 출력 JSON 파싱 실패: ${out.slice(0, 200)}`));
          }
        });
        await app.process.write(handle, body);
        if (app.process.closeStdin) await app.process.closeStdin(handle);
      })
      .catch(reject);
  });
}

/** exec-stage spawn — stdin {skeleton, stage, args} 쓰고 stdout(자식 {ev:add} JSON line + 최종 {ev:result})
 *  파싱 → { children:[add…], result }. lease=프로세스-생존: onExit 까지 대기. env=인증(claude 실행하므로 필요). */
function execStage(app, exe, env, body) {
  return new Promise((resolve, reject) => {
    let out = "";
    const dec = new TextDecoder();
    const opts = env && typeof env === "object" ? { env } : {};
    Promise.resolve(app.process.spawn(exe, ["exec-stage", "--lang", "ko"], opts))
      .then(async (handle) => {
        app.process.onData(handle, (b) => {
          out += dec.decode(b, { stream: true });
        });
        app.process.onExit(handle, (code) => {
          if (code !== 0) return reject(new Error(`exec-stage exit ${code}`));
          // generate stage = DraftDoc(단일 JSON 문서, kind:"draft-chunk"). 그 외 = 줄단위 스트림({ev:add}+{ev:result}).
          const whole = out.trim();
          if (whole.startsWith("{")) {
            try {
              const one = JSON.parse(whole);
              if (one && one.kind === "draft-chunk") return resolve({ draftDoc: one });
            } catch {
              /* 단일 JSON 아님 → 스트림 파싱으로 폴백 */
            }
          }
          const children = [];
          let result = null;
          for (const line of out.split("\n")) {
            const t = line.trim();
            if (!t.startsWith("{")) continue;
            let ev;
            try { ev = JSON.parse(t); } catch { continue; }
            if (ev.ev === "add") children.push(ev);
            else if (ev.ev === "result") result = ev.value;
          }
          resolve({ children, result });
        });
        await app.process.write(handle, body);
        if (app.process.closeStdin) await app.process.closeStdin(handle);
      })
      .catch(reject);
  });
}

export default {
  async activate(ctx) {
    const app = ctx.app;
    // 실행 런타임(workflow.run 이 갱신). reconcile 핸들러가 exec-one/exec-stage spawn 에, relay 가 task body 임베드에 쓴다.
    const runtime = { bin: "soksak-workflow", env: undefined, skeleton: undefined, directive: undefined };

    ctx.subscriptions.push(
      app.commands.register("workflow.run", {
        description: "아이디어(idea) 또는 skeleton(AST) 을 받아 칸반에 노드 DAG 로 발행하고, reconcile 로 실행을 건다. idea 면 내부에서 generate-skeleton(gen.js→skeleton) 을 먼저 돈다.",
        params: {
          idea: { type: "string", description: "사용자 아이디어 — 내부 generate-skeleton(gen.js→skeleton)으로 발행. skeleton/skeletonPath 없을 때." },
          skeleton: { type: "string", description: "skeleton JSON 문자열(stdin). idea 대신 직접 공급(하위호환)." },
          skeletonPath: { type: "string", description: "skeleton JSON 파일 경로(인자)" },
          bin: { type: "string", description: "soksak-workflow 바이너리 경로(기본 PATH)" },
          model: { type: "string", description: "generate-skeleton 저작 모델(기본 프로필 기본값)." },
          refs: { type: "string", description: "references override 경로(기본=플러그인 번들 self-contained)." },
          env: { type: "json", description: "generate-skeleton·exec-one(claude -p) 에 주입할 인증 env(ANTHROPIC_*). 순수 발행(--emit)은 토큰 불필요." },
          directive: { type: "string", description: "입력 지시어 — stage 작업 노드 body 에 임베드(exec-stage args.directive). 없으면 idea 로 승격." },
        },
        returns: "{ ok }",
        handler: async ({ idea, skeleton, skeletonPath, bin, model, refs, env, directive }) => {
          const exe = bin || "soksak-workflow";
          runtime.bin = exe;
          runtime.env = env; // reconcile exec-one/exec-stage 가 쓸 인증 env 캡처
          runtime.directive = directive || idea; // stage 작업 노드 directive: 명시 directive 우선, 없으면 idea
          // idea 만 주어지면(skeleton/skeletonPath 없음) → generate-skeleton 으로 gen.js→skeleton 저작해 발행에 흘림.
          if (idea && !skeleton && !skeletonPath) {
            skeleton = await genSkeleton(app, exe, env, { idea, model, refs });
          }
          // skeleton 캡처(인라인 문자열) — stage 작업 노드 body 에 임베드해 reconcile 이 exec-stage 로 재실행.
          try { runtime.skeleton = skeleton ? JSON.parse(skeleton) : undefined; } catch { runtime.skeleton = undefined; }
          const input = skeletonPath || "-";
          const args = [input, "--emit", "--lang", "ko"];
          const handle = await app.process.spawn(exe, args, {}); // 발행은 LLM 미호출 → env 불필요

          const keyOf = new Map(); // 워크플로 노드 id → 칸반 노드 id
          let buf = "";
          const queue = [];
          let processing = false;

          const roleToHash = new Map(); // 프롬프트 정규화: registerPrompts 등록 결과(role→sha256). item 발행이 참조.
          const handleEv = async (line) => {
            if (!line.startsWith("{")) return;
            let ev;
            try { ev = JSON.parse(line); } catch { return; }
            try {
              if (ev.ev === "add") {
                // 정규화: chunk/stage 의 registerPrompts({role:text}) → kanban prompt.put(sha256 dedup) → roleToHash.
                if (ev.register_prompts || ev.registerPrompts) {
                  const putPrompt = (value) => app.commands.execute(KANBAN + ".prompt.put", { value });
                  const reg = await registerPromptTemplates(ev.register_prompts || ev.registerPrompts, putPrompt);
                  for (const [role, hash] of reg) roleToHash.set(role, hash);
                }
                // 부모 ref: 로컬 emit id(이번 발행에서 추가됨)면 keyOf 로 칸반 id, 아니면 기존 칸반 id(chunkRef) 그대로.
                const parentId = ev.parent ? keyOf.get(ev.parent) || ev.parent : undefined;
                const blockedBy = (ev.blocked_by || ev.blockedBy || []).map((id) => keyOf.get(id) || id).filter(Boolean);
                // stage 작업(kind=task) 노드는 body 에 skeleton 임베드(exec-stage 입력). 항목/그룹은 무관.
                const taskCtx = runtime.skeleton ? { skeleton: runtime.skeleton, directive: runtime.directive } : undefined;
                const params = buildAddParams(ev, parentId, blockedBy, taskCtx, roleToHash); // 발행 relay·exec-stage relay 공유
                const r = await app.commands.execute(KANBAN + ".node.add", params);
                if (r && r.nodeId) keyOf.set(ev.id, r.nodeId);
              }
            } catch (e) {
              app.bus?.emit?.("workflow.error", { message: String(e) });
            }
          };

          // drain — 큐 순차 처리(재진입 방지로 발행 순서·keyOf race 차단).
          const drain = async () => {
            if (processing) return;
            processing = true;
            while (queue.length) await handleEv(queue.shift());
            processing = false;
          };

          app.process.onData(handle, (bytes) => {
            buf += new TextDecoder().decode(bytes);
            let nl;
            while ((nl = buf.indexOf("\n")) >= 0) {
              queue.push(buf.slice(0, nl).trim());
              buf = buf.slice(nl + 1);
            }
            void drain();
          });
          app.process.onExit(handle, () => {
            if (buf.trim()) queue.push(buf.trim());
            void drain().then(() => {
              app.bus?.emit?.("workflow.done", {});
              // 발행 완료 → reconcile 깨워 새 ready(검수전) 노드 처리.
              app.scheduler?.poke?.(RECONCILE_ID);
            });
          });

          if (!skeletonPath && skeleton) {
            await app.process.write(handle, skeleton);
            if (app.process.closeStdin) await app.process.closeStdin(handle);
          }

          return { ok: true };
        },
      }),
    );

    // reconcile 명령 — 칸반 ready 노드 1개를 exec-one 으로 실행. 스케줄러가 발화(부팅 스캔·poke).
    ctx.subscriptions.push(
      app.commands.register("workflow.reconcile", {
        description: "칸반 ready 노드(검수전·의존충족·leaf) 1개를 exec-one 으로 검증 → 배지/결과 기록 → 다음 깨움.",
        params: {},
        returns: "{ ok, processed, id?, badge? }",
        handler: async () => {
          const deps = {
            listNodes: () => app.commands.execute(KANBAN + ".node.list", {}),
            getNode: (id) => app.commands.execute(KANBAN + ".node.get", { node: id }),
            editNode: (id, fields) => app.commands.execute(KANBAN + ".node.edit", { node: id, ...fields }),
            // lease=프로세스-생존: exec-one/exec-stage 가 onExit 까지 reply 보류(도는 중 안 잘림). 코어가 backstop 으로만 관리.
            execOne: (body) => execOne(app, runtime.bin, runtime.env, body),
            execStage: (body) => execStage(app, runtime.bin, runtime.env, body),
            // exec-stage 자식 노드 발행 → 칸반 node.add, 칸반 id 반환(reconcileStage 가 배치 keyOf 로 부모 잇게).
            addNode: async (params) => {
              const r = await app.commands.execute(KANBAN + ".node.add", params);
              return r && r.nodeId;
            },
            // hunt/audit 용 ledger — 덩어리 자손 항목+배지(node.list 로).
            materializeLedger: async (chunkId) => {
              const listed = await app.commands.execute(KANBAN + ".node.list", {});
              return buildLedger((listed && listed.nodes) || [], chunkId);
            },
            poke: () => app.scheduler?.poke?.(RECONCILE_ID),
            // 프롬프트 정규화(콘텐츠 주소화): 등록(sha256 dedup)·조립({{key}}→vars). 조립기 단일=kanban.
            putPrompt: (value) => app.commands.execute(KANBAN + ".prompt.put", { value }),
            resolvePrompt: (hash, vars, refs) => app.commands.execute(KANBAN + ".prompt.resolve", { hash, vars, refs }),
            getPrompt: (hash) => app.commands.execute(KANBAN + ".prompt.get", { hash }),
          };
          // reconcileTick 이 ok 를 정한다 — exec 실패 시 ok:false → 코어 backoff 재시도(재시도 판정 ok!=true).
          return await reconcileTick(deps);
        },
      }),
    );

    // 코어 스케줄러에 reconcile 등록(멱등) — 등록 시 1회 부팅 스캔 + poke 시 발화. crash 후에도 칸반 상태로 재개.
    if (app.scheduler) {
      try {
        await app.scheduler.register({
          id: RECONCILE_ID,
          trigger: { kind: "reconcile" },
          command: RECONCILE_CMD,
          // lease=프로세스-생존: 핸들러가 onExit 까지 reply 보류(검색 1시간이든 안 잘림). 천장 통일 불필요 —
          // 정상은 provider 캡(2h)이 claude 종료시키고, timeout_ms = zombie_backstop(3h)는 그것도 실패한 좀비
          // 전용(provider 보다 길게). 중복은 lease 가 막는다(도는 중 재발화 X). core 가 zombie_backstop_ms wire.
          timeout_ms: 10800000,
          // 529 과부하 등 일시 실패 backoff 재시도(즉시 재시도 X — 지연 후 자연 복구). 실패=reconcileTick ok:false.
          retry: { max: 5, base_ms: 3000, max_ms: 60000 },
          // lease=프로세스-생존: 코어가 unclamped reply-wait(핸들러 onExit 까지) + zombie_backstop 으로 간다.
          // exec-one/exec-stage 가 검색 1h+ 돌아도 안 잘리고, 도는 중 재발화 0(lease).
          process_lease: true,
        });
      } catch (e) {
        app.bus?.emit?.("workflow.error", { message: `scheduler.register: ${String(e)}` });
      }
    }

    // 트리거 ② 외부 변화 — 칸반 노드가 워크플로 밖에서 바뀌면(사람이 선행 done 표시 등) reconcile 깨움.
    // app.data 컬렉션 watch 는 *플러그인 ns 한정*이라 칸반 nodes 를 직접 못 본다 → 크로스플러그인 bus 로.
    // 칸반이 노드 변이 시 "kanban:changed" emit 하면 활성(미emit 이면 휴면 — 무해). poke 멱등·lease 보호.
    if (app.bus?.on) {
      ctx.subscriptions.push(app.bus.on("kanban:changed", () => app.scheduler?.poke?.(RECONCILE_ID)));
    }
  },
  deactivate() {},
};
