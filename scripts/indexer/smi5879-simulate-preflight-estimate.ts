/**
 * SMI-5879 Wave 3 item 3: the §8.4-permitted sampled pre-flight estimate.
 * @module scripts/indexer/smi5879-simulate-preflight-estimate
 *
 * Writes `report_kind: "preflight_estimate"` — structurally distinct from
 * `smi5879-simulate-full.ts`'s `"full_simulation"` so `gate-check.ts` (item 4)
 * can never mistake one for the other. Design doc §8.4: "seeded sampling is an
 * estimator, never a substitute for coverage... a sampled result may not
 * satisfy any 8.5 acceptance criterion for C1, C2, C3 or C4."
 *
 * Samples ONLY cohorts C2 and C3 (per §8.4: "sample C2 and C3 to estimate the
 * verdict-change rate and hence the expected size of R") — those two
 * dominate population size (per the plan's sizing table, C2 is ~91% of the
 * full-simulation workload) and are where "did the scanner change verdicts"
 * is actually in question; C1/C4 are already-scored/quarantined cohorts whose
 * inclusion here would dilute the estimate this tool exists to produce.
 *
 * Sampling: deterministic PRNG (mulberry32, seeded), population sorted by
 * `id` before sampling (design doc §8.4's retained-unchanged mechanism), and
 * the report prints the seed, sampling-frame size, a SHA-256 hash of the
 * FULL sampling frame's sorted id list (proving the frame itself is
 * reproducible, not just the drawn sample), and a 95% normal-approximation
 * confidence interval on both the verdict-change rate and the resulting
 * |R| estimate.
 *
 * Every output surface — console AND the report JSON's own `label` field —
 * prints `ESTIMATE — NOT GATE INPUT` so this can never be mistaken for
 * `smi5879-simulate-full.ts`'s gate-eligible output even by a human skimming
 * a terminal.
 *
 * Usage:
 *   varlock run -- npx tsx scripts/indexer/smi5879-simulate-preflight-estimate.ts \
 *     --run-id=<sealed generation run_id> --purpose=<decision|window|rehearsal> \
 *     [--sample-size=200] [--seed=42] [--apply] [--report-path=<path>] [--baseline-commit=<sha>]
 */

import { writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { buildGitHubHeaders } from './_shared/github-auth.ts'
import { newRateLimitTelemetry } from './_shared/rate-limit.ts'
import { poolerSessionConnParams, runPsql } from './smi5879-census.pg.ts'
import { createSmi5879SimulateFullDbDeps } from './smi5879-simulate-full.db.ts'
import {
  materializeBaseline,
  importBaselineScanSkillBundle,
  BASELINE_COMMIT_SHA,
} from './smi5879-simulate-full.baseline.ts'
import { scanSkillBundle as headScanSkillBundle } from './skill-processor.security.ts'
import { processRow, assertPatTokenSource } from './smi5879-simulate-full.helpers.ts'
import { summarizeCounts } from './smi5879-simulate-full.sweep.ts'
import type {
  Smi5879SimulateFullDbDeps,
  SimRowOutcome,
  SimSnapshotRow,
  ScanSkillBundleFn,
  TokenSource,
} from './smi5879-simulate-full.types.ts'
import type { Smi5879Purpose } from './smi5879-census.types.ts'

export const LABEL = 'ESTIMATE — NOT GATE INPUT'
const VALID_PURPOSES: readonly Smi5879Purpose[] = ['rehearsal', 'decision', 'window']
const VERDICT_OUTCOMES: readonly SimRowOutcome[] = [
  'newly_quarantined',
  'newly_cleared',
  'unchanged_clean',
  'unchanged_quarantined',
]
export const DEFAULT_SAMPLE_SIZE = 200
export const DEFAULT_SEED = 42

export interface CliArgs {
  runId: string
  purpose: Smi5879Purpose
  apply: boolean
  sampleSize: number
  seed: number
  reportPath?: string
  baselineCommit: string
}

export function parseArgs(argv: string[]): CliArgs {
  const find = (name: string): string | undefined => {
    const prefix = `--${name}=`
    const hit = argv.find((a) => a.startsWith(prefix))
    return hit ? hit.slice(prefix.length) : undefined
  }
  const runId = find('run-id')
  if (!runId) throw new Error('SMI-5879: --run-id=<generation run_id> is required.')
  const purpose = find('purpose')
  if (!purpose || !VALID_PURPOSES.includes(purpose as Smi5879Purpose)) {
    throw new Error(
      `SMI-5879: --purpose=<${VALID_PURPOSES.join('|')}> is required, got ${purpose ?? '(missing)'}.`
    )
  }
  const sampleSizeRaw = find('sample-size')
  const sampleSize = sampleSizeRaw ? Number(sampleSizeRaw) : DEFAULT_SAMPLE_SIZE
  if (!Number.isFinite(sampleSize) || sampleSize <= 0) {
    throw new Error(`SMI-5879: --sample-size must be a positive number, got ${sampleSizeRaw}.`)
  }
  const seedRaw = find('seed')
  const seed = seedRaw ? Number(seedRaw) : DEFAULT_SEED
  if (!Number.isFinite(seed)) {
    throw new Error(`SMI-5879: --seed must be a finite number, got ${seedRaw}.`)
  }
  // `reportPath` is genuinely optional (defaulted downstream) — under
  // `exactOptionalPropertyTypes`, an optional property means "may be omitted",
  // not "may be omitted OR explicitly `undefined`", so the key must be left off
  // entirely when the flag wasn't passed rather than assigned `undefined`.
  const reportPath = find('report-path')
  return {
    runId,
    purpose: purpose as Smi5879Purpose,
    apply: argv.includes('--apply'),
    sampleSize,
    seed,
    ...(reportPath !== undefined ? { reportPath } : {}),
    baselineCommit: find('baseline-commit') ?? BASELINE_COMMIT_SHA,
  }
}

/** mulberry32 — small, fast, deterministic PRNG. Returns a function yielding floats in [0,1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function next(): number {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Deterministic partial Fisher-Yates draw of `n` items from `rows` (already sorted by caller). */
export function seededSample<T>(rows: readonly T[], n: number, seed: number): T[] {
  const pool = [...rows]
  const rng = mulberry32(seed)
  const count = Math.min(n, pool.length)
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(rng() * (pool.length - i))
    // `i < count <= pool.length` and `j` is drawn from `[i, pool.length)`, so both
    // indices are always in bounds — but `noUncheckedIndexedAccess` can't see that
    // invariant, and a bare `[pool[i], pool[j]] = [pool[j], pool[i]]` swap would
    // silently write `undefined` into the pool if it were ever violated by a
    // future refactor. Confirm it explicitly rather than casting past it.
    const a = pool[i]
    const b = pool[j]
    if (a === undefined || b === undefined) {
      throw new Error(
        `SMI-5879: seededSample index out of bounds (i=${i}, j=${j}, pool.length=${pool.length}) — should be unreachable.`
      )
    }
    pool[i] = b
    pool[j] = a
  }
  return pool.slice(0, count)
}

/** SHA-256 of the sorted-by-id sampling frame's id list, netstring-joined (deterministic, injection-proof). */
export function samplingFrameHash(sortedIds: readonly string[]): string {
  const hash = createHash('sha256')
  for (const id of sortedIds) hash.update(`${Buffer.byteLength(id, 'utf8')}:${id}`)
  return hash.digest('hex')
}

/** 95% normal-approximation CI on a sample proportion, clamped to [0,1]. */
export function wilsonNormalCi95(successes: number, n: number): [number, number] {
  if (n === 0) return [0, 0]
  const p = successes / n
  const margin = 1.96 * Math.sqrt((p * (1 - p)) / n)
  return [Math.max(0, p - margin), Math.min(1, p + margin)]
}

export interface Smi5879PreflightEstimateReport {
  report_kind: 'preflight_estimate'
  label: typeof LABEL
  run_id: string
  purpose: Smi5879Purpose
  token_source: TokenSource
  baseline_commit: string
  seed: number
  sampling_frame_size: number
  sampling_frame_id_hash: string
  sample_size: number
  fully_scanned_sample_size: number
  verdict_change_rate: number
  verdict_change_rate_ci95: [number, number]
  estimated_R: number
  estimated_R_ci95: [number, number]
  counts: Record<SimRowOutcome, number>
  generated_at: string
}

export async function runPreflightEstimate(
  db: Smi5879SimulateFullDbDeps,
  scanPostPort: ScanSkillBundleFn,
  scanPrePort: ScanSkillBundleFn,
  args: CliArgs,
  env: NodeJS.ProcessEnv = process.env
): Promise<Smi5879PreflightEstimateReport> {
  const tokenSource = assertPatTokenSource(env)

  const summary = await db.getRunSummary(args.runId)
  if (!summary) throw new Error(`SMI-5879: no smi5879_run row for run_id=${args.runId}.`)
  if (summary.status !== 'sealed') {
    throw new Error(`SMI-5879: generation ${args.runId} is "${summary.status}", not "sealed".`)
  }
  if (summary.purpose !== args.purpose) {
    throw new Error(
      `SMI-5879: generation ${args.runId} has purpose "${summary.purpose}", not --purpose=${args.purpose}.`
    )
  }

  const allRows = await db.loadCohortRows(args.runId)
  const frame: SimSnapshotRow[] = allRows
    .filter((r) => r.cohort === 'C2' || r.cohort === 'C3')
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const frameIds = frame.map((r) => r.id)
  const frameHash = samplingFrameHash(frameIds)

  const branchMap = await db.loadBranchMap(args.runId)
  const telemetry = newRateLimitTelemetry()
  const headers = await buildGitHubHeaders('skillsmith-smi5879-preflight-estimate/1.0')
  const scanDeps = { scanPostPort, scanPrePort, telemetry, headers }

  const sample = seededSample(frame, args.sampleSize, args.seed)
  const results = []
  for (const row of sample) {
    results.push(await processRow(row, branchMap, scanDeps))
  }

  const counts = summarizeCounts(results)
  const fullyScanned = results.filter((r) => VERDICT_OUTCOMES.includes(r.outcome))
  const changed = counts.newly_quarantined + counts.newly_cleared
  const rate = fullyScanned.length > 0 ? changed / fullyScanned.length : 0
  const rateCi = wilsonNormalCi95(changed, fullyScanned.length)
  const estimatedR = rate * frame.length
  const estimatedRCi: [number, number] = [rateCi[0] * frame.length, rateCi[1] * frame.length]

  return {
    report_kind: 'preflight_estimate',
    label: LABEL,
    run_id: args.runId,
    purpose: args.purpose,
    token_source: tokenSource,
    baseline_commit: args.baselineCommit,
    seed: args.seed,
    sampling_frame_size: frame.length,
    sampling_frame_id_hash: frameHash,
    sample_size: sample.length,
    fully_scanned_sample_size: fullyScanned.length,
    verdict_change_rate: rate,
    verdict_change_rate_ci95: rateCi,
    estimated_R: estimatedR,
    estimated_R_ci95: estimatedRCi,
    counts,
    generated_at: new Date().toISOString(),
  }
}

function printSummary(report: Smi5879PreflightEstimateReport): void {
  console.log(
    `\n── ${LABEL} — Preflight Sample (${report.run_id}) ──\n` +
      `  seed:                    ${report.seed}\n` +
      `  sampling_frame_size:     ${report.sampling_frame_size} (C2 ∪ C3)\n` +
      `  sampling_frame_id_hash:  ${report.sampling_frame_id_hash}\n` +
      `  sample_size:             ${report.sample_size} (${report.fully_scanned_sample_size} fully scanned)\n` +
      `  verdict_change_rate:     ${(report.verdict_change_rate * 100).toFixed(2)}% ` +
      `[${(report.verdict_change_rate_ci95[0] * 100).toFixed(2)}%, ${(report.verdict_change_rate_ci95[1] * 100).toFixed(2)}%]\n` +
      `  estimated_R:             ${report.estimated_R.toFixed(0)} ` +
      `[${report.estimated_R_ci95[0].toFixed(0)}, ${report.estimated_R_ci95[1].toFixed(0)}]\n` +
      `  counts: ${JSON.stringify(report.counts)}\n\n` +
      `${LABEL} — this report may NOT satisfy any G-2/G-5 acceptance criterion.\n`
  )
}

async function dryRun(args: CliArgs): Promise<void> {
  console.log(
    `[DRY-RUN] ${LABEL} — run-id=${args.runId} purpose=${args.purpose} sample-size=${args.sampleSize} seed=${args.seed}`
  )
  assertPatTokenSource()
  const conn = poolerSessionConnParams()
  await runPsql(conn, 'SELECT 1;')
  console.log('[DRY-RUN] DB connectivity OK (session pooler).')
  const headers = await buildGitHubHeaders('skillsmith-smi5879-preflight-estimate/1.0')
  console.log(
    `[DRY-RUN] GitHub auth headers built (Authorization present: ${'Authorization' in headers}).`
  )
  console.log(
    '[DRY-RUN] No sampling or GitHub fetches performed. Re-run with --apply for the real estimate.'
  )
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (!args.apply) {
    await dryRun(args)
    return
  }
  const conn = poolerSessionConnParams()
  const db = createSmi5879SimulateFullDbDeps(conn)
  const baselineDir = materializeBaseline(args.baselineCommit)
  const { scanSkillBundle: scanPrePort } = await importBaselineScanSkillBundle(baselineDir)

  const report = await runPreflightEstimate(db, headScanSkillBundle, scanPrePort, args)
  const reportPath = args.reportPath ?? `smi5879-preflight-estimate-report-${args.runId}.json`
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  printSummary(report)
  console.log(`Report written to ${reportPath} — ${LABEL}`)
}

// Run only when invoked directly (not when imported by the test suite).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
