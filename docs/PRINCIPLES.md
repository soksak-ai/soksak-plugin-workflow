# Development Principles

These rules bind every implementation and change in this repository. Rules come first; code
follows them. When code and a rule disagree, fix the code. When the rule itself is wrong, do
not quietly relax it — correct this document in an explicit commit.

## 1. Directive single source of truth

The refined directive that passed the authoring gate is canonical. The human-facing surface
(kanban chunk description) and the machine-facing verification basis (the directive injected
into exec) MUST be the same string. The only override is an explicit user-given `directive`.

## 2. Fail-loud

A gate failure refuses to publish or complete. No silent fallback, no empty-success. Defensive
parsers may absorb noise, but every contract violation must be observable (stderr or an error
reply). No validation layer is ever removed: authoring validate · --emit validate ·
exec-stage validate · relay checks.

## 3. Three-level normalization

Global templates are content-addressed (one row, byte-stable). Chunk-shared values (the
directive) are referenced, never inlined. Nodes carry only their own small vars. Byte
stability of shared prompt text is the precondition for sha256 dedup — "polishing" shared
text breaks dedup across every draft and is done only deliberately.

## 4. Two axes, never mixed

Verification axis = badge (검수전 → o/x/f); completion axis = status. A node that carries a
badge is done by badge alone. Any new verification-target kind reuses the badge axis — do not
invent a separate completion mechanism.

## 5. The issuerize gate

A draft is not an issue breakdown. Per-file codification tasks exist only through
`issuerize`, and its gate is: chunk badge='o' AND every fact confirmed AND every plan-unit
confirmed. No bypass path.

## 6. Never lower the bar

When a test or verification bar is not met, fix the implementation or the fixture — never the
bar. Loosened assertions, added skips, relaxed thresholds are all violations. If the bar
itself is wrong, correct it together with this document in an explicit commit.

## 7. No unnecessary LLM step

LLMs do refinement, discovery, and judgement — nothing else. Never re-refine an already
refined input. Anything deterministically computable (ledger assembly, id mapping, gate
decisions) is code, not an LLM call.

## 8. Directives own quality

Result quality comes from injected directives, not from injection machinery — that machinery
was server2's cause of death. New steps and methodologies are added as canonical docs
(workflows/) plus directive text. The executor grows only when a live failure proves the
need; speculative machinery is the same cheat as speculative decomposition.

## 9. No echo

Output schemas never carry copies of parent data. The executor composes parent information
into the prompt; the output holds only that step's own decisions. Where there is no copy,
there is no drift.

## 10. Decompose only after failure

The default is one unified turn. Splitting a step into perspective turns is adopted only when
a unified turn's deterministic failure is proven by measurement. A turn is an ideal under
constraints (time, tokens), and decomposition topology (parallel / chain / input selection)
lives in methodology docs — data, not code.

## 11. Directives generate, machines verify

Contracts (citation rules, completeness, prohibitions) are taught by directive text plus
worked examples. Violations are rejected by deterministic post-checks (ledger id
cross-checks, duplicate/unassigned detection). Schemas enforce structure only.

## 12. Ground means o-confirmed only

An injected ledger or `{{facts}}` ground carries **o-confirmed entries only** when a stage
BUILDS on it (design chain, plan, body). f (fatal) and x (rejected) entries are not ground —
injecting them hands the model a contradictory foundation (measured: a plan turn fed 111
mixed-badge facts emitted one garbage unit; the same turn on o-only ground emitted 39 real
file units). Stages that need the full ledger for their own duty keep it: hunt (duplicate
avoidance), classify (assign everything), audit (f tally).

## 13. Two-axis certification at every layer

Per-node verification (parts) never substitutes for whole-set certification (assembly).
The draft layer has verify + audit; the plan layer has unit-verify + plan-audit (does the
file set assemble into a system someone can build, deploy, and OPERATE — auth, admin,
review surfaces, jobs, boot wiring?). Formal coverage (every requirement cited by some
unit) can be 100% while the assembled system is unbuildable — measured: 60/60 cited, yet
no console, no auth surface. A layer without its assembly check is an unfinished layer.

## 14. Rejection feeds a correction loop

A certification verdict of "incomplete" with concrete gaps is not a discard — the gaps are
fed back mechanically (no authoring LLM) as candidate entries, the existing verify pipe
screens them (fake gaps die as x), and the certification re-runs. Bounded rounds (2); on
exhaustion, fail loud and discard. A gaps field with no consumer is a defect.

## 15. Retries are for transient errors only

A retry loop may swallow 529/overloaded/timeout — never a deterministic failure (parse
error, unresolved placeholder, contract violation). Retrying a deterministic failure
masks it as flakiness and burns the budget (measured: 8 rounds spent on a template
defect). Classify the error first; fail loud on the deterministic class.

## Appendix — settled decisions

- Representation = workflow-doc@0.0.1 single path. The legacy JS/ESTree interp path was removed
  (git history is the archive). NodeEvent is the wire contract.
- research/plan/design run with no authoring LLM (rule 7): canonical docs under `workflows/`
  are instantiated statically. The role files under `references/` are explanations, not truth.
- No polling. Triggers are: publish poke, self-poke, kanban:changed, activate boot poke.
