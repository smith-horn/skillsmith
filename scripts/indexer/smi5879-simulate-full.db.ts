/**
 * Production `Smi5879SimulateFullDbDeps` implementation for smi5879-simulate-full.ts.
 * @module scripts/indexer/smi5879-simulate-full.db
 *
 * Thin wrapper over item 1's `smi5879-census.pg.ts` psql helper plus the SQL
 * functions item 1's migration already ships (`smi5879_claim_run`,
 * `smi5879_heartbeat`, `smi5879_release_run`, `smi5879_population_digest`,
 * `smi5879_branch_digest`). No new SQL objects are created here.
 *
 * SMI-6294: `heartbeat()`/`heartbeatShard()` below opt into
 * `{ timeoutMs: HEARTBEAT_QUERY_TIMEOUT_MS, treatAmbiguousLossAsRetryable:
 * true }` — the identical hang-risk fix applied to `smi5879-census.ts`'s own
 * heartbeat call site, since both share the exact same
 * `smi5879_heartbeat`/`smi5879_heartbeat_shard` pattern via `queryScalar` and
 * this is the tool that runs the real 3-shard production dispatch. A prior
 * version of this header's "never modified — item 1 is merged and out of
 * scope" line described item 3's OWN original wave scoping (never touch
 * item 1's file), not a standing prohibition on `smi5879-census.pg.ts` ever
 * being extended — this file now also imports the SMI-6294 timeout constant.
 */

import {
  queryRows,
  queryScalar,
  nullable,
  runPsql,
  type PgConnParams,
} from './smi5879-census.pg.ts'
import { HEARTBEAT_QUERY_TIMEOUT_MS } from './smi5879-census.heartbeat.ts'
import type {
  BranchMap,
  RepoBranchInfo,
  SimSnapshotRow,
  SimulatedCohort,
  Smi5879SimulateFullDbDeps,
} from './smi5879-simulate-full.types.ts'
import type { Smi5879Purpose, Smi5879RunStatus } from './smi5879-census.types.ts'

/**
 * Assert a raw `queryRows` cell is present. `tsconfig.base.json`'s
 * `noUncheckedIndexedAccess` types every destructured cell as `string | undefined`
 * even though a `queryRows` result row always has as many cells as the `SELECT`'s
 * column list — a genuinely missing cell here means the query's column count has
 * drifted from what this function destructures, which is a real bug worth
 * throwing on rather than silently letting `undefined` flow into code that
 * expects a definite `string`.
 */
function requireCell(value: string | undefined, column: string): string {
  if (value === undefined) {
    throw new Error(`SMI-5879: missing '${column}' cell in query result row — column count drift?`)
  }
  return value
}

/** Build the real, psql-backed dependency set for a given connection. */
export function createSmi5879SimulateFullDbDeps(conn: PgConnParams): Smi5879SimulateFullDbDeps {
  return {
    async getRunSummary(runId) {
      const rows = await queryRows(
        conn,
        `SELECT purpose, status FROM smi5879_run WHERE run_id = :'run_id'`,
        { run_id: runId }
      )
      const row = rows[0]
      if (!row) return null
      const [purposeRaw, statusRaw] = row
      return {
        purpose: requireCell(purposeRaw, 'purpose') as Smi5879Purpose,
        status: requireCell(statusRaw, 'status') as Smi5879RunStatus,
      }
    },

    async claimRun(runId, token, holder) {
      const rows = await queryRows(
        conn,
        `SELECT run_id FROM smi5879_claim_run(:'run_id', :'token', :'holder');`,
        { run_id: runId, token, holder }
      )
      return { claimed: rows.length > 0 }
    },

    async heartbeat(runId, token) {
      // queryScalar already resolves the SQL NULL sentinel to `null` — a bare
      // `SELECT smi5879_heartbeat(...)` returns exactly one scalar row.
      // SMI-6294: timeoutMs + treatAmbiguousLossAsRetryable — see module header.
      return queryScalar(
        conn,
        `SELECT smi5879_heartbeat(:'run_id', :'token');`,
        { run_id: runId, token },
        { timeoutMs: HEARTBEAT_QUERY_TIMEOUT_MS, treatAmbiguousLossAsRetryable: true }
      )
    },

    async releaseRun(runId, token) {
      await runPsql(conn, `SELECT smi5879_release_run(:'run_id', :'token');`, {
        run_id: runId,
        token,
      })
    },

    // SMI-6015 Wave 1: shard-aware siblings, backed by the Wave 0 migration's
    // smi5879_claim_run_shard/smi5879_heartbeat_shard/smi5879_release_run_shard.
    // shardIndex/shardCount are INTEGER SQL params — psql's `-v` mechanism
    // only carries strings, so each is cast `::integer` after quoting,
    // matching the pattern the Wave 0 migration's own test suite uses.
    async claimRunShard(runId, shardIndex, shardCount, token, holder) {
      const rows = await queryRows(
        conn,
        `SELECT run_id FROM smi5879_claim_run_shard(:'run_id', :'shard_index'::integer, :'shard_count'::integer, :'token', :'holder');`,
        {
          run_id: runId,
          shard_index: String(shardIndex),
          shard_count: String(shardCount),
          token,
          holder,
        }
      )
      return { claimed: rows.length > 0 }
    },

    async heartbeatShard(runId, shardIndex, token) {
      // SMI-6294: timeoutMs + treatAmbiguousLossAsRetryable — see module header.
      return queryScalar(
        conn,
        `SELECT smi5879_heartbeat_shard(:'run_id', :'shard_index'::integer, :'token');`,
        { run_id: runId, shard_index: String(shardIndex), token },
        { timeoutMs: HEARTBEAT_QUERY_TIMEOUT_MS, treatAmbiguousLossAsRetryable: true }
      )
    },

    async releaseRunShard(runId, shardIndex, token) {
      await runPsql(
        conn,
        `SELECT smi5879_release_run_shard(:'run_id', :'shard_index'::integer, :'token');`,
        { run_id: runId, shard_index: String(shardIndex), token }
      )
    },

    async verifyDigest(runId) {
      const rows = await queryRows(
        conn,
        `SELECT
           (population_digest = smi5879_population_digest(:'run_id')),
           (branch_digest     = smi5879_branch_digest(:'run_id'))
         FROM smi5879_run WHERE run_id = :'run_id';`,
        { run_id: runId }
      )
      const row = rows[0]
      if (!row) {
        throw new Error(`SMI-5879: no smi5879_run row for run_id=${runId} — cannot verify digest.`)
      }
      const [populationMatchesRaw, branchMatchesRaw] = row
      return {
        populationMatches: requireCell(populationMatchesRaw, 'population_matches') === 't',
        branchMatches: requireCell(branchMatchesRaw, 'branch_matches') === 't',
      }
    },

    async loadCohortRows(runId) {
      const rows = await queryRows(
        conn,
        `SELECT c.cohort, s.id, s.repo_url, s.skill_path, s.author, s.name,
                s.content_hash, s.security_score, s.quarantined
           FROM v_smi5879_census_cohort c
           JOIN smi5879_snapshot_pre s ON s.run_id = c.run_id AND s.id = c.id
          WHERE c.run_id = :'run_id' AND c.cohort IN ('C1','C2','C3','C4')
          ORDER BY s.id COLLATE "C";`,
        { run_id: runId }
      )
      const out: SimSnapshotRow[] = []
      for (const [
        cohortRaw,
        idRaw,
        repoUrlRaw,
        skillPathRaw,
        authorRaw,
        nameRaw,
        contentHashRaw,
        scoreRaw,
        quarantinedRaw,
      ] of rows) {
        const score = nullable(requireCell(scoreRaw, 'security_score'))
        const quarantined = nullable(requireCell(quarantinedRaw, 'quarantined'))
        out.push({
          id: requireCell(idRaw, 'id'),
          cohort: requireCell(cohortRaw, 'cohort') as SimulatedCohort,
          repo_url: nullable(requireCell(repoUrlRaw, 'repo_url')),
          skill_path: nullable(requireCell(skillPathRaw, 'skill_path')),
          author: nullable(requireCell(authorRaw, 'author')),
          name: nullable(requireCell(nameRaw, 'name')),
          content_hash: nullable(requireCell(contentHashRaw, 'content_hash')),
          snapshot_security_score: score === null ? null : Number(score),
          snapshot_quarantined: quarantined === null ? null : quarantined === 't',
        })
      }
      return out
    },

    async loadBranchMap(runId) {
      const rows = await queryRows(
        conn,
        `SELECT owner, repo, default_branch, resolution FROM smi5879_repo_branch WHERE run_id = :'run_id';`,
        { run_id: runId }
      )
      const map: BranchMap = new Map()
      for (const [ownerRaw, repoRaw, defaultBranchRaw, resolutionRaw] of rows) {
        const owner = requireCell(ownerRaw, 'owner')
        const repo = requireCell(repoRaw, 'repo')
        const info: RepoBranchInfo = {
          resolution: requireCell(resolutionRaw, 'resolution') as RepoBranchInfo['resolution'],
          default_branch: nullable(requireCell(defaultBranchRaw, 'default_branch')),
        }
        map.set(`${owner}/${repo}`, info)
      }
      return map
    },
  }
}
