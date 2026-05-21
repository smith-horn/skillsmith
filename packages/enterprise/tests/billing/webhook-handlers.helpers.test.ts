/**
 * SMI-3415 / SMI-5036: Webhook helpers — pure functions
 *
 * extractTier / extractSeatCount / getCurrentPeriodEnd / getCurrentPeriodStart /
 * extractSubscriptionIdFromInvoice.
 */

import { describe, it, expect } from 'vitest'
import {
  extractTier,
  extractSeatCount,
  getCurrentPeriodEnd,
  getCurrentPeriodStart,
  extractSubscriptionIdFromInvoice,
} from '../../src/billing/webhook-handlers.js'
import { makeSubscription, makeInvoice } from './_helpers.js'

describe('extractTier', () => {
  it('should extract tier from metadata', () => {
    const sub = makeSubscription({ metadata: { tier: 'enterprise' } })
    expect(extractTier(sub)).toBe('enterprise')
  })

  it('should accept all valid tiers from metadata', () => {
    for (const tier of ['community', 'individual', 'team', 'enterprise']) {
      const sub = makeSubscription({ metadata: { tier } })
      expect(extractTier(sub)).toBe(tier)
    }
  })

  it('should default to individual for missing metadata', () => {
    const sub = makeSubscription({ metadata: {} })
    expect(extractTier(sub)).toBe('individual')
  })

  it('should default to individual for invalid tier in metadata', () => {
    const sub = makeSubscription({ metadata: { tier: 'platinum' } })
    expect(extractTier(sub)).toBe('individual')
  })
})

describe('extractSeatCount', () => {
  it('should extract seat count from metadata', () => {
    const sub = makeSubscription({ metadata: { seatCount: '10' } })
    expect(extractSeatCount(sub)).toBe(10)
  })

  it('should fall back to item quantity when metadata missing', () => {
    const sub = makeSubscription({ metadata: {} })
    expect(extractSeatCount(sub)).toBe(5) // from fixture item quantity
  })

  it('should fall back to item quantity for non-numeric metadata', () => {
    const sub = makeSubscription({ metadata: { seatCount: 'abc' } })
    expect(extractSeatCount(sub)).toBe(5)
  })

  it('should fall back to item quantity for zero seat count', () => {
    const sub = makeSubscription({ metadata: { seatCount: '0' } })
    expect(extractSeatCount(sub)).toBe(5)
  })

  it('should fall back to item quantity for negative seat count', () => {
    const sub = makeSubscription({ metadata: { seatCount: '-1' } })
    expect(extractSeatCount(sub)).toBe(5)
  })

  it('should return 1 when no items and no metadata', () => {
    const sub = makeSubscription({
      metadata: {},
      items: { data: [{ quantity: undefined, current_period_end: 1702592000 }] },
    })
    expect(extractSeatCount(sub)).toBe(1)
  })
})

describe('getCurrentPeriodEnd', () => {
  it('should return period end from first item', () => {
    const sub = makeSubscription()
    expect(getCurrentPeriodEnd(sub)).toBe(1702592000)
  })

  it('should return current timestamp when no items', () => {
    const sub = makeSubscription({ items: { data: [] } })
    const now = Math.floor(Date.now() / 1000)
    const result = getCurrentPeriodEnd(sub)
    // Should be within 2 seconds of now
    expect(Math.abs(result - now)).toBeLessThan(2)
  })
})

describe('getCurrentPeriodStart', () => {
  it('should return period start from first item', () => {
    const sub = makeSubscription()
    expect(getCurrentPeriodStart(sub)).toBe(1700000000)
  })

  it('should return current timestamp when no items', () => {
    const sub = makeSubscription({ items: { data: [] } })
    const now = Math.floor(Date.now() / 1000)
    const result = getCurrentPeriodStart(sub)
    expect(Math.abs(result - now)).toBeLessThan(2)
  })
})

describe('extractSubscriptionIdFromInvoice', () => {
  it('should extract string subscription ID', () => {
    const invoice = makeInvoice()
    expect(extractSubscriptionIdFromInvoice(invoice)).toBe('sub_test_1')
  })

  it('should extract ID from subscription object', () => {
    const invoice = makeInvoice({
      parent: {
        subscription_details: {
          subscription: { id: 'sub_obj_1' },
        },
      },
    })
    expect(extractSubscriptionIdFromInvoice(invoice)).toBe('sub_obj_1')
  })

  it('should return undefined when no parent', () => {
    const invoice = makeInvoice({ parent: undefined })
    expect(extractSubscriptionIdFromInvoice(invoice)).toBeUndefined()
  })

  it('should return undefined when no subscription_details', () => {
    const invoice = makeInvoice({ parent: {} })
    expect(extractSubscriptionIdFromInvoice(invoice)).toBeUndefined()
  })

  it('should return undefined when subscription is null', () => {
    const invoice = makeInvoice({
      parent: { subscription_details: { subscription: null } },
    })
    expect(extractSubscriptionIdFromInvoice(invoice)).toBeUndefined()
  })
})
