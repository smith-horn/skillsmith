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
  }
}
