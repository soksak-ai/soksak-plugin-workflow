// soksak-plugin-workflow — 워크플로 런타임(rust soksak-workflow)을 spawn 해 칸반에 노드 DAG 를 발행하고,
// 코어 스케줄러(reconcile)로 ready 노드를 실행한다. 발행(--emit)과 실행(exec-one/exec-stage)은 분리(규칙 C).
//
// 발행: soksak-workflow --emit → stdout JSON line(노드 이벤트) → 칸반 node.add(locked, 드래프트 마커).
// 실행: app.scheduler.register({trigger: reconcile}) → 'reconcile' 가 칸반 ready 노드 1개를 처리 —
//       item → exec-one(prompt/schema) 검증 → node.edit(badge=oxf, result) / task → exec-stage(stage 실행·자식 발행).
//       트리거(폴링 0): ①발행 완료 poke ②완료 poke(handler 가 진척 시 self-poke) ③activate 가 register 직후
//       poke 1회(부팅 스캔 — Reconcile 등록만으론 발화하지 않는다) ④kanban:changed(외부 변화).
//       concurrency·lease·backoff(529)는 코어가 처리 — handler 는 ready 1개만 처리하고 poke.

const KANBAN = "plugin.soksak-plugin-kanban";
const SELF = "plugin.soksak-plugin-workflow";
const RECONCILE_CMD = SELF + ".reconcile";
const RECONCILE_ID = "workflow-reconcile";

// ── 순수 로직(테스트 가능 — app 의존 없음) ──

/** 노드 done 판정(미존재 의존=false, 안전).
 *  badge 보유 노드(draft item, research fact 등 검증 대상)는 검증 시 badge(o/x/f)만 받고 status 는 영영
 *  todo(execResultToEdit 가 badge 만 박음) — status 로 판정하면 blockedBy=[검증노드들] 의 depsDone 이 영구
 *  false 라 후속 task 가 영영 안 풀린다(① deadlock). badge 축이 있으면 badge 확정(o/x/f)이 done —
 *  kind 하드코딩이 아니라 badge 보유 여부로 판정(research fact 등 새 검증 kind 가 같은 파이프를 탄다).
 *  badge 없는 노드(stage task/덩어리)는 status="done". */
export function isDone(node) {
  if (!node) return false;
  if (node.badge != null && node.badge !== "") return node.badge === "o" || node.badge === "x" || node.badge === "f";
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

/** buildLedger — 덩어리(chunkId) 자손 중 지정 kind 노드를 ledger 엔트리로(exec-stage args 주입용).
 *  부모 사슬로 자손 판정. **평탄** — 원장 항목에 id 포함(classify 가 id 로 배정). category = 항목 자신의 category 필드
 *  (부모 그룹 title 아님 — 평탄이라 그룹 없음; classify 전엔 없어서 빈 값). 기본 kind="item"(draft 요건 원장 —
 *  hunt 중복 회피·classify 배정·audit 완결성 인증). kind="fact" 로 research 기초지식 원장도 같은 형식으로 뽑는다(plan 입력). */
export function buildLedger(nodes, chunkId, kind = "item") {
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
    .filter((n) => n.kind === kind && descends(n))
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

/** makeReconcileState — reconcile 인메모리 상태(activate 가 1개 들고 매 틱 주입).
 *  재시작 시 리셋되는 건 허용 — 카운터 상한이 다시 적용될 뿐이고, 영속하려면 노드 result 를 매 후보마다
 *  재조회해야(칸반 node.list compact 가 result 미노출) 비용이 과하다.
 *  noVerdict: 항목별 무판정 연속 횟수(상한 도달 시 badge=f 확정 — 무한 LLM 재실행 루프 차단).
 *  fails: 노드별 연속 실패 횟수(ready 선택에서 실패 최소 노드 우선 — head-of-line 기아 방지). */
export function makeReconcileState() {
  return { noVerdict: new Map(), fails: new Map() };
}

/** 무판정(oxf 없음) 연속 상한 — 도달 시 badge=f 확정(fail-loud).
 *  무판정 항목의 result 기록이 kanban:changed 를 발화 → poke → 같은 항목 재선택 → exec-one(LLM) 재실행이
 *  무한 반복될 수 있다(backoff 대상 아님 — exec 자체는 성공). 상한으로 유한화하고 원인(스키마 부재/모델 이탈)을
 *  result 로 표면화한다. f 는 항목 done(①) → 체인이 풀리고, 감사(audit)가 f 를 완결성 판정에 반영한다. */
const NO_VERDICT_MAX = 3;

/** reconcile 한 틱 — ready 1개를 처리(타임아웃 안전, 프로세스-생존). 진척 시 poke 로 다음 깨움.
 *  분기(모델 B): kind=task(Generate/Hunt/Audit) → exec-stage(claude+자식 노드 발행) / 그 외(항목) → exec-one(검증→배지).
 *  deps(의존 주입 — 테스트 가능): listNodes() · getNode(id) · editNode(id,fields) · execOne(body) · execStage(body) ·
 *  addNode(ev) · poke(). state=makeReconcileState()(생략 시 틱-로컬 — 상한/기아 방지는 지속 상태를 넘겨야 동작).
 *  반환 ok — 코어 재시도 판정(ok!=true → backoff). exec 실패는 throw 말고 ok:false(노드 미변경=멱등). */
export async function reconcileTick(deps, state) {
  const st = state || makeReconcileState();
  const listed = await deps.listNodes();
  const nodes = (listed && listed.nodes) || [];
  const ready = pickReady(nodes);
  if (ready.length === 0) return { ok: true, processed: 0 };
  // 한 틱 1개 — 발화 시간 상한 안. 나머지는 poke 로 이어 처리.
  // 기아 방지: 연속 실패가 가장 적은 ready 선택 — 영구 실패 노드 1개가 ready[0] 을 점유해 나머지를 무기한
  // 막는 head-of-line blocking 차단(실패 노드 자체는 코어 backoff + 무판정 상한이 수렴시킴).
  let target = ready[0];
  if (st.fails.size) {
    let best = Infinity;
    for (const n of ready) {
      const f = st.fails.get(n.id) || 0;
      if (f < best) {
        best = f;
        target = n;
      }
    }
  }
  const full = await deps.getNode(target.id);
  const node = (full && full.node) || {};
  const body = node.body || "";
  // kind=task → exec-stage 로 stage 실행 후 자식 노드 동적 발행(generate→항목, hunt→추가항목).
  if (target.kind === "task") {
    const res = await reconcileStage(deps, target, body, nodes);
    if (res && res.ok) st.fails.delete(target.id);
    else st.fails.set(target.id, (st.fails.get(target.id) || 0) + 1);
    return res;
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
    st.fails.set(target.id, (st.fails.get(target.id) || 0) + 1);
    return { ok: false, processed: 0, id: target.id, error: String((e && e.message) || e) };
  }
  st.fails.delete(target.id);
  const edit = execResultToEdit(execOut);
  // 무판정 상한(NO_VERDICT_MAX) — 연속 무판정이면 f 확정. 미만이면 result 만 기록(badge 미변경).
  if (!edit.badge) {
    const n = (st.noVerdict.get(target.id) || 0) + 1;
    if (n >= NO_VERDICT_MAX) {
      edit.badge = "f";
      edit.result = `무판정 ${n}회 소진(출력에 oxf 없음 — 스키마 부재/모델 이탈) → 자동 f. 마지막 출력: ${edit.result || ""}`;
      st.noVerdict.delete(target.id);
    } else {
      st.noVerdict.set(target.id, n);
    }
  } else {
    st.noVerdict.delete(target.id);
  }
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
    // workflowRef(번들 정본 이름) 우선 — canonical doc(research 등)은 task 마다 임베드하지 않고 이름 참조,
    // exec-stage 가 plugin_root/workflows/<name>.doc.json 을 로드한다(단일 원천). 저작 doc(draft)은 임베드 유지.
    body = JSON.stringify(
      taskCtx && taskCtx.workflowRef
        ? { workflow: taskCtx.workflowRef, stage, args: { directive: taskCtx.directive, chunkRef: parentId } }
        : taskCtx && taskCtx.skeleton
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

/** validateDraftDoc — DraftDoc(id 기반 정규형) 인증(Rust draft_doc::validate 미러, 규칙 1,2,3,4,5,7 + ⑧⑨).
 *  **평탄** — category 개념 제거(그룹 없음, requirement.category_id 없음). 분류는 classify stage 가 나중에 node.edit.
 *  relay 입력 검증 — 위반 배열 반환(빈 배열=통과). 위반 문서는 발행 거부(fail-loud). 규칙 6(sha)은 kanban 담당.
 *  ① id 유일(requirements∪tasks) ② FK(task.blockedBy∈requirements∪tasks)
 *  ③ 완결(title·description 비지 않음 · origin∈{user,agent,search}) ④ 정규화 불변(요건 고유 필드만; 구조로 보장)
 *  ⑤ 트리(hunt.blockedBy=전 요건 · classify.blockedBy=전 요건∪{hunt} · audit.blockedBy=전 요건∪{hunt,classify}) ⑦ requirements≥1
 *  ⑧ 배지 enum(빈 값=initial_badge 폴백 허용 — 비enum 은 칸반 드랍→영구 not-done 무음 정지라 발행 전 거부)
 *  ⑨ verify_contract 완결(template·directive·schema — 빈 계약은 exec-one 'prompt 필수' 무한 backoff 로 전락). */
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
  // ⑧ 배지 enum — 비enum(예: "pending")은 칸반 node.add 가 undefined 로 드랍 → 검수전 필터에도 done 판정에도
  // 안 걸리는 영구 not-done 무음 정지. origin 은 ③이 검사하는데 badge 만 공백이던 비대칭 해소.
  const BADGES = new Set(["검수전", "o", "x", "f"]);
  for (const r of requirements) {
    if (r.badge != null && r.badge !== "" && !BADGES.has(r.badge)) {
      v.push(`[⑧] requirement ${JSON.stringify(r.id)} badge ${JSON.stringify(r.badge)} ∉ {검수전,o,x,f}`);
    }
  }
  const vc = doc.verify_contract || {};
  if (vc.initial_badge != null && !BADGES.has(vc.initial_badge)) {
    v.push(`[⑧] verify_contract.initial_badge ${JSON.stringify(vc.initial_badge)} ∉ {검수전,o,x,f}`);
  }
  // ⑨ verify_contract 완결 — 빈 계약이면 item body 가 해시 없이 발행돼 exec-one 'prompt 필수' 무한 backoff(지연 실패).
  if (!vc.template || !String(vc.template).trim()) v.push("[⑨] verify_contract.template 비어있음(registerPrompts.verify 누락)");
  if (!vc.directive || !String(vc.directive).trim()) v.push("[⑨] verify_contract.directive 비어있음(registerPrompts.directive 누락)");
  if (vc.schema == null || typeof vc.schema !== "object") v.push("[⑨] verify_contract.schema 객체 아님(registerPrompts.schema 부재)");
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
  //  - hunt: 추가항목을 덩어리 직속 item 으로 낸다. 평탄(28febc9)에선 generate 항목도 덩어리 직속이므로
  //    "직속 item 존재"만으론 항상 참(오발 — hunt 가 영영 안 돎). hunt.blockedBy(=generate 항목 칸반 id 동결 집합)
  //    **차집합**이 마커다: blockedBy 밖의 직속 item = hunt 가 발행한 추가항목.
  //    (잔여 경계: 추가항목 0개로 끝난 hunt 가 status=done 전 크래시하면 재실행 — LLM 1회 재호출일 뿐 발행 중복 없음.)
  //  - audit: 노드 0개 발행(verdict 만 덩어리 result 로) → 재실행해도 중복 노드 0 → 가드 불필요.
  // 자식 멱등키는 둘 수 없다(kanban node.add 가 매번 새 id; 비결정 generate 는 콘텐츠 dedup 불가) — 발행-완료 마커로
  // 전량 재발행만 막는 설계. (남는 경계: 마커 발행 *전* 중간 크래시의 부분-발행 원자성 — kanban node.add 멱등키 필요. 후속.)
  if (Array.isArray(nodes) && target.parentId) {
    const huntBlocked = new Set(target.blockedBy || []);
    const published =
      stageName === "generate"
        ? nodes.some((n) => n && n.parentId === target.parentId && n.kind === "task" && n.id !== target.id)
        : stageName === "hunt"
          ? nodes.some((n) => n && n.parentId === target.parentId && n.kind === "item" && !huntBlocked.has(n.id))
          : stageName === "research"
            ? // research 는 fact 를 최초 발행하는 유일한 출처 — 덩어리 직속 fact 존재=발행 완료 마커.
              nodes.some((n) => n && n.parentId === target.parentId && n.kind === "fact")
            : stageName === "plan"
              ? // plan 은 plan-unit 을 최초 발행하는 유일한 출처 — 동일 패턴.
                nodes.some((n) => n && n.parentId === target.parentId && n.kind === "plan-unit")
              : false;
    if (published) {
      await deps.editNode(target.id, { status: "done" });
      await deps.poke();
      return { ok: true, processed: 0, id: target.id, stage: true, published: 0, idempotent: true };
    }
  }
  // hunt/classify/audit/research/plan 은 ledger(덩어리 자손 요건+id+배지) materialize 해 exec-stage args 에 주입(generate 는 불필요).
  // classify 는 완성 원장(hunt 후)을 보고 각 항목 id 에 category 를 배정하므로 hunt/audit 와 동일 주입 대상.
  // research(기초지식 발굴)는 인증 요건 원장이 발굴 근거. plan(한턴 슈도코드화)은 요건 원장 + fact 원장(args.facts) 둘 다.
  let ledger;
  const LEDGER_STAGES = new Set(["hunt", "classify", "audit", "research", "plan"]);
  if (LEDGER_STAGES.has(stageName) && deps.materializeLedger && target.parentId) {
    try {
      ledger = await deps.materializeLedger(target.parentId);
      const inp = JSON.parse(body);
      inp.args = { ...(inp.args || {}), ledger };
      if (stageName === "plan" && deps.materializeFacts) {
        inp.args.facts = await deps.materializeFacts(target.parentId);
      }
      stageBody = JSON.stringify(inp);
    } catch (e) {
      // classify(배정 검증)·audit(f 집계=인증 계산)·research(발굴 근거=인증 원장)·plan(슈도코드 입력=원장)은
      // 원장이 필수 — 없으면 거부(backoff). hunt 만 ledger 없이 진행 가능(빈 원장='중복 회피 정보 없음'일 뿐).
      if (stageName !== "hunt") {
        return { ok: false, processed: 0, id: target.id, error: `원장 materialize 실패(${stageName}): ${String((e && e.message) || e)}` };
      }
    }
  }
  let staged;
  try {
    staged = await deps.execStage(stageBody);
  } catch (e) {
    return { ok: false, processed: 0, id: target.id, error: String((e && e.message) || e) };
  }
  // 자식 stage 노드(hunt/classify/audit·plan)에 워크플로 전파 — 이 task 입력 body 에서 추출(같은 골격 재실행).
  // workflowRef(번들 정본 이름)가 있으면 그것을, 없으면 임베드 skeleton 을 전파.
  let childCtx;
  try {
    const inp = JSON.parse(body);
    if (inp && inp.workflow) childCtx = { workflowRef: inp.workflow, directive: inp.args && inp.args.directive };
    else if (inp && inp.skeleton) childCtx = { skeleton: inp.skeleton, directive: inp.args && inp.args.directive };
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
  // 적용은 원장 대조 **전수 검증 통과 후에만**(부분 적용 0 — tools/verify-classify.mjs 와 동일 계약: unknown/중복/미배정=FAIL).
  // LLM 환각 id 를 그대로 edit 하면 칸반 resolve 가 key(대소문자 무시)까지 매칭해 무관 노드를 오염시킬 수 있다.
  let assigned = 0;
  if (stageName === "classify") {
    const assignments = res && typeof res === "object" && Array.isArray(res.assignments) ? res.assignments : null;
    if (!assignments) {
      return { ok: false, processed: 0, id: target.id, error: "classify 결과에 assignments 배열 없음" };
    }
    if (!Array.isArray(ledger)) {
      return { ok: false, processed: 0, id: target.id, error: "classify 원장 materialize 실패 — 배정 검증 불가" };
    }
    const ledgerIds = new Set(ledger.map((e) => e && e.id).filter(Boolean));
    const seen = new Set();
    const errs = [];
    for (const a of assignments) {
      if (!a || typeof a.id !== "string" || typeof a.category !== "string" || !a.category) {
        errs.push(`형식 위반: ${JSON.stringify(a)}`);
        continue;
      }
      if (!ledgerIds.has(a.id)) errs.push(`원장 밖 id: ${a.id}`);
      else if (seen.has(a.id)) errs.push(`중복 배정: ${a.id}`);
      seen.add(a.id);
    }
    for (const id of ledgerIds) if (!seen.has(id)) errs.push(`미배정: ${id}`);
    if (errs.length) {
      // 거부 → 노드 미변경(status todo 유지) → 코어 backoff 가 classify 재실행(LLM 재시도).
      return { ok: false, processed: 0, id: target.id, error: `classify 배정 검증 실패(${errs.length}건): ${errs[0]}` };
    }
    for (const a of assignments) {
      const er = await deps.editNode(a.id, { category: a.category });
      if (er && er.ok === false) {
        return { ok: false, processed: 0, id: target.id, error: `category 기록 실패(${a.id}): ${er.error || ""}` };
      }
      assigned += 1;
    }
  }
  // audit 는 결과가 곧 산출 — verdict/complete 없이 done 처리하면 '감사 없는 완결'이 된다(거부→재시도).
  if (stageName === "audit" && !(res && typeof res === "object")) {
    return { ok: false, processed: 0, id: target.id, error: "audit 결과 없음(verdict/complete 미반환)" };
  }
  if (res && typeof res === "object" && target.parentId) {
    const chunkEdit = {};
    if (typeof res.chunkTitle === "string" && res.chunkTitle) chunkEdit.title = res.chunkTitle;
    if (typeof res.verdict === "string" && res.verdict) chunkEdit.result = res.verdict;
    // classify: dimension 을 덩어리 result 에 기록(분류 차원 = 원장 종합 산출).
    if (stageName === "classify" && typeof res.dimension === "string" && res.dimension) chunkEdit.result = res.dimension;
    // audit: 인증 상태 기계 — complete(불리언) 소비 + 원장 f 집계 → 덩어리 badge 로 인증/폐기 확정.
    // verdict 산문만으론 인증/미인증을 구조적으로 구분할 수 없다(어느 노드가 원인인지는 항목 badge/result 가 담당).
    // 규칙: complete===true ∧ 원장 f=0 → 'o'(인증) / 그 외 → 'f'(폐기). 원장 미상(-1)은 인증 불가 → 'f'.
    if (stageName === "audit") {
      const fCount = Array.isArray(ledger) ? ledger.filter((e) => e && e.badge === "f").length : -1;
      chunkEdit.badge = res.complete === true && fCount === 0 ? "o" : "f";
    }
    if (Object.keys(chunkEdit).length) await deps.editNode(target.parentId, chunkEdit);
  }
  await deps.editNode(target.id, { status: "done" }); // stage 작업 done → 재-pick 0(멱등)
  await deps.poke(); // 발행된 항목(검수전)·후속 stage 깨움
  return { ok: true, processed: 1, id: target.id, stage: true, published: children.length, assigned };
}

/** issuerizeTick — 이슈라이즈(순수, deps 주입): 인증된 드래프트 덩어리의 plan-unit(슈도코드 단위)들을
 *  **unlock 된 개별 개발 이슈 노드**로 승격한다. 드래프트는 잠긴 채 보존, 이슈에 parentDraftId=덩어리 계보.
 *  게이트(전부 충족해야 승격 — fail-loud):
 *   ① 덩어리 badge==='o' (audit 인증 — M2 상태 기계)
 *   ② kind='fact'(research 기초지식) 자손이 ≥1 이고 전부 badge 확정(o/x/f) — research 경유 증명
 *   ③ kind='plan-unit'(plan 한턴 슈도코드) 자손 ≥1 — plan 경유 증명
 *  멱등: 이미 이 덩어리를 계보(parentDraftId)로 가진 kind='issue' 노드가 있으면 거부(중복 승격 차단).
 *  개발 실행 자체는 이슈 소비자(빌더 에이전트·사람) 몫 — 여기는 이슈화까지. deps: listNodes()·addNode(params). */
export async function issuerizeTick(deps, chunkId) {
  const listed = await deps.listNodes();
  const nodes = (listed && listed.nodes) || [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const chunk = byId.get(chunkId);
  if (!chunk) return { ok: false, error: `덩어리 미존재: ${chunkId}` };
  if (chunk.badge !== "o") {
    return { ok: false, error: `덩어리 미인증(badge=${JSON.stringify(chunk.badge ?? null)}) — audit 인증(badge='o') 후에만 이슈라이즈` };
  }
  const descends = (n) => {
    let p = n.parentId;
    let guard = 0;
    while (p && guard++ < 100) {
      if (p === chunkId) return true;
      p = (byId.get(p) || {}).parentId;
    }
    return false;
  };
  if (nodes.some((n) => n.kind === "issue" && n.parentDraftId === chunkId)) {
    return { ok: false, error: "이미 이슈라이즈된 덩어리(계보 issue 존재) — 멱등 거부" };
  }
  const facts = nodes.filter((n) => n.kind === "fact" && descends(n));
  if (facts.length === 0) return { ok: false, error: "research 미경유(기초지식 fact 없음) — research 워크플로 후에만 이슈라이즈" };
  const unverified = facts.filter((n) => !(n.badge === "o" || n.badge === "x" || n.badge === "f"));
  if (unverified.length) return { ok: false, error: `기초지식 미검증 ${unverified.length}건(검수전) — 검증 완료 후 이슈라이즈` };
  const units = nodes.filter((n) => n.kind === "plan-unit" && descends(n));
  if (units.length === 0) return { ok: false, error: "plan 미경유(plan-unit 없음) — plan(한턴 슈도코드화) 후에만 이슈라이즈" };
  // 배경지식(o 확정 fact)을 self-contained 로 이슈 본문에 동반 — 소비자가 덩어리를 다시 뒤지지 않게.
  const knowledge = facts.filter((n) => n.badge === "o").map((n) => `- ${n.title}`).join("\n");
  let issued = 0;
  for (const u of units) {
    const description = [u.description || u.title, knowledge ? `\n## 배경지식(research 확정)\n${knowledge}` : ""].join("");
    const r = await deps.addNode({
      title: u.title,
      description,
      type: "task",
      kind: "issue",
      parentDraftId: chunkId, // 계보 — 드래프트 원본은 잠긴 채 보존, 이슈는 unlock(locked 미지정)
      blockedBy: [],
    });
    if (!r) return { ok: false, error: `이슈 발행 실패(${u.id}) — 부분 승격 중단(발행 ${issued}건)`, issued };
    issued += 1;
  }
  return { ok: true, issued, chunk: chunkId };
}

/** researchGate — workflow.research 진입 게이트(순수, deps 주입: listNodes·getNode).
 *  ① 덩어리 badge==='o'(audit 인증 — PRINCIPLES §5 의 전제와 동일 축) ② description(정련 directive) 비어있지 않음
 *  ③ 멱등: 자손 fact(실행 흔적) 또는 research task(body.workflow==='research') 존재 시 거부.
 *  통과 시 directive=덩어리 description(단일 진실 §1 — 표시 표면이 곧 검증 기준). */
export async function researchGate(deps, chunkId) {
  const listed = await deps.listNodes();
  const nodes = (listed && listed.nodes) || [];
  const chunk = nodes.find((n) => n.id === chunkId);
  if (!chunk) return { ok: false, error: `덩어리 미존재: ${chunkId}` };
  if (chunk.badge !== "o") {
    return { ok: false, error: `덩어리 미인증(badge=${JSON.stringify(chunk.badge ?? null)}) — audit 인증(badge='o') 후에만 research` };
  }
  if (!chunk.description || !String(chunk.description).trim()) {
    return { ok: false, error: "덩어리 description(정련 directive) 비어있음 — 검증 기준 없이 research 불가" };
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const descends = (n) => {
    let p = n.parentId;
    let guard = 0;
    while (p && guard++ < 100) {
      if (p === chunkId) return true;
      p = (byId.get(p) || {}).parentId;
    }
    return false;
  };
  if (nodes.some((n) => n.kind === "fact" && descends(n))) {
    return { ok: false, error: "이미 research 진행/완료(fact 존재) — 멱등 거부" };
  }
  for (const t of nodes.filter((n) => n.kind === "task" && n.parentId === chunkId)) {
    const full = await deps.getNode(t.id);
    let b;
    try {
      b = JSON.parse(((full && full.node) || {}).body || "");
    } catch {
      continue;
    }
    if (b && b.workflow === "research") return { ok: false, error: "이미 research task 발행됨 — 멱등 거부" };
  }
  return { ok: true, directive: chunk.description };
}

// ── app 연결(런타임) ──

/** resolveDirective — directive 단일 진실(PRINCIPLES.md §1) 해석(순수, 테스트 대상).
 *  우선순위: ① 명시 directive 파라미터(사용자 직접 지정 = 최상위 정본)
 *           ② workflow-doc 의 정련본(args.directive.default — 저작 게이트를 통과한 정본)
 *           ③ raw 폴백(idea — 비-doc skeleton 하위호환).
 *  칸반 chunk description(--emit 이 doc default 로 발행)과 task body args.directive 가 같은 문자열이
 *  되도록 — 표시 표면과 검증 기준의 provenance 를 일치시킨다(의미가 바뀌면 결과가 바뀐다). */
export function resolveDirective(explicit, doc, raw) {
  if (typeof explicit === "string" && explicit.trim()) return explicit;
  const refined = doc && doc.spec === "workflow-doc@0.0.1" ? doc.args?.directive?.default : undefined;
  if (typeof refined === "string" && refined.trim()) return refined;
  return raw;
}

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

/** buildSecretEnvMap — secrets.keys() 목록에서 "env:" prefix 키를 spawn secretEnv(envVar→secretKey) 매핑으로.
 *  평문은 JS 를 거치지 않는다 — 키 이름만 넘기면 코어 Rust 경계가 볼트에서 해소해 자식 env 에 주입(api secretEnv).
 *  재시작 후에도 볼트에 남아 있어 reconcile exec 이 인증을 되찾는다(인메모리 캡처 env 의 휘발 해소). */
export function buildSecretEnvMap(keys) {
  const m = {};
  for (const k of Array.isArray(keys) ? keys : []) {
    if (typeof k === "string" && k.startsWith("env:") && k.length > 4) m[k.slice(4)] = k;
  }
  return m;
}

/** buildSpawnCmd — soksak-sidecar-workflow spawn 명령 조립. bin 명시(workflow.run 파라미터)면 직접 spawn,
 *  없으면 로그인셸 랩: 플러그인은 Blob 로 로드돼 자기 경로를 모른다 → 단일 폴더 플러그인 컨벤션 경로
 *  사이드카 표준($HOME/.soksak/sidecars/soksak-sidecar-workflow/dist/) 기본 + SOKSAK_SIDECAR_WORKFLOW_BIN
 *  env 오버라이드. sh -l 이 GUI(Finder) 실행의
 *  PATH 미상속도 함께 해소한다(로그인셸이 rc 를 로드 — acp-core 선례). */
export function buildSpawnCmd(bin, args) {
  if (bin) return { cmd: bin, args };
  const script =
    'exec "${SOKSAK_SIDECAR_WORKFLOW_BIN:-$HOME/.soksak/sidecars/soksak-sidecar-workflow/dist/soksak-sidecar-workflow}" "$@"';
  return { cmd: "/bin/sh", args: ["-lc", script, "soksak-sidecar-workflow", ...args] };
}

/** execOpts — spawn 3종(generate-skeleton/exec-one/exec-stage)의 env 주입 옵션.
 *  볼트 시크릿(env:* — 재시작 생존) 우선 → secretEnv 로 코어가 주입. 볼트가 비었거나 잠겼으면
 *  workflow.run 이 캡처한 세션 env 폴백(하위호환 — 재시작 전까지만 유효). */
async function execOpts(app, runtime) {
  if (app.secrets) {
    try {
      const keys = await app.secrets.keys();
      const secretEnv = buildSecretEnvMap(keys);
      if (Object.keys(secretEnv).length) return { secretEnv };
    } catch {
      /* vault 잠김 등 — 세션 env 폴백 */
    }
  }
  return runtime.env && typeof runtime.env === "object" ? { env: runtime.env } : {};
}

/** waitStdoutSettle — 프로세스 exit 후 stdout 잔여 도착 대기. 코어는 stdout EOF 후 exit 를 보내지만
 *  stdout(onData)과 exit(onExit)는 **서로 다른 Tauri IPC 채널**이라 웹뷰 도착 순서가 미보장 — 종료 직전
 *  대량 출력(20KB doc 등)이 exit 에 추월당해 유실된 실측 결함의 방어. 50ms 간격 길이 정지 2회(상한 3s) 확정. */
function waitStdoutSettle(getLen) {
  return new Promise((resolve) => {
    let last = getLen();
    let stable = 0;
    const iv = setInterval(() => {
      const cur = getLen();
      if (cur === last) {
        stable += 1;
        if (stable >= 2) {
          clearInterval(iv);
          resolve();
        }
      } else {
        stable = 0;
        last = cur;
      }
    }, 50);
    setTimeout(() => {
      clearInterval(iv);
      resolve();
    }, 3000);
  });
}

/** generate-skeleton spawn — 아이디어 → gen.js(LLM 저작) → skeleton JSON(stdout 문자열 resolve).
 *  claude 호출 → 인증 env 필요(발행 spawn 과 다름 — opts 는 execOpts 산출). lease=프로세스-생존(onExit 까지 대기). */
function genSkeleton(app, bin, opts, spec) {
  return new Promise((resolve, reject) => {
    let out = "";
    let err = ""; // stderr — 실패 원인 표면화(fail-loud §2: 원인 없는 exit N 금지)
    const dec = new TextDecoder();
    const errDec = new TextDecoder();
    const { cmd, args } = buildSpawnCmd(bin, genSkeletonArgs(spec));
    Promise.resolve(app.process.spawn(cmd, args, opts || {}))
      .then((handle) => {
        app.process.onData(handle, (b) => {
          out += dec.decode(b, { stream: true });
        });
        if (app.process.onStderr) {
          app.process.onStderr(handle, (b) => {
            err += errDec.decode(b, { stream: true });
          });
        }
        app.process.onExit(handle, (code) => {
          void waitStdoutSettle(() => out.length).then(() => {
            if (code !== 0) return reject(new Error(`generate-skeleton exit ${code}: ${err.trim().slice(-500)}`));
            const t = out.trim();
            if (!t.startsWith("{")) return reject(new Error(`generate-skeleton 출력이 doc JSON 아님(${t.length}자): ${t.slice(0, 200)}`));
            resolve(t);
          });
        });
      })
      .catch(reject);
  });
}

/** exec-one spawn — stdin 에 {prompt, schema?} 쓰고 stdout {oxf, result} 파싱.
 *  lease=프로세스-생존: spawn → **onExit await → 그제야 resolve/reject**. 도는 중(검색 1시간이든)엔 reply 금지 —
 *  스케줄러가 lease 로 기다린다. heartbeat 발신 없음(폐기). 정상 exit+결과=resolve, 비정상/무결과=reject(→ok:false). */
function execOne(app, bin, opts, body) {
  // wire 경계 — 직렬화는 여기가 소유(호출자 stringify 중복·객체 오전달 차단). process_write 는 문자열 계약.
  if (typeof body !== "string") body = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    const dec = new TextDecoder();
    const errDec = new TextDecoder();
    const { cmd, args } = buildSpawnCmd(bin, ["exec-one", "--lang", "ko"]);
    Promise.resolve(app.process.spawn(cmd, args, opts || {}))
      .then(async (handle) => {
        app.process.onData(handle, (b) => {
          out += dec.decode(b, { stream: true });
        });
        if (app.process.onStderr) {
          app.process.onStderr(handle, (b) => {
            err += errDec.decode(b, { stream: true });
          });
        }
        app.process.onExit(handle, (code) => {
          void waitStdoutSettle(() => out.length).then(() => {
            if (code !== 0) return reject(new Error(`exec-one exit ${code}: ${err.trim().slice(-500)}`));
            try {
              resolve(JSON.parse(out.trim()));
            } catch {
              reject(new Error(`exec-one 출력 JSON 파싱 실패: ${out.slice(0, 200)}`));
            }
          });
        });
        await app.process.write(handle, body);
        await app.process.closeStdin(handle); // EOF 필수 — stdin read-to-end 자식은 이 호출 없이 영구 블록(실측)
      })
      .catch(reject);
  });
}

/** exec-stage spawn — stdin {skeleton, stage, args} 쓰고 stdout(자식 {ev:add} JSON line + 최종 {ev:result})
 *  파싱 → { children:[add…], result }. lease=프로세스-생존: onExit 까지 대기. env=인증(claude 실행하므로 필요). */
function execStage(app, bin, opts, body) {
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    let seen = 0; // 진행 델타 증분 스캔 커서(축적 파싱과 별개 — 최종 판정은 exit 에서 그대로)
    const dec = new TextDecoder();
    const errDec = new TextDecoder();
    const { cmd, args } = buildSpawnCmd(bin, ["exec-stage", "--lang", "ko"]);
    Promise.resolve(app.process.spawn(cmd, args, opts || {}))
      .then(async (handle) => {
        app.process.onData(handle, (b) => {
          out += dec.decode(b, { stream: true });
          // 사이드카 {ev:add} 라인 → 표준 진행 델타(MESSAGE-PROTOCOL §2) — 실행 중 "무엇이
          // 만들어지는지"를 활동 스트림에 흘린다(A14: 변환은 소비 플러그인 책임).
          const nl = out.lastIndexOf("\n");
          if (nl > seen) {
            for (const line of out.slice(seen, nl).split("\n")) {
              const t = line.trim();
              if (!t.startsWith("{")) continue;
              let ev;
              try { ev = JSON.parse(t); } catch { continue; }
              if (ev.ev === "add" && app.events && app.events.progress) {
                const label = ev.title || ev.stage || ev.kind || "node";
                app.events.progress("reconcile", `+ ${String(label).slice(0, 120)}`);
              }
            }
            seen = nl + 1;
          }
        });
        if (app.process.onStderr) {
          app.process.onStderr(handle, (b) => {
            err += errDec.decode(b, { stream: true });
          });
        }
        app.process.onExit(handle, (code) => {
          void waitStdoutSettle(() => out.length).then(() => {
          if (code !== 0) return reject(new Error(`exec-stage exit ${code}: ${err.trim().slice(-500)}`));
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
        });
        await app.process.write(handle, body);
        await app.process.closeStdin(handle); // EOF 필수 — stdin read-to-end 자식은 이 호출 없이 영구 블록(실측)
      })
      .catch(reject);
  });
}

export default {
  async activate(ctx) {
    const app = ctx.app;
    // 실행 런타임(workflow.run/workflow.research 가 갱신). reconcile 핸들러가 exec spawn 에, relay 가 task body 에 쓴다.
    // bin=null → buildSpawnCmd 로그인셸 랩 기본(재시작 후에도 결정 가능). env 는 세션 캡처 — 영속은 secrets(env:*).
    // workflowRef: 번들 정본 이름(research 등) — 설정 시 task body 는 doc 임베드 대신 이름 참조(exec-stage 가 로드).
    const runtime = { bin: null, env: undefined, skeleton: undefined, directive: undefined, workflowRef: undefined };
    // reconcile 인메모리 상태(무판정 상한·기아 방지 카운터) — activate 수명, 재시작 시 리셋 허용.
    const reconcileState = makeReconcileState();

    /** emitAndRelay — --emit spawn + 발행 relay(workflow.run/workflow.research 공유).
     *  stdout JSON line → 칸반 node.add(keyOf 부모 해석·roleToHash 정규화·taskCtx 임베드), stderr 수집,
     *  exit code·relay 실패를 검사해 fail-loud 반환(선반환 {ok:true} 금지 — PRINCIPLES §2). */
    async function emitAndRelay(emitArgs, stdinContent) {
      const emitCmd = buildSpawnCmd(runtime.bin, emitArgs);
      const handle = await app.process.spawn(emitCmd.cmd, emitCmd.args, {}); // 발행은 LLM 미호출 → env 불필요

      const keyOf = new Map(); // 워크플로 노드 id → 칸반 노드 id
      let buf = "";
      let errBuf = ""; // --emit stderr(러스트 error: 진단) — 실패 시 사용자 표면으로.
      const queue = [];
      let processing = false;
      let relayErrors = 0; // node.add/prompt.put relay 실패 집계 — 침묵 삼킴 금지(fail-loud).
      let firstRelayError = "";

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
            // stage 작업(kind=task) 노드 body: workflowRef(번들 이름 참조) 우선, 없으면 skeleton 임베드.
            const taskCtx = runtime.workflowRef
              ? { workflowRef: runtime.workflowRef, directive: runtime.directive }
              : runtime.skeleton
                ? { skeleton: runtime.skeleton, directive: runtime.directive }
                : undefined;
            const params = buildAddParams(ev, parentId, blockedBy, taskCtx, roleToHash); // 발행 relay·exec-stage relay 공유
            const r = await app.commands.execute(KANBAN + ".node.add", params);
            if (r && r.nodeId) keyOf.set(ev.id, r.nodeId);
            else throw new Error(`node.add 거부: ${(r && r.error) || JSON.stringify(r)}`);
          }
        } catch (e) {
          relayErrors += 1;
          if (!firstRelayError) firstRelayError = String((e && e.message) || e);
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
      if (app.process.onStderr) {
        const errDec = new TextDecoder();
        app.process.onStderr(handle, (bytes) => {
          errBuf += errDec.decode(bytes, { stream: true });
        });
      }
      const exited = new Promise((resolve) => {
        app.process.onExit(handle, (code) => resolve(code));
      });

      if (stdinContent) {
        await app.process.write(handle, stdinContent);
        await app.process.closeStdin(handle); // EOF 필수 — stdin read-to-end 자식은 이 호출 없이 영구 블록(실측)
      }

      // 발행 완결까지 대기 — exit code·relay 실패를 검사해 fail-loud 로 반환(선반환 {ok:true} 금지).
      const code = await exited;
      await waitStdoutSettle(() => buf.length + queue.length); // 교차 채널 지연 도착 방어
      if (buf.trim()) queue.push(buf.trim());
      await drain();
      if (code !== 0) {
        const tail = errBuf.trim().slice(-500);
        const error = `--emit exit ${code}${tail ? `: ${tail}` : ""}`;
        app.bus?.emit?.("workflow.error", { message: error });
        return { ok: false, error, published: keyOf.size };
      }
      if (relayErrors > 0) {
        return { ok: false, error: `발행 relay 실패 ${relayErrors}건(첫: ${firstRelayError})`, published: keyOf.size };
      }
      app.bus?.emit?.("workflow.done", {});
      // 발행 완료 → reconcile 깨워 새 ready 노드 처리.
      app.scheduler?.poke?.(RECONCILE_ID);
      return { ok: true, published: keyOf.size };
    }

    ctx.subscriptions.push(
      app.commands.register("run", {
        description: "아이디어(idea) 또는 워크플로 문서(workflow-doc@0.0.1) 를 받아 칸반에 노드 DAG 로 발행하고, reconcile 로 실행을 건다. idea 면 내부에서 generate-skeleton(LLM 저작→doc) 을 먼저 돈다.",
        params: {
          idea: { type: "string", description: "사용자 아이디어 — 내부 generate-skeleton(LLM 저작→workflow-doc)으로 발행. skeleton/skeletonPath 없을 때." },
          skeleton: { type: "string", description: "workflow-doc@0.0.1 JSON 문자열(stdin). idea 대신 직접 공급." },
          skeletonPath: { type: "string", description: "workflow-doc@0.0.1 JSON 파일 경로(인자)" },
          bin: { type: "string", description: "soksak-workflow 바이너리 경로(기본 PATH)" },
          model: { type: "string", description: "generate-skeleton 저작 모델(기본 프로필 기본값)." },
          refs: { type: "string", description: "references override 경로(기본=플러그인 번들 self-contained)." },
          env: { type: "json", description: "generate-skeleton·exec-one(claude -p) 에 주입할 인증 env(ANTHROPIC_*). 순수 발행(--emit)은 토큰 불필요." },
          directive: { type: "string", description: "입력 지시어 — stage 작업 노드 body 에 임베드(exec-stage args.directive). 없으면 idea 로 승격." },
        },
        returns: "{ ok, published?, error? }",
        handler: async ({ idea, skeleton, skeletonPath, bin, model, refs, env, directive }) => {
          runtime.bin = bin || null; // null → buildSpawnCmd 로그인셸 랩 기본
          runtime.env = env; // 세션 캡처(폴백) — 영속은 아래 secrets
          // env 를 볼트에 봉인(env:* 키) — 재시작 후 reconcile exec 이 secretEnv 로 되찾는다(인메모리 휘발 해소).
          if (env && typeof env === "object" && app.secrets) {
            try {
              for (const [k, v] of Object.entries(env)) await app.secrets.set("env:" + k, String(v));
            } catch (e) {
              app.bus?.emit?.("workflow.error", { message: `secrets.set: ${String(e)}` });
            }
          }
          // idea 만 주어지면(skeleton/skeletonPath 없음) → generate-skeleton 으로 workflow-doc 저작해 발행에 흘림.
          if (idea && !skeleton && !skeletonPath) {
            skeleton = await genSkeleton(app, runtime.bin, await execOpts(app, runtime), { idea, model, refs });
          }
          // skeleton 캡처(인라인 문자열) — stage 작업 노드 body 에 임베드해 reconcile 이 exec-stage 로 재실행.
          try { runtime.skeleton = skeleton ? JSON.parse(skeleton) : undefined; } catch { runtime.skeleton = undefined; }
          runtime.workflowRef = undefined; // 저작/skeleton 경로는 임베드 — 번들 이름 참조 아님(research 잔재 차단)
          // directive 단일 진실(PRINCIPLES §1): 명시 directive > doc 정련본(저작 게이트 통과 정본) > idea raw.
          // --emit 의 chunk description(doc default)과 여기서 임베드하는 검증 기준이 같은 문자열이 된다.
          runtime.directive = resolveDirective(directive, runtime.skeleton, idea);
          const input = skeletonPath || "-";
          return await emitAndRelay([input, "--emit", "--lang", "ko"], !skeletonPath && skeleton ? skeleton : undefined);
        },
      }),
    );

    // ping — provider 헬스 프로브. exec-one 에 고정 미니 프롬프트를 **실경로**(spawn·sh랩·secretEnv)로
    // 태워 왕복을 확인한다 — 외부 임시 스크립트 금지 원칙의 내재화. 멱등(보드 무접촉·상태 무변경).
    ctx.subscriptions.push(
      app.commands.register("ping", {
        description: "provider 헬스 프로브 — exec-one 실경로로 고정 미니 프롬프트 왕복. 보드 무접촉(멱등).",
        params: {
          env: { type: "json", description: "claude -p 에 주입할 인증 env(ANTHROPIC_*). 없으면 볼트(env:*)/세션 캡처." },
        },
        returns: "{ ok, oxf?, ms?, error? }",
        handler: async ({ env }) => {
          if (env && typeof env === "object") runtime.env = env;
          const t0 = Date.now();
          try {
            const out = await execOne(app, runtime.bin, await execOpts(app, runtime), {
              prompt: '다음 항목을 판정하라: "1 더하기 1은 2다". 참이면 oxf=o.',
            });
            return { ok: true, oxf: out?.oxf ?? null, ms: Date.now() - t0 };
          } catch (e) {
            return { ok: false, ms: Date.now() - t0, error: String(e).slice(0, 500) };
          }
        },
      }),
    );

    // research — 인증 덩어리에 번들 정본 워크플로(workflows/research.doc.json)를 건다(저작 LLM 불참 — PRINCIPLES §7).
    ctx.subscriptions.push(
      app.commands.register("research", {
        description:
          "인증된 드래프트 덩어리(badge='o')에 research 워크플로를 발행 — 기초지식(fact: framework/methodology/directive) 발굴·검증 후 plan(한턴 슈도코드화)이 자동 연결된다. directive=덩어리 description(정련 정본, 단일 진실). 재호출 멱등 거부.",
        params: {
          chunk: { type: "string", description: "대상 덩어리(칸반 노드 id) — audit 인증(badge='o') 필수" },
        },
        returns: "{ ok, published?, error? }",
        handler: async ({ chunk }) => {
          if (!chunk) return { ok: false, error: "chunk(덩어리 id) 필수" };
          const gate = await researchGate(
            {
              listNodes: () => app.commands.execute(KANBAN + ".node.list", { limit: 100000 }),
              getNode: (id) => app.commands.execute(KANBAN + ".node.get", { node: id }),
            },
            chunk,
          );
          if (!gate.ok) return gate;
          runtime.workflowRef = "research"; // task body = 이름 참조(exec-stage 가 번들 doc 로드)
          runtime.skeleton = undefined;
          runtime.directive = gate.directive; // 단일 진실(§1): 덩어리 description = 정련 정본 = 검증 기준
          return await emitAndRelay(
            ["--workflow", "research", "--emit", "--lang", "ko", "--args-json", JSON.stringify({ chunkRef: chunk, directive: gate.directive })],
            undefined,
          );
        },
      }),
    );

    // reconcile 명령 — 칸반 ready 노드 1개를 실행. 스케줄러가 발화(activate poke·완료 poke·kanban:changed).
    ctx.subscriptions.push(
      app.commands.register("reconcile", {
        description:
          "칸반 ready 노드 1개를 실행 — item 은 exec-one 검증(badge o/x/f 기록), task 는 exec-stage(stage 실행·자식 노드 발행·classify category 기록·덩어리 result 갱신) → 다음 깨움.",
        params: {},
        returns: "{ ok, processed, id?, badge? }",
        handler: async () => {
          const deps = {
            // limit 명시 — 칸반 node.list 기본 200 절단이 pickReady/멱등 마커/#6 게이트/ledger 를 부분 데이터로
            // 오판시킨다(무음). 칸반 store 는 인메모리 배열이라 전량 조회 비용 무시 가능.
            listNodes: () => app.commands.execute(KANBAN + ".node.list", { limit: 100000 }),
            getNode: (id) => app.commands.execute(KANBAN + ".node.get", { node: id }),
            editNode: (id, fields) => app.commands.execute(KANBAN + ".node.edit", { node: id, ...fields }),
            // lease=프로세스-생존: exec-one/exec-stage 가 onExit 까지 reply 보류(도는 중 안 잘림). 코어가 backstop 으로만 관리.
            execOne: async (body) => execOne(app, runtime.bin, await execOpts(app, runtime), body),
            execStage: async (body) => execStage(app, runtime.bin, await execOpts(app, runtime), body),
            // exec-stage 자식 노드 발행 → 칸반 node.add, 칸반 id 반환(reconcileStage 가 배치 keyOf 로 부모 잇게).
            addNode: async (params) => {
              const r = await app.commands.execute(KANBAN + ".node.add", params);
              return r && r.nodeId;
            },
            // hunt/classify/audit/plan 용 ledger — 덩어리 자손 요건+배지(node.list 로, limit 명시).
            materializeLedger: async (chunkId) => {
              const listed = await app.commands.execute(KANBAN + ".node.list", { limit: 100000 });
              return buildLedger((listed && listed.nodes) || [], chunkId);
            },
            // plan 용 기초지식 원장 — research 가 발행한 kind=fact 자손(검증 배지 포함).
            materializeFacts: async (chunkId) => {
              const listed = await app.commands.execute(KANBAN + ".node.list", { limit: 100000 });
              return buildLedger((listed && listed.nodes) || [], chunkId, "fact");
            },
            poke: () => app.scheduler?.poke?.(RECONCILE_ID),
            // 프롬프트 정규화(콘텐츠 주소화): 등록(sha256 dedup)·조립({{key}}→vars). 조립기 단일=kanban.
            putPrompt: (value) => app.commands.execute(KANBAN + ".prompt.put", { value }),
            resolvePrompt: (hash, vars, refs) => app.commands.execute(KANBAN + ".prompt.resolve", { hash, vars, refs }),
            getPrompt: (hash) => app.commands.execute(KANBAN + ".prompt.get", { hash }),
          };
          // reconcileTick 이 ok 를 정한다 — exec 실패 시 ok:false → 코어 backoff 재시도(재시도 판정 ok!=true).
          return await reconcileTick(deps, reconcileState);
        },
      }),
    );

    // 이슈라이즈 — 인증(badge='o')·research(fact 검증 완료)·plan(plan-unit) 을 전부 경유한 덩어리의
    // 슈도코드 단위를 unlock 개발 이슈로 승격. 게이트·멱등은 issuerizeTick(순수)이 판정.
    ctx.subscriptions.push(
      app.commands.register("issuerize", {
        description:
          "인증된 드래프트 덩어리(badge='o', research fact 검증 완료, plan-unit 존재)의 슈도코드 단위를 unlock 개발 이슈 노드로 승격 — parentDraftId 계보, 원본 드래프트는 잠긴 채 보존, 재호출 멱등 거부.",
        params: {
          chunk: { type: "string", description: "이슈라이즈할 덩어리(칸반 노드 id)" },
        },
        returns: "{ ok, issued?, error? }",
        handler: async ({ chunk }) => {
          if (!chunk) return { ok: false, error: "chunk(덩어리 id) 필수" };
          const deps = {
            listNodes: () => app.commands.execute(KANBAN + ".node.list", { limit: 100000 }),
            addNode: async (params) => {
              const r = await app.commands.execute(KANBAN + ".node.add", params);
              return r && r.nodeId;
            },
          };
          return await issuerizeTick(deps, chunk);
        },
      }),
    );

    // 코어 스케줄러에 reconcile 등록(멱등) — poke 시 발화. crash 후 재개는 아래 부팅 poke 가 담당.
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
        // 부팅 1회 스캔 — Reconcile 트리거는 등록만으론 발화하지 않는다(코어 first_fire=None; 코어 테스트가
        // '등록만으론 미발화'를 고정). 재시작 후 미완 노드(검수전 항목·미완 task)가 남아 있으면 이 poke 가
        // 재개하고, 없으면 ready 0 no-op(멱등)이다.
        await app.scheduler.poke?.(RECONCILE_ID);
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
