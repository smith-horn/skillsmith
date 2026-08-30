/**
 * Batched-write / SQL-builder machinery for `smi5879-census.branches.ts`'s
 * `smi5879_repo_branch` writes (SMI-6015 post-merge retro, 2026-08-18).
 * @module scripts/indexer/smi5879-census.branches.writes
 *
 * Split out of `smi5879-census.branches.helpers.ts` to stay under CLAUDE.md's
 * <500-line-per-file budget once this file's own SMI-6015 post-merge retro
 * (spawn-error retry + 401-retry attempts-accounting fixes) pushed it over —
 * see that file's own header for the original SMI-6015 incident this whole
 * module family exists to fix. This file has no logical boundary change of
 * its own: it's the same `json_to_recordset`-based batched-write machinery
 * `smi5879-census.branches.helpers.ts` originally carried, moved wholesale.
 *
 * TOKEN FENCING (SMI-5879 checkpoint/resume, cross-model review finding —
 * High): before `--resume` existed, "I successfully claimed at the START of
 * this run" was a safe assumption for the run's entire duration — nothing
 * else could ever contend for the SAME run_id. `--resume` breaks that: once
 * a heartbeat goes stale past the takeover threshold, a resumer can claim a
 * NEW token while the ORIGINAL holder's connectivity recovers and it resumes
 * writing — with a `smi5879_snapshot_guard()` trigger that checks generation
 * `status`, never `runner_token`. Both writers could then land concurrently.
 * Every batch write here is now fenced: `WHERE`/`AND EXISTS (SELECT 1 FROM
 * smi5879_run WHERE run_id=... AND status='open' AND runner_token=... FOR
 * UPDATE)` — the SAME row-locking mechanism `smi5879_snapshot_guard()`
 * already uses, extended to also gate on the token, evaluated ATOMICALLY as
 * part of the write statement itself (verified live: a token mismatch
 * silently drops every candidate row from the batch, never errors — so the
 * caller must check the RETURNING row count against the expected batch size
 * and treat a shortfall as an immediate, loud claim-loss signal, never a
 * silent partial write). No new migration — the fence is inline WHERE-clause
 * text, not a new SQL function.
 */

import { queryRows, type PgConnParams } from './smi5879-census.pg.ts'
import type { BranchResolutionOutcome, ResolutionOutcome } from './smi5879-census.types.ts'

/** The fencing guard shared by every write below: this run's claim must still be live. */
const CLAIM_FENCE = `
  SELECT 1 FROM smi5879_run r
   WHERE r.run_id = :'run_id' AND r.status = 'open' AND r.runner_token = :'token'
   FOR UPDATE
`

interface RecordsetRow {
  owner: string
  repo: string
  default_branch: string | null
  resolution: BranchResolutionOutcome
  http_status: number | null
  attempts: number
}

/**
 * Pick a `$tag$...$tag$` dollar-quote delimiter guaranteed not to occur
 * inside `payload` — collision-checked, not merely assumed unlikely. The SQL
 * text (including this literal) is piped to `psql` via STDIN
 * (`smi5879-census.pg.ts`'s `spawnPsql` writes `sql` to `child.stdin`), so
 * there is no `-v`/argv size limit to worry about for a large batch, unlike
 * the old NULLIF-sentinel `-v` substitution this replaces.
 */
function pickDollarQuoteTag(payload: string): string {
  let tag = '$smi5879b$'
  let n = 0
  while (payload.includes(tag)) {
    n++
    tag = `$smi5879b${n}$`
  }
  return tag
}

function toRecordsetRow(o: ResolutionOutcome): RecordsetRow {
  return {
    owner: o.repo.owner,
    repo: o.repo.repo,
    default_branch: o.defaultBranch,
    resolution: o.resolution,
    http_status: o.httpStatus,
    attempts: o.attempts,
  }
}

function jsonRecordsetLiteral(outcomes: readonly ResolutionOutcome[]): string {
  const json = JSON.stringify(outcomes.map(toRecordsetRow))
  const tag = pickDollarQuoteTag(json)
  return `${tag}${json}${tag}`
}

const RECORDSET_COLUMNS =
  'owner text, repo text, default_branch text, resolution text, http_status integer, attempts integer'

/**
 * Build the fenced batched INSERT for a fresh set of outcomes (main pass).
 * JSON `null` for `default_branch`/`http_status` maps straight to SQL NULL
 * via `json_to_recordset`'s column typing — no NULLIF empty-string sentinel
 * needed (the old one-repo-at-a-time `writeOutcome` needed it only because
 * psql's `-v`/`:'var'` substitution cannot produce a bare SQL NULL; this
 * batched form never goes through that substitution for the payload).
 * `RETURNING owner` lets the caller verify every row in the batch actually
 * landed (a token mismatch silently drops ALL of them, per {@link CLAIM_FENCE}).
 */
export function buildBatchInsertSql(
  runId: string,
  token: string,
  outcomes: readonly ResolutionOutcome[]
): { sql: string; vars: Record<string, string> } {
  const literal = jsonRecordsetLiteral(outcomes)
  const sql = `
    INSERT INTO smi5879_repo_branch (run_id, owner, repo, default_branch, resolution, http_status, attempts)
    SELECT :'run_id', owner, repo, default_branch, resolution, http_status, attempts
    FROM json_to_recordset(${literal}::json) AS x(${RECORDSET_COLUMNS})
    WHERE EXISTS (${CLAIM_FENCE})
    RETURNING owner, repo;
  `
  return { sql, vars: { run_id: runId, token } }
}

/**
 * Build the fenced batched UPDATE for a re-resolution sweep pass —
 * `attempts` accumulates onto the existing row. `RETURNING b.owner` for the
 * same claim-loss verification as the INSERT above.
 */
export function buildBatchUpdateSql(
  runId: string,
  token: string,
  outcomes: readonly ResolutionOutcome[]
): { sql: string; vars: Record<string, string> } {
  const literal = jsonRecordsetLiteral(outcomes)
  const sql = `
    UPDATE smi5879_repo_branch b
       SET default_branch = x.default_branch,
           resolution     = x.resolution,
           http_status    = x.http_status,
           attempts       = b.attempts + x.attempts,
           resolved_at    = now()
      FROM json_to_recordset(${literal}::json) AS x(${RECORDSET_COLUMNS})
     WHERE b.run_id = :'run_id' AND b.owner = x.owner AND b.repo = x.repo
       AND EXISTS (${CLAIM_FENCE})
     RETURNING b.owner, b.repo;
  `
  return { sql, vars: { run_id: runId, token } }
}

/**
 * Thrown by {@link writeOutcomesBatch}/{@link updateOutcomesBatch} when the
 * write's row count didn't match what was expected.
 *
 * SMI-5879 cross-model review round-4 finding (Low): the fence
 * ({@link CLAIM_FENCE}) is all-or-nothing by construction — a token
 * mismatch/non-open generation zeroes out the ENTIRE batch, never a
 * partial one. `actual === 0` is therefore the ONLY shape the fence itself
 * can produce; a PARTIAL shortfall (`0 < actual < expected`) is proof the
 * fence did NOT reject this write — it indicates a caller/data bug (e.g. a
 * duplicate or a missing target row for the UPDATE case) instead, which
 * needs different operator guidance than "your claim was stolen."
 */
export class ClaimFencedWriteError extends Error {
  constructor(op: 'INSERT' | 'UPDATE', runId: string, expected: number, actual: number) {
    const isFenceShape = actual === 0
    super(
      isFenceShape
        ? `SMI-5879: ${op} into smi5879_repo_branch for run_id=${runId} wrote 0/${expected} rows ` +
            "— the claim fence rejected the ENTIRE batch (it's all-or-nothing: this run no longer " +
            'holds a live claim — token mismatch, or the generation is no longer open). Stop ' +
            'writing immediately, do not retry with the same token.'
        : `SMI-5879: ${op} into smi5879_repo_branch for run_id=${runId} wrote ${actual}/${expected} ` +
            'rows — a PARTIAL shortfall, which the claim fence (all-or-nothing) cannot produce. ' +
            'This indicates a caller/data bug (e.g. a duplicate or missing target row), NOT a lost ' +
            'claim — investigate before retrying; do not treat this as claim loss.'
    )
    this.name = 'ClaimFencedWriteError'
  }
}

export async function writeOutcomesBatch(
  conn: PgConnParams,
  runId: string,
  token: string,
  outcomes: readonly ResolutionOutcome[]
): Promise<void> {
  if (outcomes.length === 0) return
  const { sql, vars } = buildBatchInsertSql(runId, token, outcomes)
  const rows = await queryRows(conn, sql, vars)
  if (rows.length !== outcomes.length) {
    throw new ClaimFencedWriteError('INSERT', runId, outcomes.length, rows.length)
  }
}

export async function updateOutcomesBatch(
  conn: PgConnParams,
  runId: string,
  token: string,
  outcomes: readonly ResolutionOutcome[]
): Promise<void> {
  if (outcomes.length === 0) return
  const { sql, vars } = buildBatchUpdateSql(runId, token, outcomes)
  const rows = await queryRows(conn, sql, vars)
  if (rows.length !== outcomes.length) {
    throw new ClaimFencedWriteError('UPDATE', runId, outcomes.length, rows.length)
  }
}
