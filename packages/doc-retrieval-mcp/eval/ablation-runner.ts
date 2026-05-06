/**
 * SMI-4702 — Ablation runner for retrieval eval harness.
 *
 * Sweeps one ranking dimension at a time over the gold set, calling the
 * eval-runner's real-mode entrypoint for each candidate value. Other
 * dimensions are held at their production defaults (env unset = code default).
 *
 * Usage (via eval-runner delegation):
 *   npm run eval:retrieval -- --ablate boost
 *   npm run eval:retrieval -- --ablate boost --json
 *
 * The runner MUST NOT mutate process.env persistently. A try/finally block
 * restores prior env state after each call — tests assert this guarantee.
 *
 * JSON schema (--json output):
 *   { dimension, rows: [{ value, recallAt5, recallAt10, mrr, ndcgAt10, deltaRecallAt5, isBaseline }] }
 *   deltaRecallAt5 is a signed number (not an annotated string).
 */

import { DEFAULT_BOOST_MEMORY, DEFAULT_DAMPEN_PROCESS } from '../src/rerank.js'
import { DEFAULT_MIN_SIMILARITY } from '../src/config.js'
import type { MetricSet } from './metrics.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AblationDimension = 'boost' | 'dampen' | 'floor' | 'bm25'

export interface AblationOpts {
  json?: boolean
  goldSetPath?: string
  /** Hook for tests to inject a fake runEval — production wiring imports eval-runner's runRealMode. */
  runEvalFn?: (env: Record<string, string>, minScore: number) => Promise<MetricSet>
}

export interface AblationRow {
  value: string | number | boolean
  recallAt5: number
  recallAt10: number
  mrr: number
  ndcgAt10: number
  /** Signed float vs baseline row. Baseline row has deltaRecallAt5 === 0. */
  deltaRecallAt5: number
  isBaseline: boolean
}

export interface AblationResult {
  dimension: AblationDimension
  rows: AblationRow[]
}

// ---------------------------------------------------------------------------
// Dimension sweep matrices
// Production defaults use IMPORTED constants — a rename triggers compile error.
// ---------------------------------------------------------------------------

interface DimensionSpec {
  values: (string | number | boolean)[]
  baselineValue: string | number | boolean
  /** Build env overrides for a candidate value. Empty record means "use code default". */
  envFor: (value: string | number | boolean) => Record<string, string>
  /** minScore to pass to runEvalFn (only 'floor' varies this; others use the default). */
  minScoreFor: (value: string | number | boolean) => number
}

function buildDimensionSpec(dim: AblationDimension): DimensionSpec {
  switch (dim) {
    case 'boost':
      return {
        values: [1.0, 1.3, DEFAULT_BOOST_MEMORY, 1.7, 2.0],
        baselineValue: DEFAULT_BOOST_MEMORY,
        envFor: (v) => ({ SKILLSMITH_DOC_RETRIEVAL_BOOST_MEMORY: String(v) }),
        minScoreFor: () => DEFAULT_MIN_SIMILARITY,
      }
    case 'dampen':
      return {
        values: [0.7, DEFAULT_DAMPEN_PROCESS, 1.0],
        baselineValue: DEFAULT_DAMPEN_PROCESS,
        envFor: (v) => ({ SKILLSMITH_DOC_RETRIEVAL_DAMPEN_PROCESS: String(v) }),
        minScoreFor: () => DEFAULT_MIN_SIMILARITY,
      }
    case 'floor':
      return {
        values: [0.25, DEFAULT_MIN_SIMILARITY, 0.45],
        baselineValue: DEFAULT_MIN_SIMILARITY,
        // floor is passed as minScore, not an env var
        envFor: () => ({}),
        minScoreFor: (v) => v as number,
      }
    case 'bm25':
      return {
        values: [false, true],
        baselineValue: false,
        envFor: (v) => ({ SKILLSMITH_DOC_RETRIEVAL_RERANK: v === true ? 'bm25' : '' }),
        minScoreFor: () => DEFAULT_MIN_SIMILARITY,
      }
    default: {
      const exhaustive: never = dim
      throw new Error(`Unknown ablation dimension: ${String(exhaustive)}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Env mutation with try/finally restore
// ---------------------------------------------------------------------------

function applyEnvOverrides(overrides: Record<string, string>): Record<string, string | undefined> {
  const prior: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(overrides)) {
    prior[k] = process.env[k]
    process.env[k] = v
  }
  return prior
}

function restoreEnv(prior: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) {
      delete process.env[k]
    } else {
      process.env[k] = v
    }
  }
}

// ---------------------------------------------------------------------------
// Default runEvalFn — calls eval-runner's exported runRealMode
// ---------------------------------------------------------------------------

async function defaultRunEvalFn(env: Record<string, string>, minScore: number): Promise<MetricSet> {
  // Dynamic import so ablation-runner.ts compiles even in unit mode.
  // Production: eval-runner.ts exports runRealMode (added by Worker 2 refactor).
  const runner = await import('./eval-runner.js')
  // runRealMode accepts (minScore, goldSetPath?) and returns MetricSet (overall)
  return runner.runRealMode(minScore)
}

// ---------------------------------------------------------------------------
// Core ablation logic
// ---------------------------------------------------------------------------

export async function runAblation(
  dim: AblationDimension,
  opts?: AblationOpts
): Promise<AblationResult> {
  const spec = buildDimensionSpec(dim)
  const evalFn = opts?.runEvalFn ?? defaultRunEvalFn

  // Run each candidate value sequentially (env mutation is process-wide).
  const rawRows: Array<{ value: string | number | boolean; metrics: MetricSet }> = []

  for (const value of spec.values) {
    const envOverrides = spec.envFor(value)
    const minScore = spec.minScoreFor(value)
    const prior = applyEnvOverrides(envOverrides)
    let metrics: MetricSet
    try {
      metrics = await evalFn(envOverrides, minScore)
    } finally {
      restoreEnv(prior)
    }
    rawRows.push({ value, metrics })
  }

  // Find baseline row metrics for delta computation.
  const baselineEntry = rawRows.find((r) => r.value === spec.baselineValue)
  const baselineRecallAt5 = baselineEntry?.metrics.recallAt5 ?? 0

  const rows: AblationRow[] = rawRows.map((r) => ({
    value: r.value,
    recallAt5: r.metrics.recallAt5,
    recallAt10: r.metrics.recallAt10,
    mrr: r.metrics.mrr,
    ndcgAt10: r.metrics.ndcgAt10,
    deltaRecallAt5: r.value === spec.baselineValue ? 0 : r.metrics.recallAt5 - baselineRecallAt5,
    isBaseline: r.value === spec.baselineValue,
  }))

  const result: AblationResult = { dimension: dim, rows }

  // Output
  if (opts?.json === true) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  } else {
    process.stdout.write(renderMarkdownTable(dim, rows))
  }

  return result
}

// ---------------------------------------------------------------------------
// Markdown table rendering
// ---------------------------------------------------------------------------

function fmt4(n: number): string {
  return n.toFixed(4)
}

function fmtDelta(delta: number, isBaseline: boolean): string {
  if (isBaseline) return '0.0000 (baseline)'
  const sign = delta >= 0 ? '+' : ''
  const annotation = delta < 0 ? ' (↓)' : ''
  return `${sign}${fmt4(delta)}${annotation}`
}

function fmtValue(v: string | number | boolean): string {
  if (typeof v === 'boolean') return v ? 'on' : 'off'
  return String(v)
}

function renderMarkdownTable(dim: AblationDimension, rows: AblationRow[]): string {
  const lines: string[] = []
  lines.push(`## Ablation: ${dim}\n`)
  lines.push('| value | recall@5 | recall@10 | MRR | nDCG@10 | Δrecall@5 |')
  lines.push('|-------|----------|-----------|-----|---------|-----------|')
  for (const row of rows) {
    const marker = row.isBaseline ? ' *' : ''
    lines.push(
      `| ${fmtValue(row.value)}${marker} | ${fmt4(row.recallAt5)} | ${fmt4(row.recallAt10)} | ${fmt4(row.mrr)} | ${fmt4(row.ndcgAt10)} | ${fmtDelta(row.deltaRecallAt5, row.isBaseline)} |`
    )
  }
  lines.push('\n_* production default_\n')
  return lines.join('\n')
}
