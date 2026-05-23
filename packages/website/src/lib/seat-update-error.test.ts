import { describe, expect, it } from 'vitest'
import { isNoStripeSubscription, seatErrorMessage } from './seat-update-error'

describe('isNoStripeSubscription', () => {
  it('is true when details.code is no_stripe_subscription', () => {
    expect(
      isNoStripeSubscription({ error: 'msg', details: { code: 'no_stripe_subscription' } })
    ).toBe(true)
  })

  it('is false for a top-level code (the cors.ts wraps under details)', () => {
    expect(isNoStripeSubscription({ error: 'msg', code: 'no_stripe_subscription' })).toBe(false)
  })

  it('is false for the truly-no-subscription 404 body', () => {
    expect(isNoStripeSubscription({ error: 'No active subscription found' })).toBe(false)
  })

  it('is false for a different details.code', () => {
    expect(isNoStripeSubscription({ error: 'x', details: { code: 'something_else' } })).toBe(false)
  })

  it('handles null/undefined/non-object safely', () => {
    expect(isNoStripeSubscription(null)).toBe(false)
    expect(isNoStripeSubscription(undefined)).toBe(false)
    expect(isNoStripeSubscription('nope')).toBe(false)
    expect(isNoStripeSubscription({})).toBe(false)
  })
})

describe('seatErrorMessage', () => {
  it('returns the body error message', () => {
    expect(seatErrorMessage({ error: 'Contact support to adjust seats.' })).toBe(
      'Contact support to adjust seats.'
    )
  })

  it('falls back when error is missing or empty', () => {
    expect(seatErrorMessage({})).toBe('Failed to update seats')
    expect(seatErrorMessage({ error: '' })).toBe('Failed to update seats')
    expect(seatErrorMessage(null)).toBe('Failed to update seats')
  })

  it('respects a custom fallback', () => {
    expect(seatErrorMessage(undefined, 'Failed to preview seat change')).toBe(
      'Failed to preview seat change'
    )
  })
})
