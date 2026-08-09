/**
 * Coverage aggregation, checkpoint I/O, and the tier-3 sweep loop for
 * smi5879-simulate-full.ts. Split out of smi5879-simulate-full.helpers.ts
 * (CLAUDE.md's <500-line-per-file convention — helpers.ts plus this file
 * together are still one logical unit; `processRow`'s per-row tier-1/tier-2
 * logic stays in helpers.ts, and everything ABOVE the per-row level — how
 * many rows got what outcome, how to persist/resume progress, and how to
 * re-sweep the unevaluable residual — lives here).
 * @module scripts/indexer/smi5879-simulate-full.sweep
 *
 * Plan: docs/internal/implementation/smi-5879-wave3-census-simulation-plan.md §3b (tier 3) / §3c
 * Design: docs/internal/implementation/smi-5879-edge-twin-parity-design.md §8.3.5.2.4/§8.4
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type {
  CohortCoverage,
  CoverageByCohort,
  SimRowOutcome,
  SimRowResult,
  SimSnapshotRow,
  SimulatedCohort,
  Smi5879SimulateCheckpoint,
  SweepHardStopReason,
  TokenSource,
} from './smi5879-simulate-full.types.ts'
import type { Smi5879Purpose } from './smi5879-census.types.ts'

// ---------------------------------------------------------------------------
// Constants (design doc 8.3.5.2.5's interval table + plan §3b tier 3)
// ---------------------------------------------------------------------------

export const MAX_SWEEP_PASSES = 8
export const SWEEP_COOLDOWN_MS = 15 * 60 * 1000

// ---------------------------------------------------------------------------
// Coverage aggregation
// ---------------------------------------------------------------------------

export function computeCoverage(
  rowsByCohort: Record<SimulatedCohort, SimSnapshotRow[]>,
  results: Map<string, SimRowResult>
): CoverageByCohort {
  const coverage = {} as CoverageByCohort
  for (const cohort of Object.keys(rowsByCohort) as SimulatedCohort[]) {
    const rows = rowsByCohort[cohort]
    const total = rows.length
    let scanned = 0
    let unevaluable = 0
    let unfetchable = 0
    for (const row of rows) {
      const result = results.get(row.id)
      if (!result) continue
      scanned++
      if (result.outcome === 'unevaluable') unevaluable++
      if (result.outcome === 'unfetchable') unfetchable++
    }
    const status: CohortCoverage['status'] =
      scanned === total && unevaluable === 0 ? 'full' : 'partial'
    coverage[cohort] = { status, scanned, total, unevaluable, unfetchable }
  }
  return coverage
}

/**
 * Single source of truth for the closed `SimRowOutcome` vocabulary at
 * runtime — `summarizeCounts`'s zeroed accumulator doubles as the
 * membership set `assertValidCheckpointShape` checks a resumed
 * checkpoint's recorded outcomes against (SMI-5879 review finding 1), so
 * the two can never drift apart.
 */
const EMPTY_OUTCOME_COUNTS: Record<SimRowOutcome, number> = {
  newly_quarantined: 0,
  newly_cleared: 0,
  unchanged_clean: 0,
  unchanged_quarantined: 0,
  content_drifted: 0,
  bundle_absent: 0,
  unevaluable: 0,
  unfetchable: 0,
}

export const SIM_ROW_OUTCOMES: readonly SimRowOutcome[] = Object.keys(
  EMPTY_OUTCOME_COUNTS
) as SimRowOutcome[]

function isValidSimRowOutcome(value: unknown): value is SimRowOutcome {
  return typeof value === 'string' && (SIM_ROW_OUTCOMES as readonly string[]).includes(value)
}

export function summarizeCounts(results: Iterable<SimRowResult>): Record<SimRowOutcome, number> {
  const counts: Record<SimRowOutcome, number> = { ...EMPTY_OUTCOME_COUNTS }
  for (const r of results) counts[r.outcome]++
  return counts
}

/**
 * G-2-shaped exit code decision: 0 when every cohort is `full` and the sweep
 * converged (no hard stop); 1 otherwise. Extracted as a pure function so the
 * CLI's exit behaviour is independently unit-testable without spawning a
 * process — mirrors what `gate-check.ts` (item 4) will independently re-derive
 * from the same report fields.
 */
export function decideExitCode(
  coverage: CoverageByCohort,
  sweepHardStopped: SweepHardStopReason
): 0 | 1 {
  const anyPartial = (Object.keys(coverage) as SimulatedCohort[]).some(
    (c) => coverage[c].status === 'partial'
  )
  return anyPartial || sweepHardStopped !== null ? 1 : 0
}

/** Simple linear-throughput ETA — null when there isn't yet enough signal (0 elapsed or 0 scanned). */
export function estimateCompletionAt(
  startedAt: Date,
  now: Date,
  totalRows: number,
  scannedRows: number
): string | null {
  const elapsedMs = now.getTime() - startedAt.getTime()
  if (elapsedMs <= 0 || scannedRows <= 0) return null
  const remaining = totalRows - scannedRows
  if (remaining <= 0) return now.toISOString()
  const msPerRow = elapsedMs / scannedRows
  return new Date(now.getTime() + remaining * msPerRow).toISOString()
}

// ---------------------------------------------------------------------------
// Checkpoint I/O
// ---------------------------------------------------------------------------

export function checkpointPathFor(runId: string): string {
  return `smi5879-simulate-checkpoint-${runId}.json`
}

const VALID_COHORTS_FOR_SHAPE_CHECK: readonly SimulatedCohort[] = ['C1', 'C2', 'C3', 'C4']
const VALID_PURPOSES_FOR_SHAPE_CHECK: readonly Smi5879Purpose[] = [
  'rehearsal',
  'decision',
  'window',
]
const VALID_TOKEN_SOURCES_FOR_SHAPE_CHECK: readonly TokenSource[] = ['app', 'pat']
const VALID_HARD_STOP_REASONS_FOR_SHAPE_CHECK: readonly SweepHardStopReason[] = [
  'non_convergence',
  'max_passes',
  null,
]

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Runtime shape validation for a checkpoint read off disk — a bare
 * `JSON.parse(raw) as Smi5879SimulateCheckpoint` casts arbitrary JSON
 * straight to the type with zero verification, so a wrong
 * `--checkpoint-path` or a hand-edited file could silently carry an
 * unrecognised `outcome` value (or the wrong overall shape) straight into
 * `runSimulateFull` (SMI-5879 review finding 1). Throws — never returns a
 * best-effort partial object — because a checkpoint that fails shape
 * validation means real prior progress may exist in a form we can no
 * longer trust, which is categorically different from "no checkpoint yet"
 * (cold start) and must not be treated the same way.
 */
function assertValidCheckpointShape(
  value: unknown,
  path: string
): asserts value is Smi5879SimulateCheckpoint {
  if (!isPlainObject(value)) {
    throw new Error(`SMI-5879: checkpoint at ${path} is not a JSON object.`)
  }
  const errors: string[] = []

  // Bracket notation throughout this function is required, not stylistic —
  // `value`/`rawResult`/`sweep` are `Record<string, unknown>` (from the
  // `isPlainObject` guard), which `noPropertyAccessFromIndexSignature`
  // (tsconfig.base.json) refuses to let dot-notation read.
  const runId = value['run_id']
  const purpose = value['purpose']
  const baselineCommit = value['baseline_commit']
  const tokenSource = value['token_source']
  const cleanShutdown = value['clean_shutdown']
  const startedAt = value['started_at']
  const updatedAt = value['updated_at']
  const rowResults = value['row_results']
  const sweepRaw = value['sweep']

  if (typeof runId !== 'string' || runId.length === 0) errors.push('run_id')
  if (
    typeof purpose !== 'string' ||
    !VALID_PURPOSES_FOR_SHAPE_CHECK.includes(purpose as Smi5879Purpose)
  ) {
    errors.push(`purpose=${String(purpose)}`)
  }
  if (typeof baselineCommit !== 'string' || baselineCommit.length === 0) {
    errors.push('baseline_commit')
  }
  if (
    typeof tokenSource !== 'string' ||
    !VALID_TOKEN_SOURCES_FOR_SHAPE_CHECK.includes(tokenSource as TokenSource)
  ) {
    errors.push(`token_source=${String(tokenSource)}`)
  }
  if (typeof cleanShutdown !== 'boolean') errors.push('clean_shutdown')
  if (typeof startedAt !== 'string') errors.push('started_at')
  if (typeof updatedAt !== 'string') errors.push('updated_at')

  if (!isPlainObject(rowResults)) {
    errors.push('row_results')
  } else {
    for (const [id, rawResult] of Object.entries(rowResults)) {
      if (!isPlainObject(rawResult)) {
        errors.push(`row_results.${id} (not an object)`)
        continue
      }
      const resultId = rawResult['id']
      const cohort = rawResult['cohort']
      const outcome = rawResult['outcome']
      if (typeof resultId !== 'string') errors.push(`row_results.${id}.id`)
      if (
        typeof cohort !== 'string' ||
        !VALID_COHORTS_FOR_SHAPE_CHECK.includes(cohort as SimulatedCohort)
      ) {
        errors.push(`row_results.${id}.cohort=${String(cohort)}`)
      }
      if (!isValidSimRowOutcome(outcome)) {
        errors.push(`row_results.${id}.outcome=${String(outcome)}`)
      }
    }
  }

  if (!isPlainObject(sweepRaw)) {
    errors.push('sweep')
  } else {
    const pass = sweepRaw['pass']
    const residualHistory = sweepRaw['residual_history']
    const nonDecreaseStreak = sweepRaw['non_decrease_streak']
    const hardStopped = sweepRaw['hard_stopped']
    if (typeof pass !== 'number') errors.push('sweep.pass')
    if (!Array.isArray(residualHistory) || !residualHistory.every((n) => typeof n === 'number')) {
      errors.push('sweep.residual_history')
    }
    if (typeof nonDecreaseStreak !== 'number') errors.push('sweep.non_decrease_streak')
    if (!VALID_HARD_STOP_REASONS_FOR_SHAPE_CHECK.includes(hardStopped as SweepHardStopReason)) {
      errors.push(`sweep.hard_stopped=${String(hardStopped)}`)
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `SMI-5879: checkpoint at ${path} failed shape validation — invalid/missing field(s): ` +
        `${errors.join(', ')}. Refusing to trust a malformed checkpoint file — fix or remove it ` +
        'before resuming (removing it is a COLD START, not a safe default: confirm no real ' +
        'progress is being discarded first).'
    )
  }
}

export function readCheckpoint(path: string): Smi5879SimulateCheckpoint | null {
  if (!existsSync(path)) return null
  const raw = readFileSync(path, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    // A parse failure is NOT "no checkpoint" — it's "a checkpoint existed and
    // may hold real progress we can no longer read." Silently falling back to
    // cold start here would be the destructive choice (SMI-5879 review finding 3).
    throw new Error(
      `SMI-5879: checkpoint at ${path} exists but is not valid JSON (${(err as Error).message}). ` +
        'This is NOT the same as "no checkpoint" — a prior run may have written real progress to ' +
        'this file before crashing mid-write. Inspect the file (and any `.tmp` sibling left by an ' +
        'interrupted write) before deciding whether to delete it and cold-start.'
    )
  }
  assertValidCheckpointShape(parsed, path)
  return parsed
}

/**
 * Refuses to reuse a checkpoint whose identity doesn't match THIS
 * invocation — a wrong `--checkpoint-path` pointing at another
 * generation's checkpoint could otherwise silently skip rows that are
 * still live-unattempted for the current run (SMI-5879 review finding 1).
 * `baseline_commit` is checked separately by the caller (pre-existing).
 */
export function assertCheckpointIdentity(
  checkpoint: Smi5879SimulateCheckpoint,
  expected: { runId: string; purpose: Smi5879Purpose; tokenSource: TokenSource },
  path: string
): void {
  const mismatches: string[] = []
  if (checkpoint.run_id !== expected.runId) {
    mismatches.push(`run_id (checkpoint=${checkpoint.run_id}, this run=${expected.runId})`)
  }
  if (checkpoint.purpose !== expected.purpose) {
    mismatches.push(`purpose (checkpoint=${checkpoint.purpose}, this run=${expected.purpose})`)
  }
  if (checkpoint.token_source !== expected.tokenSource) {
    mismatches.push(
      `token_source (checkpoint=${checkpoint.token_source}, this run=${expected.tokenSource})`
    )
  }
  if (mismatches.length > 0) {
    throw new Error(
      `SMI-5879: checkpoint at ${path} does not match this invocation — ${mismatches.join('; ')}. ` +
        'A resume must reuse a checkpoint from the SAME run_id/purpose/token_source — use a fresh ' +
        '--checkpoint-path for a different generation instead of pointing at this one.'
    )
  }
}

/**
 * Refuses to reuse a checkpoint whose `row_results` keys reference row ids
 * outside the CURRENT generation's loaded row set — e.g. a stale checkpoint
 * from a different generation whose row ids happen to overlap with
 * globally-stable skill ids from this one. Must be called only after the
 * real row set for this generation has been loaded (SMI-5879 review finding 1).
 */
export function assertCheckpointRowsBelongToGeneration(
  checkpoint: Smi5879SimulateCheckpoint,
  rows: readonly SimSnapshotRow[],
  path: string
): void {
  const validIds = new Set(rows.map((r) => r.id))
  const staleIds = Object.keys(checkpoint.row_results).filter((id) => !validIds.has(id))
  if (staleIds.length > 0) {
    throw new Error(
      `SMI-5879: checkpoint at ${path} has ${staleIds.length} row_results key(s) that are not in ` +
        `this generation's row set (e.g. ${staleIds.slice(0, 5).join(', ')}) — this checkpoint was ` +
        'likely written for a different generation. Refusing to reuse stale verdicts; use a fresh ' +
        '--checkpoint-path for this generation instead.'
    )
  }
}

/**
 * Atomic replace: write to a temp file in the SAME directory as `path`,
 * then `renameSync` over the real path. `renameSync` on the same
 * filesystem is atomic on POSIX, so a crash mid-write (OOM-kill, host
 * reboot) can never leave `path` itself truncated/corrupt — it is always
 * either the previous complete checkpoint or the new one (SMI-5879 review
 * finding 3). A `.bak` of the prior checkpoint was considered and
 * deliberately skipped: the atomic rename already guarantees `path` is
 * never syntactically corrupt, which was the actual failure mode observed;
 * a backup would only help against a LOGICALLY wrong-but-valid checkpoint
 * (an application bug writing bad data), which a single stale `.bak` isn't
 * a reliable defense against either.
 */
export function writeCheckpoint(path: string, checkpoint: Smi5879SimulateCheckpoint): void {
  const tmpPath = `${path}.tmp-${process.pid}`
  writeFileSync(tmpPath, JSON.stringify(checkpoint, null, 2))
  renameSync(tmpPath, path)
}

/** True when the on-disk checkpoint represents an abnormal prior termination (design 8.3.5.2.4 point 2). */
export function isAbnormalResume(checkpoint: Smi5879SimulateCheckpoint | null): boolean {
  return checkpoint !== null && checkpoint.clean_shutdown === false
}

// ---------------------------------------------------------------------------
// Tier-3 sweep loop
// ---------------------------------------------------------------------------

export type SweepPassRunner = (residualIds: string[]) => Promise<Map<string, SimRowResult>>

export interface SweepOptions {
  maxPasses?: number
  cooldownMs?: number
  sleep?: (ms: number) => Promise<void>
  /**
   * Fires after each completed pass with the ABSOLUTE (resume-inclusive)
   * pass number, that pass's resulting residual size, and the
   * non-decrease streak as of that pass — the caller's single source of
   * truth for writing a durable per-pass checkpoint segment, so a crash
   * mid-sweep loses at most one pass of progress (SMI-5879 review
   * finding 2). Do NOT independently increment a separate pass counter
   * alongside this — that's exactly the doubled-accounting bug this
   * finding flagged.
   */
  onPass?: (pass: number, residualSize: number, nonDecreaseStreak: number) => void
  /**
   * Resume state from a prior (possibly crashed) invocation's checkpoint
   * (SMI-5879 review finding 2a) — a crash mid-sweep must not reset the
   * `MAX_SWEEP_PASSES` budget or the two-consecutive-non-decrease
   * hard-stop streak back to zero. Both default to 0 (cold start).
   */
  startingPass?: number
  startingNonDecreaseStreak?: number
}

export interface SweepOutcome {
  finalResults: Map<string, SimRowResult>
  hardStopped: SweepHardStopReason
  /** ABSOLUTE (resume-inclusive) total pass count — NOT just this invocation's own passes. */
  passesRun: number
  /** Only the passes actually run by THIS invocation — the caller prepends any prior history once. */
  residualHistory: number[]
  finalResidualSize: number
  /** Final non-decrease streak value, for persisting back into the checkpoint across a resume. */
  nonDecreaseStreak: number
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Re-run ONLY the rows currently classified `unevaluable`, in repeated sweep
 * passes, until fixed point (`|R_k| = 0`) or a hard stop (plan §3b tier 3).
 * `unfetchable` rows are never included in `initialResidual` by the caller —
 * being terminal, they can never cause non-convergence.
 */
export async function runTier3Sweep(
  initialResidual: SimRowResult[],
  runPass: SweepPassRunner,
  options: SweepOptions = {}
): Promise<SweepOutcome> {
  const maxPasses = options.maxPasses ?? MAX_SWEEP_PASSES
  const cooldownMs = options.cooldownMs ?? SWEEP_COOLDOWN_MS
  const sleep = options.sleep ?? defaultSleep
  const startingPass = options.startingPass ?? 0
  const startingNonDecreaseStreak = options.startingNonDecreaseStreak ?? 0

  const finalResults = new Map<string, SimRowResult>(initialResidual.map((r) => [r.id, r]))
  let residual = initialResidual
  // `initialResidual` IS already "the residual as of the end of the last
  // completed pass" on a resume (it's recomputed fresh from the checkpoint's
  // row_results by the caller), so no special-casing is needed here for
  // continuity — it's the correct `prevSize` baseline whether this is a cold
  // start or a resume.
  let prevSize = initialResidual.length
  let nonDecreaseStreak = startingNonDecreaseStreak
  let hardStopped: SweepHardStopReason = null
  let passesRun = startingPass
  const residualHistory: number[] = []

  for (let pass = startingPass + 1; pass <= maxPasses; pass++) {
    if (residual.length === 0) break
    await sleep(cooldownMs)
    passesRun = pass

    const updated = await runPass(residual.map((r) => r.id))
    for (const [id, result] of updated) finalResults.set(id, result)

    const newResidual = residual
      .map((r) => finalResults.get(r.id) as SimRowResult)
      .filter((r) => r.outcome === 'unevaluable')
    residualHistory.push(newResidual.length)

    if (newResidual.length === 0) {
      nonDecreaseStreak = 0
      residual = newResidual
      options.onPass?.(pass, newResidual.length, nonDecreaseStreak)
      break
    }

    if (newResidual.length >= prevSize) nonDecreaseStreak++
    else nonDecreaseStreak = 0
    prevSize = newResidual.length
    residual = newResidual
    options.onPass?.(pass, newResidual.length, nonDecreaseStreak)

    if (nonDecreaseStreak >= 2) {
      hardStopped = 'non_convergence'
      break
    }
  }

  if (residual.length > 0 && hardStopped === null) hardStopped = 'max_passes'

  return {
    finalResults,
    hardStopped,
    passesRun,
    residualHistory,
    finalResidualSize: residual.length,
    nonDecreaseStreak,
  }
}
