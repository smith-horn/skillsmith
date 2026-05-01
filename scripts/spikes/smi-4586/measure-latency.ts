/**
 * SMI-4586 Goal #1 — Latency budget for end-to-end audit pass.
 *
 * Measures the realistic audit latency on a ~55-entry fixture inventory.
 * Reports p50/p95/p99 + min/max for both real-ONNX and mock embedding paths.
 *
 * Pass criterion: p95 < 500ms with real ONNX. Mock numbers are control values.
 *
 * Decomposed measurements: scan (fs walk), exact-match pass, generic-pass,
 * semantic-pass — each timed separately to identify the dominant cost.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { OverlapDetector, type TriggerPhraseSkill } from '@skillsmith/core'
import { detectGenericTriggerWords } from '../../../packages/mcp-server/src/tools/skill-pack-audit.helpers.js'

const GENERIC_TRIGGERS = JSON.parse(
  readFileSync(
    join(import.meta.dirname ?? '.', '../../../packages/core/src/data/generic-triggers.json'),
    'utf8',
  ),
)

const FIXTURE_ROOT = process.env.SPIKE_FIXTURE_DIR ?? '/tmp/smi-4586-fixture'
const RUNS = Number(process.env.SPIKE_RUNS ?? 50)
const WARMUP = 2

interface FixtureSkill {
  id: string
  name: string
  description: string
  triggerPhrases: string[]
}

function scanFixture(root: string): { skills: FixtureSkill[]; scanMs: number } {
  const t0 = performance.now()
  const skillsDir = join(root, 'skills')
  const skills: FixtureSkill[] = []
  for (const entry of readdirSync(skillsDir)) {
    const skillMd = join(skillsDir, entry, 'SKILL.md')
    if (!statSync(skillMd, { throwIfNoEntry: false })) continue
    const content = readFileSync(skillMd, 'utf8')
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
    if (!fmMatch) continue
    const fm = fmMatch[1]
    const nameMatch = fm.match(/^name:\s*(.+)$/m)
    const descMatch = fm.match(/^description:\s*(.+)$/m)
    if (!nameMatch || !descMatch) continue
    const name = nameMatch[1].trim()
    let description = descMatch[1].trim()
    // Strip surrounding JSON quotes if present
    if (description.startsWith('"') && description.endsWith('"')) {
      try { description = JSON.parse(description) } catch { /* leave as-is */ }
    }
    const phrases = description
      .split(/[.!?]\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .slice(0, 5)
    skills.push({
      id: entry,
      name,
      description,
      triggerPhrases: phrases.length > 0 ? phrases : [name],
    })
  }
  return { skills, scanMs: performance.now() - t0 }
}

function pXX(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx]
}

async function measurePass(
  label: string,
  fn: () => Promise<void>,
  runs: number,
  warmup: number,
): Promise<number[]> {
  // Warmup
  for (let i = 0; i < warmup; i++) await fn()
  const samples: number[] = []
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    await fn()
    samples.push(performance.now() - t0)
  }
  console.error(
    `[${label}] runs=${runs} p50=${pXX(samples, 50).toFixed(1)}ms p95=${pXX(samples, 95).toFixed(1)}ms p99=${pXX(samples, 99).toFixed(1)}ms`,
  )
  return samples
}

async function measureMode(useFallback: boolean, label: string): Promise<{
  full: number[]
  exactOnly: number[]
  scanMs: number
  genericMs: number
}> {
  const { skills, scanMs } = scanFixture(FIXTURE_ROOT)
  const tpSkills: TriggerPhraseSkill[] = skills.map((s) => ({
    id: s.id,
    name: s.name,
    triggerPhrases: s.triggerPhrases,
  }))

  // Generic pass timing (single iteration since pure CPU)
  const t0 = performance.now()
  for (const s of skills) {
    detectGenericTriggerWords(s.description, s.name, null, GENERIC_TRIGGERS)
  }
  const genericMs = performance.now() - t0

  // Full semantic+exact pass — fresh detector per run (cold-path = realistic audit latency)
  const fullSamples = await measurePass(
    `${label} full`,
    async () => {
      const d = new OverlapDetector({ useFallback })
      await d.findAllOverlaps(tpSkills)
      d.close()
    },
    RUNS,
    WARMUP,
  )

  // Exact-only pass — phraseThreshold=1.01 makes semantic effectively never fire
  const exactSamples = await measurePass(
    `${label} exact-only`,
    async () => {
      const d = new OverlapDetector({
        useFallback,
        phraseThreshold: 1.01,
        useExactMatch: true,
      })
      await d.findAllOverlaps(tpSkills)
      d.close()
    },
    Math.min(RUNS, 20),
    1,
  )

  return { full: fullSamples, exactOnly: exactSamples, scanMs, genericMs }
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString()

  // Real ONNX
  delete process.env.SKILLSMITH_USE_MOCK_EMBEDDINGS
  console.error('--- real-ONNX ---')
  const real = await measureMode(false, 'real')

  // Mock
  process.env.SKILLSMITH_USE_MOCK_EMBEDDINGS = 'true'
  console.error('--- mock ---')
  const mock = await measureMode(true, 'mock')

  const result = {
    goal: 1,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    fixture_dir: FIXTURE_ROOT,
    runs: RUNS,
    warmup: WARMUP,
    real_onnx: {
      full_p50: pXX(real.full, 50),
      full_p95: pXX(real.full, 95),
      full_p99: pXX(real.full, 99),
      full_min: Math.min(...real.full),
      full_max: Math.max(...real.full),
      full_runs: real.full,
      exact_only_p50: pXX(real.exactOnly, 50),
      exact_only_p95: pXX(real.exactOnly, 95),
      exact_only_runs: real.exactOnly,
    },
    mock: {
      full_p50: pXX(mock.full, 50),
      full_p95: pXX(mock.full, 95),
      full_p99: pXX(mock.full, 99),
      full_min: Math.min(...mock.full),
      full_max: Math.max(...mock.full),
      full_runs: mock.full,
      exact_only_p50: pXX(mock.exactOnly, 50),
      exact_only_p95: pXX(mock.exactOnly, 95),
      exact_only_runs: mock.exactOnly,
    },
    decomposed: {
      scan_ms: real.scanMs,
      generic_ms: real.genericMs,
      // exact_ms approximated by exact-only run
      // semantic_ms = full - exact (approximation; signature dominated by embed cost)
    },
    criterion: 'p95 < 500ms (real-ONNX, full pass)',
    verdict: pXX(real.full, 95) < 500 ? 'pass' : 'no-go',
  }

  console.log(JSON.stringify(result, null, 2))
}

main().catch((err) => {
  console.error('measure-latency failed:', err)
  process.exit(1)
})
