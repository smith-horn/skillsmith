/**
 * I-1..I-5 partition invariants for smi5879-census.ts (design doc 8.3.1.4 / 8.3.5.2.6)
 * @module scripts/indexer/smi5879-census.invariants
 *
 * All five are fail-closed preconditions run by the census tool immediately after
 * sealing a generation. I-1/I-2/I-3 are query-level checks against
 * `v_smi5879_census_cohort` (8.3.1.4), scoped `WHERE run_id = :run_id`. I-4/I-5 are
 * new in 8.3.5.2.6. None of the five are SQL objects the migration creates — per
 * the design doc's own text, they are invariant CHECK QUERIES, and this module is
 * where they live.
 *
 * I-5 (branch coverage) reuses `parseSkillMdUrl` — the SAME owner/repo derivation
 * `smi5879-census.branches.ts` uses to decide which repos to resolve — rather than
 * reimplementing a second regex that could silently drift from it.
 */

import { queryRows, queryScalar, nullable, type PgConnParams } from './smi5879-census.pg.ts'
import { parseSkillMdUrl } from './_shared/skill-md-fetch.ts'
import type { InvariantResult } from './smi5879-census.types.ts'

/** I-1 totality — `count(*) FILTER (WHERE cohort IS NULL)` must be 0. */
export async function checkI1Totality(conn: PgConnParams, runId: string): Promise<InvariantResult> {
  const raw = await queryScalar(
    conn,
    `SELECT count(*) FILTER (WHERE cohort IS NULL) FROM v_smi5879_census_cohort WHERE run_id = :'run_id'`,
    { run_id: runId }
  )
  const n = Number(raw ?? '0')
  return {
    id: 'I-1',
    name: 'totality',
    passed: n === 0,
    detail:
      n === 0
        ? 'every row has a non-NULL cohort'
        : `${n} row(s) have a NULL cohort — the CASE expression's ELSE branch was likely replaced with a conditional`,
  }
}

/** I-2 disjointness — no `id` may appear under more than one cohort row. */
export async function checkI2Disjointness(
  conn: PgConnParams,
  runId: string
): Promise<InvariantResult> {
  const raw = await queryScalar(
    conn,
    `SELECT count(*) FROM (
       SELECT id FROM v_smi5879_census_cohort WHERE run_id = :'run_id' GROUP BY id HAVING count(*) > 1
     ) t`,
    { run_id: runId }
  )
  const n = Number(raw ?? '0')
  return {
    id: 'I-2',
    name: 'disjointness',
    passed: n === 0,
    detail:
      n === 0
        ? 'no id appears in more than one cohort'
        : `${n} id(s) appear in more than one cohort — the view was likely refactored into a UNION of overlapping per-cohort SELECTs`,
  }
}

/** I-3 completeness — the cohort partition must exactly cover the snapshotted population. */
export async function checkI3Completeness(
  conn: PgConnParams,
  runId: string
): Promise<InvariantResult> {
  const totalRaw = await queryScalar(
    conn,
    `SELECT count(*) FROM smi5879_snapshot_pre WHERE run_id = :'run_id'`,
    { run_id: runId }
  )
  const partitionedRaw = await queryScalar(
    conn,
    `SELECT COALESCE(sum(n), 0) FROM (
       SELECT count(*) AS n FROM v_smi5879_census_cohort WHERE run_id = :'run_id' GROUP BY cohort
     ) t`,
    { run_id: runId }
  )
  const total = Number(totalRaw ?? '0')
  const partitioned = Number(partitionedRaw ?? '0')
  return {
    id: 'I-3',
    name: 'completeness',
    passed: total === partitioned,
    detail:
      total === partitioned
        ? `snapshot (${total}) exactly equals C1∪C2∪C3∪C4∪E (${partitioned})`
        : `snapshot has ${total} row(s) but the cohort partition sums to ${partitioned} — the view is reading a different population than smi5879_snapshot_pre`,
  }
}

/** I-4 single-instant — the whole generation must have been loaded under one `REPEATABLE READ` instant. */
export async function checkI4SingleInstant(
  conn: PgConnParams,
  runId: string
): Promise<InvariantResult> {
  const raw = await queryScalar(
    conn,
    `SELECT count(DISTINCT snapshot_taken_at) FROM smi5879_snapshot_pre WHERE run_id = :'run_id'`,
    { run_id: runId }
  )
  const n = Number(raw ?? '0')
  // 0 is vacuously fine (an empty population has no instant to conflict); >1 is the failure.
  return {
    id: 'I-4',
    name: 'single-instant',
    passed: n <= 1,
    detail:
      n <= 1
        ? `snapshot_taken_at has ${n} distinct value(s) (single instant)`
        : `snapshot_taken_at has ${n} distinct values — the population load lost its REPEATABLE READ framing (a smear across the load, not one instant)`,
  }
}

/**
 * I-5 branch coverage — every distinct `(owner, repo)` derivable (via
 * {@link parseSkillMdUrl}) from a FETCHING generation's population must have
 * exactly one `smi5879_repo_branch` row for that `run_id`. Callers must only
 * invoke this for a `rehearsal`/`decision` generation — a `window` generation
 * performs no GitHub I/O and populates no `smi5879_repo_branch` rows at all by
 * design (8.3.5.2.2), so running I-5 against one would always fail vacuously.
 */
export async function checkI5BranchCoverage(
  conn: PgConnParams,
  runId: string
): Promise<InvariantResult> {
  const urlRows = await queryRows(
    conn,
    `SELECT DISTINCT repo_url FROM smi5879_snapshot_pre WHERE run_id = :'run_id' AND repo_url IS NOT NULL`,
    { run_id: runId }
  )
  const derived = new Set<string>()
  for (const [rawUrl] of urlRows) {
    const url = nullable(rawUrl)
    if (url === null) continue
    const parsed = parseSkillMdUrl(url, null)
    if (parsed) derived.add(`${parsed.owner}/${parsed.repo}`)
  }

  const branchRows = await queryRows(
    conn,
    `SELECT owner, repo FROM smi5879_repo_branch WHERE run_id = :'run_id'`,
    { run_id: runId }
  )
  const covered = new Set(branchRows.map(([owner, repo]) => `${owner}/${repo}`))

  const missing = [...derived].filter((pair) => !covered.has(pair))
  return {
    id: 'I-5',
    name: 'branch coverage',
    passed: missing.length === 0,
    detail:
      missing.length === 0
        ? `all ${derived.size} distinct repo(s) have a branch-resolution row`
        : `${missing.length} distinct repo(s) have NO smi5879_repo_branch row (would silently fall back to 'main'): ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ', ...' : ''}`,
  }
}

/**
 * I-6 branch-resolution quality (SMI-6015) — zero-tolerance for a `transient`
 * `smi5879_repo_branch.resolution` row at seal time, for the same reason I-5
 * is scoped to a fetching generation: only `rehearsal`/`decision`
 * generations populate `smi5879_repo_branch` at all.
 *
 * Zero-tolerance (any count > 0 fails), matching the zero-tolerance posture
 * already established for G-1 ("every row in R has a recorded disposition")
 * and — the more directly analogous downstream gate — G-2 ("zero rows in
 * C1-C4 report the `unevaluable` outcome"), rather than inventing a
 * percentage threshold here. The rationale: every `transient`
 * `smi5879_repo_branch` row resolves to `unevaluable` in the simulator
 * (`smi5879-simulate-full.helpers.ts`'s `processRow`), which G-2
 * zero-tolerates — so a census sealed with ANY transient row is already
 * guaranteed to fail G-2 after a potentially multi-day simulate-full run.
 * Catching it here, at the census's own invariant layer, immediately after
 * sealing (matching I-1..I-5's own timing — see this module's header),
 * makes that guaranteed-downstream-failure diagnosable in minutes instead of
 * days. `smi5879-census.ts`'s `runCensus()` already runs a bounded
 * re-resolution sweep (`sweepTransientRepos`) over transient rows before
 * seal specifically to minimize how often this actually fires — but this
 * check does not depend on that sweep having run; it only verifies the
 * state that is actually in `smi5879_repo_branch` at invariant-check time.
 */
export async function checkI6BranchResolutionQuality(
  conn: PgConnParams,
  runId: string
): Promise<InvariantResult> {
  const raw = await queryScalar(
    conn,
    `SELECT count(*) FROM smi5879_repo_branch WHERE run_id = :'run_id' AND resolution = 'transient'`,
    { run_id: runId }
  )
  const n = Number(raw ?? '0')
  return {
    id: 'I-6',
    name: 'branch-resolution quality',
    passed: n === 0,
    detail:
      n === 0
        ? 'zero transient branch-resolution rows'
        : `${n} smi5879_repo_branch row(s) still report resolution='transient' — every one of these ` +
          "would resolve to 'unevaluable' in the simulator, which the G-2 coverage gate " +
          'zero-tolerates; re-run the census or investigate GitHub API/credential health before proceeding',
  }
}

/**
 * Run I-1 through I-6 (I-5/I-6 only for a fetching generation) and return
 * every result. Callers fail closed — any `passed === false` result means the
 * census tool must exit non-zero, naming which invariant failed and why (each
 * result's `detail` is written verbatim into the census report and echoed on
 * stderr).
 */
export async function runInvariantChecks(
  conn: PgConnParams,
  runId: string,
  isFetchingGeneration: boolean
): Promise<InvariantResult[]> {
  const results: InvariantResult[] = [
    await checkI1Totality(conn, runId),
    await checkI2Disjointness(conn, runId),
    await checkI3Completeness(conn, runId),
    await checkI4SingleInstant(conn, runId),
  ]
  if (isFetchingGeneration) {
    results.push(await checkI5BranchCoverage(conn, runId))
    results.push(await checkI6BranchResolutionQuality(conn, runId))
  }
  return results
}
