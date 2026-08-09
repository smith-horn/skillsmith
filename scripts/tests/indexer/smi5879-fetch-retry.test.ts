/**
 * SMI-5879 Wave 3 item 3, tier 1: smi5879-fetch-retry.ts tests.
 * @module scripts/tests/indexer/smi5879-fetch-retry
 *
 * Covers plan §3b tier 1's exact contract: `{content}`/`{removed:true}`
 * return without retry; `null` retries with full-jitter waits bounded by
 * `[0, min(maxMs, baseMs * 2^attempt)]`; retry exhaustion returns a
 * distinguished `{exhausted:true, lastStatus}` (never a bare `null`); a
 * `RateLimitError`-shaped throw is retried without depending on `withBackoff`;
 * and — the module's own must-not-modify guarantee — `_shared/rate-limit.ts`'s
 * `withBackoff` export is byte-identical to a hash captured at authoring time.
 */

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import {
  withFetchRetry,
  fullJitterWaitMs,
  DEFAULT_BASE_MS,
  DEFAULT_MAX_MS,
} from '../../indexer/smi5879-fetch-retry.ts'
import { RateLimitError } from '../../indexer/_shared/rate-limit.ts'

describe('withFetchRetry', () => {
  it('returns { content } immediately, without retry', async () => {
    const attempt = vi.fn().mockResolvedValue({ content: 'hello' })
    const result = await withFetchRetry(attempt)
    expect(result).toEqual({ content: 'hello' })
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it('returns { removed: true } immediately, without retry — a 404 is a positive absence signal', async () => {
    const attempt = vi.fn().mockResolvedValue({ removed: true })
    const result = await withFetchRetry(attempt)
    expect(result).toEqual({ removed: true })
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it('retries on null with waits inside [0, min(maxMs, baseMs * 2^attempt)]', async () => {
    const waits: number[] = []
    const attempt = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ content: 'ok' })

    const result = await withFetchRetry(attempt, {
      baseMs: 10,
      maxMs: 1000,
      onRetry: (_attempt, waitMs) => waits.push(waitMs),
    })

    expect(result).toEqual({ content: 'ok' })
    expect(attempt).toHaveBeenCalledTimes(3)
    expect(waits).toHaveLength(2)
    // attempt index 0: cap = min(1000, 10*2^0) = 10
    expect(waits[0]).toBeGreaterThanOrEqual(0)
    expect(waits[0]).toBeLessThanOrEqual(10)
    // attempt index 1: cap = min(1000, 10*2^1) = 20
    expect(waits[1]).toBeGreaterThanOrEqual(0)
    expect(waits[1]).toBeLessThanOrEqual(20)
  })

  it('exhaustion returns a distinguished { exhausted: true, lastStatus } — never collapses to a bare null', async () => {
    const attempt = vi.fn().mockResolvedValue(null)
    const result = await withFetchRetry(attempt, { maxRetries: 2, baseMs: 1, maxMs: 5 })
    expect(result).toEqual({ exhausted: true, lastStatus: null })
    expect(result).not.toBeNull()
    // 1 initial attempt + 2 retries = 3 calls
    expect(attempt).toHaveBeenCalledTimes(3)
  })

  it('exhaustion carries lastStatus when the caller supplies one via captureStatus', async () => {
    const attempt = vi.fn().mockResolvedValue(null)
    const result = await withFetchRetry(attempt, {
      maxRetries: 1,
      baseMs: 1,
      maxMs: 5,
      captureStatus: () => 503,
    })
    expect(result).toEqual({ exhausted: true, lastStatus: 503 })
  })

  it('a RateLimitError-shaped throw is treated as retryable, handled without depending on withBackoff', async () => {
    let calls = 0
    const attempt = vi.fn().mockImplementation(async () => {
      calls++
      if (calls === 1) throw new RateLimitError('rate limited', 429, 0)
      return { content: 'recovered' }
    })
    const result = await withFetchRetry(attempt, { baseMs: 1, maxMs: 5 })
    expect(result).toEqual({ content: 'recovered' })
    expect(attempt).toHaveBeenCalledTimes(2)
  })

  it('a RateLimitError throw contributes its .status to lastStatus on exhaustion', async () => {
    const attempt = vi.fn().mockRejectedValue(new RateLimitError('rate limited', 429, 0))
    const result = await withFetchRetry(attempt, { maxRetries: 1, baseMs: 1, maxMs: 5 })
    expect(result).toEqual({ exhausted: true, lastStatus: 429 })
  })

  it('propagates a non-RateLimitError throw rather than silently retrying it', async () => {
    const attempt = vi.fn().mockRejectedValue(new Error('boom'))
    await expect(withFetchRetry(attempt, { maxRetries: 3 })).rejects.toThrow('boom')
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it('honors overridden maxRetries/baseMs/maxMs defaults', () => {
    expect(DEFAULT_BASE_MS).toBe(1000)
    expect(DEFAULT_MAX_MS).toBe(60_000)
  })
})

describe('fullJitterWaitMs', () => {
  it('is always within [0, min(maxMs, baseMs * 2^attempt)]', () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const cap = Math.min(60_000, 1000 * 2 ** attempt)
      for (let i = 0; i < 20; i++) {
        const wait = fullJitterWaitMs(attempt, 1000, 60_000)
        expect(wait).toBeGreaterThanOrEqual(0)
        expect(wait).toBeLessThanOrEqual(cap)
      }
    }
  })

  it('respects the maxMs ceiling even at a high attempt count', () => {
    const wait = fullJitterWaitMs(20, 1000, 60_000)
    expect(wait).toBeLessThanOrEqual(60_000)
  })
})

describe('_shared/rate-limit.ts must-not-modify guard', () => {
  /**
   * Extract `withBackoff`'s exact exported source text via brace matching
   * (robust to reformatting elsewhere in the file) and hash it. A hardcoded
   * expected hash — captured when this test was authored — is more robust
   * than a `git diff HEAD` comparison (trivially zero at authoring time
   * regardless of whether anything is actually protected, and brittle across
   * shallow clones / rebase mechanics) and more targeted than hashing the
   * whole file (which would also trip on unrelated future changes to this
   * shared module, e.g. new telemetry fields).
   */
  function extractWithBackoffSource(fileSrc: string): string {
    const marker = 'export async function withBackoff'
    const start = fileSrc.indexOf(marker)
    if (start === -1) {
      throw new Error(
        'withBackoff export not found in _shared/rate-limit.ts — has it been renamed/removed?'
      )
    }
    let depth = 0
    let started = false
    let end = -1
    for (let i = start; i < fileSrc.length; i++) {
      if (fileSrc[i] === '{') {
        depth++
        started = true
      } else if (fileSrc[i] === '}') {
        depth--
        if (started && depth === 0) {
          end = i + 1
          break
        }
      }
    }
    if (end === -1) throw new Error('Could not locate the end of withBackoff — unbalanced braces?')
    return fileSrc.slice(start, end)
  }

  it("withBackoff's source is byte-identical to the hash captured when smi5879-fetch-retry.ts was authored", () => {
    const filePath = join(process.cwd(), 'scripts/indexer/_shared/rate-limit.ts')
    const src = readFileSync(filePath, 'utf8')
    const withBackoffSrc = extractWithBackoffSource(src)
    const hash = createHash('sha256').update(withBackoffSrc).digest('hex')
    expect(hash).toBe('bd424985a8b41895dd1bb95e1e8b24998a753ccdeea54f5d0f7db06857d0441f')
  })
})
