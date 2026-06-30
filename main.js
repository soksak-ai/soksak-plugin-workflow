// soksak-plugin-workflow — 워크플로 런타임(rust soksak-run --kanban)을 spawn 하고,
// 그 stdout JSON line(노드 이벤트)을 받아 soksak-plugin-kanban 의 node.add/edit 내부 command 로 중계.
// 발행 노드는 locked: true(스케줄러 전용). CLI 아님 — app.commands.execute(plugin.<id>.<cmd>).
//
// 순서 보장: onData 조각을 라인 단위로 큐에 분리(동기)하고, drain 워커가 순차 await(keyOf race 방지).

const KANBAN = "plugin.soksak-plugin-kanban";

export default {
  activate(ctx) {
    const app = ctx.app;

    ctx.subscriptions.push(
      app.commands.register("workflow.run", {
        description: "워크플로 skeleton(AST) 을 실행해 칸반에 노드 DAG 로 그린다.",
        params: {
          skeleton: { type: "string", description: "skeleton JSON 문자열(stdin)" },
          skeletonPath: { type: "string", description: "skeleton JSON 파일 경로(인자)" },
          concurrency: { type: "number", description: "동시 실행 상한(기본 8)" },
          bin: { type: "string", description: "soksak-run 바이너리 경로(기본 PATH)" },
          env: { type: "json", description: "spawn 환경변수(예: 인증 프로필 ANTHROPIC_*)" },
        },
        returns: "{ ok }",
        handler: async ({ skeleton, skeletonPath, concurrency, bin, env }) => {
          const exe = bin || "soksak-run";
          const input = skeletonPath || "-";
          const args = [input, "--kanban", "--concurrency", String(concurrency ?? 8), "--lang", "ko"];
          const handle = await app.process.spawn(exe, args, env && typeof env === "object" ? { env } : {});

          const keyOf = new Map(); // 워크플로 노드 id → 칸반 노드 key
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
                const r = await app.commands.execute(KANBAN + ".node.add", {
                  title: ev.title || ev.kind,
                  parentId,
                  body: ev.body || "",
                  blockedBy,
                  locked: true,
                  type: "task",
                });
                if (r && r.nodeId) keyOf.set(ev.id, r.nodeId);
              } else if (ev.ev === "status") {
                const node = keyOf.get(ev.id);
                if (node) {
                  await app.commands.execute(KANBAN + ".node.edit", {
                    node,
                    status: ev.status === "done" ? "done" : "inprogress",
                    result: ev.result || "",
                  });
                }
              }
            } catch (e) {
              app.bus?.emit?.("workflow.error", { message: String(e) });
            }
          };

          // drain — 큐를 순차 처리(한 번에 하나, await). 재진입 방지로 순서 보장.
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
            void drain();
            app.bus?.emit?.("workflow.done", {});
          });

          if (!skeletonPath && skeleton) {
            await app.process.write(handle, skeleton);
            if (app.process.closeStdin) await app.process.closeStdin(handle);
          }

          return { ok: true };
        },
      })
    );
  },
  deactivate() {},
};
