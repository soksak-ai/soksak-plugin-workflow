# Completion Charter — what is being built, and what closes it

Single source of truth for the scope and the definition of done of the build-directives work.
Nothing outside this list is called done; nothing on it is skipped silently. Weakening a
criterion violates PRINCIPLES rule 6 — if a criterion is wrong, correct this document in an
explicit commit.

## 1. Deliverables

| # | Deliverable | Where |
|---|---|---|
| D1 | Directive suite: design (domain models / interfaces / acceptance criteria, one unified turn) · plan (pseudocode units for every file) · body (per-file real code + PROOF) · three verify templates | `workflows/research.doc.json` |
| D2 | issuerize redefined: confirmed o-units become per-file codification body tasks (the old "unlock issue" form is gone) | the service (issuerize_tick) |
| D3 | Methodology tournament assets: two decomposition variant docs (parallel / chain) + committed runner + metrics | `e2e/methodologies/` · `tools/run-tournament.zsh` |
| D4 | CLI executor surface: `next` (execution package for a ready verification node) / `submit` (output back into the same badge pipeline) + a usage skill teaching the next→perform→submit loop. No claude -p call — an external LLM pulls, performs, submits. Scope v1 = verification nodes (stage tasks stay spawn-owned) | the service + `plugin.json` + bundled skill |
| D5 | Run catalog: raw per-call event stream + latest symlink | `src/provider.rs` (done) |
| D6 | Code export: write confirmed code nodes to a real file tree (explicit target dir, confirmed code only) | the service (export_tick) |

## 2. Definition of done — all of C1–C5, each with evidence

- **C1a Standalone full-chain run** ✅ (2026-07-10): the committed runner drove the whole
  chain app-free — 63 requirements individually verified (o60/x3) → hunt (+3) → classify →
  audit certification (one rejection→re-audit cycle) → 111 facts (research+design chain) →
  plan 51 units → plan-audit assembly certification (2 rejection→patch rounds grew the file
  set 38→48, adding the operating surfaces) → per-file body with rework loops (rejected code
  regenerated with the verifier's findings injected; 5/5 rework successes) → **48/48 files
  confirmed**. Every verdict a real LLM oxf; the strict gate (every o unit backed by an o
  code) passed. Evidence locked: e2e/out/full-chain/evidence/ (REPORT.md + board snapshot)
  + run catalog + exported file tree (export/, 48 files).
- **C1b App attachment** ✅ (2026-07-08): attach sequence (window discovery → ping env
  re-seed → reconcile poke) produced a live transition observed as it happened (o 6→7), the
  confirmed node carrying a full verdict (oxf=o, origin, concrete reason) — the scheduler
  spawn path advanced end-to-end. Four more nodes had advanced autonomously between
  observations (2→6), evidencing unattended persistence. Evidence: board counts + node.get
  verdict in the work log.
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

## Axis 2 — pull execution (implemented 2026-07-10, proof pending)

Every LLM turn (refinement, stages, verification) can be pulled by an in-TUI executor and
submitted back with zero LLM spawn: exec-stage `--assemble`/`--with-output`,
generate-skeleton `--assemble`/`--with-refined`, `run {pull|refined}`, `next`/`submit`
extended to stage tasks (shared assembly/consumption pipeline with the scheduler).
Proof criterion met (2026-07-11): a full run — idea → refinement → publish → 12 requirements
verified → hunt/classify/audit certification → research → design chain → plan → issuerize →
per-file codification with two runtime-evidence rework loops → export — was driven entirely
by in-TUI executors (the orchestrating agent plus fan-out subagents pulling next/submit),
with zero claude -p / codex exec processes. The exported tree runs: the CLI works end-to-end
and the multi-process stress test passes (lost-update 0, SIGKILL atomicity). The run also
surfaced and fixed three pipeline defects (issuerize rework semantics, category mapping,
body idempotency marker) — and demonstrated twice that runtime execution catches seam
defects text verification cannot, fixing PROOF execution as the next frontier.
The codex symmetry (2026-07-11): a single natural-language instruction to a codex TUI
session (gpt-5.5) drove the same full pipeline on a fresh idea — the agent self-loaded the
skill, pulled every turn (refinement → 14 requirements → certification → 23 facts → design
→ 5 units → 5 code files), spawned its own reviewer subagents, found and fixed a symlink-
escape defect RED→GREEN on its own, and exported a tree that runs (pass 7/0, manual smoke
independently reproduced). Board transit verified — every gate passed, no bypass.
