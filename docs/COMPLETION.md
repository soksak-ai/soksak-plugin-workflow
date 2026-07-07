# Completion Charter — what is being built, and what closes it

Single source of truth for the scope and the definition of done of the build-directives work.
Nothing outside this list is called done; nothing on it is skipped silently. Weakening a
criterion violates PRINCIPLES rule 6 — if a criterion is wrong, correct this document in an
explicit commit.

## 1. Deliverables

| # | Deliverable | Where |
|---|---|---|
| D1 | Directive suite: design (domain models / interfaces / acceptance criteria, one unified turn) · plan (pseudocode units for every file) · body (per-file real code + PROOF) · three verify templates | `workflows/research.doc.json` |
| D2 | issuerize redefined: confirmed o-units become per-file codification body tasks (the old "unlock issue" form is gone) | `main.js` issuerizeTick |
| D3 | Methodology tournament assets: two decomposition variant docs (parallel / chain) + committed runner + metrics | `e2e/methodologies/` · `tools/run-tournament.zsh` |
| D4 | CLI executor surface: `next` (execution package for a ready verification node) / `submit` (output back into the same badge pipeline) + a usage skill teaching the next→perform→submit loop. No claude -p call — an external LLM pulls, performs, submits. Scope v1 = verification nodes (stage tasks stay spawn-owned) | `main.js` + `plugin.json` + bundled skill |
| D5 | Run catalog: raw per-call event stream + latest symlink | `src/provider.rs` (done) |
| D6 | Code export: write confirmed code nodes to a real file tree (explicit target dir, confirmed code only) | `main.js` export command |

## 2. Definition of done — all of C1–C5, each with evidence

- **C1 Live-board unattended run**: one `run` call (the pharmacy SaaS idea) on the real app
  board, then zero human intervention: requirements discovered → all confirmed → hunt →
  classify → audit **badge='o'** → research facts all confirmed → design facts all confirmed →
  plan units all confirmed → issuerize → **every file's code node confirmed**. No simulated
  ledgers, no harness-driven step execution (observation only). Evidence: full board snapshot
  + run catalog.
- **C2 CLI idempotency**: on the C1 board, at least one pending node confirmed through
  `next`→`submit` (same contract as the spawn path); resubmission of a confirmed node is
  rejected as ALREADY_DONE. Evidence: command replies + board transitions.
- **C2b Export**: confirmed code nodes of the C1 board written to a file tree; file count =
  code node count. Evidence: file listing.
- **C3 Tournament verdict**: M-C (unified, twice — reproducibility) · M-A (parallel) ·
  M-B (chain) measured on frozen input → metric table (file coverage / seam defects /
  traceability / cost / stability) → rule-10 judgement (baseline passing deterministically
  means no decomposition) → default methodology committed. Evidence: table + reasoning.
- **C4 Verify steps measured**: design-verify, plan-verify, body-verify each produce an oxf
  verdict with a real LLM at least once — before C1. No completion claim while verify
  directives are unmeasured.
- **C5 Deterministic gates all green**: full cargo + full node (`make test-unit`) + bundled
  doc validate.

## 3. Explicitly out of scope (stated as remainder in the completion report)

- **PROOF execution (build/test)**: running arbitrary commands needs sandbox/environment
  design — a separate axis (the builder stage in the cc2 lineage). Until PROOF runs, "the
  code works" is unproven, and the report says so; body-verify's static judgement is not a
  substitute.
- **Stage tasks over CLI (v2)**: submitting publish side-effects needs its own contract;
  C2's idempotency proof stands on verification nodes.
- **Tournament re-run through the app**: the tournament lives on frozen input by design; the
  winning methodology is exercised through the app in C1.

(Correction log: the usage skill and code export were listed here at first — judged as
deferral on audit and promoted into D4/D6, 2026-07-08.)

## 4. Current status (2026-07-08 — keep updated)

- D1 assembled, units green; generation steps (design/plan/body) each passed one CLI
  measurement on simulated ledgers; **verify steps unmeasured (C4 open)**
- D2 units green, unmeasured · D3 running · D4 implemented (next/submit/export commands,
  leases, usage skill, units green) — live proof pending (C2) · D5 done · D6 implemented,
  units green — live proof pending (C2b)
- C1–C5 all open — not done.
