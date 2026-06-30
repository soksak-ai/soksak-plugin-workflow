// soksak-workflow — JS 어댑터. 추출기(추출, node) + soksak-workflow(실행, rust) 사이드카를
// 묶어 commands 로 노출한다. 자체 로직 0 — 추출은 추출기, 실행/③파생은 soksak-workflow.
// agent 의 실제 LLM 호출은 soksak-workflow 가 claude -p(인증 프로필)로 위임.
//
// 흐름(workflow.run): .workflow.js ──node 추출기 parse──▶ 골격 JSON ──fs.writeText──▶
//   임시파일 ──soksak-workflow <tmp> --arg IDEA=…(인증 프로필 env)──▶ 결과 JSON.
// 노출: directive.synth {idea} · workflow.run {workflowJs, idea, allowTools?}

export default {
  async activate(ctx) {
    const app = ctx.app;
    const cfg = ctx.config || {};
    const runBin = cfg.soksakWorkflowBin || "soksak-workflow";
    const 추출기Cli = cfg.추출기Cli || null; // node 로 실행할 cli.js 경로
    const tmpDir = cfg.tmpDir || "/tmp";
    const 인증 프로필Env = cfg.인증 프로필Env || {};

    ctx.subscriptions.push(
      app.commands.register("directive.synth", {
        description: "③파생 도메인 지시어 생성(LLM 없음)",
        handler: async (args) => {
          const idea = args && args.idea;
          if (!idea) return { ok: false, message: "idea 필수" };
          try {
            const { stdout } = await runProc(app, ctx, runBin, ["synth", "--idea", idea], {});
            return { ok: true, result: JSON.parse(stdout) };
          } catch (e) {
            return { ok: false, message: String((e && e.message) || e) };
          }
        },
      }),
    );

    ctx.subscriptions.push(
      app.commands.register("workflow.run", {
        description: "워크플로(.workflow.js) 실행 — 추출→③파생→agent(claude -p)",
        handler: async (args) => {
          const { workflowJs, idea, allowTools } = args || {};
          if (!workflowJs || !idea) return { ok: false, message: "workflowJs, idea 필수" };
          if (!추출기Cli) return { ok: false, message: "config.추출기Cli(경로) 필요" };
          try {
            // 1) 추출: node 추출기/cli.js parse <workflowJs> → 골격 JSON.
            const { stdout: skeletonJson } = await runProc(app, ctx, "node", [추출기Cli, "parse", workflowJs], {});
            // 2) 골격을 임시파일로(soksak-workflow 는 파일/`-` 입력).
            const tmp = `${tmpDir}/soksak-skeleton-${Date.now()}.json`;
            await app.fs.writeText(tmp, skeletonJson);
            // 3) 실행: soksak-workflow <tmp> --arg IDEA=<idea> [--allow-tools …] (인증 프로필 env).
            const runArgs = [tmp, "--arg", `IDEA=${idea}`];
            if (allowTools) runArgs.push("--allow-tools", allowTools);
            const { stdout } = await runProc(app, ctx, runBin, runArgs, 인증 프로필Env);
            return { ok: true, result: JSON.parse(stdout) };
          } catch (e) {
            return { ok: false, message: String((e && e.message) || e) };
          }
        },
      }),
    );
  },

  deactivate() {},
};

// runProc — 프로세스를 끝까지 실행, stdout 수집. exit 0 = resolve, 그 외 = reject(stderr).
function runProc(app, ctx, cmd, args, env) {
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    const dec = new TextDecoder();
    Promise.resolve(app.process.spawn(cmd, args, { env }))
      .then((handle) => {
        const dOut = app.process.onData(handle, (b) => {
          out += dec.decode(b, { stream: true });
        });
        const dErr = app.process.onStderr(handle, (b) => {
          err += dec.decode(b, { stream: true });
        });
        const dExit = app.process.onExit(handle, (code) => {
          dispose(dOut);
          dispose(dErr);
          dispose(dExit);
          if (code === 0) resolve({ stdout: out, stderr: err });
          else reject(new Error(`${cmd} exit ${code}: ${err.slice(0, 300)}`));
        });
        ctx.subscriptions.push(dOut, dErr, dExit);
      })
      .catch(reject);
  });
}

function dispose(d) {
  if (d && typeof d.dispose === "function") d.dispose();
}
