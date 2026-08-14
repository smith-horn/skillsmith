/**
 * Shared rate-limiting utilities for GitHub API consumers (Node port)
 * @module scripts/indexer/_shared/rate-limit
 *
 * SMI-4852: Node-flavored sibling of `supabase/functions/_shared/rate-limit.ts`.
 * Body is byte-identical for `createTokenBucket`, `pMapBounded`,
 * `GITHUB_API_DELAY`, `delay` — parity guarded by
 * `scripts/indexer/tests/parity.test.ts`. Adds `withBackoff` and
 * `withRateLimitTracking` for SMI-4852 Phase 1 parallelism + observability.
 */

/** Delay between sequential GitHub API requests (ms) */
export const GITHUB_API_DELAY = 150

/** Promise-based delay helper for rate limiting */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * SMI-4846: Token bucket interface — singleton across all callers, async-safe.
 */
export interface TokenBucket {
  acquire(): Promise<void>
  readonly remaining: number
}

/**
 * SMI-4846: Token bucket factory. Rate is enforced as `ratePerSecond` tokens
 * refilled per second, with a `burst` cap on instantaneous capacity.
 */
export function createTokenBucket(ratePerSecond: number, burst: number): TokenBucket {
  let tokens = burst
  let lastRefill = Date.now()
  let queue: Promise<void> = Promise.resolve()

  function refill(): void {
    const now = Date.now()
    const elapsed = (now - lastRefill) / 1000
    if (elapsed > 0) {
      tokens = Math.min(burst, tokens + elapsed * ratePerSecond)
      lastRefill = now
    }
  }

  async function acquireOne(): Promise<void> {
    refill()
    if (tokens >= 1) {
      tokens -= 1
      return
    }
    const waitMs = ((1 - tokens) / ratePerSecond) * 1000
    await delay(Math.ceil(waitMs))
    refill()
    tokens = Math.max(0, tokens - 1)
  }

  return {
    acquire(): Promise<void> {
      const next = queue.then(() => acquireOne())
      queue = next.catch(() => undefined)
      return next
    },
    get remaining(): number {
      refill()
      return tokens
    },
  }
}

/**
 * SMI-4846: Semaphore-bounded `Array.map`. Runs at most `concurrency` mappers
 * in flight; preserves input order in the returned array.
 */
export async function pMapBounded<T, R>(
  items: ReadonlyArray<T>,
  mapper: (item: T, index: number) => Promise<R>,
  options: { concurrency: number }
): Promise<R[]> {
  const concurrency = Math.max(1, options.concurrency)
  const results: R[] = new Array(items.length)
  let cursor = 0
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++
      if (i >= items.length) return
      results[i] = await mapper(items[i], i)
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  await Promise.all(workers)
  return results
}

/** Returned from `onOutcome` to request an immediate, cooperative abort of a `runCancellablePool`. */
export interface PoolAbortSignal {
  reason: Error
}

export interface CancellablePoolResult {
  /** Non-null iff the pool stopped early — either `processItem` threw or `onOutcome` signalled abort. */
  abortedBy: Error | null
  /**
   * True iff the pool stopped because `deadlineAtMs` was reached — distinct
   * from `abortedBy`: a deadline is an EXPECTED, non-fatal way to stop (the
   * caller decides what to do next), never something to rethrow the way a
   * fatal `abortedBy` condition is.
   */
  deadlineExceeded: boolean
}

/**
 * Bounded-concurrency worker pool, calling `processItem` for each item and
 * `onOutcome` synchronously after every completion. SMI-6015: deliberately
 * NOT the same as `pMapBounded` above — that helper's worker loops have no
 * shared cancellation check, so a caller that "aborts" by rejecting the
 * awaited `Promise.all` does nothing to stop the OTHER concurrent workers —
 * they keep pulling and processing items to the end of the list regardless,
 * silently defeating the whole point of an abort. `pMapBounded` itself is
 * intentionally left unchanged (many unrelated callers depend on its
 * simpler, non-cancellable contract); this is a separate, additive
 * primitive for callers that specifically need cooperative cancellation —
 * originally built for SMI-5879's GitHub-App-token-expiry / 401-abort /
 * circuit-breaker requirements (`smi5879-census.branches.ts`,
 * `smi5879-simulate-full.ts`), generalized here so both share one
 * correctness-reviewed implementation instead of two parallel copies.
 *
 * Workers check a shared `abortedBy` flag (and, if given, a `deadlineAtMs`)
 * BEFORE pulling each new item AND again immediately AFTER `processItem`
 * resolves, before calling `onOutcome` — the second check matters because a
 * sibling worker (or the deadline) can flip the stop condition while this
 * worker's own call was still in flight; without it, a result that raced
 * past an abort would still get processed (GPT-5.6-Sol review, 2026-08-14).
 */
export async function runCancellablePool<TItem, TOutcome>(
  items: readonly TItem[],
  processItem: (item: TItem) => Promise<TOutcome>,
  onOutcome: (outcome: TOutcome, completedCount: number) => PoolAbortSignal | void,
  concurrency: number,
  deadlineAtMs?: number
): Promise<CancellablePoolResult> {
  let cursor = 0
  let completedCount = 0
  let abortedBy: Error | null = null
  let deadlineExceeded = false

  function deadlineHit(): boolean {
    if (deadlineAtMs === undefined) return false
    if (Date.now() < deadlineAtMs) return false
    deadlineExceeded = true
    return true
  }

  async function worker(): Promise<void> {
    while (!abortedBy && !deadlineHit()) {
      const i = cursor++
      const item = items[i]
      if (item === undefined) return // i >= items.length
      let outcome: TOutcome
      try {
        outcome = await processItem(item)
      } catch (err) {
        if (!abortedBy) abortedBy = err instanceof Error ? err : new Error(String(err))
        return
      }
      if (abortedBy || deadlineHit()) return
      completedCount++
      const signal = onOutcome(outcome, completedCount)
      if (signal && !abortedBy) abortedBy = signal.reason
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length))
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return { abortedBy, deadlineExceeded }
}

/**
 * SMI-4852: Exponential-backoff wrapper for GitHub fetches that may hit
 * secondary rate limits. Honors `retry-after` header on 403/429; doubles up
 * to `maxMs`. Caller throws or returns Response; this wrapper retries iff the
 * inner fn throws a `RateLimitError` (see below) OR returns a Response with
 * status 403/429.
 */
export interface BackoffOptions {
  maxRetries: number
  baseMs: number
  maxMs: number
  onRetry?: (attempt: number, waitMs: number) => void
}

export class RateLimitError extends Error {
  retryAfterSeconds: number
  status: number
  constructor(message: string, status: number, retryAfterSeconds: number) {
    super(message)
    this.name = 'RateLimitError'
    this.status = status
    this.retryAfterSeconds = retryAfterSeconds
  }
}

export async function withBackoff<T>(fn: () => Promise<T>, opts: BackoffOptions): Promise<T> {
  let attempt = 0
  let waitMs = opts.baseMs
  while (true) {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof RateLimitError && attempt < opts.maxRetries) {
        const headerWaitMs = err.retryAfterSeconds * 1000
        const computedWait = Math.min(opts.maxMs, Math.max(waitMs, headerWaitMs))
        opts.onRetry?.(attempt + 1, computedWait)
        await delay(computedWait)
        waitMs = Math.min(opts.maxMs, waitMs * 2)
        attempt++
        continue
      }
      throw err
    }
  }
}

/**
 * SMI-4918: GitHub rate-limit buckets the indexer consumes. GitHub meters
 * each bucket independently: `core` is the REST API (Trees, Contents) at
 * 5000/h; `search` is the Search API at 30/min (Phase 2 topic search);
 * `code_search` is 10/min (Phase 3a/3b). The bucket is reported on every
 * metered response via the `x-ratelimit-resource` header.
 */
export type RateLimitBucket = 'core' | 'search' | 'code_search'

/**
 * SMI-4918: Classify a GitHub response by the `x-ratelimit-resource` header.
 * An absent/unrecognized resource on an `api.github.com` response defaults
 * to `core` — the REST bucket every non-search endpoint draws from.
 */
function classifyRateLimitBucket(resourceHeader: string | null): RateLimitBucket {
  switch (resourceHeader) {
    case 'search':
      return 'search'
    case 'code_search':
      return 'code_search'
    default:
      return 'core'
  }
}

/** SMI-4918: parse a request URL's host, tolerating malformed input. */
function parseHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/**
 * SMI-4852: Rate-limit telemetry collector. One instance per indexer run;
 * thread through every `withRateLimitTracking` call and flush to
 * `audit_logs.metadata` in the entrypoint.
 */
export interface RateLimitTelemetry {
  /**
   * Min `x-ratelimit-remaining` across the three GitHub API buckets
   * (`raw.githubusercontent.com` CDN responses excluded — SMI-4918).
   * `Number.POSITIVE_INFINITY` when no metered call was observed.
   *
   * Kept for backward compat: this conflates `core`/`search`/`code_search`,
   * so a `0` here cannot tell you *which* bucket ran dry. Use the per-bucket
   * minimums below for budget diagnosis (SMI-4918).
   */
  rate_limit_remaining_min: number
  /** SMI-4918: min `x-ratelimit-remaining` for the `core` bucket (REST 5000/h). */
  core_remaining_min: number
  /** SMI-4918: min `x-ratelimit-remaining` for the `search` bucket (30/min). */
  search_remaining_min: number
  /** SMI-4918: min `x-ratelimit-remaining` for the `code_search` bucket (10/min). */
  code_search_remaining_min: number
  /** Count of HTTP 403 + 429 responses (secondary rate limit signal). */
  secondary_rate_limit_hits: number
  /** Max `retry-after` header value observed, in seconds. */
  retry_after_max_seconds: number
}

export function newRateLimitTelemetry(): RateLimitTelemetry {
  return {
    rate_limit_remaining_min: Number.POSITIVE_INFINITY,
    core_remaining_min: Number.POSITIVE_INFINITY,
    search_remaining_min: Number.POSITIVE_INFINITY,
    code_search_remaining_min: Number.POSITIVE_INFINITY,
    secondary_rate_limit_hits: 0,
    retry_after_max_seconds: 0,
  }
}

/** SMI-4918: the telemetry field holding the running minimum for a bucket. */
type BucketRemainingField =
  | 'core_remaining_min'
  | 'search_remaining_min'
  | 'code_search_remaining_min'

const BUCKET_FIELD: Record<RateLimitBucket, BucketRemainingField> = {
  core: 'core_remaining_min',
  search: 'search_remaining_min',
  code_search: 'code_search_remaining_min',
}

/**
 * Convert telemetry into the shape stored in `audit_logs.metadata`.
 * Resolves the POSITIVE_INFINITY sentinel to 0 (the "no calls observed" case
 * means we never saw any remaining, which we surface as 0 — the
 * `v_indexer_health` view casts to int). SMI-4918: the per-bucket minimums
 * are resolved the same way.
 */
export function summarizeRateLimitTelemetry(t: RateLimitTelemetry): {
  rate_limit_remaining_min: number
  core_remaining_min: number
  search_remaining_min: number
  code_search_remaining_min: number
  secondary_rate_limit_hits: number
  retry_after_max_seconds: number
} {
  const resolve = (v: number): number => (Number.isFinite(v) ? v : 0)
  return {
    rate_limit_remaining_min: resolve(t.rate_limit_remaining_min),
    core_remaining_min: resolve(t.core_remaining_min),
    search_remaining_min: resolve(t.search_remaining_min),
    code_search_remaining_min: resolve(t.code_search_remaining_min),
    secondary_rate_limit_hits: t.secondary_rate_limit_hits,
    retry_after_max_seconds: t.retry_after_max_seconds,
  }
}

/**
 * SMI-5964: default per-request wall-clock cap (ms) applied at the
 * `withRateLimitTracking` chokepoint. Bounds BOTH the header phase and the
 * body-read phase — aborting a fetch's signal errors the response body
 * stream, so a pending `reader.read()` (e.g. `readResponseWithLimit`,
 * `skill-processor.security.ts:80`) rejects rather than hanging.
 * `0` disables the cap entirely (byte-identical to pre-SMI-5964 behavior).
 * Override via `SKILLSMITH_INDEXER_FETCH_TIMEOUT_MS` (registered in
 * docs/internal/process/guards-and-opt-outs.md).
 */
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000

/** SMI-5964: resolve the effective per-request timeout from env, falling back
 * to {@link DEFAULT_FETCH_TIMEOUT_MS} on an absent/blank/non-numeric/negative
 * override. */
function resolveFetchTimeoutMs(): number {
  const raw = process.env.SKILLSMITH_INDEXER_FETCH_TIMEOUT_MS
  if (raw == null || raw === '') return DEFAULT_FETCH_TIMEOUT_MS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_FETCH_TIMEOUT_MS
}

/**
 * SMI-4852: Wrap a GitHub `fetch` call so its rate-limit headers and
 * 403/429 incidents are recorded into a shared telemetry object.
 *
 * **Hard Rule 1 (retro 2026-05-10)**: every GitHub API fetch in the indexer
 * MUST route through this wrapper. Grep enforcement:
 *   grep -rn "fetch(" scripts/indexer/ | grep -v withRateLimitTracking
 * must return zero hits against `api.github.com` URLs.
 *
 * Behavior is purely additive — returns the same Response the caller would
 * have received. On 403/429, ALSO throws a `RateLimitError` so `withBackoff`
 * can drive retry. Callers that don't want retry semantics can catch and
 * ignore the throw (the side-effect on telemetry is already recorded).
 *
 * SMI-5964: injects a default `AbortSignal.timeout(...)` when the caller did
 * NOT already supply its own `init.signal` (e.g. `org-verification.ts:94`'s
 * existing 1s SMI-4743 precedent is never overridden). No fetch on the
 * indexer path had any timeout before this — a single stalled connection
 * could block the crawl indefinitely, defeating every position-based budget
 * check downstream (§1a of the SMI-5964 plan).
 */
export async function withRateLimitTracking(
  telemetry: RateLimitTelemetry,
  url: string,
  init?: RequestInit & { _throwOnRateLimit?: boolean }
): Promise<Response> {
  const throwOnRateLimit = init?._throwOnRateLimit !== false
  const timeoutMs = resolveFetchTimeoutMs()
  const effectiveInit: RequestInit | undefined =
    timeoutMs > 0 && init?.signal == null
      ? { ...init, signal: AbortSignal.timeout(timeoutMs) }
      : init
  const response = await fetch(url, effectiveInit)

  // SMI-4918: `raw.githubusercontent.com` is CDN-served and carries no
  // GitHub rate-limit headers — exclude it so its responses can't pollute
  // the minimums. For metered `api.github.com` responses, attribute the
  // `x-ratelimit-remaining` value to its bucket via `x-ratelimit-resource`.
  if (parseHost(url) !== 'raw.githubusercontent.com') {
    const remainingHeader = response.headers.get('x-ratelimit-remaining')
    if (remainingHeader != null) {
      const remaining = Number(remainingHeader)
      if (Number.isFinite(remaining)) {
        if (remaining < telemetry.rate_limit_remaining_min) {
          telemetry.rate_limit_remaining_min = remaining
        }
        const bucketField =
          BUCKET_FIELD[classifyRateLimitBucket(response.headers.get('x-ratelimit-resource'))]
        if (remaining < telemetry[bucketField]) {
          telemetry[bucketField] = remaining
        }
      }
    }
  }

  if (response.status === 403 || response.status === 429) {
    telemetry.secondary_rate_limit_hits++
    const retryAfter = Number(response.headers.get('retry-after') ?? '0')
    const retryAfterSec = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 0
    if (retryAfterSec > telemetry.retry_after_max_seconds) {
      telemetry.retry_after_max_seconds = retryAfterSec
    }
    if (throwOnRateLimit) {
      throw new RateLimitError(
        `GitHub API ${response.status} on ${url}`,
        response.status,
        retryAfterSec
      )
    }
  }

  return response
}
