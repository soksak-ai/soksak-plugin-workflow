# soksak-plugin-workflow

One soksak plugin, two runtimes that share nothing. The plugin **exposes** a workflow
engine and **implements** an issue-execution ledger; their only seam is `issuerize`.

- **The workflow engine** — the content and verification runtime. Its commands
  (`run`/`reconcile`/`next`/`submit`/`research`/`issuerize`/`export`/`proof`/`ping`) bind to a
  resident sidecar service (`bind: "service"`); the core spawns it from the sidecar repo
  `soksak-sidecar-workflow` and routes to it. This repo declares those commands but does
  not implement them.
- **The JS half** — the issue-execution ledger and its blocking gates, the actual code in
  this repo (`js/`, bundled to `main.js`). After issuerize it owns each issue's life:
  leases, receipts, the two gates, and drift detection.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design.

## How the engine works

1. **Publish** — `run` takes an idea (or `research` takes a question), has the LLM
   author a workflow skeleton, and publishes it to the kanban board as a node DAG:
   items (single verifications), tasks (stage executions), and `blockedBy` edges.
2. **Execute** — the core scheduler's `reconcile` trigger picks up ready nodes.
   An item runs as one `exec-one` verification and lands a verdict badge (o/x/f);
   a task runs as an `exec-stage` (generate / classify / audit) and, through the
   draft-review consensus loop, publishes its children back onto the board.
3. **Track** — every stage streams progress deltas into the activity feed while it
   runs, and each node's badge records the outcome on the board.

The journey runs one direction over a single Draft chunk — `DRAFT → RESEARCH → DESIGN →
PLAN` — then `issuerize` fans the finished plan out into per-file real work. Workflow
documents are language-neutral JSON (`workflow-doc@0.0.1`), bundled in the sidecar repo.
Agent execution is delegated to `claude -p`; auth env (`ANTHROPIC_*` or OAuth) comes from
the caller or the secrets vault.

## Commands (CLI / MCP)

Call as `sok plugin.soksak-plugin-workflow.<command>` or via MCP.

### Workflow commands (exposed; run in the sidecar)

| Command | Description |
|---|---|
| `run` | Refine an idea and publish it as a certified-draft node DAG |
| `research` | Publish the research→design→plan chain for a certified chunk (badge 'o') |
| `issuerize` | Turn confirmed plan units into per-file codification tasks (real code out) |
| `next` | CLI executor pull — one ready verification node's execution package (leased) |
| `submit` | CLI executor submit — verdict back into the same badge pipeline (idempotent) |
| `export` | Write confirmed code nodes to a real file tree (PROOF stays on the node) |
| `proof` | Run a confirmed chunk's PROOF commands and record pass/fail on the node's `proof` field (execution axis; gated off unless `SOKSAK_PROOF_EXEC`) |
| `reconcile` | Execute ready workflow nodes (scheduler trigger — runs automatically) |
| `ping` | Provider health probe — one fixed mini prompt through the real exec path |

### Ledger commands (this repo's JS half)

| Command | Description |
|---|---|
| `entry.add` | Put an issue on the ledger — unleased, unreceipted |
| `lease.acquire` | Take the dispatch lease (owner + expiry); another's live lease refuses |
| `lease.renew` / `lease.release` / `lease.list` | Extend / give up / list leases |
| `receipt.add` | Record verifiable evidence — a commit sha, or a test command with its verdict |
| `gate.dispatch` | Block a dispatch unless the caller owns a live lease |
| `gate.transition` | Carry an issue to `done` — only on a verifiable receipt |
| `drift.check` | Audit the ledger against the repository; report, never repair |
| `board.sync` | Project the ledger onto the issue board (discovered by contract) |
| `board.accept` | Observe the board and adopt each unlocked work task under a done Draft as a ledger entry (idempotent — the seam issuerize opens into the ledger) |
| `entry.remove` | Drop a ledger entry (refuses under a live lease) |

## The issue ledger (the JS half)

After `issuerize` fans the plan out into work items, the JS half owns each one's life. It
is the intentional parallel of the engine — the same board, a different job — and shares no
name, command, or state cell with it.

- **entry + lease** — an issue enters the ledger unleased; `lease.acquire` gives it a
  single owner for a bounded time, so two agents never work one issue.
- **receipts** — `receipt.add` records only verifiable evidence: a commit sha, or a test
  command with its verdict. A claim wearing a receipt's clothes is refused at the door.
- **gates (blocking-or-nothing)** — `gate.dispatch` refuses unless the caller owns a live
  lease; `gate.transition` refuses `done` without a passing receipt. A gate that can be
  talked past is not a gate.
- **drift** — `drift.check` compares the ledger against the actual repository (a fabricated
  commit receipt, a `done` never merged, a lease on a reclaimed worktree) and reports it
  loud, never repairing in place.
- **board.sync** — projects the ledger onto whatever plugin implements both the issue-board
  and prompt-store contracts (discovered, never named); no board is a lawful state.

The ledger lives in the core data store, so it survives a restart, and a Ledger view
renders it.

## Layout

- `plugin.json` — the manifest: the workflow commands bind to the resident sidecar service
  (`bind: "service"`); the ledger commands and the Ledger view bind to this repo's entry
  (`entry: main.js`)
- `js/` — the JS half (source): the ledger (`index.js`), the blocking gates (`gate.js`),
  board projection (`board.js`), git probing (`git.js`)
- `main.js` — the bundled JS entry, built from `js/` by `build.mjs`
- `build.mjs` — the esbuild bundle (`js/` → `main.js`)
- `test/` — the JS half's tests (`node --test`)
- `docs/` — the design and principles (`ARCHITECTURE.md`, `PRINCIPLES.md`, `COMPLETION.md`)
- `skill/` — the executor skill (`SKILL.md`)

The workflow engine (Rust), the bundled workflow documents, the stage skill texts, and the
e2e harness live in the sidecar repo `soksak-sidecar-workflow`, not here.

## Requirements

- soksak with the plugin platform (permissions: `service`, `sidecar`, `commands`,
  `commands:destructive`, `schedule`, `secrets`, `data`, `ui`, `process`)
- `claude` CLI on PATH for agent execution; auth env exported or stored in the vault
- Node.js to build the JS half (`npm run build` → `main.js`; `npm test`)

---

한국어 안내는 [README.ko.md](README.ko.md).

## Pull mode (zero LLM spawn)

All authoring turns can also be pulled: `run {idea, pull:true}` → perform → `run {idea, refined}`; then loop `next`/`submit` — stage tasks are issued as packages and outputs are replayed through the same publish pipeline. See `skill/SKILL.md`.
