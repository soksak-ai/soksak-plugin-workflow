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

/** ready 노드 = 드래프트 항목(badge="검수전") ∧ leaf(자식 없음) ∧ blockedBy 전부 done.
 *  parallel=형제(blockedBy 없음)·pipeline=체인(blockedBy)은 노드 데이터로만 표현 — 여긴 그걸 읽어 판정. */
export function pickReady(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  const byId = new Map(list.map((n) => [n.id, n]));
  const hasChild = new Set();
  for (const n of list) if (n.parentId) hasChild.add(n.parentId);
  return list.filter(
    (n) =>
      n.badge === "검수전" &&
      !hasChild.has(n.id) &&
      (n.blockedBy || []).every((b) => isDone(byId.get(b))),
  );
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

/** reconcile 한 틱 — ready 1개를 exec-one 으로 처리(타임아웃 안전). 진척 시 poke 로 다음 깨움.
 *  deps(의존 주입 — 테스트 가능): listNodes() · getNode(id) · editNode(id,fields) · execOne(body) · poke(). */
export async function reconcileTick(deps) {
  const listed = await deps.listNodes();
  const nodes = (listed && listed.nodes) || [];
  const ready = pickReady(nodes);
  if (ready.length === 0) return { processed: 0 };
  const target = ready[0]; // 한 틱 1개 — 발화 시간 상한 안. 나머지는 poke 로 이어 처리.
  const full = await deps.getNode(target.id);
  const body = (full && full.node && full.node.body) || "";
  const execOut = await deps.execOne(body);
  const edit = execResultToEdit(execOut);
  await deps.editNode(target.id, edit);
  // 진척(배지 확정)했을 때만 다음 틱 깨움 — 무판정으로 self-poke 하면 tight loop. 외부/부팅이 재시도.
  if (edit.badge) await deps.poke();
  return { processed: 1, id: target.id, badge: edit.badge || null };
}

// ── app 연결(런타임) ──

/** exec-one spawn — stdin 에 {prompt, schema?} 쓰고 stdout {oxf, result} 파싱. */
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

export default {
  async activate(ctx) {
    const app = ctx.app;
    // 실행 런타임(workflow.run 이 갱신). reconcile 핸들러가 exec-one spawn 에 쓴다.
    const runtime = { bin: "soksak-workflow", env: undefined };

    ctx.subscriptions.push(
      app.commands.register("workflow.run", {
        description: "워크플로 skeleton(AST) 을 발행해 칸반에 노드 DAG 로 그리고, reconcile 로 실행을 건다.",
        params: {
          skeleton: { type: "string", description: "skeleton JSON 문자열(stdin)" },
          skeletonPath: { type: "string", description: "skeleton JSON 파일 경로(인자)" },
          bin: { type: "string", description: "soksak-workflow 바이너리 경로(기본 PATH)" },
          env: { type: "json", description: "exec-one(claude -p) 에 주입할 env(인증 프로필 ANTHROPIC_*). 발행은 토큰 불필요." },
        },
        returns: "{ ok }",
        handler: async ({ skeleton, skeletonPath, bin, env }) => {
          const exe = bin || "soksak-workflow";
          runtime.bin = exe;
          runtime.env = env; // reconcile exec-one 이 쓸 인증 env 캡처
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
                const parentId = ev.parent ? keyOf.get(ev.parent) : undefined;
                const blockedBy = (ev.blocked_by || ev.blockedBy || []).map((id) => keyOf.get(id)).filter(Boolean);
                // 칸반 Node.body = 워크플로 실행 지시(prompt/schema) — reconcile 가 exec-one stdin 으로 그대로 파이프.
                const execInput = ev.prompt
                  ? JSON.stringify(ev.schema ? { prompt: ev.prompt, schema: ev.schema } : { prompt: ev.prompt })
                  : ev.body || "";
                const params = {
                  title: ev.title || ev.kind,
                  parentId,
                  body: execInput,
                  blockedBy,
                  locked: true,
                  type: "task",
                };
                // 칸반 드래프트 계약(Phase 2): 마커는 드래프트 노드에만 — 일반 노드엔 안 넣음(보드 오염 방지).
                if (ev.badge) params.badge = ev.badge;
                if (ev.is_draft) params.isDraft = true;
                if (ev.parent_draft_id) params.parentDraftId = ev.parent_draft_id;
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
            execOne: (body) => execOne(app, runtime.bin, runtime.env, body),
            poke: () => app.scheduler?.poke?.(RECONCILE_ID),
          };
          const r = await reconcileTick(deps);
          return { ok: true, ...r };
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
          // exec-one(GLM 529 backoff 복구)이 길어도 발화가 TIMEOUT 으로 중복 실행 안 되게 넉넉히.
          timeout_ms: 600000,
        });
      } catch (e) {
        app.bus?.emit?.("workflow.error", { message: `scheduler.register: ${String(e)}` });
      }
    }
  },
  deactivate() {},
};
