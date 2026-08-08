/**
 * default_branch resolution pass for smi5879-census.ts (design doc 8.3.5.2.2)
 * @module scripts/indexer/smi5879-census.branches
 *
 * `skills` carries no `branch`/`default_branch` column, so every existing
 * consumer falls back to `parsed.ref ?? 'main'` — silently 404ing every sibling
 * fetch on a repo whose default branch is not `main`, which reads as a
 * confirmed-clean bundle. This module resolves the default branch once per
 * distinct `(owner, repo)` in the generation's population, via
 * `GET /repos/{owner}/{repo}`, and records the outcome — including failures —
 * into `smi5879_repo_branch`.
 *
 * Runs ONLY for a `rehearsal`/`decision` generation. A `window` generation
 * performs no GitHub I/O at all (8.3.5.2.2) — its `smi5879_repo_branch` stays
 * empty and its `branch_digest` is the empty-population digest, which is
 * correct rather than a gap.
 *
 * JUDGMENT CALL (flagged per task instructions): the design doc's
 * `smi5879_repo_branch.resolution` vocabulary includes `'unparseable' => repo_url
 * did not yield an (owner, repo) at all`, but `owner`/`repo` are NOT NULL primary-key
 * columns on that table — there is no key to insert an 'unparseable' row under
 * when derivation genuinely fails. This module therefore never emits an
 * 'unparseable' row: a `repo_url` that {@link parseSkillMdUrl} cannot derive an
 * `(owner, repo)` from is excluded from the "distinct repos to resolve" set
 * entirely (it is a row-level unfetchable condition per 8.5 G-1's own
 * independent listing of that case, not a `smi5879_repo_branch` row), and its
 * count is tracked separately in {@link BranchResolutionSummary.unparseable} for
 * report visibility. The `unparseable` CHECK value stays in the migration for
 * forward compatibility even though this implementation never writes it.
 */

import { withRateLimitTracking, createTokenBucket, pMapBounded } from './_shared/rate-limit.ts'
import type { RateLimitTelemetry } from './_shared/rate-limit.ts'
import { parseSkillMdUrl } from './_shared/skill-md-fetch.ts'
import { queryRows, runPsql, nullable, type PgConnParams } from './smi5879-census.pg.ts'
import type {
  BranchResolutionOutcome,
  BranchResolutionSummary,
  DistinctRepo,
} from './smi5879-census.types.ts'

/** Conservative sustained rate for the repo-metadata GET pass — well under the PAT's 5,000/h ceiling. */
const REPO_RESOLUTION_RATE_PER_SEC = 1
const REPO_RESOLUTION_BURST = 3
/** Bounded concurrency for the resolution pass (matches revalidate-stale-quarantines.ts's polite BATCH). */
const RESOLUTION_CONCURRENCY = 5
const MAX_RETRIES = 3

interface ResolutionOutcome {
  repo: DistinctRepo
  resolution: BranchResolutionOutcome
  defaultBranch: string | null
  httpStatus: number | null
  attempts: number
}

/** Query the just-loaded population's distinct repo_urls and derive `(owner, repo)` pairs. */
export async function distinctRepos(
  conn: PgConnParams,
  runId: string
): Promise<{ repos: DistinctRepo[]; unparseableCount: number }> {
  const rows = await queryRows(
    conn,
    `SELECT DISTINCT repo_url FROM smi5879_snapshot_pre WHERE run_id = :'run_id' AND repo_url IS NOT NULL`,
    { run_id: runId }
  )
  const seen = new Map<string, DistinctRepo>()
  let unparseableCount = 0
  for (const [rawUrl] of rows) {
    const url = nullable(rawUrl)
    if (url === null) continue
    const parsed = parseSkillMdUrl(url, null)
    if (!parsed) {
      unparseableCount++
      continue
    }
    seen.set(`${parsed.owner}/${parsed.repo}`, { owner: parsed.owner, repo: parsed.repo })
  }
  return { repos: [...seen.values()], unparseableCount }
}

/** Resolve one repo's default branch, with bounded retry on 403/429/5xx/network. */
async function resolveOne(
  repo: DistinctRepo,
  headers: Record<string, string>,
  telemetry: RateLimitTelemetry,
  bucket: ReturnType<typeof createTokenBucket>
): Promise<ResolutionOutcome> {
  let attempts = 0
  let lastStatus: number | null = null
  while (attempts < MAX_RETRIES) {
    attempts++
    await bucket.acquire()
    try {
      const response = await withRateLimitTracking(
        telemetry,
        `https://api.github.com/repos/${repo.owner}/${repo.repo}`,
        { headers, _throwOnRateLimit: false }
      )
      lastStatus = response.status
      if (response.status === 404) {
        return { repo, resolution: 'not-found', defaultBranch: null, httpStatus: 404, attempts }
      }
      if (response.status === 403 || response.status === 429) {
        // Honor retry-after if present; otherwise a short fixed backoff.
        const retryAfter = Number(response.headers.get('retry-after') ?? '0')
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000
        await new Promise((r) => setTimeout(r, waitMs))
        continue
      }
      if (response.status >= 500) {
        await new Promise((r) => setTimeout(r, 500 * attempts))
        continue
      }
      if (response.ok) {
        const body = (await response.json().catch(() => null)) as {
          default_branch?: unknown
        } | null
        const defaultBranch = typeof body?.default_branch === 'string' ? body.default_branch : null
        if (defaultBranch) {
          return {
            repo,
            resolution: 'resolved',
            defaultBranch,
            httpStatus: response.status,
            attempts,
          }
        }
        // 200 with no usable default_branch is a shape we've never seen from GitHub
        // in practice — treat as transient (never fabricate a false 'resolved').
        return {
          repo,
          resolution: 'transient',
          defaultBranch: null,
          httpStatus: response.status,
          attempts,
        }
      }
      // Unclassified status — safe default is transient, never a false not-found.
      return {
        repo,
        resolution: 'transient',
        defaultBranch: null,
        httpStatus: response.status,
        attempts,
      }
    } catch {
      // Network error — retry within budget, then transient.
      await new Promise((r) => setTimeout(r, 500 * attempts))
      continue
    }
  }
  return { repo, resolution: 'transient', defaultBranch: null, httpStatus: lastStatus, attempts }
}

/**
 * Insert one resolution outcome into `smi5879_repo_branch` (one psql call per
 * repo — durable progress). `default_branch`/`http_status` are nullable columns;
 * psql's `-v`/`:'var'` substitution can only produce a quoted string literal,
 * never a bare SQL `NULL`, so both are passed through as an empty-string
 * sentinel and converted with `NULLIF(..., '')` — a real git branch name and a
 * real HTTP status are never the empty string, so this is unambiguous. Passing
 * the sentinel straight through (an earlier version of this function did) fails
 * the `smi5879_repo_branch_resolved_has_branch` CHECK constraint for every
 * non-'resolved' outcome, since `''` is NOT NULL.
 */
async function writeOutcome(
  conn: PgConnParams,
  runId: string,
  o: ResolutionOutcome
): Promise<void> {
  await runPsql(
    conn,
    `INSERT INTO smi5879_repo_branch (run_id, owner, repo, default_branch, resolution, http_status, attempts)
     VALUES (
       :'run_id', :'owner', :'repo',
       NULLIF(:'default_branch', ''),
       :'resolution',
       NULLIF(:'http_status', '')::integer,
       :'attempts'
     );`,
    {
      run_id: runId,
      owner: o.repo.owner,
      repo: o.repo.repo,
      default_branch: o.defaultBranch ?? '',
      resolution: o.resolution,
      http_status: o.httpStatus === null ? '' : String(o.httpStatus),
      attempts: String(o.attempts),
    }
  )
}

/**
 * Run the full default_branch resolution pass for `runId`'s just-loaded
 * population and write every outcome to `smi5879_repo_branch`. Idempotent per
 * repo is NOT guaranteed across re-invocation within the same generation — the
 * table's PK is `(run_id, owner, repo)`, so calling this twice for the same
 * generation will fail on the second repo's duplicate-key INSERT. Callers run
 * this exactly once per generation, immediately after the population load.
 */
export async function resolveDefaultBranches(
  conn: PgConnParams,
  runId: string,
  headers: Record<string, string>,
  telemetry: RateLimitTelemetry
): Promise<BranchResolutionSummary> {
  const { repos, unparseableCount } = await distinctRepos(conn, runId)
  const bucket = createTokenBucket(REPO_RESOLUTION_RATE_PER_SEC, REPO_RESOLUTION_BURST)

  const outcomes = await pMapBounded(
    repos,
    (repo) => resolveOne(repo, headers, telemetry, bucket),
    { concurrency: RESOLUTION_CONCURRENCY }
  )

  for (const outcome of outcomes) {
    await writeOutcome(conn, runId, outcome)
  }

  const summary: BranchResolutionSummary = {
    distinct_repos: repos.length,
    resolved: outcomes.filter((o) => o.resolution === 'resolved').length,
    not_found: outcomes.filter((o) => o.resolution === 'not-found').length,
    transient: outcomes.filter((o) => o.resolution === 'transient').length,
    unparseable: unparseableCount,
  }
  return summary
}
