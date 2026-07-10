---
name: soksak-workflow
description: Use when turning an idea into a certified, developable backlog inside soksak — drive the workflow plugin by CLI/MCP commands (`sok plugin.soksak-plugin-workflow.*`) to publish a draft (run), watch the scheduler verify/hunt/classify/audit it, run research and design, issuerize into per-file codification, and — as an LLM executor yourself — pull verification work with `next`, perform it in your own turn, and `submit` the verdict. 아이디어 구체화, 드래프트 인증, 리서치/설계/플랜, 파일별 실코드화, 검증 대행(next/submit)도 여기.
---

# soksak workflow — from idea to certified code, and you can be an executor

The workflow plugin turns one idea into a **certified backlog chunk** on the kanban board and
carries it to **per-file real code**. Every LLM output lands as a node with a badge
(검수전 → o/x/f); the core scheduler (reconcile) drives ready nodes; gates are deterministic.

Pipeline: `run`(idea) → requirements verified → hunt → classify → audit certifies the chunk
(badge o) → `research`(chunk) → facts verified → design facts verified → plan units (one per
file) verified → `issuerize`(chunk) → per-file codification → code nodes verified → `export`.

## Pull mode — the whole pipeline without spawning an LLM

Every LLM turn — refinement, discovery, design, planning, codification, and verification —
can be pulled and performed by YOU (the agent reading this), so the system never spawns
`claude -p` or `codex exec`:

1. **Draft refinement**: `run '{"idea":"...","pull":true}'` returns the refinement package
   ({prompt, schema}). Perform it, then publish with `run '{"idea":"...","refined":<your output>}'`.
2. **Everything after**: loop `next`. It returns either a verification node (judge it, submit
   `{"oxf":"o|x|f", ...}`) or a stage task (`node.kind == "task"`, `node.stage` names the turn —
   generate/hunt/classify/audit/research/design-*/plan/body). Perform the stage prompt and
   submit the schema-shaped output; the system replays it through the same publish pipeline
   the scheduler uses (children nodes, gates, transitions).
3. `next` returning `node:null` means nothing is ready — either the chunk is waiting on
   verification you can pull on the next call, or the pipeline is done. `export` writes the
   confirmed code nodes to real files.

Leases (30 min) keep multiple executors — you, your subagents, another agent system — from
colliding; dependencies (blockedBy) are enforced by the board, so just keep pulling.

## Discover first — never guess names

```
sok commands | grep plugin.soksak-plugin-workflow
```

## Being an executor: the next → perform → submit loop

You (an LLM in a terminal) can perform verification turns yourself — no claude -p spawn:

1. `sok plugin.soksak-plugin-workflow.next` — returns one ready verification node:
   `{node:{id,kind,title}, prompt, schema, leaseMs}`. The node is leased to you (default 30
   min); the scheduler will not double-run it.
2. **Perform the prompt yourself, in this turn.** The `prompt` is the full directive; your
   answer MUST match `schema` and MUST carry an `oxf` verdict: `"o"` (holds), `"x"`
   (legitimately rejected, kept), `"f"` (fatal).
3. `sok plugin.soksak-plugin-workflow.submit node=<id> output='<your JSON>'` — the same badge
   pipeline as the spawn path records badge+result and wakes the next node.

Rules: never submit without `oxf` (rejected). A confirmed node rejects resubmission
(ALREADY_DONE) — do not retry it. If you cannot finish, just stop; the lease expires and the
scheduler reclaims the node.

## Orchestration commands

- `run idea="..."` — refine + publish a draft chunk; the scheduler takes over.
- `ping` — provider round-trip health check (no board writes).
- `research chunk=<id>` — gate: chunk badge must be 'o'. Publishes fact discovery → design →
  plan chain.
- `issuerize chunk=<id>` — gate: facts and plan units all confirmed. Publishes one
  codification task per confirmed file unit.
- `export chunk=<id> dir=/abs/path` — writes confirmed code nodes as real files (PROOF block
  stays on the node).
- `reconcile` — manually drive one ready node (the scheduler normally does this).

Progress is visible on the kanban board (every node, badge, and result) and in the run
catalog (`$SOKSAK_HOME/runs/soksak-sidecar-workflow/latest.jsonl`, raw event stream).
