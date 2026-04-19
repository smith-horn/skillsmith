/**
 * Rate Limiter Utility (SMI-4316)
 *
 * Token-bucket style rate limiter intended for gating log output. First N
 * events per window fire unconditionally; after that, one-in-`SAMPLE_EVERY`
 * is allowed through. Windows reset automatically once `WINDOW_MS` elapses
 * since the first event in the window.
 *
 * Keyed: callers pass a stable string key (e.g. file path or error
 * signature). Different keys are isolated — a flood on key A does not
 * starve key B.
 *
 * Intended for observability, not security-sensitive throttling.
 */

type Key = string

interface BucketState {
  count: number
  windowStart: number
}

const BUCKETS = new Map<Key, BucketState>()

/** Window length for a single bucket (1 hour). */
export const WINDOW_MS = 60 * 60 * 1000

/** First N events per window always pass through. */
export const FIRST_N = 5

/** After the first N, every Nth subsequent event passes through. */
export const SAMPLE_EVERY = 100

/**
 * Return `true` if the event for `key` should be allowed through
 * (logged / processed), or `false` if it is suppressed by the limiter.
 *
 * The first `FIRST_N` events in a window always return `true`. After that,
 * one-in-`SAMPLE_EVERY` events return `true` until the window rolls over.
 *
 * @param key - Stable grouping key (per-file, per-error, etc.)
 * @param now - Optional timestamp override for tests (defaults to Date.now()).
 */
export function rateLimited(key: Key, now: number = Date.now()): boolean {
  const existing = BUCKETS.get(key)
  const bucket: BucketState =
    existing && now - existing.windowStart <= WINDOW_MS ? existing : { count: 0, windowStart: now }
  bucket.count += 1
  BUCKETS.set(key, bucket)

  if (bucket.count <= FIRST_N) return true
  return (bucket.count - FIRST_N) % SAMPLE_EVERY === 1
}

/**
 * Reset all buckets. Intended for tests; callers in production should not
 * need this.
 */
export function resetRateLimiter(): void {
  BUCKETS.clear()
}
