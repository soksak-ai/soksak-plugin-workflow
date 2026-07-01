# Workflow — quality patterns

> Provenance: restored from the Workflow tool description (orchestrator system prompt, cc 2.1.195), plus structure read from the canonical `extracted/2.1.193/deep-research/deep-research.workflow.js`.

## Canonical multi-stage — pipeline + adversarial verify (the default shape)

Each dimension verifies as soon as its review completes — no wasted wall-clock:

```js
const DIMENSIONS = [{key:'bugs', prompt:'...'}, {key:'perf', prompt:'...'}]
const results = await pipeline(
  DIMENSIONS,
  d => agent(d.prompt, {label:`review:${d.key}`, phase:'Review', schema: FINDINGS_SCHEMA}),
  review => parallel(review.findings.map(f => () =>
    agent(`Adversarially verify: ${f.title}`, {label:`verify:${f.file}`, phase:'Verify', schema: VERDICT_SCHEMA})
      .then(v => ({...f, verdict: v}))
  ))
)
const confirmed = results.flat().filter(Boolean).filter(f => f.verdict?.isReal)
```

## When a barrier IS correct — dedup across ALL findings first

```js
const all = await parallel(DIMENSIONS.map(d => () => agent(d.prompt, {schema: FINDINGS_SCHEMA})))
const deduped = dedupeByFileAndLine(all.filter(Boolean).flatMap(r => r.findings))  // genuinely needs ALL at once
const verified = await parallel(deduped.map(f => () => agent(verifyPrompt(f), {schema: VERDICT_SCHEMA})))
```

## Loop-until-count

```js
const bugs = []
while (bugs.length < 10) {
  const r = await agent("Find bugs in this codebase.", {schema: BUGS_SCHEMA})
  bugs.push(...r.bugs); log(`${bugs.length}/10 found`)
}
```

## Loop-until-budget

```js
const bugs = []
while (budget.total && budget.remaining() > 50_000) {   // guard on budget.total
  const r = await agent("Find bugs.", {schema: BUGS_SCHEMA})
  bugs.push(...r.bugs); log(`${bugs.length} found, ${Math.round(budget.remaining()/1000)}k left`)
}
```

## Composed — exhaustive review (find → dedup vs seen → diverse-lens panel → loop-until-dry)

```js
const seen = new Set(), confirmed = []
let dry = 0
while (dry < 2) {                                               // loop-until-dry
  const found = (await parallel(FINDERS.map(f => () =>          // barrier: collect all finders this round
    agent(f.prompt, {phase:'Find', schema: BUGS})))).filter(Boolean).flatMap(r => r.bugs)
  const fresh = found.filter(b => !seen.has(key(b)))            // dedup vs ALL seen — plain code, not an agent
  if (!fresh.length) { dry++; continue }
  dry = 0; fresh.forEach(b => seen.add(key(b)))
  const judged = await parallel(fresh.map(b => () =>            // each fresh bug judged by 3 distinct lenses
    parallel(['correctness','security','repro'].map(lens => () =>
      agent(`Judge "${b.desc}" via the ${lens} lens — real?`, {phase:'Verify', schema: VERDICT})))
      .then(vs => ({ b, real: vs.filter(Boolean).filter(v => v.real).length >= 2 }))))
  confirmed.push(...judged.filter(v => v.real).map(v => v.b))
}
// dedup vs `seen`, NOT `confirmed` — else judge-rejected findings reappear every round and it never converges.
```

## The pattern catalogue — pick by task, compose freely

- **Adversarial verify** — spawn N independent skeptics per finding, each prompted to REFUTE. Kill if ≥majority refute. Default to `refuted=true` if uncertain. Prevents plausible-but-wrong findings from surviving.
- **Perspective-diverse verify** — when a finding can fail in more than one way, give each verifier a distinct lens (correctness / security / perf / does-it-reproduce) instead of N identical refuters. Diversity catches failure modes redundancy can't.
- **Judge panel** — generate N independent attempts from different angles (MVP-first, risk-first, user-first), score with parallel judges, synthesize from the winner while grafting the best ideas from runners-up. Beats one-attempt-iterated when the solution space is wide.
- **Loop-until-dry** — for unknown-size discovery, keep spawning finders until K consecutive rounds return nothing new. Simple `while count < N` counters miss the tail.
- **Multi-modal sweep** — parallel agents each searching a *different way* (by-container, by-content, by-entity, by-time). Each blind to what the others surface; one angle won't find everything.
- **Completeness critic** — a final agent that asks "what's missing — modality not run, claim unverified, source unread?" What it finds becomes the next round of work.
- **No silent caps** — if a workflow bounds coverage (top-N, no-retry, sampling), `log()` what was dropped. Silent truncation reads as "covered everything" when it didn't.

These aren't exhaustive — compose novel harnesses (tournament brackets, self-repair loops, staged escalation) when the task calls for it.

## Robustness (read off deep-research)

- **Null-guard every agent result** — `if (!r) return {error}` / `.filter(Boolean)`. agent() returns null on skip/death.
- **Salvage paths** — at each failure point return useful partial results rather than throwing the whole run away (no claims → return stats; all refuted → return refuted list; synthesis failed → return verified claims unmerged).
- **Dedup + budget** — normalize keys (e.g. URL host+path), cap fan-out (MAX_FETCH), log dupes/budget-dropped.
- **Abstention handling in votes** — a null vote = abstain. Survive only if a **quorum of valid votes** adjudicated it AND fewer than the refute threshold refuted. All-abstain must NOT pass (else `refuted=0` → false survive).

## Scale to the request

"find any bugs" → a few finders, single-vote verify. "thoroughly audit this" / "be comprehensive" → larger finder pool, 3–5 vote adversarial pass, synthesis stage. Lean toward thoroughness for research/review/audit; brevity for quick checks.
