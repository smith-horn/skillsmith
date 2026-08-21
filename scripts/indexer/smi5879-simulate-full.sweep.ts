/**
 * Coverage aggregation and the tier-3 sweep loop for
 * smi5879-simulate-full.ts. Split out of smi5879-simulate-full.helpers.ts
 * (CLAUDE.md's <500-line-per-file convention — helpers.ts plus this file
 * together are still one logical unit; `processRow`'s per-row tier-1/tier-2
 * logic stays in helpers.ts, and everything ABOVE the per-row level — how
 * many rows got what outcome and how to re-sweep the unevaluable residual —
 * lives here). Checkpoint I/O (read/write/shape-validation/identity guards)
 * moved to the sibling `smi5879-simulate-full.checkpoint.ts` (SMI-6015 Wave
 * 1's `cohorts` field pushed the combined file over the 500-line budget).
 * @module scripts/indexer/smi5879-simulate-full.sweep
 *
 * Plan: docs/internal/implementation/smi-5879-wave3-census-simulation-plan.md §3b (tier 3) / §3c
 * Design: docs/internal/implementation/smi-5879-edge-twin-parity-design.md §8.3.5.2.4/§8.4
 */

import { runCancellablePool, type RateLimitTelemetry } from './_shared/rate-limit.ts'
import { processRow, PROCESS_CONCURRENCY } from './smi5879-simulate-full.helpers.ts'
import { writeCheckpoint } from './smi5879-simulate-full.checkpoint.ts'
import { EMPTY_OUTCOME_COUNTS } from './smi5879-simulate-full.types.ts'
import type {
  BranchMap,
  CohortCoverage,
  CoverageByCohort,
  ScanSkillBundleFn,
  SimRowOutcome,
  SimRowResult,
  SimSnapshotRow,
  SimulatedCohort,
  Smi5879SimulateCheckpoint,
  SweepHardStopReason,
} from './smi5879-simulate-full.types.ts'

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

// Outcome-vocabulary constants (SIM_ROW_OUTCOMES, isValidSimRowOutcome) moved
// to smi5879-simulate-full.types.ts (SMI-6015 Wave 1) to avoid a circular
// import once this file needed writeCheckpoint from .checkpoint.ts, which
// itself needs the outcome validator — see that file's own doc comment.

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

// ---------------------------------------------------------------------------
// Sweep phase orchestration (SMI-6015 Wave 1 — moved out of
// smi5879-simulate-full.ts's runSimulateFull to stay under the 500-line
// budget once the wall-clock deadline / cohorts additions landed there)
// ---------------------------------------------------------------------------

export async function runSweepPhase(
  rows: SimSnapshotRow[],
  branchMap: BranchMap,
  scanDeps: {
    scanPostPort: ScanSkillBundleFn
    scanPrePort: ScanSkillBundleFn
    telemetry: RateLimitTelemetry
    getHeaders: () => Promise<Record<string, string>>
  },
  results: Map<string, SimRowResult>,
  checkpointIn: Smi5879SimulateCheckpoint,
  checkpointPath: string
): Promise<{ checkpoint: Smi5879SimulateCheckpoint; hardStopped: SweepHardStopReason }> {
  let checkpoint = checkpointIn
  // Resume state threaded into the sweep (SMI-5879 review finding 2a) — a
  // crash mid-sweep must not reset the MAX_SWEEP_PASSES budget or the
  // non-decrease hard-stop streak. `priorResidualHistory` is captured ONCE
  // and `sweepResidualHistory` grows it incrementally via `onPass` as the
  // single source of truth for every per-pass checkpoint write (finding 2b).
  const priorResidualHistory = [...checkpoint.sweep.residual_history]
  const sweepResidualHistory: number[] = [...priorResidualHistory]

  const residual = [...results.values()].filter((r) => r.outcome === 'unevaluable')
  const sweep = await runTier3Sweep(
    residual,
    async (residualIds) => {
      const idSet = new Set(residualIds)
      const targets = rows.filter((r) => idSet.has(r.id))
      const outcomes: SimRowResult[] = []
      // SMI-6015: same cooperative-cancellation fix as runMainPass — see
      // smi5879-simulate-full.helpers.ts's own comment for the rationale.
      const { abortedBy } = await runCancellablePool(
        targets,
        (row) => processRow(row, branchMap, scanDeps),
        (outcome) => {
          outcomes.push(outcome)
        },
        PROCESS_CONCURRENCY
      )
      const updated = new Map(outcomes.map((o) => [o.id, o]))
      for (const [id, result] of updated) results.set(id, result)
      if (abortedBy) {
        // SMI-6015 (GPT-5.6-Sol review round 2, 2026-08-14): throwing here
        // rejects runTier3Sweep's own `await runPass(...)` before it ever
        // reaches `options.onPass` — the ONLY place that normally writes a
        // checkpoint after a pass. Write the partial progress explicitly,
        // matching onPass's shape but WITHOUT advancing
        // pass/residual_history/non_decrease_streak — this pass never
        // cleanly completed, so it must not be counted as if it had.
        checkpoint = {
          ...checkpoint,
          clean_shutdown: false,
          row_results: Object.fromEntries(results),
          updated_at: new Date().toISOString(),
        }
        writeCheckpoint(checkpointPath, checkpoint)
        throw abortedBy
      }
      return updated
    },
    {
      startingPass: checkpoint.sweep.pass,
      startingNonDecreaseStreak: checkpoint.sweep.non_decrease_streak,
      onPass: (pass, residualSize, nonDecreaseStreak) => {
        sweepResidualHistory.push(residualSize)
        checkpoint = {
          ...checkpoint,
          clean_shutdown: false,
          row_results: Object.fromEntries(results),
          sweep: {
            pass,
            residual_history: [...sweepResidualHistory],
            non_decrease_streak: nonDecreaseStreak,
            hard_stopped: null,
          },
          updated_at: new Date().toISOString(),
        }
        writeCheckpoint(checkpointPath, checkpoint)
      },
    }
  )

  checkpoint = {
    ...checkpoint,
    clean_shutdown: true,
    row_results: Object.fromEntries(results),
    sweep: {
      pass: sweep.passesRun,
      residual_history: [...priorResidualHistory, ...sweep.residualHistory],
      non_decrease_streak: sweep.nonDecreaseStreak,
      hard_stopped: sweep.hardStopped,
    },
    updated_at: new Date().toISOString(),
  }
  writeCheckpoint(checkpointPath, checkpoint)

  return { checkpoint, hardStopped: sweep.hardStopped }
}
