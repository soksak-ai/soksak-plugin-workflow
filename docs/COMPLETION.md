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

- **C1a Standalone full-chain run** (correction 2026-07-08 — the standing instruction was
  "run standalone first, connect to the app later"; binding the full run to the app caused
  instance contention and is wrong): the committed standalone runner drives the whole chain
  app-free on a file board — requirements verify (each item, real LLM) → hunt → additions
  verified → classify → audit **certification** → research facts verified → design chain
  verified → plan units verified → per-file body + body-verify — until every node is
  confirmed. No simulated badges: every verdict is a real LLM oxf. Evidence: the file board
  + run catalog.
- **C1b App attachment**: the same assets running as the plugin — already live-proven for
  publish → generate → item verify → next/submit (C2); after C1a, one attachment check on the
  live board suffices (scheduler advances at least one node end-to-end). Evidence: board
  transitions.
- **C2 CLI idempotency** ✅ (2026-07-08): a live-board pending item was confirmed through
  `next`→`submit` (badge o + full result recorded, same pipeline as spawn); resubmission
  rejected as ALREADY_DONE. Evidence: command replies + node.get transition in the work log.
- **C2b Export**: confirmed code nodes of the C1 board written to a file tree; file count =
  code node count. Evidence: file listing.
- **C3 Tournament verdict** ✅ (2026-07-08): measured on frozen input — M-C failed
  reproducibility decisively (58↔19 facts, run 2 emitted zero criteria and dropped legally
  mandated entities; clean termination, so genuine variance, not truncation). M-A (parallel)
  had the best coverage (67, 1:1 verdicts) but 6 CONFIRMED systemic seam contradictions
  (UUID vs BIGINT joins, triple ledger definitions, RBAC enum split) — unbuildable, and
  structural to parallelism. M-B (chain) had letter-exact seams with local, correctable
  coverage gaps. **Adopted: M-B chain (interface→domain→criteria)** with two directive
  prescriptions (1:1 criterion coverage; no dangling upstream references) — committed into
  the canonical doc. Evidence: metric table + two-lens adversarial panel in the work log.
- **C4 Verify steps measured** ✅ (2026-07-08): design-verify o · plan-verify o ·
  body-verify **x** — the x matters: the verifier acknowledged the code implements the
  pseudocode but rejected a defective PROOF command (conkey check), proving the verify
  directives discriminate rather than rubber-stamp. (The round also caught and fixed two
  harness defects: template consumption-contract violations, retry loops masking
  deterministic failures.)
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
