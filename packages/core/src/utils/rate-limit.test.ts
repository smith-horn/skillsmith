/**
 * SMI-4316: rateLimited() unit tests.
 *
 * Covers:
 *   1. First-N events (<= FIRST_N) always return true.
 *   2. Sampled-after-N events follow the 1-in-SAMPLE_EVERY cadence.
 *   3. Per-key isolation (one key's flood does not starve another key).
 *   4. Window rollover when `now` advances beyond WINDOW_MS.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { FIRST_N, SAMPLE_EVERY, WINDOW_MS, rateLimited, resetRateLimiter } from './rate-limit.js'

describe('rateLimited', () => {
  afterEach(() => {
    resetRateLimiter()
  })

  it('allows the first FIRST_N calls for a key', () => {
    const results: boolean[] = []
    for (let i = 0; i < FIRST_N; i += 1) {
      results.push(rateLimited('k1'))
    }
    expect(results.every((r) => r === true)).toBe(true)
  })

  it('after FIRST_N, allows one-in-SAMPLE_EVERY', () => {
    // Burn the first N allowed events.
    for (let i = 0; i < FIRST_N; i += 1) rateLimited('k2')
    // Next 2 * SAMPLE_EVERY events should produce exactly 2 allowed.
    let allowed = 0
    for (let i = 0; i < 2 * SAMPLE_EVERY; i += 1) {
      if (rateLimited('k2')) allowed += 1
    }
    expect(allowed).toBe(2)
  })

  it('matches the plan count: 5 firsts + 200 sampled = 7 total allowed', () => {
    // Mirrors the acceptance test described in the plan.
    let allowed = 0
    for (let i = 0; i < FIRST_N; i += 1) {
      if (rateLimited('k3')) allowed += 1
    }
    for (let i = 0; i < 200; i += 1) {
      if (rateLimited('k3')) allowed += 1
    }
    expect(allowed).toBe(FIRST_N + 2)
  })

  it('isolates per-key: flooding one key does not starve another', () => {
    // Flood key A well past FIRST_N.
    for (let i = 0; i < FIRST_N * 3; i += 1) rateLimited('A')
    // Key B still gets its full FIRST_N window.
    let bAllowed = 0
    for (let i = 0; i < FIRST_N; i += 1) {
      if (rateLimited('B')) bAllowed += 1
    }
    expect(bAllowed).toBe(FIRST_N)
  })

  it('resets the bucket when the window elapses', () => {
    const t0 = 1_000_000
    // Exhaust first window at t0.
    for (let i = 0; i < FIRST_N; i += 1) rateLimited('win', t0)
    // Next event at t0 is the first sampled hit (count-FIRST_N === 1),
    // so it passes. Step past that so the next is definitely suppressed.
    rateLimited('win', t0)
    expect(rateLimited('win', t0)).toBe(false)
    // Advance past WINDOW_MS — the next call starts a fresh bucket and
    // returns true as count-1.
    const t1 = t0 + WINDOW_MS + 1
    expect(rateLimited('win', t1)).toBe(true)
  })

  it('suppresses events after FIRST_N + 1 that are not on the sampled boundary', () => {
    const t = 5_000
    // First N pass.
    for (let i = 0; i < FIRST_N; i += 1) {
      expect(rateLimited('same-now', t)).toBe(true)
    }
    // FIRST_N + 1: first sampled hit, (count - FIRST_N) % SAMPLE_EVERY === 1 → true.
    expect(rateLimited('same-now', t)).toBe(true)
    // FIRST_N + 2: (count - FIRST_N) % SAMPLE_EVERY === 2 → false.
    expect(rateLimited('same-now', t)).toBe(false)
  })
})
