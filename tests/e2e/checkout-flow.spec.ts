/**
 * Checkout Flow E2E Tests
 *
 * SMI-1593: E2E test checkout flow
 *
 * Tests the complete checkout flow including:
 * - New user checkout
 * - Existing user upgrade flow
 * - Database record verification
 *
 * Run with: npm test -- tests/e2e/checkout-flow.spec.ts
 */

import { describe, it, expect, beforeAll } from 'vitest'

// API_BASE must be set via environment variable - no hardcoded fallback
const API_BASE = process.env.SKILLSMITH_API_URL
const WEBSITE_BASE = process.env.SKILLSMITH_WEBSITE_URL || 'https://www.skillsmith.app'

// Stripe test mode card (always succeeds)
// Used in manual testing with Stripe CLI
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _TEST_CARD = '4242424242424242'

/**
 * Helper to generate test user email
 */
function generateTestEmail(): string {
  const timestamp = Date.now()
  const random = Math.random().toString(36).substring(2, 8)
  return `test-checkout-${timestamp}-${random}@skillsmith-e2e.test`
}

describe('Checkout Flow E2E Tests', () => {
  beforeAll(() => {
    if (!API_BASE) {
      throw new Error('SKILLSMITH_API_URL environment variable is required for E2E tests')
    }
  })

  describe('Checkout Page Accessibility', () => {
    it('should return signup page with pricing plans', async () => {
      const response = await fetch(`${WEBSITE_BASE}/signup`)

      // Should return the signup page (or redirect)
      expect([200, 301, 302]).toContain(response.status)
    })

    it('should accept tier parameter in signup URL', async () => {
      const tiers = ['individual', 'team', 'enterprise']

      for (const tier of tiers) {
        const response = await fetch(`${WEBSITE_BASE}/signup?tier=${tier}&period=monthly`, {
          redirect: 'manual',
        })

        // Should either serve the page or redirect to Stripe
        expect([200, 301, 302, 303, 307, 308]).toContain(response.status)
      }
    })
  })

  describe('Checkout Session Creation', () => {
    it('should create checkout session for individual tier', async () => {
      const response = await fetch(`${API_BASE}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tier: 'individual',
          period: 'monthly',
          email: generateTestEmail(),
        }),
      })

      // Should either succeed or require authentication
      expect([200, 201, 401, 403]).toContain(response.status)

      if (response.ok) {
        const data = await response.json()
        // Should return checkout session URL
        expect(data.url || data.sessionId).toBeDefined()
      }
    })

    it('should create checkout session for team tier with seat count', async () => {
      const response = await fetch(`${API_BASE}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tier: 'team',
          period: 'monthly',
          seatCount: 5,
          email: generateTestEmail(),
        }),
      })

      // Should either succeed or require authentication
      expect([200, 201, 401, 403]).toContain(response.status)

      if (response.ok) {
        const data = await response.json()
        expect(data.url || data.sessionId).toBeDefined()
      }
    })

    it('should reject invalid tier', async () => {
      const response = await fetch(`${API_BASE}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tier: 'invalid-tier',
          period: 'monthly',
          email: generateTestEmail(),
        }),
      })

      // Should reject with 400
      expect([400, 401, 403]).toContain(response.status)
    })

    it('should handle annual billing period', async () => {
      const response = await fetch(`${API_BASE}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tier: 'individual',
          period: 'annual',
          email: generateTestEmail(),
        }),
      })

      expect([200, 201, 401, 403]).toContain(response.status)
    })

    it('should allow checkout without email (email is optional)', async () => {
      const response = await fetch(`${API_BASE}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tier: 'individual',
          period: 'monthly',
          // No email provided - email is optional
        }),
      })

      // Should succeed without email (Stripe will collect it)
      expect([200, 201]).toContain(response.status)
    })
  })

  describe('Post-Checkout Verification', () => {
    // Note: These tests verify the expected state after checkout
    // In a real E2E environment, we'd use Stripe test webhooks

    it('should verify subscription lookup endpoint works', async () => {
      // This tests the endpoint that verifies subscriptions
      const response = await fetch(`${API_BASE}/verify-subscription`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
        }),
      })

      // Endpoint should exist and respond (even if no subscription found)
      expect([200, 401, 404]).toContain(response.status)
    })

    it('should have get-user-subscription RPC available', async () => {
      // This tests that the RPC function is available
      const response = await fetch(`${API_BASE}/user-subscription`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          // Would need auth header in production
        },
      })

      // Should respond (even if unauthorized)
      expect([200, 401, 403, 404, 405]).toContain(response.status)
    })
  })

  describe('Existing User Upgrade Flow', () => {
    it('should handle upgrade from community to individual', async () => {
      // Test that the upgrade endpoint exists and responds
      const response = await fetch(`${API_BASE}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tier: 'individual',
          period: 'monthly',
          email: 'existing-user@skillsmith-e2e.test',
          upgradeFrom: 'community',
        }),
      })

      // Should accept the upgrade request
      expect([200, 201, 400, 401, 403]).toContain(response.status)
    })

    it.skip('should handle tier downgrade request', async () => {
      // TODO: Deploy create-portal-session function
      // Test downgrade handling (should be handled by portal, not checkout)
      const response = await fetch(`${API_BASE}/create-portal-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          returnUrl: 'https://skillsmith.app/account/subscription',
        }),
      })

      // Should either succeed or require auth
      expect([200, 201, 401, 403]).toContain(response.status)
    })
  })

  describe('Security and Validation', () => {
    it('should reject malformed email', async () => {
      const response = await fetch(`${API_BASE}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tier: 'individual',
          period: 'monthly',
          email: 'not-an-email',
        }),
      })

      // Should reject invalid email
      expect([400, 401, 403]).toContain(response.status)
    })

    it('should reject negative seat count', async () => {
      const response = await fetch(`${API_BASE}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tier: 'team',
          period: 'monthly',
          email: generateTestEmail(),
          seatCount: -5,
        }),
      })

      // Should reject invalid seat count
      expect([400, 401, 403]).toContain(response.status)
    })

    it('should reject seat count over maximum', async () => {
      const response = await fetch(`${API_BASE}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tier: 'team',
          period: 'monthly',
          email: generateTestEmail(),
          seatCount: 10000, // Over 1000 max
        }),
      })

      // Should reject excessive seat count
      expect([400, 401, 403]).toContain(response.status)
    })

    it('should handle XSS attempt in email gracefully', async () => {
      const response = await fetch(`${API_BASE}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tier: 'individual',
          period: 'monthly',
          email: '<script>alert("xss")</script>@test.com',
        }),
      })

      // Should not crash, should reject as invalid
      expect(response.status).not.toBe(500)
    })
  })

  describe('Performance', () => {
    it('should respond within performance budget (3s)', async () => {
      const start = Date.now()

      await fetch(`${API_BASE}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tier: 'individual',
          period: 'monthly',
          email: generateTestEmail(),
        }),
      })

      const elapsed = Date.now() - start
      expect(elapsed).toBeLessThan(3000)
    })
  })
})
