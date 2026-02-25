/**
 * SMI-2755 Wave 2: Quota helpers pure-function unit tests
 *
 * Tests for InMemoryQuotaStorage, getWarningMessage, and getWarningLevel
 * from quota-helpers.ts. No mocking needed — all pure functions or
 * simple in-memory operations.
 */

import { describe, it, expect } from 'vitest'
import {
  InMemoryQuotaStorage,
  getWarningMessage,
  getWarningLevel,
} from '../../middleware/quota-helpers.js'

// ============================================================================
// InMemoryQuotaStorage
// ============================================================================

describe('InMemoryQuotaStorage', () => {
  it('starts with zero usage for a new customer', async () => {
    const storage = new InMemoryQuotaStorage()

    const usage = await storage.getUsage('customer-1')

    expect(usage.used).toBe(0)
    expect(usage.periodStart).toBeInstanceOf(Date)
    expect(usage.periodEnd).toBeInstanceOf(Date)
    expect(usage.periodEnd.getTime()).toBeGreaterThan(usage.periodStart.getTime())
  })

  it('accumulates usage correctly across multiple incrementUsage calls', async () => {
    const storage = new InMemoryQuotaStorage()

    await storage.incrementUsage('customer-a', 1)
    await storage.incrementUsage('customer-a', 1)
    await storage.incrementUsage('customer-a', 3)

    const usage = await storage.getUsage('customer-a')

    expect(usage.used).toBe(5)
  })

  it('tracks usage independently per customer', async () => {
    const storage = new InMemoryQuotaStorage()

    await storage.incrementUsage('cust-x', 10)
    await storage.incrementUsage('cust-y', 5)

    const usageX = await storage.getUsage('cust-x')
    const usageY = await storage.getUsage('cust-y')

    expect(usageX.used).toBe(10)
    expect(usageY.used).toBe(5)
  })

  it('resets usage after initializePeriod', async () => {
    const storage = new InMemoryQuotaStorage()

    await storage.incrementUsage('cust-z', 50)
    await storage.initializePeriod('cust-z', 1000)

    const usage = await storage.getUsage('cust-z')

    expect(usage.used).toBe(0)
  })
})

// ============================================================================
// getWarningMessage()
// ============================================================================

describe('getWarningMessage()', () => {
  it('returns undefined for warning level 0 (no warning)', () => {
    const msg = getWarningMessage(0, 100, 1000, 'community')

    expect(msg).toBeUndefined()
  })

  it('returns 80% notice string for warning level 80', () => {
    const msg = getWarningMessage(80, 800, 1000, 'community')

    expect(msg).toBeDefined()
    expect(msg).toContain('80%')
    expect(msg).toContain('200') // 200 remaining
  })

  it('returns 90% warning string for warning level 90', () => {
    const msg = getWarningMessage(90, 900, 1000, 'community')

    expect(msg).toBeDefined()
    expect(msg).toContain('90%')
    expect(msg).toContain('100') // 100 remaining
    expect(msg).toContain('upgrading')
  })

  it('returns exceeded string for warning level 100', () => {
    const msg = getWarningMessage(100, 1000, 1000, 'community')

    expect(msg).toBeDefined()
    expect(msg).toContain('exceeded')
    expect(msg).toContain('Upgrade')
  })
})

// ============================================================================
// getWarningLevel()
// ============================================================================

describe('getWarningLevel()', () => {
  it('returns 0 for usage below 80%', () => {
    expect(getWarningLevel(0)).toBe(0)
    expect(getWarningLevel(50)).toBe(0)
    expect(getWarningLevel(79.9)).toBe(0)
  })

  it('returns 80 for usage at exactly 80%', () => {
    expect(getWarningLevel(80)).toBe(80)
  })

  it('returns 80 for usage between 80% and 90%', () => {
    expect(getWarningLevel(85)).toBe(80)
    expect(getWarningLevel(89.9)).toBe(80)
  })

  it('returns 90 for usage at exactly 90%', () => {
    expect(getWarningLevel(90)).toBe(90)
  })

  it('returns 90 for usage between 90% and 100%', () => {
    expect(getWarningLevel(95)).toBe(90)
    expect(getWarningLevel(99.9)).toBe(90)
  })

  it('returns 100 for usage at exactly 100%', () => {
    expect(getWarningLevel(100)).toBe(100)
  })

  it('returns 100 for usage above 100% (over-quota)', () => {
    expect(getWarningLevel(110)).toBe(100)
  })
})
