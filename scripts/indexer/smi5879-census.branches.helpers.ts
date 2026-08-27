/**
 * Per-repo resolution, worker-pool, circuit-breaker, and progress-logging
 * machinery for smi5879-census.branches.ts's default_branch resolution pass
 * (SMI-6015). Batched-write / SQL-builder machinery lives in the sibling
 * ./smi5879-census.branches.writes.ts (split out 2026-08-18, this file's own
 * post-merge retro, to stay under the 500-line-per-file budget).
 * @module scripts/indexer/smi5879-census.branches.helpers
 *
 * Split out of smi5879-census.branches.ts to stay under CLAUDE.md's
 * <500-line-per-file budget once Wave 3's first production-scale dry run
 * (SMI-6015) root-caused two bugs in that pass:
 *
 * 1. `resolveOne` was called with a FROZEN headers object built once, ~8h
 *    before the pass finished. GitHub App installation tokens expire after
 *    1h, so every post-expiry call returned 401 — and `resolveOne` had no
 *    branch for 401 specifically, falling through to its "unclassified
 *    status, safe default is transient" catch-all. 25,014 of 28,601 repos
 *    (87.5%) were recorded `transient`, which `smi5879-simulate-full.
 *    helpers.ts` maps to `unevaluable`, which the G-2 gate zero-tolerates —
 *    the generation was structurally guaranteed to fail downstream despite
 *    the census's own I-1..I-5 invariants all reporting PASS (I-5 only
 *    checks that every repo has *a* row, not that resolution succeeded).
 * 2. The write loop spawned one `psql` subprocess per repo, sequentially,
 *    AFTER every repo had already been resolved (a second full pass over the
 *    population) — ~0.66s/spawn x 28,601 = ~5h14m of a ~13h run spent on
 *    writes contributing zero resolution work, with zero visible progress
 *    until the entire pass finished.
 *
 * This module fixes both: `resolveOne` takes a `getHeaders` callback invoked
 * fresh on every retry attempt (not once for the whole pass — see
 * `_shared/github-auth.ts`'s `getInstallationToken()`, which caches and only
 * re-mints near expiry, so this costs ~nil when the token is still fresh);
 * 401 gets one dedicated cache-busted retry and is otherwise fatal, aborting
 * the pass rather than being classified `transient`; writes are batched via
 * `json_to_recordset` (~500 rows/psql spawn) and flushed incrementally as
 * outcomes arrive, not held until the whole pass completes; and a circuit
 * breaker aborts a doomed pass early instead of continuing for hours.
 *
 * SMI-6015 follow-up (2026-08-18): a production run hit a single 401 after
 * ~1h54m and 2,298/30,471 repos resolved, aborted per (1) above exactly as
 * designed — but a live re-check immediately after showed a freshly-minted
 * installation token succeeding cleanly against the SAME repo, with no
 * correlating GitHub-status incident in the window. A lone 401 is therefore
 * not by itself proof of a dead credential. `resolveOne` now gives a 401
 * exactly one retry (`clearTokenCache()` + fresh mint) before treating it as
 * fatal — a second 401 straight after a guaranteed-fresh token remains
 * unambiguous and still aborts the whole pass.
 */

import {
  createTokenBucket,
  withRateLimitTracking,
  runCancellablePool,
  type RateLimitTelemetry,
  type PoolAbortSignal,
  type CancellablePoolResult,
} from './_shared/rate-limit.ts'
import { GitHubAuthError, clearTokenCache } from './_shared/github-auth.ts'
import type { DistinctRepo, ResolutionOutcome } from './smi5879-census.types.ts'

// ---------------------------------------------------------------------------
// Constants (named, per CLAUDE.md — no magic numbers)
// ---------------------------------------------------------------------------

/** Conservative sustained rate for the repo-metadata GET pass — well under the PAT's 5,000/h ceiling. */
export const REPO_RESOLUTION_RATE_PER_SEC = 1
export const REPO_RESOLUTION_BURST = 3
/** Bounded concurrency for the resolution pass (matches revalidate-stale-quarantines.ts's polite BATCH). */
export const RESOLUTION_CONCURRENCY = 5
/** Per-repo retry budget inside `resolveOne` (403/429/5xx/network — separate from the dedicated 401 retry below). */
export const MAX_RETRIES = 3
/** Fixed backoff for a 403/429 that is NOT a primary rate-limit exhaustion (secondary/abuse detection). */
export const SECONDARY_RATE_LIMIT_BACKOFF_MS = 1_000
/** Backoff for a 5xx/network error, multiplied by the attempt number. */
export const SERVER_ERROR_BACKOFF_MS = 500
/**
 * SMI-6015 follow-up (2026-08-18 production incident): a single 401 does not
 * by itself prove a dead credential — observed live, a freshly re-minted
 * installation token succeeded immediately after an in-pass 401 with no
 * correlating GitHub-status incident. Fixed backoff before the ONE dedicated
 * retry `resolveOne` gives a 401 (via `clearTokenCache()` + a fresh mint),
 * independent of the general `attempts` budget above.
 */
export const AUTH_RETRY_BACKOFF_MS = 500
/** Small buffer added past `x-ratelimit-reset` to avoid retrying right on the reset boundary. */
export const PRIMARY_RATE_LIMIT_RESET_BUFFER_MS = 2_000
/** Fallback wait when a primary-rate-limit 403/429 carries no usable `x-ratelimit-reset`. */
export const PRIMARY_RATE_LIMIT_FALLBACK_WAIT_MS = 60_000

/** `smi5879_repo_branch` write batch size — one `json_to_recordset` INSERT/UPDATE per this many outcomes. */
export const WRITE_BATCH_SIZE = 500
/** Emit a progress/telemetry log line every this many completions. */
export const PROGRESS_LOG_INTERVAL = 500
/** Circuit breaker: don't evaluate the transient rate until at least this many repos have been attempted. */
export const CIRCUIT_BREAKER_WARMUP_COUNT = 200
/** Circuit breaker: abort the pass once the running transient rate exceeds this fraction past warm-up. */
export const CIRCUIT_BREAKER_TRANSIENT_RATE_THRESHOLD = 0.5

/** Bounded re-resolution sweep (item 6): at most this many extra passes over still-transient rows. */
export const REEXOLUTION_SWEEP_MAX_PASSES = 3
/** Bounded re-resolution sweep (item 6): hard wall-clock cap, independent of the pass cap. */
export const REEXOLUTION_SWEEP_WALL_CLOCK_BUDGET_MS = 10 * 60 * 1000

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Thrown by `resolveOne` on a SECOND consecutive HTTP 401 — after its one
 * dedicated cache-busted retry also came back 401 — a credential-level
 * failure, not a per-repo condition (GitHub returns 404, not 401, for a repo
 * the token can't see). Propagates through `runResolutionPool` to abort the
 * whole pass; callers must never catch-and-continue this as a `transient`
 * outcome.
 */
export class BranchResolutionAuthError extends GitHubAuthError {
  constructor(
    public readonly repo: DistinctRepo,
    public readonly httpStatus: number
  ) {
    super(
      `SMI-5879/SMI-6015: GitHub returned ${httpStatus} (Unauthorized) resolving default_branch ` +
        `for ${repo.owner}/${repo.repo} — credential-level failure (GitHub returns 404, not 401, ` +
        'for a repo the token cannot see). Aborting the entire branch-resolution pass rather than ' +
        "continuing to record every remaining repo as 'transient' under a dead token."
    )
    this.name = 'BranchResolutionAuthError'
  }
}

/** Thrown when the running transient rate exceeds threshold past warm-up — see `checkCircuitBreaker`. */
export class BranchResolutionCircuitBreakerError extends Error {
  constructor(
    public readonly completedCount: number,
    public readonly transientCount: number,
    public readonly transientRate: number
  ) {
    super(
      `SMI-5879/SMI-6015: branch-resolution circuit breaker tripped after ${completedCount} ` +
        `completions — ${transientCount} (${(transientRate * 100).toFixed(1)}%) came back ` +
        `'transient', exceeding the ${(CIRCUIT_BREAKER_TRANSIENT_RATE_THRESHOLD * 100).toFixed(0)}% ` +
        `threshold past the ${CIRCUIT_BREAKER_WARMUP_COUNT}-completion warm-up. Aborting rather than ` +
        'continuing a pass that is already effectively guaranteed to fail I-6 (and, downstream, G-2).'
    )
    this.name = 'BranchResolutionCircuitBreakerError'
  }
}

// ---------------------------------------------------------------------------
// Per-repo resolution
// ---------------------------------------------------------------------------

/** Wait out a 403/429 — primary (bucket fully drained) vs secondary (abuse detection) rate limit. */
export async function waitOutRateLimit(response: Response): Promise<void> {
  const remainingHeader = response.headers.get('x-ratelimit-remaining')
  if (remainingHeader === '0') {
    // Primary exhaustion: a short fixed backoff cannot possibly succeed
    // before the bucket refills — wait until GitHub's own reset time.
    const resetHeader = Number(response.headers.get('x-ratelimit-reset') ?? '0')
    const resetAtMs =
      Number.isFinite(resetHeader) && resetHeader > 0
        ? resetHeader * 1000
        : Date.now() + PRIMARY_RATE_LIMIT_FALLBACK_WAIT_MS
    const waitMs = Math.max(0, resetAtMs - Date.now()) + PRIMARY_RATE_LIMIT_RESET_BUFFER_MS
    await new Promise((r) => setTimeout(r, waitMs))
    return
  }
  // Secondary rate limit / abuse detection — honor retry-after if present, else a short fixed backoff.
  const retryAfter = Number(response.headers.get('retry-after') ?? '0')
  const waitMs =
    Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : SECONDARY_RATE_LIMIT_BACKOFF_MS
  await new Promise((r) => setTimeout(r, waitMs))
}

/**
 * Resolve one repo's default branch, with bounded retry on 403/429/5xx/network.
 * `getHeaders` is invoked FRESH on every attempt (SMI-6015) — never once for
 * the whole pass — so a token that expires mid-pass is transparently
 * refreshed on the next attempt rather than producing a silent 401 storm.
 *
 * A 401 gets exactly ONE dedicated retry (SMI-6015 follow-up, 2026-08-18)
 * before being treated as fatal: `clearTokenCache()` forces the next
 * `getHeaders()` call to re-mint rather than read a possibly-still-cached
 * token, then the SAME request is retried. This retry is deliberately
 * independent of the general `attempts` loop below — inlined into the 401
 * branch itself, not a `continue` back through the outer `while` — so a 401
 * arriving on the loop's OWN final attempt still gets its one chance rather
 * than silently falling through to this function's "unclassified status,
 * safe default is transient" catch-all, which would misclassify a
 * genuinely-dead credential exactly as `BranchResolutionAuthError` exists to
 * prevent.
 *
 * GPT-5.6-Sol review note: `clearTokenCache()` only produces a genuinely
 * FRESH credential when GitHub App installation-token auth is configured
 * (`_shared/github-auth.ts`'s `getInstallationToken()` shares the same
 * module-singleton cache this clears). Under the static-PAT fallback
 * (`GITHUB_TOKEN`, no App credentials), clearing is a no-op and the retry
 * reuses the identical token — still able to recover from an endpoint-side
 * transient 401, just not from a genuinely revoked/expired PAT. Either way,
 * a SECOND 401 — after either a guaranteed-fresh App token or an identical
 * retried PAT — is unambiguous: continuing to fail with the best credential
 * available (fresh or not) means the pass cannot proceed.
 */
export async function resolveOne(
  repo: DistinctRepo,
  getHeaders: () => Promise<Record<string, string>>,
  telemetry: RateLimitTelemetry,
  bucket: ReturnType<typeof createTokenBucket>
): Promise<ResolutionOutcome> {
  // `attempts` is PURELY the outer loop's own retry-BUDGET counter (gates
  // `while` below) -- it must stay untouched by the 401 branch, or the
  // dedicated 401 retry silently consumes one of the outer loop's own
  // attempts, truncating the general 403/429/5xx retry budget below what
  // this function's own docs promise (GPT-5.6-Sol round-2 review,
  // 2026-08-18: walked a 401 -> 403 -> 5xx sequence that loses its 4th,
  // otherwise-available attempt if the two counters are conflated).
  // `totalRequests` is the separate, purely additive count of real HTTP
  // requests made -- what `ResolutionOutcome.attempts` actually reports
  // downstream, so it DOES include the 401 retry's own request.
  let attempts = 0
  let totalRequests = 0
  let lastStatus: number | null = null
  while (attempts < MAX_RETRIES) {
    attempts++
    await bucket.acquire()
    try {
      const headers = await getHeaders()
      totalRequests++
      let response = await withRateLimitTracking(
        telemetry,
        `https://api.github.com/repos/${repo.owner}/${repo.repo}`,
        { headers, _throwOnRateLimit: false }
      )

      if (response.status === 401) {
        clearTokenCache()
        await new Promise((r) => setTimeout(r, AUTH_RETRY_BACKOFF_MS))
        await bucket.acquire()
        totalRequests++
        const retryHeaders = await getHeaders()
        response = await withRateLimitTracking(
          telemetry,
          `https://api.github.com/repos/${repo.owner}/${repo.repo}`,
          { headers: retryHeaders, _throwOnRateLimit: false }
        )
        if (response.status === 401) {
          throw new BranchResolutionAuthError(repo, response.status)
        }
      }
      lastStatus = response.status

      if (response.status === 404) {
        return {
          repo,
          resolution: 'not-found',
          defaultBranch: null,
          httpStatus: 404,
          attempts: totalRequests,
        }
      }
      // 451 ("Unavailable For Legal Reasons") is GitHub's own status for a
      // repo blocked by a DMCA/legal takedown -- a permanent state, not a
      // transient one. Retrying never resolves it (confirmed live, SMI-6015
      // Wave 3 rehearsal, 2026-08-27: dzcmemory-web/bazi-ziwei-skill returned
      // 451 across both its attempts and again on a fresh census run,
      // repeatedly refusing I-6's seal check). Classified as `not-found`
      // (same terminal bucket as 404) rather than falling into the generic
      // "unclassified status" catch-all below, which defaults to `transient`
      // and would keep this repo permanently `unevaluable` -- exactly the
      // outcome G-2's coverage gate zero-tolerates.
      if (response.status === 451) {
        return {
          repo,
          resolution: 'not-found',
          defaultBranch: null,
          httpStatus: 451,
          attempts: totalRequests,
        }
      }
      if (response.status === 403 || response.status === 429) {
        await waitOutRateLimit(response)
        continue
      }
      if (response.status >= 500) {
        await new Promise((r) => setTimeout(r, SERVER_ERROR_BACKOFF_MS * attempts))
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
            attempts: totalRequests,
          }
        }
        // 200 with no usable default_branch is a shape we've never seen from GitHub
        // in practice — treat as transient (never fabricate a false 'resolved').
        return {
          repo,
          resolution: 'transient',
          defaultBranch: null,
          httpStatus: response.status,
          attempts: totalRequests,
        }
      }
      // Unclassified status — safe default is transient, never a false not-found.
      return {
        repo,
        resolution: 'transient',
        defaultBranch: null,
        httpStatus: response.status,
        attempts: totalRequests,
      }
    } catch (err) {
      // Fatal auth failure must never be swallowed into the network-error retry below.
      if (err instanceof BranchResolutionAuthError) throw err
      // Network error — retry within budget, then transient.
      await new Promise((r) => setTimeout(r, SERVER_ERROR_BACKOFF_MS * attempts))
      continue
    }
  }
  return {
    repo,
    resolution: 'transient',
    defaultBranch: null,
    httpStatus: lastStatus,
    attempts: totalRequests,
  }
}

// ---------------------------------------------------------------------------
// Bounded-concurrency worker pool with cooperative cancellation
// ---------------------------------------------------------------------------

export type { PoolAbortSignal }
/** Branch-resolution-shaped alias of the generic `_shared/rate-limit.ts` pool result. */
export type ResolutionPoolResult = CancellablePoolResult

/**
 * Branch-resolution-shaped wrapper around `_shared/rate-limit.ts`'s generic
 * `runCancellablePool` — see that function's own docstring for the full
 * cooperative-cancellation rationale (built here first for SMI-5879's
 * 401-fatal / circuit-breaker requirements, then generalized so
 * `smi5879-simulate-full.ts` can share the same correctness-reviewed
 * implementation rather than a second parallel copy).
 *
 * `deadlineAtMs` (optional): if given, no worker pulls a NEW item once
 * `Date.now() >= deadlineAtMs` — used by `sweepTransientRepos` to bound a
 * single pass's own wall-clock cost, since the sweep's own between-passes
 * check (SMI-6015 GPT-5.6-Sol review, 2026-08-14) cannot interrupt a pass
 * already in flight at the conservative 1 req/sec pace.
 */
export async function runResolutionPool(
  repos: readonly DistinctRepo[],
  getHeaders: () => Promise<Record<string, string>>,
  telemetry: RateLimitTelemetry,
  concurrency: number,
  onOutcome: (outcome: ResolutionOutcome, completedCount: number) => PoolAbortSignal | void,
  deadlineAtMs?: number
): Promise<ResolutionPoolResult> {
  const bucket = createTokenBucket(REPO_RESOLUTION_RATE_PER_SEC, REPO_RESOLUTION_BURST)
  return runCancellablePool(
    repos,
    (repo) => resolveOne(repo, getHeaders, telemetry, bucket),
    onOutcome,
    concurrency,
    deadlineAtMs
  )
}

// ---------------------------------------------------------------------------
// Circuit breaker + progress logging
// ---------------------------------------------------------------------------

export interface ResolutionCounts {
  resolved: number
  'not-found': number
  transient: number
  unparseable: number
}

export function emptyResolutionCounts(): ResolutionCounts {
  return { resolved: 0, 'not-found': 0, transient: 0, unparseable: 0 }
}

/** Evaluate the circuit breaker after a completion — see the two constants above for the exact rule. */
export function checkCircuitBreaker(
  completedCount: number,
  transientCount: number
): PoolAbortSignal | void {
  if (completedCount < CIRCUIT_BREAKER_WARMUP_COUNT) return
  const rate = transientCount / completedCount
  if (rate > CIRCUIT_BREAKER_TRANSIENT_RATE_THRESHOLD) {
    return { reason: new BranchResolutionCircuitBreakerError(completedCount, transientCount, rate) }
  }
}

export function logResolutionProgress(
  runId: string,
  completedCount: number,
  total: number,
  counts: ResolutionCounts,
  telemetry: RateLimitTelemetry
): void {
  const fmt = (n: number): string => (Number.isFinite(n) ? String(n) : 'n/a')
  console.log(
    `[smi5879-census.branches] run_id=${runId} progress ${completedCount}/${total} ` +
      `resolved=${counts.resolved} not-found=${counts['not-found']} transient=${counts.transient} ` +
      `core_remaining_min=${fmt(telemetry.core_remaining_min)} ` +
      `secondary_rate_limit_hits=${telemetry.secondary_rate_limit_hits} ` +
      `retry_after_max_seconds=${telemetry.retry_after_max_seconds}`
  )
}

// Batched-write / SQL-builder machinery (buildBatchInsertSql,
// buildBatchUpdateSql, writeOutcomesBatch, updateOutcomesBatch) moved to
// ./smi5879-census.branches.writes.ts (SMI-6015 post-merge retro,
// 2026-08-18) to stay under the 500-line-per-file budget — no logical
// boundary change, same code, different file.
