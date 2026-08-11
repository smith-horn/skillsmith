#!/usr/bin/env tsx
/**
 * SMI-5930 Wave 2 (Wave 1 of docs/internal/implementation/smi-5930-wave2-and-adjacent-fixes.md):
 * Targeted repair for the ~42,487 "latched" `skills` rows whose `name` equals
 * the repo name (not the skill's own declared name) but can never self-heal
 * via organic re-crawl.
 *
 * ── Why these rows are stuck ─────────────────────────────────────────────
 * The indexer's own skip-gate skips writing `name` whenever `content_hash`
 * already matches a re-fetch AND `security_score` is non-NULL -- for the
 * affected rows that condition is permanently true, so organic re-crawl
 * can never reach the path that re-derives `name` from frontmatter.
 *
 * ── The fix (data-only, no DDL) ──────────────────────────────────────────
 * NULL `content_hash` for exactly the rows matching {@link LATCHED_ROW_PREDICATE}.
 * This does NOT touch `name` directly -- it un-sticks the row so the next
 * organic re-crawl's hash-match check fails and routes it through the full
 * path where `name` gets correctly re-derived. Safe to run now because the
 * prior plan's Wave 1 (re-key trigger, `supabase/migrations/
 * 20260811000000_skill_name_change_rekey_trigger.sql`) is deployed +
 * smoke-tested: any name correction this enables re-keys
 * `workspace_skills`/`skill_update_notifications_sent` atomically.
 *
 * ── Critical design point (plan-review finding) ──────────────────────────
 * Re-running {@link LATCHED_ROW_PREDICATE} after this script applies will
 * trivially show fewer matches -- but that is CIRCULAR, not proof anything
 * was actually fixed. It only proves the row got unlatched (content_hash is
 * NULL again), never that `name` was corrected -- that only happens on the
 * row's NEXT organic re-crawl, which is out of this script's control and
 * out of scope for this script to verify. So every row this script
 * successfully unlatches has its id appended to a log file (see
 * {@link defaultLogPath}) as soon as its batch's UPDATE commits -- a
 * SEPARATE, later, manual process (the plan owner) re-checks those EXACT
 * ids' `name` after their next re-crawl. This script's job ends at "recorded
 * the ids it unlatched", not at "proved the name is now correct". The log is
 * best-effort, not a completeness guarantee -- see {@link appendBatchLog}'s
 * own doc comment for the honest bound on that.
 *
 * ── Conventions mirrored (do not invent new shapes) ──────────────────────
 *  - `--dry-run` (default) / `--apply` (opt-in), logging shape, and the
 *    "skipped when imported by tests" guard mirror
 *    `scripts/indexer/dequarantine-false-positives.ts`.
 *  - Session-pooler access reuses `smi5879-census.pg.ts`'s
 *    `poolerSessionConnParams`/`queryRows`, already shared by
 *    `smi5879-census.ts`/`smi5879-gate-check.ts`/`smi5879-simulate-full.ts`.
 *  - {@link updateBatchWithRetry}'s halve-and-retry logic mirrors
 *    `upsertChunkWithRetry` (`indexer-runners.batch.ts`): same halving math
 *    (`Math.ceil(len / 2)`), sequential await of both halves, same
 *    `MAX_TIMEOUT_SPLIT_DEPTH` cap, same terminal-error behavior (record an
 *    error string, never throw past this function).
 *  - The default log path mirrors `purge-dead-quarantines.ts`'s
 *    `defaultExportPath()` convention.
 *
 * ── Run-gated (CORRECTED -- code-review finding) ─────────────────────────
 * An earlier version of this comment wrongly claimed this script (and
 * `purge-dead-quarantines.ts`) were exempt from `run-gate.ts` -- unverified;
 * `purge-dead-quarantines.ts` actually DOES call `assertRunAllowed`/
 * `assertFreezeMarkerClear`. This script now does the same via a new
 * `'repair'` `GatedRunType` -- a genuine one-time `skills` WRITER, same class
 * as dequarantine/purge/revalidate, not a reader like `smi5879-census.ts`
 * (correctly exempt). See `run-gate.ts`'s `GATED_RUN_TYPES` doc comment.
 *
 * ── Usage (host tool -- requires Docker container running for varlock) ────
 *   varlock run -- npx tsx scripts/indexer/repair-latched-name-rows.ts             # dry-run
 *   varlock run -- npx tsx scripts/indexer/repair-latched-name-rows.ts --apply     # live
 *   varlock run -- npx tsx scripts/indexer/repair-latched-name-rows.ts --batch-size 500
 */

import { mkdir, appendFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { poolerSessionConnParams, queryRows, type PgConnParams } from './smi5879-census.pg.ts'
import { parseLogPathArg, parseBatchSizeArg } from './repair-latched-name-rows.cli.ts'
import { assertRunAllowed, assertFreezeMarkerClear } from './run-gate.ts'
import { createSupabaseAdminClient } from './_shared/supabase.ts'

export {
  isFlagLikeToken,
  parseLogPathArg,
  parseBatchSizeArg,
} from './repair-latched-name-rows.cli.ts'

// ---------------------------------------------------------------------------
// Predicate (single source of truth -- reused by both the fetch and the
// eventual manual Step-2-style verification query so they can never drift)
// ---------------------------------------------------------------------------

/**
 * Identifies a "latched" row: `discovery_path` came from the subdirectory
 * search path, the stored `name` equals the repo name (not the skill's own
 * declared name), AND both gate columns the indexer's skip-check reads are
 * non-NULL. No `AND TRUE` -- this predicate is already fully selective.
 */
export const LATCHED_ROW_PREDICATE = `discovery_path LIKE 'subdirectory_search%'
  AND lower(name) = lower(split_part(replace(repo_url, 'https://github.com/', ''), '/', 2))
  AND content_hash IS NOT NULL
  AND security_score IS NOT NULL`

/** `SELECT` fetching every candidate id, ordered by `id` (stable batch boundaries). */
export function buildFetchCandidateIdsSql(): string {
  return `SELECT id FROM skills WHERE ${LATCHED_ROW_PREDICATE} ORDER BY id;`
}

/**
 * `UPDATE` nulling `content_hash` for exactly the ids in `:'ids'` (a
 * comma-joined string, split server-side -- `psql -v` only substitutes a
 * single quoted string literal, so an explicit id LIST is passed this way
 * rather than as a native SQL array literal) -- AND still matching
 * {@link LATCHED_ROW_PREDICATE} at UPDATE time, not just at the original
 * fetch (code-review finding, HIGH): a candidate id list is fetched once,
 * but this script's batches run over an extended window (potentially
 * minutes to hours across ~85 batches). Without re-checking the predicate
 * here, a row organically corrected by a concurrent re-crawl BETWEEN the
 * fetch and this specific batch's UPDATE -- which would already have a
 * freshly-computed, correct `content_hash` -- would be wrongly nulled back
 * out by this script, undoing a legitimate write. Re-checking the full
 * predicate makes this UPDATE self-correcting: it only ever touches rows
 * that are STILL latched at the moment it actually runs.
 */
export function buildNullContentHashSql(): string {
  return `UPDATE skills
    SET content_hash = NULL
    WHERE id = ANY(string_to_array(:'ids', ','))
      AND ${LATCHED_ROW_PREDICATE}
    RETURNING id;`
}

// ---------------------------------------------------------------------------
// DB access (thin, injectable -- mirrors createSmi5879SimulateFullDbDeps)
// ---------------------------------------------------------------------------

export interface RepairDbDeps {
  /** Every candidate id matching {@link LATCHED_ROW_PREDICATE}, ordered by id. */
  fetchCandidateIds(): Promise<string[]>
  /**
   * NULL `content_hash` for exactly `ids`. Returns the ids actually updated
   * (via `RETURNING id`). Throws on any DB error, including a detectable
   * statement-timeout error -- callers use {@link updateBatchWithRetry} to
   * retry on that specific case.
   */
  nullContentHashForIds(ids: readonly string[]): Promise<string[]>
}

/**
 * A `queryRows` result row always has as many cells as the query's column
 * list; a genuinely missing cell means the SELECT's column count drifted
 * from what this function destructures -- worth throwing on rather than
 * silently letting `undefined` flow downstream (matches the `requireCell`
 * convention in every other `smi5879-census.pg.ts` consumer).
 */
function requireIdCell(value: string | undefined): string {
  if (value === undefined) {
    throw new Error(
      'repair-latched-name-rows: missing id cell in query result row — column count drift?'
    )
  }
  return value
}

/**
 * `skills.id` is an unconstrained `TEXT` column (code-review finding,
 * MEDIUM) -- {@link buildNullContentHashSql} comma-joins a batch of ids into
 * a single `:'ids'` string, split server-side via `string_to_array`. A
 * comma-joined list is not value-safe against an id that itself contains a
 * comma: it would silently split into the wrong set of values, matching a
 * broader or narrower row set than intended. Every id this script ever
 * handles originates from `fetchCandidateIds()`'s own `SELECT id FROM
 * skills`, never from external/user input, and this repo's actual `skills`
 * ids are UUIDs in practice -- but rather than assert that unverified
 * assumption (and risk false positives against a real id shape this script
 * hasn't seen), this checks the ONE thing that's actually unsafe about the
 * comma-join encoding itself: a literal comma. Anything else `string_to_array`
 * would split on unmodified is fine; a comma is the sole failure mode.
 */
export function assertJoinableId(id: string): string {
  if (id.includes(',')) {
    throw new Error(
      `repair-latched-name-rows: id "${id}" contains a comma and is not safe to comma-join — ` +
        `refusing to build a batch UPDATE that could silently split into the wrong id list ` +
        `and match the wrong rows. Stop and investigate before re-running.`
    )
  }
  return id
}

/** Build the real, psql-backed dependency set for a given session-pooler connection. */
export function createRepairDbDeps(conn: PgConnParams): RepairDbDeps {
  return {
    async fetchCandidateIds() {
      const rows = await queryRows(conn, buildFetchCandidateIdsSql())
      return rows.map(([id]) => requireIdCell(id))
    },
    async nullContentHashForIds(ids) {
      if (ids.length === 0) return []
      const joined = ids.map(assertJoinableId).join(',')
      const rows = await queryRows(conn, buildNullContentHashSql(), { ids: joined })
      return rows.map(([id]) => requireIdCell(id))
    },
  }
}

// ---------------------------------------------------------------------------
// Batching
// ---------------------------------------------------------------------------

export const DEFAULT_BATCH_SIZE = 750
export const MIN_BATCH_SIZE = 500
export const MAX_BATCH_SIZE = 1000

/** Slice `ids` (already ordered by id) into fixed-size batches. Pure, unit-tested. */
export function planBatches(ids: readonly string[], batchSize: number): string[][] {
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error(
      `repair-latched-name-rows: batch size must be a positive integer, got ${batchSize}`
    )
  }
  const batches: string[][] = []
  for (let i = 0; i < ids.length; i += batchSize) {
    batches.push(ids.slice(i, i + batchSize))
  }
  return batches
}

// ---------------------------------------------------------------------------
// Statement-timeout halve-and-retry (structural mirror of upsertChunkWithRetry
// in indexer-runners.batch.ts -- see module doc for the exact correspondence)
// ---------------------------------------------------------------------------

/** Postgres's `canceling statement due to statement timeout` message substring. */
const STATEMENT_TIMEOUT_SUBSTRING = 'statement timeout'

/** Same depth cap as `upsertChunkWithRetry` -- bounds a systemic-timeout run to 2^depth leaves. */
export const MAX_TIMEOUT_SPLIT_DEPTH = 8

function isStatementTimeoutError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return message.includes(STATEMENT_TIMEOUT_SUBSTRING)
}

export interface BatchUpdateResult {
  updatedIds: string[]
  errors: string[]
}

/**
 * Attempt to null `content_hash` for exactly `ids`. On a statement-timeout
 * error, halve `ids` and retry each half independently (depth-first,
 * sequential -- the left half is fully awaited before the right half
 * starts), bounded by {@link MAX_TIMEOUT_SPLIT_DEPTH}. A non-timeout error,
 * or a timeout at max depth, is recorded as an error string covering that
 * (sub)batch and NEVER thrown past this function -- one bad batch must not
 * abort the whole run, exactly like `upsertChunkWithRetry`.
 */
export async function updateBatchWithRetry(
  db: RepairDbDeps,
  ids: readonly string[],
  depth = 0
): Promise<BatchUpdateResult> {
  try {
    const updatedIds = await db.nullContentHashForIds(ids)
    return { updatedIds, errors: [] }
  } catch (err) {
    if (isStatementTimeoutError(err) && ids.length > 1 && depth < MAX_TIMEOUT_SPLIT_DEPTH) {
      const mid = Math.ceil(ids.length / 2)
      const left = await updateBatchWithRetry(db, ids.slice(0, mid), depth + 1)
      const right = await updateBatchWithRetry(db, ids.slice(mid), depth + 1)
      return {
        updatedIds: [...left.updatedIds, ...right.updatedIds],
        errors: [...left.errors, ...right.errors],
      }
    }
    const message = err instanceof Error ? err.message : String(err)
    return {
      updatedIds: [],
      errors: [`Batch update failed (${ids.length} row(s)): ${message}`],
    }
  }
}

// ---------------------------------------------------------------------------
// Dry-run sampling (bounded output -- never dump the full ~42,487-row list)
// ---------------------------------------------------------------------------

export const DRY_RUN_SAMPLE_SIZE = 10

export interface DryRunSample {
  first: string[]
  last: string[]
}

/** First/last `n` ids of an (already `id`-ordered) candidate list, for a bounded dry-run preview. */
export function sampleIdsForDryRun(
  ids: readonly string[],
  n: number = DRY_RUN_SAMPLE_SIZE
): DryRunSample {
  const first = ids.slice(0, n)
  const last = ids.length > n ? ids.slice(-n) : []
  return { first, last }
}

// ---------------------------------------------------------------------------
// Unlatched-ids log (the record a later, separate process needs to check
// each row's `name` after its next re-crawl -- see module doc)
// ---------------------------------------------------------------------------

/** Timestamped default path under `~/.skillsmith/backups/`, mirroring `purge-dead-quarantines.ts`. */
export function defaultLogPath(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  return join(homedir(), '.skillsmith', 'backups', `repair-latched-name-rows-${stamp}.jsonl`)
}

export interface BatchLogEntry {
  batchIndex: number
  batchCount: number
  unlatchedAt: string
  ids: string[]
}

/**
 * Append one JSONL line per successful batch, immediately after that batch's
 * UPDATE commits -- NOT buffered to end-of-run, so a crash mid-run leaves a
 * record of every batch that had already finished logging at that point.
 *
 * HONEST LIMIT (code-review finding, HIGH -- corrects an earlier version of
 * this comment that overclaimed "durable record"): this filesystem append
 * and the database UPDATE it follows are two separate systems and cannot be
 * made atomic without a real two-phase-commit / outbox mechanism, which is
 * disproportionate infrastructure for a one-time maintenance script. A crash
 * landing in the narrow window between "UPDATE committed" and "this append
 * returns" loses that one batch's ids from the log -- the DB mutation itself
 * is unaffected and correct (see {@link buildNullContentHashSql}'s own
 * predicate re-check), but the plan's later convergence-sampling step won't
 * have those specific ids to check. This is a bounded risk to audit
 * COMPLETENESS only, not to data correctness: the affected rows still
 * self-heal via the normal predicate-driven re-crawl path, and Step 2's own
 * count-query re-run (see the plan doc) is the actual verification of
 * overall progress, not a substitute for per-row tracking. Do not treat this
 * log as a system of record -- it is an operational convenience for
 * sampling, not a completeness guarantee.
 */
export async function appendBatchLog(path: string, entry: BatchLogEntry): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, JSON.stringify(entry) + '\n', 'utf-8')
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface RunRepairOptions {
  apply: boolean
  batchSize?: number
  logPath?: string
}

export interface RunRepairResult {
  totalCandidates: number
  batchCount: number
  batchSize: number
  updatedIds: string[]
  errors: string[]
  logPath?: string
}

/** Run the repair (dry-run by default). Returns the run counts. */
export async function runRepair(
  db: RepairDbDeps,
  opts: RunRepairOptions
): Promise<RunRepairResult> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE
  if (batchSize < MIN_BATCH_SIZE || batchSize > MAX_BATCH_SIZE) {
    throw new Error(
      `repair-latched-name-rows: --batch-size must be between ${MIN_BATCH_SIZE} and ${MAX_BATCH_SIZE} (got ${batchSize}), per the SMI-5930 plan.`
    )
  }

  const ids = await db.fetchCandidateIds()
  const batches = planBatches(ids, batchSize)

  console.log(
    `\n${opts.apply ? '🔧 APPLY' : '🔍 DRY-RUN'} — repair-latched-name-rows (SMI-5930 Wave 2)\n` +
      `Predicate: ${LATCHED_ROW_PREDICATE.replace(/\s+/g, ' ')}\n`
  )
  console.log(`  total candidates: ${ids.length}`)
  console.log(`  batch size:       ${batchSize}`)
  console.log(`  batch count:      ${batches.length}`)

  if (!opts.apply) {
    const { first, last } = sampleIdsForDryRun(ids)
    console.log(`  first ${first.length} id(s): ${first.join(', ') || '(none)'}`)
    if (last.length > 0) console.log(`  last ${last.length} id(s):  ${last.join(', ')}`)
    console.log(
      '\nDry-run only — no rows modified. Re-run with --apply to null content_hash for these rows.\n'
    )
    return {
      totalCandidates: ids.length,
      batchCount: batches.length,
      batchSize,
      updatedIds: [],
      errors: [],
    }
  }

  const logPath = opts.logPath ?? defaultLogPath()
  // PR-review finding (BLOCKING): preflight the log dir before the first
  // batch commits -- an unwritable path previously wasn't caught until the
  // first appendBatchLog, by which point that batch's UPDATE had already
  // committed (empty logPath is rejected earlier, at CLI parse time).
  await mkdir(dirname(logPath), { recursive: true })
  const updatedIds: string[] = []
  const errors: string[] = []

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i] ?? []
    const result = await updateBatchWithRetry(db, batch)
    updatedIds.push(...result.updatedIds)
    errors.push(...result.errors)

    if (result.updatedIds.length > 0) {
      await appendBatchLog(logPath, {
        batchIndex: i,
        batchCount: batches.length,
        unlatchedAt: new Date().toISOString(),
        ids: result.updatedIds,
      })
    }

    console.log(
      `  progress: ${updatedIds.length}/${ids.length} rows unlatched (batch ${i + 1}/${batches.length})`
    )
    for (const e of result.errors) console.error(`  ERROR: ${e}`)
  }

  console.log(
    `\n── Summary ──\n` +
      `  candidates:  ${ids.length}\n` +
      `  unlatched:   ${updatedIds.length}\n` +
      `  errors:      ${errors.length}\n` +
      `  log:         ${logPath}\n`
  )
  if (errors.length > 0) {
    console.log(
      'Some batches failed — re-run with --apply to retry the remaining rows (idempotent: only still-latched rows match the predicate).\n'
    )
  }

  return {
    totalCandidates: ids.length,
    batchCount: batches.length,
    batchSize,
    updatedIds,
    errors,
    logPath,
  }
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

/** CLI entrypoint (skipped when imported by tests). */
async function main(): Promise<void> {
  // SMI-5879 Gate C: env-sourced check first (no dependency on a DB round
  // trip), then the DB-sourced freeze marker immediately after client
  // construction -- same call-site contract as purge-dead-quarantines.ts's
  // main() (code-review finding: this script must be gated like its true
  // siblings, dequarantine/purge/revalidate, not exempt like a reader).
  assertRunAllowed('repair')
  const gateClient = createSupabaseAdminClient()
  await assertFreezeMarkerClear(gateClient, 'repair')

  // `--dry-run` wins over `--apply` if both are somehow passed -- the safe
  // default for a ~42K-row prod data mutation.
  const dryRunFlag = process.argv.includes('--dry-run')
  const apply = process.argv.includes('--apply') && !dryRunFlag

  const conn = poolerSessionConnParams()
  const db = createRepairDbDeps(conn)
  const result = await runRepair(db, {
    apply,
    batchSize: parseBatchSizeArg(process.argv),
    logPath: parseLogPathArg(process.argv),
  })
  // Code-review finding, MEDIUM: a run with one or more failed batches must
  // not exit 0 -- a caller piping this into automation, or just checking
  // `$?` after a long unattended run, needs to be able to tell "some rows
  // were not repaired" from "everything succeeded" without parsing stdout.
  if (result.errors.length > 0) {
    process.exitCode = 1
  }
}

// Run only when invoked directly (not when imported by the test suite).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
