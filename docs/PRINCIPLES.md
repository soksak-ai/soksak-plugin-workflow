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

## Appendix — settled decisions

- Representation = workflow-doc@0.0.1 single path. The legacy JS/ESTree interp path was removed
  (git history is the archive). NodeEvent is the wire contract.
- research/plan/design run with no authoring LLM (rule 7): canonical docs under `workflows/`
  are instantiated statically. The role files under `references/` are explanations, not truth.
- No polling. Triggers are: publish poke, self-poke, kanban:changed, activate boot poke.
