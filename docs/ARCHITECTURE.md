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
`issuerize`, `export`, `ping` (`src/wf_service.rs:545`). It owns the two verification axes: `badge`
(o/x/f), set per node, and `status` completion.

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
- **CODE / EXPORT** — codify and materialize files (`src/reconcile.rs:1243`).

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

- **badge crosses the board seam outside the contract.** `badge`/`category`/`isDraft`/`origin` travel
  through `node.add`/`node.edit` (`src/reconcile.rs:494,859`; `src/reconcile/draft.rs:82`), but the
  `issue-board` contract's `node.edit` defines only `{title?, description?, status?}`
  (`soksak-contract-issue-board/SPEC.md:76-81`). It works today only because the kanban implementer
  natively models the badge axis (`soksak-plugin-kanban/src/commands.ts:263`); a different board
  implementing only the contract would silently drop every verdict. Target: the verification axis
  reaches the board through a contract-legal channel.

- **The change model is not materialized.** `apply_changes` — the confirmed-doc protocol where each
  item carries `history[]{round, action, reason}` — is fully written and tested
  (`src/consensus.rs:100-168`) but unwired. The live path calls only `apply_review`
  (`src/reconcile.rs:857`), so the history that blocks oscillation lives in transient stage inputs, not
  on the board.

- **The round is fixed.** The one wired consensus call passes `round = 1` literally
  (`src/reconcile.rs:857` `apply_review(res, 1)`). Rounds do not advance, so the injected `{{history}}`
  cannot accumulate across them. Target: the round is threaded through the self-republish so each round
  sees every prior round's changes.

- **Work cards flood the board, ungrouped.** Issuerize currently fans out to locked Rust `kind:task`
  exec nodes routed back through exec-stage (`src/reconcile.rs:1392-1410`), not to unlocked JS-ledger
  work items under the Draft epic; and the JS ledger projects each entry as an individual card under a
  single `workflow ledger` card (`js/board.js:49,99-115`). Neither yet groups the issued work under the
  completed spec as its epic header (section 11). Target: one Draft-rooted tree of unlocked work tasks,
  the finished spec as the header.
