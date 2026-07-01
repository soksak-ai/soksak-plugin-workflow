# Workflow — full API reference

> Provenance: restored from the Workflow tool description (orchestrator system prompt, cc 2.1.195). The clone runtime (soksak-run `interp.rs`) implements a subset; differences are noted where known.

## `export const meta` — required first statement

```js
export const meta = {
  name: 'find-flaky-tests',                 // required
  description: 'Find flaky tests and fix',  // required — one line, shown in the permission dialog
  whenToUse: '...',                         // optional — shown in the workflow list
  phases: [                                 // optional — one entry per phase() call
    { title: 'Scan', detail: 'grep logs' },
    { title: 'Fix',  detail: 'one agent per flaky test', model: 'sonnet' },
  ],
}
```

`meta` MUST be a PURE LITERAL — no variables, function calls, spreads, or template interpolation. Use the SAME phase titles in `meta.phases` as in `phase()` calls (matched exactly). A `phase()` with no matching meta entry gets its own progress group.

## Hooks

### `agent(prompt, opts?) → Promise`
Spawn a subagent.
- **Without `schema`** → returns the subagent's final text as a **string**.
- **With `schema`** (a JSON Schema) → the subagent is **forced to call a StructuredOutput tool**; `agent()` returns the **validated object** (no parsing). Validation is at the tool-call layer, so the model retries on mismatch.
- Returns **`null`** if the user skips the agent mid-run or the subagent dies on a terminal error after retries → `.filter(Boolean)`.

`opts`:
| key | effect |
|---|---|
| `label` | display label override |
| `phase` | assign this agent to a progress group (use inside pipeline/parallel stages to avoid racing the global `phase()` state — same string → same box) |
| `schema` | JSON Schema → forced structured output |
| `model` | model override. **Default: omit** — inherits the main-loop model (almost always correct). Only set when highly confident a different tier fits. |
| `effort` | `'low'｜'medium'｜'high'｜'xhigh'｜'max'` — omit to inherit session effort; `'low'` for cheap mechanical stages, higher only for the hardest verify/judge |
| `isolation: 'worktree'` | fresh git worktree — EXPENSIVE (~200-500ms + disk). ONLY when agents mutate files in parallel and would conflict. Auto-removed if unchanged. |
| `agentType` | custom subagent type (e.g. `'Explore'`, `'code-reviewer'`) instead of the default. Composes with `schema`. |

Subagents are told **their final text IS the return value** (not a human-facing message), so they return raw data.

**MCP tools:** Workflow agents can reach all session-connected MCP tools via ToolSearch — schemas load on demand per agent. Caveat: interactively-authenticated MCP servers (e.g. claude.ai) may be absent in headless/cron runs.

### `pipeline(items, stage1, stage2, ...) → Promise<any[]>`
Run each item through all stages **independently — NO barrier between stages**. Item A can be in stage 3 while item B is still in stage 1. **This is the DEFAULT for multi-stage work.** Wall-clock = slowest single-item chain, not sum-of-slowest-per-stage. Every stage callback receives `(prevResult, originalItem, index)` — use `originalItem`/`index` in later stages to label work without threading context through stage 1's return. A stage that throws drops that item to `null` and skips its remaining stages.

### `parallel(thunks) → Promise<any[]>`
Run tasks concurrently. **This is a BARRIER** — awaits all thunks. A thunk that throws (or whose agent errors) resolves to `null` — the call never rejects → `.filter(Boolean)` before using. Use ONLY when you genuinely need all results together.

### `log(message)` — narrator line above the progress tree.
### `phase(title)` — start a phase; subsequent `agent()` calls group under it.
### `args` — the value passed as Workflow's `args`, verbatim. Pass arrays/objects as real JSON (NOT a JSON-encoded string, or `args.map`/`args.filter` throw).
### `budget` — `{total, spent(), remaining()}`.
- `budget.total` is null if no target set. The target is a HARD ceiling: once `spent()` reaches `total`, further `agent()` calls throw.
- Dynamic loop: `while (budget.total && budget.remaining() > 50_000) { ... }`. Static scaling: `const FLEET = budget.total ? Math.floor(budget.total / 100_000) : 5`.
- Guard on `budget.total` — with no target, `remaining()` is `Infinity` and a budget loop runs to the agent cap.
### `workflow(nameOrRef, args?) → Promise` — run another workflow inline as a sub-step (returns its return value). Shares this run's concurrency cap, agent counter, abort signal, token budget. Nesting is ONE level only — `workflow()` inside a child throws.

## Language / runtime constraints

- Plain **JavaScript**, NOT TypeScript — no type annotations, interfaces, generics.
- Body runs async — `await` directly.
- Standard JS built-ins available **EXCEPT** `Date.now()` / `Math.random()` / argless `new Date()` — they **throw** (would break resume). Pass timestamps via `args`; for randomness vary the agent prompt/label by index.
- No filesystem or Node.js API access.
- (clone subset, `interp.rs`: ForOf + While only — NO C-style `for`; schema must be a named top-level const, not inline/computed; no regex.)

## Caps

- Concurrent `agent()` calls capped at **min(16, cpu-2)** per workflow — excess queues.
- Total agents across a workflow's lifetime capped at **1000** (runaway backstop).
- A single `parallel()`/`pipeline()` call accepts at most **4096** items.

## Ultracode

When a system-reminder confirms ultracode is on, the opt-in is standing: author and run a workflow for every substantive task by default; token cost is not a constraint. Multi-phase work → several workflows in sequence (one per phase). When the reminder says ultracode is off, revert to explicit opt-in.
