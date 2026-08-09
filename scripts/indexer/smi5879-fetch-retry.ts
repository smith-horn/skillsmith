/**
 * SMI-5879 Wave 3 item 3, tier 1: per-fetch retry wrapper with full-jitter backoff.
 * @module scripts/indexer/smi5879-fetch-retry
 *
 * Plan: docs/internal/implementation/smi-5879-wave3-census-simulation-plan.md §3b (tier 1)
 * Design: docs/internal/implementation/smi-5879-edge-twin-parity-design.md §8.2.3
 *
 * `withBackoff` (`_shared/rate-limit.ts:120-138`) only retries a thrown
 * `RateLimitError` — but `fetchSiblingContent` (`skill-processor.security.ts`)
 * and `fetchSkillMd` (`_shared/skill-md-fetch.ts`) both return `null`/`{kind:
 * 'transient'}` for every transient failure class (429, oversized, non-ok,
 * network error) and never throw for those cases, so `withBackoff` cannot be
 * applied to either directly. Changing `withBackoff` itself to accommodate
 * them would alter the retry behaviour of every live indexer fetch path that
 * already depends on its current contract — out of scope and explicitly
 * forbidden by the Wave 3 plan. This module is therefore a sibling helper,
 * NOT a modification of `_shared/rate-limit.ts` (verified unmodified by
 * `smi5879-fetch-retry.test.ts`'s source-diff assertion).
 *
 * Contract (plan §3b):
 *  - `{ content }` / `{ removed: true }` return immediately — never retried. A
 *    404 is a *positive absence* signal, not a failure.
 *  - `null` (or a thrown `RateLimitError`) is retried. Wait is full jitter:
 *    `random(0, min(maxMs, baseMs × 2^attempt))` — the AWS "Exponential
 *    Backoff and Jitter" formulation, chosen over equal/decorrelated jitter
 *    because ~314K sequential retries against one host benefit most from
 *    maximum dispersion.
 *  - Retry exhaustion returns a distinguished `{ exhausted: true, lastStatus }`
 *    — NEVER collapses back to a bare `null`, which would be indistinguishable
 *    from a first-attempt failure to tier-2 outcome classification.
 *
 * `fetchSiblingContent`'s own return shape (`{content}|{removed:true}|null`)
 * carries no HTTP status on its `null` case, so this module's `attempt`
 * parameter is typed against that exact shape and callers who DO have a
 * status to report (the primary `fetchSkillMd` path, whose `transient` kind
 * carries one) pass it via the optional `captureStatus` callback rather than
 * this module inventing a fourth return variant that `fetchSiblingContent`
 * itself doesn't have — see `smi5879-simulate-full.helpers.ts` for that
 * adapter.
 */

import { RateLimitError } from './_shared/rate-limit.ts'

/** The exact shape `fetchSiblingContent` (skill-processor.security.ts) returns. */
export type RetryableFetchResult = { content: string } | { removed: true } | null

export interface FetchRetryOptions {
  /** Max retry attempts after the first. Default 5. */
  maxRetries?: number
  /** Base backoff, ms. Default 1000. */
  baseMs?: number
  /** Backoff ceiling, ms. Default 60_000. */
  maxMs?: number
  /** Invoked before each wait with the 1-indexed attempt number and computed wait. */
  onRetry?: (attempt: number, waitMs: number) => void
  /**
   * Invoked immediately after a `null`/retryable-throw attempt to capture an
   * HTTP status for the eventual `{ exhausted: true, lastStatus }` result.
   * `fetchSiblingContent` itself carries no status on `null`, so this is
   * `undefined` for sibling fetches and populated by the primary-fetch
   * adapter, which does have one (`SkillMdFetch`'s `transient.status`).
   */
  captureStatus?: () => number | undefined
}

export type FetchRetryOutcome =
  | { content: string }
  | { removed: true }
  | { exhausted: true; lastStatus: number | null }

export const DEFAULT_MAX_RETRIES = 5
export const DEFAULT_BASE_MS = 1000
export const DEFAULT_MAX_MS = 60_000

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Full-jitter wait for a given 0-indexed attempt: `random(0, min(maxMs, baseMs * 2^attempt))`. */
export function fullJitterWaitMs(attempt: number, baseMs: number, maxMs: number): number {
  const cap = Math.min(maxMs, baseMs * 2 ** attempt)
  return Math.random() * cap
}

/**
 * Wrap a `fetchSiblingContent`/`fetchSkillMd`-shaped attempt with full-jitter
 * retry. See module header for the exact contract. `attempt` may either
 * resolve to `RetryableFetchResult` or throw a `RateLimitError` (the shape
 * `_shared/rate-limit.ts`'s `withRateLimitTracking` throws on 403/429 when
 * `_throwOnRateLimit` isn't disabled) — both are treated as retryable
 * signals, handled entirely within this module without depending on
 * `withBackoff`.
 */
export async function withFetchRetry(
  attempt: () => Promise<RetryableFetchResult>,
  options: FetchRetryOptions = {}
): Promise<FetchRetryOutcome> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
  const baseMs = options.baseMs ?? DEFAULT_BASE_MS
  const maxMs = options.maxMs ?? DEFAULT_MAX_MS

  let lastStatus: number | null = null

  for (let i = 0; i <= maxRetries; i++) {
    let result: RetryableFetchResult
    try {
      result = await attempt()
    } catch (err) {
      if (err instanceof RateLimitError) {
        lastStatus = err.status
        result = null
      } else {
        // Not a retryable-shaped error — a genuine bug in the caller, not a
        // transient fetch condition. Propagate rather than silently retrying
        // (and eventually masking) an unrelated failure.
        throw err
      }
    }

    if (result !== null) return result // { content } or { removed: true } — immediate, never retried

    const captured = options.captureStatus?.()
    if (captured !== undefined) lastStatus = captured

    if (i === maxRetries) break

    const waitMs = fullJitterWaitMs(i, baseMs, maxMs)
    options.onRetry?.(i + 1, waitMs)
    await sleep(waitMs)
  }

  return { exhausted: true, lastStatus }
}
