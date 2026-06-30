// soksak-plugin-workflow — 워크플로 런타임(rust soksak-run --kanban)을 spawn 하고,
// 그 stdout JSON line(노드 이벤트)을 받아 soksak-plugin-kanban 의 node.add/edit 내부 command 로 중계.
// 발행 노드는 locked: true(스케줄러 전용 — 사람 드래그/분리 차단). CLI 아님 — app.commands.execute.

const KANBAN = "soksak-plugin-kanban";

export default {
  activate(ctx) {
    const app = ctx.app;

    ctx.subscriptions.push(
      app.commands.register("workflow.run", {
        description: "워크플로 skeleton(AST) 을 실행해 칸반에 노드 DAG 로 그린다.",
        params: {
          skeleton: { type: "string", required: true, description: "추출기 가 뽑은 skeleton JSON 문자열" },
          concurrency: { type: "number", description: "동시 실행 상한(기본 8)" },
          bin: { type: "string", description: "soksak-run 바이너리 경로(기본 PATH)" },
        },
        returns: "{ ok }",
        handler: async ({ skeleton, concurrency, bin }) => {
          const exe = bin || "soksak-run";
          const args = ["-", "--kanban", "--concurrency", String(concurrency ?? 8), "--lang", "ko"];
          const handle = await app.process.spawn(exe, args, {});

          // 워크플로 노드 id → 칸반 노드 key (parent/blockedBy 매핑용).
          const keyOf = new Map();
          let buf = "";

          const flush = async () => {
            let nl;
            while ((nl = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (!line.startsWith("{")) continue;
              let ev;
              try { ev = JSON.parse(line); } catch { continue; }
              try {
                if (ev.ev === "add") {
                  const parentId = ev.parent ? keyOf.get(ev.parent) : undefined;
                  const blockedBy = (ev.blockedBy || []).map((id) => keyOf.get(id)).filter(Boolean);
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
            }
          };

          app.process.onData(handle, (bytes) => {
            buf += new TextDecoder().decode(bytes);
            void flush();
          });
          app.process.onExit(handle, () => {
            void flush();
            app.bus?.emit?.("workflow.done", {});
          });

          // skeleton 을 stdin 으로 전달(soksak-run 의 "-" 입력).
          await app.process.write(handle, skeleton);
          if (app.process.closeStdin) await app.process.closeStdin(handle);

          return { ok: true };
        },
      })
    );
  },
  deactivate() {},
};
