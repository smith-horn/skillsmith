/**
 * Tests for timeAlternating (SMI-7241): the alternating ratio timing and its
 * fail-fast branch, driven by a fake clock so each branch is reached on
 * purpose rather than by host timing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { timeAlternating } from './ratio-timing.js'

// A fake clock: performance.now() reads `clock`, and each run advances it by
// the cost the test assigns to that call.
function fakeClock(costOf: (text: string, call: number) => number) {
  let clock = 0
  const calls: string[] = []
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  const run = (text: string) => {
    calls.push(text)
    clock += costOf(text, calls.length)
    return text === 'large' ? 2 : 1
  }
  return { run, calls }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('timeAlternating', () => {
  it('times every pair and keeps the fastest of each size', () => {
    // Warm-ups cost 1 and 4; the timed large runs cost 8, 4, 6, so the
    // fastest is not the last (a "keep the last run" helper would read 6).
    const LARGE: Record<number, number> = { 2: 4, 4: 8, 6: 4, 8: 6 }
    const { run, calls } = fakeClock((text, call) => (text === 'small' ? 1 : LARGE[call]))
    const t = timeAlternating(run, 'small', 'large', { pairs: 3 })
    expect(calls).toEqual(['small', 'large', 'small', 'large', 'small', 'large', 'small', 'large'])
    expect(t.smallMs).toBe(1)
    expect(t.largeMs).toBe(4)
    expect(t.ratio).toBe(4)
    expect([t.smallHits, t.largeHits]).toEqual([1, 2])
    expect(t.failedFast).toBe(false)
  })

  it('fails fast after one confirming pair when warm-ups and that pair exceed the limit', () => {
    const { run, calls } = fakeClock((text) => (text === 'small' ? 1 : 20))
    const t = timeAlternating(run, 'small', 'large', { failFast: 16 })
    expect(calls).toHaveLength(4) // two warm-ups, one timed pair
    expect(t.failedFast).toBe(true)
    expect(t.ratio).toBe(20)
  })

  it('does not fail fast on a slow large warm-up alone: all pairs run', () => {
    // Only the large warm-up (call 2) is slow, as a single load spike would be.
    const { run, calls } = fakeClock((text, call) => (text === 'small' ? 1 : call === 2 ? 20 : 4))
    const t = timeAlternating(run, 'small', 'large', { failFast: 16 })
    expect(calls).toHaveLength(2 + 2 * 7)
    expect(t.failedFast).toBe(false)
    expect(t.ratio).toBe(4)
  })

  it('does not fail fast on a slow first timed pair after fast warm-ups', () => {
    // The mirror of a slow warm-up: only the first timed large run (call 4)
    // is slow. The warm-up ratio is 4, so the gate must not fire.
    const { run, calls } = fakeClock((text, call) => (text === 'small' ? 1 : call === 4 ? 20 : 4))
    const t = timeAlternating(run, 'small', 'large', { failFast: 16 })
    expect(calls).toHaveLength(2 + 2 * 7)
    expect(t.failedFast).toBe(false)
    expect(t.ratio).toBe(4)
  })

  it('only the first timed pair can stop early, even if a later running ratio exceeds the limit', () => {
    // Slow warm-ups (ratio 20), a fast first pair (ratio 4), then a small run
    // of 0.125 makes the running ratio 4 / 0.125 = 32 at the second pair.
    const { run, calls } = fakeClock((text, call) =>
      text === 'small' ? (call === 5 ? 0.125 : 1) : call === 2 ? 20 : 4
    )
    const t = timeAlternating(run, 'small', 'large', { failFast: 16 })
    expect(calls).toHaveLength(2 + 2 * 7)
    expect(t.failedFast).toBe(false)
    expect(t.ratio).toBe(32)
  })

  it('never fails fast without a failFast limit', () => {
    const { run, calls } = fakeClock((text) => (text === 'small' ? 1 : 20))
    const t = timeAlternating(run, 'small', 'large')
    expect(calls).toHaveLength(2 + 2 * 7)
    expect(t.failedFast).toBe(false)
    expect(t.ratio).toBe(20)
  })
})
