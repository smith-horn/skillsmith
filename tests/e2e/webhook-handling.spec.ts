/**
 * Webhook Handling E2E Tests
 *
 * SMI-1593: E2E test webhook handling
 *
 * Tests the Stripe webhook handler including:
 * - Signature validation
 * - Idempotency handling
 * - Event processing
 *
 * Note: These tests simulate webhook behavior without actual Stripe events.
 * For full integration testing, use Stripe CLI with test webhooks.
 *
 * Run with: npm test -- tests/e2e/webhook-handling.spec.ts
 */

import { describe, it, expect } from 'vitest'
import { createHmac } from 'crypto'

const API_BASE = process.env.SKILLSMITH_API_URL || 'https://api.skillsmith.app/functions/v1'

/**
 * Generate a fake Stripe webhook signature for testing
 * Note: This will fail validation (intentionally) to test signature rejection
 */
function generateFakeStripeSignature(payload: string, timestamp: number): string {
  const fakeSecret = 'whsec_test_fake_secret_for_testing_only'
  const signedPayload = `${timestamp}.${payload}`
  const signature = createHmac('sha256', fakeSecret)
    .update(signedPayload)
    .digest('hex')
  return `t=${timestamp},v1=${signature}`
}

/**
 * Create a mock Stripe checkout.session.completed event
 */
function createMockCheckoutEvent(options: {
  customerId?: string
  subscriptionId?: string
  email?: string
  tier?: string
}): Record<string, unknown> {
  return {
    id: `evt_test_${Date.now()}`,
    object: 'event',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: `cs_test_${Date.now()}`,
        object: 'checkout.session',
        mode: 'subscription',
        customer: options.customerId || 'cus_test123',
        subscription: options.subscriptionId || 'sub_test123',
        customer_email: options.email || 'test@example.com',
        customer_details: {
          email: options.email || 'test@example.com',
          name: 'Test User',
        },
        metadata: {
          tier: options.tier || 'individual',
          seatCount: '1',
          billingPeriod: 'monthly',
        },
      },
    },
  }
}

/**
 * Create a mock Stripe subscription.updated event
 */
function createMockSubscriptionUpdatedEvent(options: {
  subscriptionId?: string
  status?: string
}): Record<string, unknown> {
  return {
    id: `evt_test_${Date.now()}`,
    object: 'event',
    type: 'customer.subscription.updated',
    data: {
      object: {
        id: options.subscriptionId || 'sub_test123',
        object: 'subscription',
        status: options.status || 'active',
        current_period_start: Math.floor(Date.now() / 1000),
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
        cancel_at_period_end: false,
        canceled_at: null,
      },
    },
  }
}

describe('Webhook Handling E2E Tests', () => {
  describe('Signature Validation', () => {
    it('should reject requests without stripe-signature header', async () => {
      const payload = JSON.stringify(createMockCheckoutEvent({}))

      const response = await fetch(`${API_BASE}/stripe-webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Intentionally omitting stripe-signature header
        },
        body: payload,
      })

      // Should reject with 400 for missing signature
      expect(response.status).toBe(400)
    })

    it('should reject requests with invalid signature', async () => {
      const payload = JSON.stringify(createMockCheckoutEvent({}))
      const timestamp = Math.floor(Date.now() / 1000)
      const fakeSignature = generateFakeStripeSignature(payload, timestamp)

      const response = await fetch(`${API_BASE}/stripe-webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': fakeSignature,
        },
        body: payload,
      })

      // Should reject with 400 for invalid signature
      expect(response.status).toBe(400)
    })

    it('should reject malformed signature header', async () => {
      const payload = JSON.stringify(createMockCheckoutEvent({}))

      const response = await fetch(`${API_BASE}/stripe-webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': 'malformed-signature-not-valid-format',
        },
        body: payload,
      })

      // Should reject with 400 for malformed signature
      expect(response.status).toBe(400)
    })

    it('should reject empty signature', async () => {
      const payload = JSON.stringify(createMockCheckoutEvent({}))

      const response = await fetch(`${API_BASE}/stripe-webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': '',
        },
        body: payload,
      })

      // Should reject with 400 for empty signature
      expect(response.status).toBe(400)
    })

    it('should reject expired timestamp in signature', async () => {
      const payload = JSON.stringify(createMockCheckoutEvent({}))
      // Timestamp from 10 minutes ago (Stripe default tolerance is 5 minutes)
      const oldTimestamp = Math.floor(Date.now() / 1000) - 600
      const expiredSignature = generateFakeStripeSignature(payload, oldTimestamp)

      const response = await fetch(`${API_BASE}/stripe-webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': expiredSignature,
        },
        body: payload,
      })

      // Should reject with 400 for expired signature
      expect(response.status).toBe(400)
    })
  })

  describe('HTTP Method Validation', () => {
    it('should reject GET requests', async () => {
      const response = await fetch(`${API_BASE}/stripe-webhook`, {
        method: 'GET',
      })

      // Should reject with 405 Method Not Allowed
      expect(response.status).toBe(405)
    })

    it('should reject PUT requests', async () => {
      const response = await fetch(`${API_BASE}/stripe-webhook`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': 't=123,v1=fake',
        },
        body: JSON.stringify({}),
      })

      // Should reject with 405 Method Not Allowed
      expect(response.status).toBe(405)
    })

    it('should reject DELETE requests', async () => {
      const response = await fetch(`${API_BASE}/stripe-webhook`, {
        method: 'DELETE',
      })

      // Should reject with 405 Method Not Allowed
      expect(response.status).toBe(405)
    })
  })

  describe('Payload Validation', () => {
    it('should reject malformed JSON', async () => {
      const timestamp = Math.floor(Date.now() / 1000)
      const malformedJson = '{ invalid json {'
      const signature = generateFakeStripeSignature(malformedJson, timestamp)

      const response = await fetch(`${API_BASE}/stripe-webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': signature,
        },
        body: malformedJson,
      })

      // Should reject with 400 for malformed JSON
      expect(response.status).toBe(400)
    })

    it('should reject empty body', async () => {
      const timestamp = Math.floor(Date.now() / 1000)
      const signature = generateFakeStripeSignature('', timestamp)

      const response = await fetch(`${API_BASE}/stripe-webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': signature,
        },
        body: '',
      })

      // Should reject with 400 for empty body
      expect(response.status).toBe(400)
    })
  })

  describe('Idempotency', () => {
    // Note: True idempotency testing requires valid Stripe signatures
    // These tests verify the endpoint exists and handles repeated calls

    it('should handle rapid repeated requests gracefully', async () => {
      const payload = JSON.stringify(createMockCheckoutEvent({
        customerId: 'cus_idempotency_test',
      }))
      const timestamp = Math.floor(Date.now() / 1000)
      const signature = generateFakeStripeSignature(payload, timestamp)

      // Send multiple rapid requests
      const requests = Array(3).fill(null).map(() =>
        fetch(`${API_BASE}/stripe-webhook`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'stripe-signature': signature,
          },
          body: payload,
        })
      )

      const responses = await Promise.all(requests)

      // All should respond (likely 400 due to invalid signature)
      // The key is that none should cause server errors
      for (const response of responses) {
        expect([200, 400, 401, 403]).toContain(response.status)
      }
    })
  })

  describe('Event Type Handling', () => {
    // Note: Without valid signatures, we test that the endpoint responds
    // For actual event processing, use Stripe CLI: stripe trigger checkout.session.completed

    it('should handle checkout.session.completed event type', async () => {
      const event = createMockCheckoutEvent({})
      const payload = JSON.stringify(event)
      const timestamp = Math.floor(Date.now() / 1000)
      const signature = generateFakeStripeSignature(payload, timestamp)

      const response = await fetch(`${API_BASE}/stripe-webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': signature,
        },
        body: payload,
      })

      // Will reject due to invalid signature, but should not crash
      expect(response.status).toBe(400)
      expect(response.status).not.toBe(500)
    })

    it('should handle customer.subscription.updated event type', async () => {
      const event = createMockSubscriptionUpdatedEvent({})
      const payload = JSON.stringify(event)
      const timestamp = Math.floor(Date.now() / 1000)
      const signature = generateFakeStripeSignature(payload, timestamp)

      const response = await fetch(`${API_BASE}/stripe-webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': signature,
        },
        body: payload,
      })

      // Will reject due to invalid signature, but should not crash
      expect(response.status).toBe(400)
      expect(response.status).not.toBe(500)
    })

    it('should handle invoice.payment_failed event type', async () => {
      const event = {
        id: `evt_test_${Date.now()}`,
        object: 'event',
        type: 'invoice.payment_failed',
        data: {
          object: {
            id: `in_test_${Date.now()}`,
            object: 'invoice',
            subscription: 'sub_test123',
            customer_email: 'test@example.com',
            attempt_count: 1,
          },
        },
      }
      const payload = JSON.stringify(event)
      const timestamp = Math.floor(Date.now() / 1000)
      const signature = generateFakeStripeSignature(payload, timestamp)

      const response = await fetch(`${API_BASE}/stripe-webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': signature,
        },
        body: payload,
      })

      // Will reject due to invalid signature, but should not crash
      expect(response.status).toBe(400)
      expect(response.status).not.toBe(500)
    })
  })

  describe('Security', () => {
    it('should not expose internal errors in response', async () => {
      const timestamp = Math.floor(Date.now() / 1000)
      const payload = JSON.stringify({ malicious: 'payload' })
      const signature = generateFakeStripeSignature(payload, timestamp)

      const response = await fetch(`${API_BASE}/stripe-webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': signature,
        },
        body: payload,
      })

      // Should not expose stack traces or internal details
      const text = await response.text()
      expect(text).not.toContain('at ')
      expect(text).not.toContain('Error:')
      expect(text).not.toContain('stack')
    })

    it('should handle SQL injection attempt safely', async () => {
      const event = createMockCheckoutEvent({
        email: "test@example.com'; DROP TABLE users; --",
      })
      const payload = JSON.stringify(event)
      const timestamp = Math.floor(Date.now() / 1000)
      const signature = generateFakeStripeSignature(payload, timestamp)

      const response = await fetch(`${API_BASE}/stripe-webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': signature,
        },
        body: payload,
      })

      // Should reject (invalid signature) but not crash
      expect(response.status).not.toBe(500)
    })

    it('should handle XSS attempt safely', async () => {
      const event = createMockCheckoutEvent({
        email: '<script>alert("xss")</script>@test.com',
      })
      const payload = JSON.stringify(event)
      const timestamp = Math.floor(Date.now() / 1000)
      const signature = generateFakeStripeSignature(payload, timestamp)

      const response = await fetch(`${API_BASE}/stripe-webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': signature,
        },
        body: payload,
      })

      // Should reject (invalid signature) but not crash
      expect(response.status).not.toBe(500)
    })
  })

  describe('Performance', () => {
    it('should respond within performance budget (2s)', async () => {
      const event = createMockCheckoutEvent({})
      const payload = JSON.stringify(event)
      const timestamp = Math.floor(Date.now() / 1000)
      const signature = generateFakeStripeSignature(payload, timestamp)

      const start = Date.now()

      await fetch(`${API_BASE}/stripe-webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': signature,
        },
        body: payload,
      })

      const elapsed = Date.now() - start
      expect(elapsed).toBeLessThan(2000)
    })
  })

  describe('Content Type', () => {
    it('should reject non-JSON content type', async () => {
      const timestamp = Math.floor(Date.now() / 1000)
      const signature = generateFakeStripeSignature('<xml>bad</xml>', timestamp)

      const response = await fetch(`${API_BASE}/stripe-webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/xml',
          'stripe-signature': signature,
        },
        body: '<xml>bad</xml>',
      })

      // Should reject non-JSON content
      expect([400, 415]).toContain(response.status)
    })
  })
})

/**
 * Integration Test Instructions
 *
 * For full integration testing with real Stripe events, use the Stripe CLI:
 *
 * 1. Install Stripe CLI: brew install stripe/stripe-cli/stripe
 * 2. Login: stripe login
 * 3. Forward webhooks: stripe listen --forward-to localhost:54321/functions/v1/stripe-webhook
 * 4. Trigger events: stripe trigger checkout.session.completed
 *
 * Test cards for manual testing:
 * - Success: 4242424242424242
 * - Declined: 4000000000000002
 * - Requires authentication: 4000002500003155
 */
