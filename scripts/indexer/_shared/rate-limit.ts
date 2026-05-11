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
 * SMI-4852: Rate-limit telemetry collector. One instance per indexer run;
 * thread through every `withRateLimitTracking` call and flush to
 * `audit_logs.metadata` in the entrypoint.
 */
export interface RateLimitTelemetry {
  /** Min `x-ratelimit-remaining` observed across all calls (Number.POSITIVE_INFINITY if none). */
  rate_limit_remaining_min: number
  /** Count of HTTP 403 + 429 responses (secondary rate limit signal). */
  secondary_rate_limit_hits: number
  /** Max `retry-after` header value observed, in seconds. */
  retry_after_max_seconds: number
}

export function newRateLimitTelemetry(): RateLimitTelemetry {
  return {
    rate_limit_remaining_min: Number.POSITIVE_INFINITY,
    secondary_rate_limit_hits: 0,
    retry_after_max_seconds: 0,
  }
}

/**
 * Convert telemetry into the shape stored in `audit_logs.metadata`.
 * Resolves the POSITIVE_INFINITY sentinel to 0 (the "no calls observed" case
 * means we never saw any remaining, which we surface as 0 — the
 * `v_indexer_health` view casts to int).
 */
export function summarizeRateLimitTelemetry(t: RateLimitTelemetry): {
  rate_limit_remaining_min: number
  secondary_rate_limit_hits: number
  retry_after_max_seconds: number
} {
  return {
    rate_limit_remaining_min: Number.isFinite(t.rate_limit_remaining_min)
      ? t.rate_limit_remaining_min
      : 0,
    secondary_rate_limit_hits: t.secondary_rate_limit_hits,
    retry_after_max_seconds: t.retry_after_max_seconds,
  }
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
 */
export async function withRateLimitTracking(
  telemetry: RateLimitTelemetry,
  url: string,
  init?: RequestInit & { _throwOnRateLimit?: boolean }
): Promise<Response> {
  const throwOnRateLimit = init?._throwOnRateLimit !== false
  const response = await fetch(url, init)

  const remainingHeader = response.headers.get('x-ratelimit-remaining')
  if (remainingHeader != null) {
    const remaining = Number(remainingHeader)
    if (Number.isFinite(remaining) && remaining < telemetry.rate_limit_remaining_min) {
      telemetry.rate_limit_remaining_min = remaining
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
