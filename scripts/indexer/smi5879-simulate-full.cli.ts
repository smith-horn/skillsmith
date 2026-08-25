/**
 * CLI argument parsing for smi5879-simulate-full.ts, split out per CLAUDE.md's
 * <500-line-per-file convention (the orchestration file was approaching the
 * budget once SMI-6015 Wave 1 added the wall-clock deadline and cohort-scope
 * flags below).
 * @module scripts/indexer/smi5879-simulate-full.cli
 *
 * Plan: docs/internal/implementation/smi-6015-wave3-simulate-full-ci-workflow-plan.md Wave 1
 */

import { BASELINE_COMMIT_SHA } from './smi5879-simulate-full.baseline.ts'
import { ALL_SIMULATED_COHORTS, type SimulatedCohort } from './smi5879-simulate-full.types.ts'
import type { Smi5879Purpose } from './smi5879-census.types.ts'

const VALID_PURPOSES: readonly Smi5879Purpose[] = ['rehearsal', 'decision', 'window']

export interface CliArgs {
  runId: string
  purpose: Smi5879Purpose
  apply: boolean
  checkpointPath?: string
  reportPath?: string
  baselineCommit: string
  /**
   * SMI-6015 Wave 1: wall-clock self-checkpoint-and-exit budget for THIS
   * invocation, in minutes. Undefined means no deadline (the pre-existing
   * behavior) — a CI workflow dispatch always sets this so a GHA
   * `timeout-minutes` kill never arrives before the process has had a
   * chance to checkpoint and exit gracefully on its own terms.
   */
  maxElapsedMinutes?: number
  /**
   * SMI-6015 Wave 1: restrict this dispatch to a subset of cohorts.
   * Undefined means all four (the pre-existing, gate-eligible behavior) —
   * exists to enable a cheap, non-gating rehearsal dispatch (e.g. C4 alone)
   * before committing to the full, multi-day `purpose=decision` run. Never
   * valid combined with `purpose=decision` (see the check below) — G-2
   * requires ALL FOUR cohorts fully simulated in one decision-purpose
   * report, so a cohort-scoped decision dispatch could never satisfy the
   * gate no matter what it found.
   */
  cohorts?: SimulatedCohort[]
  /**
   * SMI-6015 Wave 1 (PAT-sharded fetch plan §1): this dispatch's shard
   * assignment for a PAT-sharded fetch. Both-or-neither with `shardCount` —
   * undefined means unsharded (the pre-existing single-process behavior).
   * Row-level, not cohort-level: every shard processes a slice of EVERY
   * cohort (see `shardOf()`'s own doc comment) — orthogonal to, and
   * composable with, `cohorts` above.
   */
  shardIndex?: number
  /** SMI-6015 Wave 1: total number of shards for this decision run. Both-or-neither with `shardIndex`. */
  shardCount?: number
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

  const maxElapsedMinutesRaw = find('max-elapsed-minutes')
  let maxElapsedMinutes: number | undefined
  if (maxElapsedMinutesRaw !== undefined) {
    const parsed = Number(maxElapsedMinutesRaw)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(
        `SMI-6015: --max-elapsed-minutes=<N> must be a positive number, got "${maxElapsedMinutesRaw}".`
      )
    }
    maxElapsedMinutes = parsed
  }

  const cohortsRaw = find('cohorts')
  let cohorts: SimulatedCohort[] | undefined
  if (cohortsRaw !== undefined && cohortsRaw !== '') {
    const parts = cohortsRaw.split(',').map((s) => s.trim())
    const invalid = parts.filter((p) => !ALL_SIMULATED_COHORTS.includes(p as SimulatedCohort))
    if (invalid.length > 0) {
      throw new Error(
        `SMI-5879: --cohorts=<comma-list> contains invalid cohort(s): ${invalid.join(', ')}. ` +
          `Valid: ${ALL_SIMULATED_COHORTS.join(', ')}.`
      )
    }
    cohorts = parts as SimulatedCohort[]
    // SMI-6015 Wave 1 plan-review Medium finding #10: reject at parse time,
    // not silently at runtime — a cohort-scoped `decision` dispatch would
    // burn a multi-hour run against a population that CANNOT satisfy G-2 no
    // matter what it finds (G-2 requires ALL FOUR cohorts fully simulated
    // in one decision-purpose report; see smi5879-gate-check.gates.ts).
    if (purpose === 'decision') {
      throw new Error(
        'SMI-5879: --cohorts=<subset> cannot be combined with --purpose=decision — G-2 requires ' +
          'ALL FOUR cohorts (C1-C4) fully simulated in one decision-purpose report; a cohort-scoped ' +
          'dispatch can never satisfy that gate. Use --purpose=rehearsal for a cohort-scoped run.'
      )
    }
  }

  // SMI-6015 Wave 1: --shard-index/--shard-count, both-or-neither. Row-level
  // sharding, orthogonal to --cohorts (plan §1) — no cross-validation against
  // `cohorts`/`purpose` needed here; every shard processes a slice of every
  // cohort regardless of the cohort scope.
  const shardIndexRaw = find('shard-index')
  const shardCountRaw = find('shard-count')
  let shardIndex: number | undefined
  let shardCount: number | undefined
  if (shardIndexRaw !== undefined || shardCountRaw !== undefined) {
    if (shardIndexRaw === undefined || shardCountRaw === undefined) {
      throw new Error(
        'SMI-6015: --shard-index and --shard-count must both be present or both be absent, got ' +
          `--shard-index=${shardIndexRaw ?? '(missing)'} --shard-count=${shardCountRaw ?? '(missing)'}.`
      )
    }
    const parsedCount = Number(shardCountRaw)
    if (!Number.isInteger(parsedCount) || parsedCount < 1) {
      throw new Error(
        `SMI-6015: --shard-count=<N> must be an integer >= 1, got "${shardCountRaw}".`
      )
    }
    const parsedIndex = Number(shardIndexRaw)
    // Also covers the degenerate --shard-count=1 case correctly: with
    // parsedCount=1, the only value satisfying 0 <= i < 1 is 0, so
    // --shard-index=0 --shard-count=1 (a no-op single-shard run, useful for
    // the merge tool's own tests) passes, and any other --shard-index with
    // --shard-count=1 is naturally rejected by this same bound — no separate
    // special case needed.
    if (!Number.isInteger(parsedIndex) || parsedIndex < 0 || parsedIndex >= parsedCount) {
      throw new Error(
        `SMI-6015: --shard-index=<i> must be an integer with 0 <= i < --shard-count (${parsedCount}), got "${shardIndexRaw}".`
      )
    }
    shardIndex = parsedIndex
    shardCount = parsedCount
  }

  // `checkpointPath`/`reportPath` are genuinely optional (downstream defaults via
  // `?? checkpointPathFor(...)` / `?? 'smi5879-simulate-report-...'`) — under
  // `exactOptionalPropertyTypes`, an optional property means "may be omitted",
  // not "may be omitted OR explicitly `undefined`", so the key must be left off
  // entirely when the flag wasn't passed rather than assigned `undefined`.
  const checkpointPath = find('checkpoint-path')
  const reportPath = find('report-path')
  return {
    runId,
    purpose: purpose as Smi5879Purpose,
    apply: argv.includes('--apply'),
    ...(checkpointPath !== undefined ? { checkpointPath } : {}),
    ...(reportPath !== undefined ? { reportPath } : {}),
    baselineCommit: find('baseline-commit') ?? BASELINE_COMMIT_SHA,
    ...(maxElapsedMinutes !== undefined ? { maxElapsedMinutes } : {}),
    ...(cohorts !== undefined ? { cohorts } : {}),
    ...(shardIndex !== undefined ? { shardIndex } : {}),
    ...(shardCount !== undefined ? { shardCount } : {}),
  }
}
