/**
 * Checkpoint I/O for smi5879-simulate-full.ts: on-disk read/write, shape
 * validation for a checkpoint read off disk, and the two identity guards
 * that refuse to resume a checkpoint that doesn't actually belong to this
 * invocation. Split out of smi5879-simulate-full.sweep.ts (CLAUDE.md's
 * <500-line-per-file convention — SMI-6015 Wave 1's `cohorts` field pushed
 * the combined file over budget). Coverage aggregation and the tier-3 sweep
 * loop stay in `.sweep.ts`; `processRow`'s per-row logic stays in
 * `.helpers.ts` — this file owns everything about persisting/resuming
 * progress on disk.
 * @module scripts/indexer/smi5879-simulate-full.checkpoint
 *
 * Plan: docs/internal/implementation/smi-5879-wave3-census-simulation-plan.md §3c
 * Design: docs/internal/implementation/smi-5879-edge-twin-parity-design.md §8.3.5.2.4
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { ALL_SIMULATED_COHORTS, isValidSimRowOutcome } from './smi5879-simulate-full.types.ts'
import { shardOf } from './smi5879-simulate-full.shard.ts'
import type {
  SimSnapshotRow,
  SimulatedCohort,
  Smi5879SimulateCheckpoint,
  SweepHardStopReason,
  TokenSource,
} from './smi5879-simulate-full.types.ts'
import type { Smi5879Purpose } from './smi5879-census.types.ts'

export function checkpointPathFor(runId: string): string {
  return `smi5879-simulate-checkpoint-${runId}.json`
}

/**
 * SMI-6015 Wave 1 (PAT-sharded fetch plan §2): shard-aware checkpoint path
 * convention, matching the Wave 3 dispatch runbook's own naming
 * (`smi5879-simulate-checkpoint-${runId}-shard${i}.json`). Callers pass an
 * explicit `--checkpoint-path` per shard in production (this function is a
 * convenience default, same relationship {@link checkpointPathFor} has to
 * `--checkpoint-path`) — {@link assertCheckpointIdentity} cross-checks
 * whatever path IS used against the checkpoint's own `shard_index` when the
 * path matches this naming pattern.
 */
export function checkpointPathForShard(runId: string, shardIndex: number): string {
  return `smi5879-simulate-checkpoint-${runId}-shard${shardIndex}.json`
}

/**
 * Extract the shard index embedded in a checkpoint path by
 * {@link checkpointPathForShard}'s own naming convention, or `null` if the
 * path doesn't match it (e.g. a fully custom `--checkpoint-path`) — in which
 * case there is no path-implied identity to cross-check, and
 * {@link assertCheckpointIdentity} skips that specific sub-check rather than
 * treating "doesn't match the convention" as itself an error.
 *
 * SHARD-INDEX ONLY, deliberately not run-id-aware (round-1 GPT-5.6-Sol
 * review, Low finding): `run_id` values are not fixed-shape (they can
 * themselves contain dashes and digit runs — see real examples in this
 * generation's own `run_id` values), so reliably reverse-parsing a `run_id`
 * back out of `smi5879-simulate-checkpoint-${runId}-shard${i}.json` without
 * the same ambiguity is not possible in general. This is not a gap in
 * practice: {@link assertCheckpointIdentity}'s own `checkpoint.run_id !==
 * expected.runId` content-based comparison (checked unconditionally, not
 * only when the path matches this convention) already catches a genuinely
 * wrong `run_id`, regardless of what the path's own name happens to imply.
 */
function parseShardIndexFromPath(path: string): number | null {
  const match = /-shard(\d+)\.json$/.exec(path)
  const captured = match?.[1]
  if (captured === undefined) return null
  return Number(captured)
}

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
        !ALL_SIMULATED_COHORTS.includes(cohort as SimulatedCohort)
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

/** Order-insensitive equality for a resolved cohort scope — `['C2','C4']` and `['C4','C2']` are the same scope. */
function sameCohorts(a: readonly SimulatedCohort[], b: readonly SimulatedCohort[]): boolean {
  if (a.length !== b.length) return false
  const sortedA = [...a].sort()
  const sortedB = [...b].sort()
  return sortedA.every((c, i) => c === sortedB[i])
}

/**
 * Refuses to reuse a checkpoint whose identity doesn't match THIS
 * invocation — a wrong `--checkpoint-path` pointing at another
 * generation's checkpoint could otherwise silently skip rows that are
 * still live-unattempted for the current run (SMI-5879 review finding 1).
 * `baseline_commit` is checked separately by the caller (pre-existing).
 *
 * SMI-6015 Wave 1 (plan-review Medium finding #9): `cohorts` is checked the
 * same way — a resumed dispatch with a DIFFERENT `--cohorts` filter than the
 * checkpoint was written with must be refused loudly, not silently accepted
 * (a cohort-scoped rehearsal checkpoint resumed as if it were the full
 * population, or vice versa, would silently corrupt that generation's
 * coverage accounting).
 *
 * SMI-6015 Wave 1 (PAT-sharded fetch plan §2): `shardIndex`/`shardCount` are
 * checked the same way, both-or-neither with `expected.shardIndex`/
 * `expected.shardCount` — a resume against a checkpoint written for a
 * different shard index, a different shard count, or crossing between
 * sharded and unsharded, is refused loudly rather than silently corrupting
 * that shard's row assignment. ADDITIONALLY, when `path` matches
 * {@link checkpointPathForShard}'s naming convention, the shard index
 * embedded in the PATH itself is cross-checked against the checkpoint
 * content's own `shard_index` — this catches a copy/rename mistake (a
 * checkpoint file physically moved/copied to a path implying a different
 * shard than its own content) that the plain content-vs-`expected` check
 * above cannot: if the operator's `--shard-index` flag and the checkpoint's
 * content happen to agree with each other but NEITHER agrees with what the
 * file's own name implies, the flag-vs-content check alone would pass.
 */
export function assertCheckpointIdentity(
  checkpoint: Smi5879SimulateCheckpoint,
  expected: {
    runId: string
    purpose: Smi5879Purpose
    tokenSource: TokenSource
    cohorts: SimulatedCohort[]
    shardIndex?: number
    shardCount?: number
  },
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
  if (!sameCohorts(checkpoint.cohorts, expected.cohorts)) {
    mismatches.push(
      `cohorts (checkpoint=${checkpoint.cohorts.join(',')}, this run=${expected.cohorts.join(',')})`
    )
  }
  if (
    checkpoint.shard_index !== expected.shardIndex ||
    checkpoint.shard_count !== expected.shardCount
  ) {
    mismatches.push(
      `shard (checkpoint=index ${checkpoint.shard_index ?? '(unsharded)'}/count ${checkpoint.shard_count ?? '(unsharded)'}, ` +
        `this run=index ${expected.shardIndex ?? '(unsharded)'}/count ${expected.shardCount ?? '(unsharded)'})`
    )
  }
  const pathShardIndex = parseShardIndexFromPath(path)
  if (pathShardIndex !== null && pathShardIndex !== checkpoint.shard_index) {
    mismatches.push(
      `shard index embedded in --checkpoint-path (${pathShardIndex}) does not match the checkpoint's ` +
        `own shard_index (${checkpoint.shard_index ?? '(unsharded)'}) — this file was likely copied ` +
        'or renamed to this path from a different shard'
    )
  }
  if (mismatches.length > 0) {
    throw new Error(
      `SMI-5879: checkpoint at ${path} does not match this invocation — ${mismatches.join('; ')}. ` +
        'A resume must reuse a checkpoint from the SAME run_id/purpose/token_source/cohorts/shard — ' +
        'use a fresh --checkpoint-path for a different generation, cohort scope, or shard instead of ' +
        'pointing at this one.'
    )
  }
}

/**
 * Refuses to reuse a checkpoint whose `row_results` keys reference row ids
 * outside the CURRENT generation's loaded row set — e.g. a stale checkpoint
 * from a different generation whose row ids happen to overlap with
 * globally-stable skill ids from this one. Must be called only after the
 * real row set for this generation has been loaded (SMI-5879 review finding 1).
 *
 * SMI-6015 PAT-sharded fetch plan Wave 1 (round-1 GPT-5.6-Sol review, High
 * finding): generation membership alone is NOT sufficient once shards
 * exist. `assertCheckpointIdentity` only compares the checkpoint's OWN
 * declared `shard_index`/`cohorts` against this invocation's — it says
 * nothing about whether each INDIVIDUAL `row_results` entry actually
 * belongs to that declared scope. A structurally valid checkpoint could
 * declare `shard_index: 1` while its `row_results` (corrupted, hand-edited,
 * or produced by some future bug) actually contains shard-0 or
 * excluded-cohort rows — resume would silently accept them, producing a
 * shard report with rows outside its own partition and breaking the
 * row-id-disjointness invariant Wave 2's merge tool depends on. Every
 * `row_results` entry is now checked against: (1) `result.id === key` (the
 * dictionary key matches its own stored result — catches a corrupted/
 * mismatched entry), (2) `result.cohort`/`result.author`/`result.name`
 * (round-2/round-3 review findings — every field `processRow` derives from
 * the canonical row, not just `id`) each agree with the CANONICAL row's own
 * values — `report.rows`/`counts` are built from the stored results
 * directly, not re-derived from the canonical row set, so any of these
 * disagreeing would otherwise survive into the report unverified, (3) the
 * row's cohort is within `scope.cohorts`, and (4) when sharded,
 * `shardOf(id, scope.shardCount) === scope.shardIndex` (the row genuinely
 * belongs to THIS shard's partition, not just this generation).
 */
export function assertCheckpointRowsBelongToGeneration(
  checkpoint: Smi5879SimulateCheckpoint,
  rows: readonly SimSnapshotRow[],
  path: string,
  scope: { cohorts: SimulatedCohort[]; shardIndex?: number; shardCount?: number }
): void {
  const rowById = new Map(rows.map((r) => [r.id, r]))
  const problems: string[] = []
  for (const [key, result] of Object.entries(checkpoint.row_results)) {
    const row = rowById.get(key)
    if (!row) {
      problems.push(`${key} (not in this generation's row set)`)
      continue
    }
    if (result.id !== key) {
      problems.push(`${key} (row_results key does not match its own result.id=${result.id})`)
      continue
    }
    // Round-2 GPT-5.6-Sol review, High finding: the FIRST-round fix checked
    // the CANONICAL loaded row's cohort against scope, but never checked
    // that the STORED result's OWN `cohort` field actually agrees with that
    // canonical row — `report.rows`/`counts` are built directly from the
    // stored results (`summarizeCounts(results.values())`), not re-derived
    // from the canonical row set, so a malformed entry with a real row id
    // but a WRONG `result.cohort` would survive into the report untouched,
    // even though `coverage[cohort].total` (keyed off the canonical rows)
    // stayed correct — a real corruption path this closes.
    if (result.cohort !== row.cohort) {
      problems.push(
        `${key} (stored result.cohort=${result.cohort} does not match this row's real cohort=${row.cohort})`
      )
      continue
    }
    // Round-3 GPT-5.6-Sol review, Medium finding: `author`/`name` are the
    // same class of gap as `cohort` above — `processRow` (helpers.ts)
    // derives both directly from the canonical row, but resume never
    // cross-checks the stored values against it, and both flow unchanged
    // into `report.rows`. Not gate-relevant (unlike `cohort`, which feeds
    // `coverage`/`counts`) — these are purely informational/display fields
    // for a human reviewer reading the report — but a malformed stored
    // value would still silently misattribute a row in the report.
    if (result.author !== row.author || result.name !== row.name) {
      problems.push(
        `${key} (stored result.author/name=${result.author}/${result.name} does not match this row's real author/name=${row.author}/${row.name})`
      )
      continue
    }
    if (!scope.cohorts.includes(row.cohort)) {
      problems.push(`${key} (cohort ${row.cohort} outside this run's cohort scope)`)
      continue
    }
    if (scope.shardIndex !== undefined && scope.shardCount !== undefined) {
      const expectedShard = shardOf(key, scope.shardCount)
      if (expectedShard !== scope.shardIndex) {
        problems.push(
          `${key} (belongs to shard ${expectedShard}, not this shard ${scope.shardIndex})`
        )
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `SMI-5879: checkpoint at ${path} has ${problems.length} row_results entr` +
        `${problems.length === 1 ? 'y' : 'ies'} that don't belong to this invocation's scope: ` +
        `${problems.slice(0, 5).join('; ')}` +
        `${problems.length > 5 ? `, and ${problems.length - 5} more` : ''} — this checkpoint was ` +
        'likely written for a different generation, cohort scope, or shard. Refusing to reuse ' +
        'stale/foreign verdicts; use a fresh --checkpoint-path instead.'
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
