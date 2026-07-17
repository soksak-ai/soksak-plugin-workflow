#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMMIT_RE = /^[a-f0-9]{40}$/;

function git(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

export function validateReleaseContext({ environment, checkoutHead, owner }) {
  if (environment.GITHUB_EVENT_NAME !== "workflow_dispatch") {
    throw new Error("release must run only from workflow_dispatch");
  }
  if (environment.GITHUB_REF !== "refs/heads/main") {
    throw new Error("release must run from the main branch");
  }
  const repository = environment.GITHUB_REPOSITORY;
  if (owner?.repository !== `https://github.com/${repository}`) {
    throw new Error("release context does not match the owner repository");
  }
  const commit = environment.GITHUB_SHA;
  if (!COMMIT_RE.test(commit) || !COMMIT_RE.test(checkoutHead) || checkoutHead !== commit) {
    throw new Error("release commit must equal the exact checkout HEAD");
  }
  return { repository, commit };
}

export function verifyReleaseContext(environment = process.env) {
  const workspace = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const result = validateReleaseContext({
    environment,
    checkoutHead: git(["rev-parse", "--verify", "HEAD"]),
    owner: workspace.soksakRelease,
  });
  const status = git(["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status !== "") throw new Error(`release checkout is dirty:\n${status}`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(`${JSON.stringify(verifyReleaseContext())}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
