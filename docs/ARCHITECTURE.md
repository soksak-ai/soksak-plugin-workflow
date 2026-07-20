# Architecture

This document rules the TARGET architecture — the agreed design, not a description of the code as it
stands today. Where code and a rule here disagree and the code is merely behind, fix the code. Where
the design itself is wrong, do not quietly bend the rule to match a shortcut — correct this document
in an explicit commit. The final section records the deltas between what runs now and what is ruled
here; those are debts against the code, never licenses to lower the bar.

Grounding: Rust `src/…` references are `path:line` in the sidecar repo `soksak-sidecar-workflow`
(the canonical runtime; this plugin repo is now pure JS). `js/…` references are `path:line` in this
plugin repo. Contract and kanban references name their own repo (`soksak-contract-*/SPEC.md`,
`soksak-plugin-kanban/…`). A reference that no longer resolves is stale — fix the reference or the
code, never delete the claim.

## 1. Three parts, coupled by contract alone

The system is three separately-replaceable parts: the **core**, the **kanban plugin**, and the
**workflow plugin**. No part names another part's plugin id anywhere in its source or manifest. Every
join is a pinned contract (a manifest `consumes`/`implements` pair), discovered at call time. A part
that hard-codes another part's id has not joined by contract — it has fused two parts into one, and
the whole point of the split is lost.

The workflow plugin declares only its consumed contracts and its sidecar interface — never a board's
name (`plugin.json` `consumes`: `soksak-spec-plugin-issue-board`, `soksak-spec-plugin-prompt-store`).

## 2. The core couples to nothing

The core is plugin host + poke scheduler + `app.data` (namespace-isolated SQLite) + a service proxy.
It is a broker, never a party: it holds no workflow state and knows no board. It mediates cross-plugin
calls (`Emit::call`, e.g. `src/wf_service.rs:306`) and schedule pokes (`schedule.poke`), and that is
all.

Reconcile is trigger-driven, never registered-into-existence. Registering a schedule does not fire it;
only a poke does. The triggers are exactly: publish poke, self-poke, `bus:issue-board:changed`, and
the activate/boot poke (`docs/PRINCIPLES.md` appendix). There is no polling. A loop with no poke owed
to it is a loop at rest, and rest is a correct state — not a stall to paper over.

## 3. The kanban plugin: one tree, seven views

The kanban plugin implements both consumed contracts at once — `soksak-spec-plugin-issue-board` and
`soksak-spec-plugin-prompt-store`. It is discovered as the **intersection** of the two, never as the
first board that answers (`src/wf_service.rs:37` `pick_implementer`; `js/board.js:19` `pickImplementer`):
a node carries the address of the prompt it runs, and an address minted by one store means nothing to
another — so the board holding the card must be the store holding the text.

The board is one tree in `app.data[ns=kanban]["nodes"]`. Structure is expressed by exactly two fields
— `parentId` (parent reference) and `order` (sibling position) — and nothing else; depth is unbounded
through the `parentId` chain (`soksak-plugin-kanban/src/types.ts:20`). No nested-object or `children`
array is ever a structural channel; every structural operation moves `parentId`/`order` only.

A node carries, beyond structure: `badge` (검수전/o/x/f), `result`, `status`, `history`, `collapsed`,
`locked`, `kind`, `category`, `isDraft`, `parentDraftId` (`soksak-plugin-kanban/src/types.ts:5-48`).
Ids are UUIDs the board mints; a consumer never constructs or predicts one
(`soksak-contract-issue-board/SPEC.md:60-68`).

The one tree projects into seven views — outline / board / timeline / gantt / calendar / table / tree
(`soksak-plugin-kanban/src/types.ts:50`) — with drill-in, breadcrumb, and a scope of direct-children
or all-descendants (`soksak-plugin-kanban/src/commands.ts:553-576,660`). Views are projections of the
one tree; none is a second source of truth.

## 4. One id, two runtimes

The workflow plugin is a single plugin id with **two runtimes that share nothing** — not a name, not a
command, not a state cell. They are deliberately parallel, and the only place they touch is issuerize
(section 11).

**(a) The Rust sidecar** — the content and verification engine. It binds `bind: "service"`; the core
spawns it resident as `<bin> serve` (`src/wf_service.rs:803`). It finds its board by the contract
intersection, never by name (section 3). Its ops are `run`, `reconcile`, `next`, `submit`, `research`,
`issuerize`, `export`, `proof`, `ping` (`src/interface.rs:6` `SERVICE_OPS`). It owns the static
verification axes — `badge` (o/x/f), set per node, and `status` completion — and, distinct from both,
the execution axis `proof` (section 10).

**(b) The JS half** — the execution ledger and its blocking gates. Its entry is `main.js`
(`plugin.json` `entry`). Its lifecycle is `entry → lease → gate.dispatch → receipt → gate.transition →
done`, with `drift.check` as the outside audit (`js/index.js:116,139,222,317,335,355`). Every gate is
blocking-or-nothing: a gate that can be talked past is not a gate (`js/gate.js:1-11`). It is the
intentional parallel of the Rust engine — the same board, a different job.

## 5. The relationship rules

Every relationship is a contract dependency; there is no direct coupling anywhere:

- **sidecar ↔ kanban** = `issue-board` + `prompt-store` (the intersection; `src/wf_service.rs:57`).
- **JS ↔ kanban** = `issue-board` (`js/board.js:10`, discovered, projection-only).
- **sidecar ↔ JS** = no direct coupling. Their only seam is issuerize (section 11).
- **core** mediates and nothing more (section 2).

The board is a projection, never a source of truth. Nothing reads a card back into the engine, and a
missing board is lawful: the loop runs unwatched, exactly as before. A producer that fails without its
board has made the board load-bearing, which the contract forbids
(`soksak-contract-issue-board/SPEC.md:28-31`; `js/board.js:5-8`).

## 6. What the workflow does

The workflow carries an idea from specification through decomposition to real work, in one direction:

```
DRAFT → RESEARCH → DESIGN → PLAN → ISSUERIZE → CODE/EXPORT
```

- **DRAFT** — idea → spec: discover requirements, verify each cell (o/x/f), reach consensus.
- **RESEARCH** — spec → facts, grounded by search (`src/wf_service.rs:666`).
- **DESIGN** — interface → domain → criteria, inheriting the o-confirmed ground (`docs/PRINCIPLES.md`
  rule 12).
- **PLAN** — → per-file pseudocode units (`plan-unit`).
- **ISSUERIZE** — fan the finished plan out into per-file real work (`src/reconcile.rs:1287`).
- **CODE / EXPORT** — codify and materialize files (`src/reconcile.rs:1243`), then optionally `proof`
  runs each confirmed file's PROOF commands against the exported tree and records pass/fail on the
  node — the execution axis, gated off by default (section 10; `src/reconcile.rs:1802` `proof_tick`).

DRAFT through PLAN is one continuous journey over a single chunk. Real work begins at ISSUERIZE, and
not before — that boundary is the issuerize gate (`docs/PRINCIPLES.md` rule 5), never bypassed.

## 7. How the loop turns

The engine is driven by the sidecar poking itself. `reconcile_tick` advances the DAG by **one node per
tick** (`src/reconcile.rs:936`): an `item` runs exec-one and earns a cell verdict o/x/f
(`src/reconcile.rs:981`); a `task` runs exec-stage and emits its children
(`src/reconcile.rs:925,795`). On progress — a badge finalized, children published — the tick pokes:
`deps.poke → schedule.poke → reconcile` re-fires (`src/reconcile.rs:1010-1012`; `src/wf_service.rs:363`).
On no progress it pokes nothing, and the loop rests. Progress is the fuel; absence of progress is the
stop condition, not a bug.

Stage-graph auto-advance stays **inside one workflow**: `blockedBy` gates order, and a stage that
publishes the next stage's precondition lets the next tick pick it up (`src/reconcile.rs:204`
`pick_ready`). Transitions **between** workflows — `run → research → issuerize → export` — are never
automatic; each is a caller-invoked op (`src/wf_service.rs:647-696`). The engine advances a workflow;
the caller advances between workflows.

## 8. The consensus loop

Completeness is not a fixed pass — it is a self-terminating loop. Each round a reviewer sees `[current
set + change history]` and either **adds** or **removes**; it repeats until nobody dissents (zero
changes = consensus), reaching correction and termination with no third party
(`src/consensus.rs:1-11`). Three elements are load-bearing and none may be dropped: `remove` (the loop
retracts its own mistakes), the change history (what was added/removed and why, injected into the next
round to block re-litigation and oscillation), and zero-change convergence
(`src/consensus.rs:apply_review:30`, `apply_changes:100`).

A stage review that yields changes republishes itself (a new round); a review with no changes advances
to the next stage (`converged`, `src/consensus.rs:68,162`). A `remove` never deletes — the removed
entry stays with its reason as `badge=x`, so the next round sees "already removed" and does not re-add
it (`src/reconcile.rs:854-860`; removed-with-reason channel `src/reconcile.rs:668-683`). Every
completeness point — draft, research, design, plan — reuses this one loop.

Ground carried into a building stage is **o-confirmed only** — x and f are not ground (`docs/PRINCIPLES.md`
rule 12; `src/reconcile.rs:626,642-666` `o_only` filter). Stages that need the full ledger for their
own duty (classify, audit) keep it.

## 9. The board model

**DRAFT through PLAN is one indivisible chunk.** Under the Draft journey card (the chunk, `isDraft`)
hang stage sections — Spec, Research, Design, Plan — and under each section hang its frames
(requirements, facts, plan-units). A frame is a **locked, collapsed** child: it can be neither
promoted nor outdented, because it is a piece of the spec, not a unit of work
(`locked: true` at `src/reconcile/draft.rs:79`, `src/reconcile.rs:480`; the board refuses to move a
locked subtree, `soksak-plugin-kanban/src/commands.ts:89,395`). Each frame carries a verification
comment: a `badge` (o/x/f) plus a `result` giving the reason (`src/reconcile.rs:859,1009`).

The chunk is alive and sequential. A draft grows a Spec section and its frames, verification comments
accrete; when Spec closes, a Research node attaches and its sub-work restarts; then Design; then Plan.
A human drills in to watch it live — unbounded depth, breadcrumb trail — while parent `status` rolls
up and keeps the view in motion (`soksak-plugin-kanban/src/commands.ts:553-576,660`).

When the plan closes, the chunk's `status` becomes `done`, and issuerize decomposes the one chunk into
real work. The finished spec is the epic header.

## 10. The two verification axes, never mixed

Verification axis = `badge` (검수전 → o/x/f); completion axis = `status`. A node that carries a badge is
done by badge alone (`is_done`, `src/reconcile.rs:175-183`; `docs/PRINCIPLES.md` rule 4). Any new
verification-target kind reuses the badge axis. No second completion mechanism is ever invented beside
it.

The sidecar publishes badge-bearing frames and verifies both axes to closure; the audit rolls the
chunk badge to `o` only when the set is complete and no `f` remains, else `f`
(`src/reconcile.rs:891-895`).

Distinct from both static axes is the **execution axis** `proof`. `badge`/`status` are the static
judgement — a human or an LLM reading the code — and `proof` is whether the code actually runs: `proof`
runs the confirmed code's PROOF commands and records `{status, reason, commands}` on the node's own
`proof` field, never touching `badge` (`src/reconcile.rs:1802` `proof_tick`, `proof_edit_fields`). It
is not a second completion mechanism — a node stays done-by-badge — and it is gated off by default
(`SOKSAK_PROOF_EXEC`; the arbitrary-command sandbox is undesigned, so every node reports `gated` until
it is enabled).

## 11. The one seam: issuerize

Issuerize is the only join between the two axes. The Rust engine builds the spec (one chunk); issuerize
decomposes it into JS-ledger work items (`lease/receipt/gate/done`). Its gate is absolute
(`docs/PRINCIPLES.md` rule 5; `src/reconcile.rs:1296-1359`): chunk `badge='o'` AND every fact confirmed
AND every plan-unit confirmed. No bypass path.

Each decomposed piece is an **unlocked work task parented under the Draft** — an individual card moving
`backlog → inprogress → done` on its own (`soksak-contract-issue-board/SPEC.md:44-53`). The completed
spec (the Draft chunk) is the epic header those work tasks hang under; a producer with many issues MUST
group them, because a board is shared and scattered issues are unreadable
(`soksak-contract-issue-board/SPEC.md:70-73`; grouping via `parentId`, `js/board.js:49,109`).

The two axes are stitched by `board.accept`: the JS ledger observes the board through the contract
path (`node.list`) and find-or-creates one entry per unlocked work task under a done Draft — idempotent,
so the same task adopted twice is still one entry, keyed by the board's own node id
(`js/index.js:316`; `js/board.js:63` `acceptable`). It reads only what the sidecar wrote; it never
reaches back into the engine.

The JS half then owns each work item's life: `lease.acquire` guards single-ownership, `receipt.add`
records verifiable evidence, `gate.dispatch`/`gate.transition` block on it, and `drift.check` audits
the ledger against the repository from the outside — reported loud, never repaired in place
(`js/index.js:139,222,317,335,355`; `js/gate.js:112` `detectDrift`).

## 12. The change signal

The board changes under a human's hands — a card dragged, an issue closed. The contract owns the
topic, not the implementer: `issue-board:changed`, subscribed on the bus axis as
`bus:issue-board:changed` (`soksak-contract-issue-board/SPEC.md:111-131`; `plugin.json` `service.subscribe`;
`src/wf_service.rs:585-588`). The signal is a notification, never a diff: on it the consumer re-reads
`node.list` and reconciles against what it finds. A payload the consumer trusted would become a second,
weaker copy of the board's state. A topic named after the implementer would be an id smuggled into a
string — swapping the board would silence the consumer without a single error.

## Current vs Target — known deltas

These are debts the code owes this document, listed so no one mistakes the present for the design. Each
is fixed by moving the code up, never by moving a rule down.

- **badge is a board field outside the contract's declaration.** The wire defect is fixed: change
  fields now flatten to top-level so the board reads plaintext `{node, badge?, result?, status?…}`
  rather than a wrapper the board silently drops (`src/wf_service.rs:317-320` `node_edit_params`). What
  remains is that `badge`/`category`/`isDraft`/`origin` are still fields the `issue-board` contract's
  `node.edit` does not declare — it names only `{title?, description?, status?}`
  (`soksak-contract-issue-board/SPEC.md:76-81`). It works because the kanban implementer natively
  models the badge axis (`soksak-plugin-kanban/src/commands.ts:263`); a different board implementing
  only the contract would accept the write and drop the verdict. Target: the verification axis reaches
  the board through a contract-declared channel.

- **`board.accept` reads board fields the contract does not guarantee** — same family as the badge
  debt, the mirror image on the JS side. It selects work by `kind`/`locked`/`parentId`
  (`js/board.js:63` `acceptable`), but `node.list` promises only `{id, title, status, description}`.
  A board returning just the contract fields yields nothing — on purpose, since there is no axis to
  tell a work task from a spec frame — so the seam works only against the kanban implementer. Target:
  the work-vs-frame distinction crosses the seam through a contract-declared field.

- **RESOLVED — the change model is materialized.** `apply_changes` — the confirmed-doc protocol where
  each item carries `history[]{round, action, reason}` — is now wired for the three completeness stages
  (`src/reconcile.rs:1199` `apply_changes(&doc, changes, round)`; consensus-stage gate at
  `src/reconcile.rs:846`). The legacy `apply_review` remains only for the non-consensus
  audit/classify/generate returns (`src/reconcile.rs:1237`).

- **RESOLVED — the round advances.** `reconcile` owns the counter (the doc engine cannot do
  arithmetic): each self-republish reads `args.round` and injects `round + 1`
  (`src/reconcile.rs:917` `read_round`, `932` `inject_round`, `1129`), so the injected `{{history}}`
  accumulates across rounds until zero-change convergence or the `CONSENSUS_ROUND_MAX` seal to `badge=f`
  (`src/reconcile.rs:1282-1288`).

- **A per-item verify can overwrite a consensus frame's add-history** (Step 5 follow-up). `apply_changes`
  CREATEs pre-review frames carrying their `history`, but the per-item verify then writes
  `{badge, result}` onto the same node (`src/reconcile.rs:1231`), which can clobber the history the
  round injected. Target: the two writers compose on one node without one erasing the other.

- **RESOLVED — issued work is one Draft-rooted tree.** Issuerize fans out unlocked work tasks parented
  under the done Draft (section 11), and the JS ledger adopts exactly those through `board.accept`
  (`js/index.js:316`; `js/board.js:63`), grouping the issued work under the completed spec as its epic
  header rather than scattering individual cards.

- **PROOF runs arbitrary commands, so it is gated off.** The execution axis is implemented and its
  deterministic core is tested — `parse_proof`, `evaluate_pass_condition`, `proof_edit_fields`
  (`src/reconcile.rs:1802` `proof_tick`) — but running a confirmed file's PROOF commands means spawning
  arbitrary shell, whose sandbox/environment is undesigned. So it spawns only under `SOKSAK_PROOF_EXEC`
  and otherwise reports every node `gated` (`src/wf_service.rs:420-434`). Target: a sandbox design that
  lets the execution axis run by default.
