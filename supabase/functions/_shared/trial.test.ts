/**
 * Tests for _shared/trial.ts
 * SMI-2738: 14-day free trial utility functions
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

const { mockDateNow } = vi.hoisted(() => {
  ;(globalThis as Record<string, unknown>).Deno = {
    env: { get: () => undefined },
  }
  const mockDateNow = vi.fn(() => 1_740_000_000_000) // 2026-02-19T21:20:00Z
  return { mockDateNow }
})

vi.stubGlobal('Date', {
  ...Date,
  now: mockDateNow,
})

import { TRIAL_TIERS, TRIAL_DAYS, isTrialEligible, isTrialStillActive } from './trial.ts'

afterEach(() => {
  vi.clearAllMocks()
})

describe('TRIAL_TIERS', () => {
  it('contains individual and team', () => {
    expect(TRIAL_TIERS.has('individual')).toBe(true)
    expect(TRIAL_TIERS.has('team')).toBe(true)
  })

  it('does not contain enterprise or community', () => {
    expect(TRIAL_TIERS.has('enterprise')).toBe(false)
    expect(TRIAL_TIERS.has('community')).toBe(false)
  })
})

describe('TRIAL_DAYS', () => {
  it('is 14', () => {
    expect(TRIAL_DAYS).toBe(14)
  })
})

describe('isTrialEligible', () => {
  it('returns true for individual', () => {
    expect(isTrialEligible('individual')).toBe(true)
  })

  it('returns true for team', () => {
    expect(isTrialEligible('team')).toBe(true)
  })

  it('returns false for enterprise', () => {
    expect(isTrialEligible('enterprise')).toBe(false)
  })

  it('returns false for community', () => {
    expect(isTrialEligible('community')).toBe(false)
  })

  it('returns false for unknown tier', () => {
    expect(isTrialEligible('unknown')).toBe(false)
  })
})

describe('isTrialStillActive', () => {
  // mockDateNow returns 1_740_000_000_000 ms → epoch seconds = 1_740_000_000

  it('returns false when trial_end is null (no trial)', () => {
    expect(isTrialStillActive(null)).toBe(false)
  })

  it('returns true when trial_end is in the future', () => {
    const futureEpoch = 1_740_000_000 + 3600 // 1 hour from now
    expect(isTrialStillActive(futureEpoch)).toBe(true)
  })

  it('returns false when trial_end is in the past', () => {
    const pastEpoch = 1_740_000_000 - 3600 // 1 hour ago
    expect(isTrialStillActive(pastEpoch)).toBe(false)
  })

  it('returns false when trial_end equals current time exactly', () => {
    // trial_end === now means expired (not strictly greater than)
    expect(isTrialStillActive(1_740_000_000)).toBe(false)
  })

  it('returns true one second before trial_end', () => {
    const oneSecondBeforeExpiry = 1_740_000_000 + 1
    expect(isTrialStillActive(oneSecondBeforeExpiry)).toBe(true)
  })
})
