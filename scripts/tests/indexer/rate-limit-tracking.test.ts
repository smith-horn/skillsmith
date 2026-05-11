/**
 * Rate-limit tracking wrapper test (Hard Rule 1 / Issue #4)
 * @module scripts/indexer/tests/rate-limit-tracking
 *
 * SMI-4852: Asserts `withRateLimitTracking` records `x-ratelimit-remaining`
 * (min), 403/429 hit count, and `retry-after` (max) into the shared
 * telemetry object.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  newRateLimitTelemetry,
  summarizeRateLimitTelemetry,
  withRateLimitTracking,
  withBackoff,
  RateLimitError,
} from '../../indexer/_shared/rate-limit.ts'

describe('withRateLimitTracking', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let originalFetch: typeof global.fetch

  beforeEach(() => {
    originalFetch = global.fetch
    fetchMock = vi.fn()
    // @ts-expect-error overriding global for test
    global.fetch = fetchMock
  })
  afterEach(() => {
    global.fetch = originalFetch
  })

  it('records x-ratelimit-remaining minimum across calls', async () => {
    const telemetry = newRateLimitTelemetry()
    fetchMock
      .mockResolvedValueOnce(
        new Response('ok', { status: 200, headers: { 'x-ratelimit-remaining': '4500' } })
      )
      .mockResolvedValueOnce(
        new Response('ok', { status: 200, headers: { 'x-ratelimit-remaining': '4200' } })
      )

    await withRateLimitTracking(telemetry, 'https://api.github.com/x')
    await withRateLimitTracking(telemetry, 'https://api.github.com/y')

    expect(telemetry.rate_limit_remaining_min).toBe(4200)
    expect(telemetry.secondary_rate_limit_hits).toBe(0)
  })

  it('increments secondary_rate_limit_hits on 403 and records retry-after', async () => {
    const telemetry = newRateLimitTelemetry()
    fetchMock.mockResolvedValueOnce(
      new Response('forbidden', {
        status: 403,
        headers: { 'retry-after': '60', 'x-ratelimit-remaining': '0' },
      })
    )

    await expect(
      withRateLimitTracking(telemetry, 'https://api.github.com/z')
    ).rejects.toBeInstanceOf(RateLimitError)

    expect(telemetry.secondary_rate_limit_hits).toBe(1)
    expect(telemetry.retry_after_max_seconds).toBe(60)
    expect(telemetry.rate_limit_remaining_min).toBe(0)
  })

  it('increments secondary_rate_limit_hits on 429', async () => {
    const telemetry = newRateLimitTelemetry()
    fetchMock.mockResolvedValueOnce(
      new Response('too many', { status: 429, headers: { 'retry-after': '30' } })
    )
    await expect(
      withRateLimitTracking(telemetry, 'https://api.github.com/q')
    ).rejects.toBeInstanceOf(RateLimitError)
    expect(telemetry.secondary_rate_limit_hits).toBe(1)
    expect(telemetry.retry_after_max_seconds).toBe(30)
  })

  it('summarizeRateLimitTelemetry collapses POSITIVE_INFINITY to 0', () => {
    const telemetry = newRateLimitTelemetry()
    const summary = summarizeRateLimitTelemetry(telemetry)
    expect(summary.rate_limit_remaining_min).toBe(0)
    expect(summary.secondary_rate_limit_hits).toBe(0)
  })

  it('withBackoff retries on RateLimitError up to maxRetries', async () => {
    let attempts = 0
    const fn = async (): Promise<string> => {
      attempts++
      if (attempts < 3) {
        throw new RateLimitError('rate-limited', 403, 0)
      }
      return 'ok'
    }
    const result = await withBackoff(fn, { maxRetries: 5, baseMs: 1, maxMs: 5 })
    expect(result).toBe('ok')
    expect(attempts).toBe(3)
  })

  it('withBackoff throws after maxRetries exhausted', async () => {
    const fn = async (): Promise<string> => {
      throw new RateLimitError('rate-limited', 429, 0)
    }
    await expect(withBackoff(fn, { maxRetries: 2, baseMs: 1, maxMs: 5 })).rejects.toBeInstanceOf(
      RateLimitError
    )
  })
})
