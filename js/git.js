// Probe the repository for the facts drift compares against. Git runs directly through the process
// capability; the comparison itself stays pure (gate.js) so it can be judged without a repository.

const ENV = Object.freeze({ LC_ALL: "C", LANG: "C", GIT_OPTIONAL_LOCKS: "0" });
const TIMEOUT_MS = 30_000;

export function makeGit(processApi) {
  function run(cwd, args) {
    return new Promise((resolve, reject) => {
      const dec = new TextDecoder();
      let out = "";
      let err = "";
      let done = false;
      let timer = null;
      processApi
        .spawn("git", args, { cwd, env: { ...ENV } })
        .then((handle) => {
          const subs = [];
          const finish = (fn, v) => {
            if (done) return;
            done = true;
            if (timer) clearTimeout(timer);
            for (const s of subs) s.dispose();
            fn(v);
          };
          timer = setTimeout(() => {
            void processApi.kill(handle);
            finish(reject, new Error(`git ${args[0] ?? ""} timeout`));
          }, TIMEOUT_MS);
          subs.push(
            processApi.onData(handle, (b) => (out += dec.decode(b, { stream: true }))),
            processApi.onStderr(handle, (b) => (err += new TextDecoder().decode(b))),
            processApi.onExit(handle, (code) => finish(resolve, { code, stdout: out, stderr: err.trim() })),
          );
        })
        .catch((e) => {
          if (!done) {
            done = true;
            if (timer) clearTimeout(timer);
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        });
    });
  }

  return {
    run,
    async root(cwd) {
      const r = await run(cwd, ["rev-parse", "--show-toplevel"]);
      return r.code === 0 ? r.stdout.trim() : null;
    },
    // What the repository actually shows about a claim. Every fact is observed, never assumed.
    async probe({ repoRoot, branch, commits = [], base = "main" }) {
      const branchExists = branch
        ? (await run(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0
        : false;

      const commitsPresent = [];
      for (const sha of commits) {
        if ((await run(repoRoot, ["cat-file", "-e", `${sha}^{commit}`])).code === 0) commitsPresent.push(sha);
      }

      // merged = the branch tip is an ancestor of base (its work is already in)
      let branchMerged = true;
      if (branch && branchExists) {
        branchMerged = (await run(repoRoot, ["merge-base", "--is-ancestor", branch, base])).code === 0;
      }

      const wl = await run(repoRoot, ["worktree", "list", "--porcelain"]);
      const worktreeExists = branch ? wl.stdout.includes(`branch refs/heads/${branch}`) : false;

      return { branchExists, commitsPresent, branchMerged, worktreeExists };
    },
  };
}
