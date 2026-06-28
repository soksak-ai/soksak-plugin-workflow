export const meta = {
  name: 'compare-clarp-vs-claude-e',
  description: 'Compare clarp (TS) vs claude-e (Rust) Claude -p wrappers across dimensions, then synthesize pros/cons',
  phases: [
    { title: 'Analyze', detail: 'one agent per dimension, each compares both repos' },
    { title: 'Synthesize', detail: 'merge dimension verdicts into final pros/cons + recommendation' },
  ],
}

const CLARP = '/Users/max/ai/cli/claude-p/clarp'
const CLAUDE_E = '/Users/max/ai/cli/claude-p/claude-e'

const CONTEXT = `Two competing open-source projects both wrap an interactive Claude Code session.
- clarp at ${CLARP} — TypeScript/Node.js, node-pty.
- claude-e at ${CLAUDE_E} — Rust, portable-pty + vt100.
Read the ACTUAL files in both repos. Cite concrete evidence.`

const DIM_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['dimension', 'verdict'],
  properties: {
    dimension: { type: 'string' },
    verdict: { type: 'string' },
  },
}

const DIMENSIONS = [
  { key: 'architecture', prompt: 'DIMENSION: Architecture. Compare PTY handling and pipeline.' },
  { key: 'code_quality', prompt: 'DIMENSION: Code quality. TS vs Rust tradeoffs.' },
  { key: 'testing', prompt: 'DIMENSION: Testing. Compare test suites and CI.' },
]

phase('Analyze')
const findings = await parallel(
  DIMENSIONS.map((d) => () =>
    agent(`${CONTEXT}\n\n${d.prompt}`, { label: `analyze:${d.key}`, phase: 'Analyze', schema: DIM_SCHEMA })
  )
)
const clean = findings.filter(Boolean)

phase('Synthesize')
const SYNTH_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['summary', 'recommendation'],
  properties: {
    summary: { type: 'string' },
    recommendation: { type: 'string' },
  },
}
const synthesis = await agent(
  `Synthesize these per-dimension findings (JSON):\n${JSON.stringify(clean, null, 2)}\n\nProduce a balanced comparison.`,
  { label: 'synthesize', phase: 'Synthesize', schema: SYNTH_SCHEMA }
)
return { findings: clean, synthesis }
