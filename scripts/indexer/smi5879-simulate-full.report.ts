/**
 * Report assembly for `smi5879-simulate-full.ts`'s `runSimulateFull` —
 * split out per CLAUDE.md's <500-line-per-file convention (SMI-6481: the
 * `assertCheckpointRowsAreCoherent` call plus the block-bodied
 * producer-side coherence check pushed `runSimulateFull`'s own file to
 * 503 lines post-prettier; this closure was the more self-contained half
 * to relocate — it captured `runSimulateFull`'s locals purely for report
 * ASSEMBLY, never for control flow, so an explicit context object is a
 * faithful, non-behavior-changing extraction).
 * @module scripts/indexer/smi5879-simulate-full.report
 *
 * Plan: docs/internal/implementation/smi-5879-wave3-census-simulation-plan.md §3a/§3b
 * Design: docs/internal/implementation/smi-5879-edge-twin-parity-design.md §8.2.3
 */

import { assertRowsInternallyCoherent } from './smi5879-merge-shards.outcome-coherence.ts'
import {
  computeCoverage,
  summarizeCounts,
  estimateCompletionAt,
} from './smi5879-simulate-full.sweep.ts'
import type { Smi5879Purpose, Smi5879RunStatus } from './smi5879-census.types.ts'
import type {
  SimRowResult,
  SimSnapshotRow,
  SimulatedCohort,
  Smi5879SimulateFullReport,
  TokenSource,
} from './smi5879-simulate-full.types.ts'

/**
 * Everything {@link buildSimulateFullReport} needs that stays FIXED for the
 * whole `runSimulateFull` invocation — built once, right after `results` is
 * seeded, and reused by both the normal-completion and deadline-exit paths.
 */
export interface BuildReportContext {
  runId: string
  purpose: Smi5879Purpose
  status: Smi5879RunStatus
  tokenSource: TokenSource
  baselineCommit: string
  rowsByCohort: Record<SimulatedCohort, SimSnapshotRow[]>
  results: Map<string, SimRowResult>
  startedAt: Date
  totalRows: number
}

/**
 * Assemble the gate-eligible report from current state. SMI-6481
 * defence-in-depth: `assertRowsInternallyCoherent` also covers rows THIS
 * invocation just produced itself via `processRow` — on top of the
 * checkpoint-seed check `runSimulateFull` runs immediately after seeding
 * `results` (`assertCheckpointRowsAreCoherent`,
 * `smi5879-simulate-full.checkpoint-coherence.ts`) — this single-invocation path
 * never otherwise runs `smi5879-merge-shards.ts`'s own pre-write checks at
 * all.
 */
export function buildSimulateFullReport(
  ctx: BuildReportContext,
  scannedRows: number,
  sweepInfo: {
    passes_run: number
    hard_stopped: Smi5879SimulateFullReport['sweep']['hard_stopped']
  }
): Smi5879SimulateFullReport {
  const finalRows = [...ctx.results.values()]
  assertRowsInternallyCoherent(finalRows)
  return {
    report_kind: 'full_simulation',
    run_id: ctx.runId,
    purpose: ctx.purpose,
    status: ctx.status,
    token_source: ctx.tokenSource,
    baseline_commit: ctx.baselineCommit,
    coverage: computeCoverage(ctx.rowsByCohort, ctx.results),
    estimated_completion_at: estimateCompletionAt(
      ctx.startedAt,
      new Date(),
      ctx.totalRows,
      scannedRows
    ),
    sweep: sweepInfo,
    rows: finalRows,
    counts: summarizeCounts(finalRows),
    generated_at: new Date().toISOString(),
  }
}
