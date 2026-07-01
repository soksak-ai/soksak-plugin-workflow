---
name: workflow
description: Use when a task needs many subagents orchestrated deterministically — comprehensive coverage (decompose + parallel), confidence (independent perspectives + adversarial checks), or scale one context can't hold (migrations, audits, sweeps).
provenance: Restored from the Workflow tool description loaded in the orchestrator (Claude) system prompt of cc 2.1.195. High fidelity for behavior/API/patterns. NOT a byte-copy of a cc-internal SKILL.md — the Workflow feature ships as a TOOL; this file reconstructs its usage as a skill for our clone's authoring LLM.
---

# Workflow — orchestrate many subagents deterministically

A workflow is a JavaScript script that fans work out across subagents under **deterministic** control flow (loops, conditionals, fan-out) — control flow you decide in code, not control flow the model improvises. The runtime runs the script in the background, spawning each `agent()` call as a subagent, and returns one structured result.

## When to author a workflow

Reach for a workflow when the task is one of:
- **Understand** — parallel readers over subsystems → structured map
- **Design** — judge panel of N independent approaches → scored synthesis
- **Review** — dimensions → find → adversarially verify
- **Research** — multi-modal sweep → deep-read → synthesize
- **Migrate** — discover sites → transform each (worktree isolation) → verify

For a single-fact lookup, do NOT author a workflow — just search. For larger work, run several workflows in **sequence**, reading each result before deciding the next phase.

**Hybrid is often right:** scout inline first (list the files, find the channels, scope the diff) to discover the work-list, THEN author a workflow to pipeline over it. You don't need the shape before the *task* — only before the *orchestration step*.

## Opt-in discipline

A workflow can spawn dozens of agents and burn a large token budget. Only author/run one when the user has explicitly opted in (asked for a workflow / multi-agent orchestration, invoked a skill that calls it, or ultracode is on). For any other task, use a single `Agent` instead, or describe what a workflow could do and ask.

## Lifecycle

1. **Author** the script — begins with `export const meta = {...}` (pure literal), then the body using `agent()/parallel()/pipeline()/phase()/log()`.
2. **Invoke** — `Workflow({script})` (inline), `Workflow({name})` (saved/built-in), or `Workflow({scriptPath})` (a file). Pass `args` to parameterize.
3. **Runs in background** — the call returns immediately with a `runId` + a persisted `scriptPath`. A `<task-notification>` arrives on completion.
4. **Watch** live progress with `/workflows`.
5. **Read** the returned result (the script's `return` value) — relay what matters; it is not shown to the user.

## Iterating

Every invocation persists its script to a file under the session dir and returns that path. To iterate: **edit that file** (Write/Edit) and re-invoke `Workflow({scriptPath})` — do not re-send the whole script.

## Resume

To resume after a pause/kill/edit: relaunch with `Workflow({scriptPath, resumeFromRunId})`. The longest unchanged prefix of `agent()` calls returns cached results instantly; the first edited/new call and everything after runs live. Same script + same args → 100% cache hit. (This is why `Date.now()/Math.random()/new Date()` are unavailable in scripts — they would break resume. Stamp timestamps after the workflow returns, or pass them via `args`.)

**Fallback when no journal is available:** Read the `agent-<id>.jsonl` files in the transcript directory and hand-author a continuation script.

## The one rule that decides quality: pipeline() by default

DEFAULT TO `pipeline()`. A barrier (`parallel()` between stages) is correct ONLY when stage N genuinely needs ALL of stage N-1 together (dedup/merge across the full set, early-exit on zero, or a prompt that references "the other findings"). It is NOT justified by "I need to flatten/map/filter first" (do that inside a stage), "the stages are conceptually separate", or "it's cleaner". Barrier latency is real.

See `api-reference.md` for every hook, `patterns.md` for the quality patterns, and `../../extracted/2.1.193/deep-research/deep-research.workflow.js` for a canonical fan-out script.
