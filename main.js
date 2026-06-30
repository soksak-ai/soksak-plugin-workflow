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

/** 노드 done 판정(미존재 의존=false, 안전). */
export function isDone(node) {
  return !!node && node.status === "done";
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
  return list.filter((n) => {
    if (!depsDone(n)) return false;
    if (n.badge === "검수전" && !hasChild.has(n.id)) return true; // 항목 검증
    if (n.kind === "task" && n.status !== "done") return true; // stage 작업 실행
    return false;
  });
}

/** buildLedger — 덩어리(chunkId) 자손 항목(kind=item)을 ledger 엔트리로(hunt/audit exec-stage args.ledger).
 *  부모 사슬로 자손 판정. category = 항목의 그룹(부모) title. hunt 가 중복 회피·audit 가 완결성 인증에 씀. */
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
    .map((n) => ({ title: n.title, badge: n.badge, category: (byId.get(n.parentId) || {}).title }));
}

/** classifyResult — exec-one 산출(result)의 모양으로 처리 분기를 정한다(모델 B 동적 발행).
 *  draft 스테이지마다 산출 스키마가 달라 main.js reconcile 가 이걸로 가른다:
 *  - generate: {title, groups[]} → 덩어리 title 갱신 + 그룹/항목 동적 발행(--emit expand 재호출).
 *  - hunt:     {additions[]}      → 누락 항목(badge=검수전) 동적 발행.
 *  - audit:    {complete|verdict} → 덩어리 감사 기록.
 *  - verify:   {status|oxf=o/x/f} → 항목 배지 갱신(execResultToEdit).
 *  - plain:    그 외(raw 텍스트 등) → 결과만 기록. */
export function classifyResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return "plain";
  if (Array.isArray(result.groups)) return "generate";
  if (Array.isArray(result.additions)) return "hunt";
  if (typeof result.complete === "boolean" || typeof result.verdict === "string") return "audit";
  const v = result.oxf || result.status;
  if (v === "o" || v === "x" || v === "f") return "verify";
  return "plain";
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
    return reconcileStage(deps, target, body);
  }
  // 항목 검증 — exec-one(verifyPrompt) → 배지.
  let execOut;
  try {
    execOut = await deps.execOne(body);
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
 *  - kind=task(stage 작업) + taskCtx{skeleton,directive} → exec-stage 입력 {skeleton, stage(=ev.prompt), args{directive,chunkRef}}.
 *    chunkRef=부모(덩어리). main.js 가 skeleton 임베드 — draft.js 무관여.
 *  - 그 외(항목) → exec-one 입력 {prompt(=verifyPrompt), schema}. prompt 없으면(그룹/덩어리) body 빈 문자열. */
export function buildAddParams(ev, parentId, blockedBy, taskCtx) {
  let body;
  if (ev.kind === "task" && taskCtx && taskCtx.skeleton) {
    body = JSON.stringify({
      skeleton: taskCtx.skeleton,
      stage: ev.prompt || "generate",
      args: { directive: taskCtx.directive, chunkRef: parentId },
    });
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
  if (ev.badge) params.badge = ev.badge;
  if (ev.is_draft) params.isDraft = true;
  if (ev.parent_draft_id) params.parentDraftId = ev.parent_draft_id;
  return params;
}

/** reconcileStage — kind=task 노드를 exec-stage 로 실행 → 자식 노드 발행 + 덩어리 갱신 + status=done(멱등) + poke.
 *  exec-stage 산출 = { children:[add 이벤트…], result:<워크플로 return> }. 실패는 ok:false(노드 미변경)→backoff.
 *  자식 부모 ref 해결: 배치 keyOf(로컬 emit id→칸반 id) / 기존 칸반 id(chunkRef)는 그대로. addNode(params)→칸반 id. */
async function reconcileStage(deps, target, body) {
  // hunt/audit 는 ledger(덩어리 자손 항목+배지) materialize 해 exec-stage args 에 주입(generate 는 불필요).
  let stageBody = body;
  let stageName;
  try { stageName = JSON.parse(body).stage; } catch { /* body 가 exec-stage 입력 아님 */ }
  if ((stageName === "hunt" || stageName === "audit") && deps.materializeLedger && target.parentId) {
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
  const children = (staged && staged.children) || [];
  const keyOf = new Map();
  for (const ev of children) {
    const parentId = ev.parent ? keyOf.get(ev.parent) || ev.parent : undefined;
    const blockedBy = (ev.blocked_by || ev.blockedBy || []).map((id) => keyOf.get(id) || id).filter(Boolean);
    const nodeId = await deps.addNode(buildAddParams(ev, parentId, blockedBy, childCtx));
    if (nodeId) keyOf.set(ev.id, nodeId);
  }
  // 덩어리 갱신: generate→title, audit→verdict(result). 덩어리 = stage 노드의 parent.
  const res = staged && staged.result;
  if (res && typeof res === "object" && target.parentId) {
    const chunkEdit = {};
    if (typeof res.chunkTitle === "string" && res.chunkTitle) chunkEdit.title = res.chunkTitle;
    if (typeof res.verdict === "string" && res.verdict) chunkEdit.result = res.verdict;
    if (Object.keys(chunkEdit).length) await deps.editNode(target.parentId, chunkEdit);
  }
  await deps.editNode(target.id, { status: "done" }); // stage 작업 done → 재-pick 0(멱등)
  await deps.poke(); // 발행된 항목(검수전)·후속 stage 깨움
  return { ok: true, processed: 1, id: target.id, stage: true, published: children.length };
}

// ── app 연결(런타임) ──

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
        description: "워크플로 skeleton(AST) 을 발행해 칸반에 노드 DAG 로 그리고, reconcile 로 실행을 건다.",
        params: {
          skeleton: { type: "string", description: "skeleton JSON 문자열(stdin)" },
          skeletonPath: { type: "string", description: "skeleton JSON 파일 경로(인자)" },
          bin: { type: "string", description: "soksak-workflow 바이너리 경로(기본 PATH)" },
          env: { type: "json", description: "exec-one(claude -p) 에 주입할 env(인증 프로필 ANTHROPIC_*). 발행은 토큰 불필요." },
          directive: { type: "string", description: "입력 지시어(아이디어) — stage 작업 노드 body 에 임베드(exec-stage args.directive)." },
        },
        returns: "{ ok }",
        handler: async ({ skeleton, skeletonPath, bin, env, directive }) => {
          const exe = bin || "soksak-workflow";
          runtime.bin = exe;
          runtime.env = env; // reconcile exec-one/exec-stage 가 쓸 인증 env 캡처
          runtime.directive = directive;
          // skeleton 캡처(인라인 문자열) — stage 작업 노드 body 에 임베드해 reconcile 이 exec-stage 로 재실행.
          try { runtime.skeleton = skeleton ? JSON.parse(skeleton) : undefined; } catch { runtime.skeleton = undefined; }
          const input = skeletonPath || "-";
          const args = [input, "--emit", "--lang", "ko"];
          const handle = await app.process.spawn(exe, args, {}); // 발행은 LLM 미호출 → env 불필요

          const keyOf = new Map(); // 워크플로 노드 id → 칸반 노드 id
          let buf = "";
          const queue = [];
          let processing = false;

          const handleEv = async (line) => {
            if (!line.startsWith("{")) return;
            let ev;
            try { ev = JSON.parse(line); } catch { return; }
            try {
              if (ev.ev === "add") {
                // 부모 ref: 로컬 emit id(이번 발행에서 추가됨)면 keyOf 로 칸반 id, 아니면 기존 칸반 id(chunkRef) 그대로.
                const parentId = ev.parent ? keyOf.get(ev.parent) || ev.parent : undefined;
                const blockedBy = (ev.blocked_by || ev.blockedBy || []).map((id) => keyOf.get(id) || id).filter(Boolean);
                // stage 작업(kind=task) 노드는 body 에 skeleton 임베드(exec-stage 입력). 항목/그룹은 무관.
                const taskCtx = runtime.skeleton ? { skeleton: runtime.skeleton, directive: runtime.directive } : undefined;
                const params = buildAddParams(ev, parentId, blockedBy, taskCtx); // 발행 relay·exec-stage relay 공유
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
