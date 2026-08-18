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
 */

import { runPsql, type PgConnParams } from './smi5879-census.pg.ts'
import type { BranchResolutionOutcome, ResolutionOutcome } from './smi5879-census.types.ts'

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
 * Build the batched INSERT for a fresh set of outcomes (main pass). JSON
 * `null` for `default_branch`/`http_status` maps straight to SQL NULL via
 * `json_to_recordset`'s column typing — no NULLIF empty-string sentinel
 * needed (the old one-repo-at-a-time `writeOutcome` needed it only because
 * psql's `-v`/`:'var'` substitution cannot produce a bare SQL NULL; this
 * batched form never goes through that substitution for the payload).
 */
export function buildBatchInsertSql(
  runId: string,
  outcomes: readonly ResolutionOutcome[]
): { sql: string; vars: Record<string, string> } {
  const literal = jsonRecordsetLiteral(outcomes)
  const sql = `
    INSERT INTO smi5879_repo_branch (run_id, owner, repo, default_branch, resolution, http_status, attempts)
    SELECT :'run_id', owner, repo, default_branch, resolution, http_status, attempts
    FROM json_to_recordset(${literal}::json) AS x(${RECORDSET_COLUMNS});
  `
  return { sql, vars: { run_id: runId } }
}

/** Build the batched UPDATE for a re-resolution sweep pass — `attempts` accumulates onto the existing row. */
export function buildBatchUpdateSql(
  runId: string,
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
     WHERE b.run_id = :'run_id' AND b.owner = x.owner AND b.repo = x.repo;
  `
  return { sql, vars: { run_id: runId } }
}

export async function writeOutcomesBatch(
  conn: PgConnParams,
  runId: string,
  outcomes: readonly ResolutionOutcome[]
): Promise<void> {
  if (outcomes.length === 0) return
  const { sql, vars } = buildBatchInsertSql(runId, outcomes)
  await runPsql(conn, sql, vars)
}

export async function updateOutcomesBatch(
  conn: PgConnParams,
  runId: string,
  outcomes: readonly ResolutionOutcome[]
): Promise<void> {
  if (outcomes.length === 0) return
  const { sql, vars } = buildBatchUpdateSql(runId, outcomes)
  await runPsql(conn, sql, vars)
}
