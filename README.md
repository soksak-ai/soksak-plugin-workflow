# soksak-plugin-workflow

A draft pipeline soksak plugin: an idea goes in, an LLM-authored workflow publishes it
as a kanban node DAG, and the core scheduler executes and tracks every node.

## How it works

1. **Publish** — `run` takes an idea (or `research` takes a question), has the LLM
   author a workflow skeleton, and publishes it to the kanban board as a node DAG:
   items (single verifications), tasks (stage executions), and `blockedBy` edges.
2. **Execute** — the core scheduler's `reconcile` trigger picks up ready nodes.
   An item runs as one `exec-one` verification and lands a verdict badge (o/x/f);
   a task runs as an `exec-stage` (generate / hunt / classify / audit) and publishes
   its children back onto the board.
3. **Track** — every stage streams progress deltas into the activity feed while it
   runs, and each node's badge records the outcome on the board.

Workflow documents are language-neutral JSON (`workflow-doc@0.0.1`, bundled canonical
copies in `workflows/`). Agent execution is delegated to `claude -p`; auth env
(`ANTHROPIC_*` or OAuth) comes from the caller or the secrets vault.

## Commands (CLI / MCP)

Call as `sok plugin.soksak-plugin-workflow.<command>` or via MCP.

| Command | Description |
|---|---|
| `run` | Refine an idea and publish it as a certified-draft node DAG |
| `research` | Publish the research→design→plan chain for a certified chunk (badge 'o') |
| `issuerize` | Turn confirmed plan units into per-file codification tasks (real code out) |
| `next` | CLI executor pull — one ready verification node's execution package (leased) |
| `submit` | CLI executor submit — verdict back into the same badge pipeline (idempotent) |
| `export` | Write confirmed code nodes to a real file tree (PROOF stays on the node) |
| `reconcile` | Execute ready workflow nodes (scheduler trigger — runs automatically) |
| `ping` | Provider health probe — one fixed mini prompt through the real exec path |

## Layout

- `main.js` — plugin adapter: commands, publish relay, scheduler wiring
- `src/` — execution runtime (Rust): doc execution, exec-one / exec-stage, provider
- `workflows/` — bundled canonical workflow documents (`workflow-doc@0.0.1`)
- `references/` — stage skill texts the authoring prompts embed
- `e2e/` — reproducible harness (`e2e/run-e2e.zsh`, `make -C e2e help`)
- `docs/PRINCIPLES.md` — development principles the runtime enforces

## Requirements

- soksak with the plugin platform (permissions: `process`, `commands`, `schedule`, `secrets`)
- `claude` CLI on PATH for agent execution; auth env exported or stored in the vault

---

한국어 안내는 [README.ko.md](README.ko.md).
