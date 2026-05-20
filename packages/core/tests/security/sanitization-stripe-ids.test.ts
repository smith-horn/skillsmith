/**
 * SMI-1062: Stripe ID Validator Tests
 *
 * Tests for Stripe ID validation and sanitization functions.
 */

import { describe, it, expect } from 'vitest'
import {
  isValidStripeId,
  sanitizeStripeCustomerId,
  sanitizeStripeSubscriptionId,
  sanitizeStripePriceId,
  sanitizeStripeInvoiceId,
  sanitizeStripeEventId,
} from '../../src/security/sanitization.js'

describe('Stripe ID Validators', () => {
  describe('isValidStripeId', () => {
    it('should validate customer IDs', () => {
      expect(isValidStripeId('cus_OtLqEJvHu1Mvxm', 'customer')).toBe(true)
      expect(isValidStripeId('cus_123456789abcdef', 'customer')).toBe(true)
      expect(isValidStripeId('cus_a', 'customer')).toBe(true)
    })

    it('should validate subscription IDs', () => {
      expect(isValidStripeId('sub_1234567890abcdef', 'subscription')).toBe(true)
      expect(isValidStripeId('sub_ABC123', 'subscription')).toBe(true)
    })

    it('should validate price IDs', () => {
      expect(isValidStripeId('price_1234567890abcdef', 'price')).toBe(true)
      expect(isValidStripeId('price_team_monthly', 'price')).toBe(false) // underscores not allowed
    })

    it('should validate invoice IDs', () => {
      expect(isValidStripeId('in_1234567890abcdef', 'invoice')).toBe(true)
    })

    it('should validate event IDs', () => {
      expect(isValidStripeId('evt_1234567890abcdef', 'event')).toBe(true)
    })

    it('should reject invalid IDs', () => {
      // Wrong prefix
      expect(isValidStripeId('sub_123', 'customer')).toBe(false)
      expect(isValidStripeId('cus_123', 'subscription')).toBe(false)

      // No prefix
      expect(isValidStripeId('123456789', 'customer')).toBe(false)

      // Special characters in suffix
      expect(isValidStripeId('cus_123-456', 'customer')).toBe(false)
      expect(isValidStripeId('cus_123_456', 'customer')).toBe(false)
      expect(isValidStripeId('cus_<script>', 'customer')).toBe(false)

      // Too short
      expect(isValidStripeId('cus_', 'customer')).toBe(false)
      expect(isValidStripeId('cus', 'customer')).toBe(false)

      // Empty or null - use unknown cast to test defensive behavior
      expect(isValidStripeId('', 'customer')).toBe(false)
      expect(isValidStripeId(null as unknown as string, 'customer')).toBe(false)
      expect(isValidStripeId(undefined as unknown as string, 'customer')).toBe(false)
    })

    it('should reject IDs exceeding max length', () => {
      // ID exactly at max length (4 char prefix + 96 chars = 100)
      const maxLengthId = 'cus_' + 'a'.repeat(96)
      expect(isValidStripeId(maxLengthId, 'customer')).toBe(true) // exactly at default max of 100

      // ID exceeding max length
      const longId = 'cus_' + 'a'.repeat(100) // 104 chars total
      expect(isValidStripeId(longId, 'customer')).toBe(false) // exceeds default max of 100
      expect(isValidStripeId(longId, 'customer', 50)).toBe(false)
    })
  })

  describe('sanitizeStripeCustomerId', () => {
    it('should return valid customer IDs unchanged', () => {
      const id = 'cus_OtLqEJvHu1Mvxm'
      expect(sanitizeStripeCustomerId(id)).toBe(id)
    })

    it('should return empty string for invalid customer IDs', () => {
      expect(sanitizeStripeCustomerId('invalid')).toBe('')
      expect(sanitizeStripeCustomerId('sub_123456')).toBe('')
      expect(sanitizeStripeCustomerId('cus_<script>alert(1)</script>')).toBe('')
    })
  })

  describe('sanitizeStripeSubscriptionId', () => {
    it('should return valid subscription IDs unchanged', () => {
      const id = 'sub_1234567890abcdef'
      expect(sanitizeStripeSubscriptionId(id)).toBe(id)
    })

    it('should return empty string for invalid subscription IDs', () => {
      expect(sanitizeStripeSubscriptionId('cus_123456')).toBe('')
      expect(sanitizeStripeSubscriptionId('invalid')).toBe('')
    })
  })

  describe('sanitizeStripePriceId', () => {
    it('should return valid price IDs unchanged', () => {
      const id = 'price_1234567890abcdef'
      expect(sanitizeStripePriceId(id)).toBe(id)
    })

    it('should return empty string for invalid price IDs', () => {
      expect(sanitizeStripePriceId('invalid')).toBe('')
      expect(sanitizeStripePriceId('prod_123456')).toBe('')
    })
  })

  describe('sanitizeStripeInvoiceId', () => {
    it('should return valid invoice IDs unchanged', () => {
      const id = 'in_1234567890abcdef'
      expect(sanitizeStripeInvoiceId(id)).toBe(id)
    })

    it('should return empty string for invalid invoice IDs', () => {
      expect(sanitizeStripeInvoiceId('invalid')).toBe('')
    })
  })

  describe('sanitizeStripeEventId', () => {
    it('should return valid event IDs unchanged', () => {
      const id = 'evt_1234567890abcdef'
      expect(sanitizeStripeEventId(id)).toBe(id)
    })

    it('should return empty string for invalid event IDs', () => {
      expect(sanitizeStripeEventId('invalid')).toBe('')
    })
  })
})
