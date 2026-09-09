/**
 * SMI-6481: whole-checkpoint runtime shape validation, split out of
 * `smi5879-simulate-full.checkpoint.ts` — which had crept back to 499/500
 * lines (the blocking pre-commit gate) as the SMI-6481 guards and their
 * rationale comments landed. That file now owns checkpoint FILE I/O; this one
 * owns "is this parsed JSON actually a checkpoint". Per-ROW field validation
 * is a further split again, in
 * `smi5879-simulate-full.checkpoint-row-shape.ts`.
 *
 * @module scripts/indexer/smi5879-simulate-full.checkpoint-shape
 */

import { ALL_SIMULATED_COHORTS } from './smi5879-simulate-full.types.ts'
import {
  isPlainObject,
  validateCheckpointRowShape,
} from './smi5879-simulate-full.checkpoint-row-shape.ts'
import type {
  SimulatedCohort,
  Smi5879SimulateCheckpoint,
  SweepHardStopReason,
  TokenSource,
} from './smi5879-simulate-full.types.ts'
import type { Smi5879Purpose } from './smi5879-census.types.ts'

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

/**
 * SMI-6481: cap on how many individual shape-validation failures a single
 * refusal enumerates — applied at ACCUMULATION time, not just at `join` time,
 * so a wholly corrupt checkpoint cannot retain millions of strings on its way
 * to a capped message. A single bad row can contribute up to 9 fragments (id,
 * cohort, outcome, the two boolean fields, the two score fields, `reason`,
 * `unfetchable_subtype`), so the unbounded form scaled at 9x the row count.
 * The reported total stays exact; only the enumeration is capped.
 */
const MAX_SHAPE_ERRORS_IN_MESSAGE = 20

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
export function assertValidCheckpointShape(
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
  const cohorts = value['cohorts']
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
  // SMI-6015 Wave 1: `cohorts` must be a non-empty array of valid cohort
  // values — always the explicit resolved scope, never omitted (see the
  // field's own doc comment in smi5879-simulate-full.types.ts).
  if (
    !Array.isArray(cohorts) ||
    cohorts.length === 0 ||
    !cohorts.every((c) => ALL_SIMULATED_COHORTS.includes(c as SimulatedCohort))
  ) {
    errors.push(`cohorts=${JSON.stringify(cohorts)}`)
  }
  // SMI-6015 Wave 1: shard_index/shard_count are both-or-neither, and when
  // present must be a valid (index, count) pair — same rigor as the CLI
  // parser's own validation (smi5879-simulate-full.cli.ts), re-applied here
  // because a hand-edited or stale checkpoint file bypasses the CLI parser
  // entirely.
  const shardIndex = value['shard_index']
  const shardCount = value['shard_count']
  if (shardIndex !== undefined || shardCount !== undefined) {
    if (
      typeof shardCount !== 'number' ||
      !Number.isInteger(shardCount) ||
      shardCount < 1 ||
      typeof shardIndex !== 'number' ||
      !Number.isInteger(shardIndex) ||
      shardIndex < 0 ||
      shardIndex >= shardCount
    ) {
      errors.push(`shard_index=${String(shardIndex)}/shard_count=${String(shardCount)}`)
    }
  }
  if (typeof cleanShutdown !== 'boolean') errors.push('clean_shutdown')
  if (typeof startedAt !== 'string') errors.push('started_at')
  if (typeof updatedAt !== 'string') errors.push('updated_at')

  // SMI-6481 (F5): `sweep` is validated BEFORE `row_results` — corrupt resume
  // state must never be the half elided from a truncated message. Scope, per
  // mutation: defence-in-depth, not the active mechanism (F4's cap already
  // makes the row loop self-limiting while this block pushes unconditionally,
  // so swapping the two fails no test). Kept because reverting BOTH — cap at
  // `join` over a full array, sweep last — does break it. See the regression
  // test in `smi5879-simulate-full.checkpoint.test.ts`.
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

  // SMI-6481 (governance round 2, finding F4): count every row error but STOP
  // RETAINING them past the message cap. Capping only at `join` time (the
  // round-1 fix) still accumulated one string per bad field per bad row — at a
  // real population (hundreds of thousands of rows, up to 9 fragments each)
  // that is millions of retained strings: the same blow-up the cap was added to
  // prevent, relocated from `Error.message` into the array.
  //
  // Per-row validation lives in `smi5879-simulate-full.checkpoint-row-shape.ts`
  // — see that module's header for why type-checking (not just
  // presence-checking) the scored fields is what closes the refusal.
  // `suppressedCount` is an explicit counter rather than a prefix-match over
  // `errors` at the throw site (round-3 finding): correct today, but it made
  // the total silently dependent on no other error string ever starting with
  // `row_results.` — a fragile coupling for something an operator relies on.
  let suppressedCount = 0
  if (!isPlainObject(rowResults)) {
    errors.push('row_results')
  } else {
    for (const [id, rawResult] of Object.entries(rowResults)) {
      const rowErrors = validateCheckpointRowShape(id, rawResult)
      for (let i = 0; i < rowErrors.length; i++) {
        if (errors.length >= MAX_SHAPE_ERRORS_IN_MESSAGE) {
          suppressedCount += rowErrors.length - i
          break
        }
        errors.push(rowErrors[i] as string)
      }
    }
  }

  if (errors.length > 0) {
    // The enumeration is capped; the reported TOTAL is not — an operator needs
    // the true scale even when only the first `MAX_SHAPE_ERRORS_IN_MESSAGE` are
    // named. Every sibling guard in this family caps the same way
    // (`assertCheckpointRowsBelongToGeneration`'s `slice(0, 5)`,
    // `MAX_IDS_IN_ERROR`, `MAX_IDS_IN_CHECKPOINT_REMEDIATION`).
    const total = errors.length + suppressedCount
    const remainder = suppressedCount
    const suffix = remainder > 0 ? `, and ${remainder} more` : ''
    throw new Error(
      `SMI-5879: checkpoint at ${path} failed shape validation — ${total} ` +
        `invalid/missing field(s): ${errors.join(', ')}${suffix}. Refusing to trust a malformed ` +
        'checkpoint file — fix or remove it before resuming (removing it is a COLD START, not a ' +
        'safe default: confirm no real progress is being discarded first).'
    )
  }
}
