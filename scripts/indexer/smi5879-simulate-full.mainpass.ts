/**
 * The tier-1/tier-2 main pass loop for `smi5879-simulate-full.ts`, split out
 * of the sibling `smi5879-simulate-full.helpers.ts` (SMI-6481) — `helpers.ts`
 * was itself already at CLAUDE.md's <500-line-per-file budget before the
 * SMI-6481 `processRow` delta-branch fix (the dropped bundle-absence
 * diagnostic) needed a few more lines, and `runMainPass` was the more
 * self-contained half to relocate (it was already moved INTO helpers.ts from
 * `smi5879-simulate-full.ts` itself for the exact same reason — see that
 * file's own "runMainPass lives in..." comment). `processRow` and the
 * `ProcessRowDeps`/constants it needs stay in `helpers.ts`; this module only
 * imports them.
 * @module scripts/indexer/smi5879-simulate-full.mainpass
 *
 * Plan: docs/internal/implementation/smi-5879-wave3-census-simulation-plan.md §3a/§3b
 * Design: docs/internal/implementation/smi-5879-edge-twin-parity-design.md §8.2.3
 */

import { runCancellablePool, type RateLimitTelemetry } from './_shared/rate-limit.ts'
import { assertRowsInternallyCoherent } from './smi5879-merge-shards.outcome-coherence.ts'
import {
  processRow,
  CHECKPOINT_BATCH_SIZE,
  PROCESS_CONCURRENCY,
} from './smi5879-simulate-full.helpers.ts'
import type {
  BranchMap,
  ScanSkillBundleFn,
  SimRowResult,
  SimSnapshotRow,
} from './smi5879-simulate-full.types.ts'

/** Return value of {@link runMainPass} — see `deadlineExceeded`'s doc comment there. */
export interface RunMainPassResult {
  /**
   * True iff the pass stopped because `deadlineAtMs` was reached — an
   * EXPECTED, non-fatal way to stop (mirrors `runCancellablePool`'s own
   * `deadlineExceeded`/`abortedBy` distinction and
   * `smi5879-census.branches.ts`'s `sweepTransientRepos` pattern). The
   * caller decides what to do next (write a final checkpoint and exit with
   * partial coverage for re-dispatch); never rethrown the way a fatal
   * `abortedBy` condition is.
   */
  deadlineExceeded: boolean
}

/**
 * Run the main pass over every not-yet-attempted row (from the checkpoint, if
 * resuming), in concurrency-bounded batches, checkpointing after each batch.
 *
 * SMI-6015 (GPT-5.6-Sol review, 2026-08-14): uses `runCancellablePool`, not
 * the plain `pMapBounded` this originally shipped with — `pMapBounded` has no
 * shared cancellation check between its concurrent workers, so a
 * `PrimaryFetchAuthError` thrown by one worker rejects the outer await while
 * sibling workers already in flight keep fetching from GitHub in the
 * background regardless, silently defeating the point of aborting on a dead
 * credential. `runCancellablePool`'s workers check a shared abort flag both
 * before AND after each item, so an abort actually stops new work; whatever
 * partial progress a batch made before the abort is checkpointed via
 * `onBatchDone` BEFORE rethrowing (durable partial write) — unless that same
 * batch also fails the SMI-6481 coherence assert below, which deliberately
 * pre-empts the checkpoint write so poison never reaches disk (the batch's
 * good rows simply re-scan on the next resume).
 *
 * SMI-6015 Wave 1 (plan-review High finding #6): `deadlineAtMs` (optional)
 * threads straight into `runCancellablePool`'s own built-in deadline support
 * — the SAME mechanism `smi5879-census.branches.ts`'s `sweepTransientRepos`
 * already uses for its per-pass wall-clock cap, reused here rather than
 * inventing a second, fatal-`abortedBy`-based mechanism (the original design
 * for this Wave 1 item, corrected during plan review). A deadline hit between
 * batches (checked at the top of the next `runCancellablePool` call) or
 * mid-batch (checked per-worker) stops pulling new work; whatever the current
 * batch completed is still checkpointed via `onBatchDone` before returning,
 * exactly like a normal batch boundary — never a partial/corrupt write.
 */
export async function runMainPass(
  rows: SimSnapshotRow[],
  alreadyResults: Map<string, SimRowResult>,
  branchMap: BranchMap,
  scanDeps: {
    scanPostPort: ScanSkillBundleFn
    scanPrePort: ScanSkillBundleFn
    telemetry: RateLimitTelemetry
    // SMI-6015: a callback, not a frozen headers object — see
    // `ProcessRowDeps`'s doc comment in `smi5879-simulate-full.helpers.ts`.
    // This run is multi-day; a token built once at startup would go stale
    // after GitHub's 1h App-token expiry, same root cause as the census's
    // own frozen-header bug.
    getHeaders: () => Promise<Record<string, string>>
  },
  onBatchDone: (results: Map<string, SimRowResult>) => Promise<void>,
  deadlineAtMs?: number
): Promise<RunMainPassResult> {
  const pending = rows.filter((r) => !alreadyResults.has(r.id))
  for (let i = 0; i < pending.length; i += CHECKPOINT_BATCH_SIZE) {
    const batch = pending.slice(i, i + CHECKPOINT_BATCH_SIZE)
    const outcomes: SimRowResult[] = []
    const { abortedBy, deadlineExceeded } = await runCancellablePool(
      batch,
      (row) => processRow(row, branchMap, scanDeps),
      (outcome) => {
        outcomes.push(outcome)
      },
      PROCESS_CONCURRENCY,
      deadlineAtMs
    )
    // SMI-6481: validate THIS batch's own outcomes for internal coherence
    // BEFORE merging them into `alreadyResults` and durably checkpointing
    // via `onBatchDone` below — a `processRow` regression producing an
    // incoherent row (e.g. `bundle_absent` whose own quarantine booleans
    // show a real verdict change) must fail loudly HERE, before it can ever
    // reach disk. Catching it only at report-assembly time (the
    // `buildSimulateFullReport` check, `smi5879-simulate-full.report.ts`)
    // would be too late for THIS run, and catching it only on a future
    // resume (`assertCheckpointRowsAreCoherent`,
    // `smi5879-simulate-full.checkpoint-coherence.ts`) would misattribute the cause
    // to "a pre-SMI-6436 checkpoint" when the real cause is a live
    // classifier regression. Both of those checks stay in place too
    // (defence-in-depth, not a replacement for this one).
    assertRowsInternallyCoherent(outcomes)
    for (const outcome of outcomes) alreadyResults.set(outcome.id, outcome)
    await onBatchDone(alreadyResults)
    if (abortedBy) throw abortedBy
    if (deadlineExceeded) return { deadlineExceeded: true }
  }
  return { deadlineExceeded: false }
}
