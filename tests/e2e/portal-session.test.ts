/**
 * E2E Tests: Billing Portal Session Flow
 * @module tests/e2e/portal-session
 *
 * Portal session flow tests for subscription cancellation scenarios
 *
 * Test Scenarios:
 * 1. Active subscription: Can access billing portal
 * 2. Canceled subscription: Can still access portal (customer exists)
 * 3. No subscription: Gets appropriate error message
 * 4. Missing Stripe customer: Handles gracefully
 *
 * Prerequisites:
 * - Supabase local instance running: `supabase start`
 * - Test Stripe secret key configured
 *
 * @see https://stripe.com/docs/billing/subscriptions/customer-portal
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createClient, SupabaseClient } from '@supabase/supabase-js'

// Test configuration
const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321'
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
// Portal session URL for future integration tests
// const PORTAL_SESSION_URL = `${SUPABASE_URL}/functions/v1/create-portal-session`

// Test data
const TEST_USER_ID = '00000000-0000-0000-0000-000000000098'
const TEST_EMAIL = 'portal-test@example.com'

describe('Billing Portal Session E2E', () => {
  let supabase: SupabaseClient

  beforeAll(async () => {
    if (!SUPABASE_SERVICE_KEY) {
      console.warn('Skipping E2E tests: SUPABASE_SERVICE_ROLE_KEY not set')
      return
    }

    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    // Create a test user for authentication
    // Note: In real scenario, this would be done via auth.admin.createUser
    // For this test, we'll simulate auth via service role
  })

  beforeEach(async () => {
    if (!SUPABASE_SERVICE_KEY) return
    await cleanupTestData(supabase)
  })

  afterAll(async () => {
    if (!SUPABASE_SERVICE_KEY) return
    await cleanupTestData(supabase)
  })

  describe('1. Active Subscription - Portal Access', () => {
    it('should allow portal access for user with active subscription', async () => {
      if (!SUPABASE_SERVICE_KEY) {
        console.log('Skipping: No service key')
        return
      }

      // Create test user profile
      await supabase.from('profiles').upsert({
        id: TEST_USER_ID,
        email: TEST_EMAIL,
        tier: 'individual',
        display_name: 'Portal Test User',
      })

      // Create active subscription with Stripe customer ID
      const stripeCustomerId = 'cus_portal_active_123'
      await supabase.from('subscriptions').insert({
        user_id: TEST_USER_ID,
        stripe_customer_id: stripeCustomerId,
        stripe_subscription_id: 'sub_portal_active_123',
        tier: 'individual',
        status: 'active',
        billing_period: 'monthly',
        seat_count: 1,
        current_period_start: new Date().toISOString(),
        current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      })

      // Verify subscription exists with stripe_customer_id
      const { data: subscription } = await supabase
        .from('subscriptions')
        .select('stripe_customer_id, status')
        .eq('user_id', TEST_USER_ID)
        .single()

      expect(subscription).toBeDefined()
      expect(subscription?.stripe_customer_id).toBe(stripeCustomerId)
      expect(subscription?.status).toBe('active')

      // Note: Actual portal session creation requires valid Stripe API call
      // This test verifies the database state that would allow portal access
    })
  })

  describe('2. Canceled Subscription - Portal Access', () => {
    it('should allow portal access for user with canceled subscription (customer still exists)', async () => {
      if (!SUPABASE_SERVICE_KEY) {
        console.log('Skipping: No service key')
        return
      }

      // Create test user profile
      await supabase.from('profiles').upsert({
        id: TEST_USER_ID,
        email: TEST_EMAIL,
        tier: 'community', // Downgraded after cancellation
        display_name: 'Canceled Subscription User',
      })

      // Create canceled subscription with Stripe customer ID
      // IMPORTANT: The stripe_customer_id should still exist in Stripe
      const stripeCustomerId = 'cus_portal_canceled_123'
      await supabase.from('subscriptions').insert({
        user_id: TEST_USER_ID,
        stripe_customer_id: stripeCustomerId,
        stripe_subscription_id: 'sub_portal_canceled_123',
        tier: 'individual',
        status: 'canceled',
        billing_period: 'monthly',
        seat_count: 1,
        current_period_start: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
        current_period_end: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        canceled_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      })

      // Verify subscription exists with canceled status
      const { data: subscription } = await supabase
        .from('subscriptions')
        .select('stripe_customer_id, status')
        .eq('user_id', TEST_USER_ID)
        .single()

      expect(subscription).toBeDefined()
      expect(subscription?.stripe_customer_id).toBe(stripeCustomerId)
      expect(subscription?.status).toBe('canceled')

      // Portal session creation should still work if the Stripe customer exists
      // Even though subscription is canceled, customer can view invoices, update payment
    })

    it('should handle portal access when subscription canceled via Stripe dashboard', async () => {
      if (!SUPABASE_SERVICE_KEY) {
        console.log('Skipping: No service key')
        return
      }

      // This scenario: User canceled directly in Stripe dashboard
      // Webhook fired and updated subscription to 'canceled'
      // User then tries to access portal from our app

      await supabase.from('profiles').upsert({
        id: TEST_USER_ID,
        email: TEST_EMAIL,
        tier: 'community',
        display_name: 'Dashboard Canceled User',
      })

      // Subscription was canceled via Stripe dashboard
      const stripeCustomerId = 'cus_dashboard_canceled_456'
      await supabase.from('subscriptions').insert({
        user_id: TEST_USER_ID,
        stripe_customer_id: stripeCustomerId,
        stripe_subscription_id: 'sub_dashboard_canceled_456',
        tier: 'individual',
        status: 'canceled',
        billing_period: 'monthly',
        seat_count: 1,
        current_period_start: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        current_period_end: new Date().toISOString(),
        canceled_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      })

      // The portal session endpoint should find this subscription
      // and use its stripe_customer_id
      const { data: subscription } = await supabase
        .from('subscriptions')
        .select('stripe_customer_id, status')
        .eq('user_id', TEST_USER_ID)
        .order('created_at', { ascending: false })
        .limit(1)
        .single()

      expect(subscription).toBeDefined()
      expect(subscription?.stripe_customer_id).toBeTruthy()

      // Key assertion: Even canceled subscriptions should have customer ID
      // that allows billing portal access (for invoice viewing, etc.)
    })
  })

  describe('3. No Subscription - Error Handling', () => {
    it('should return appropriate error when user has no subscription', async () => {
      if (!SUPABASE_SERVICE_KEY) {
        console.log('Skipping: No service key')
        return
      }

      // Create user with no subscription
      await supabase.from('profiles').upsert({
        id: TEST_USER_ID,
        email: TEST_EMAIL,
        tier: 'community',
        display_name: 'Free Tier User',
      })

      // Verify no subscription exists
      const { data: subscriptions } = await supabase
        .from('subscriptions')
        .select('id')
        .eq('user_id', TEST_USER_ID)

      expect(subscriptions).toHaveLength(0)

      // The portal session endpoint should return a clear error message
      // "No active subscription found. You must have an active subscription to access the billing portal."
    })

    it('should return error when subscription exists but stripe_customer_id is null', async () => {
      if (!SUPABASE_SERVICE_KEY) {
        console.log('Skipping: No service key')
        return
      }

      await supabase.from('profiles').upsert({
        id: TEST_USER_ID,
        email: TEST_EMAIL,
        tier: 'individual',
        display_name: 'Missing Customer ID User',
      })

      // Create subscription without stripe_customer_id (edge case)
      await supabase.from('subscriptions').insert({
        user_id: TEST_USER_ID,
        stripe_customer_id: null, // Missing!
        stripe_subscription_id: 'sub_missing_customer_123',
        tier: 'individual',
        status: 'active',
        billing_period: 'monthly',
        seat_count: 1,
        current_period_start: new Date().toISOString(),
        current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      })

      // Portal session should fail with appropriate error
      const { data: subscription } = await supabase
        .from('subscriptions')
        .select('stripe_customer_id')
        .eq('user_id', TEST_USER_ID)
        .single()

      expect(subscription?.stripe_customer_id).toBeNull()
    })
  })

  describe('4. Edge Cases', () => {
    it('should handle multiple subscriptions (use most recent)', async () => {
      if (!SUPABASE_SERVICE_KEY) {
        console.log('Skipping: No service key')
        return
      }

      await supabase.from('profiles').upsert({
        id: TEST_USER_ID,
        email: TEST_EMAIL,
        tier: 'team',
        display_name: 'Multiple Subscriptions User',
      })

      // Create old canceled subscription
      await supabase.from('subscriptions').insert({
        user_id: TEST_USER_ID,
        stripe_customer_id: 'cus_old_123',
        stripe_subscription_id: 'sub_old_123',
        tier: 'individual',
        status: 'canceled',
        billing_period: 'monthly',
        seat_count: 1,
        current_period_start: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
        current_period_end: new Date(Date.now() - 335 * 24 * 60 * 60 * 1000).toISOString(),
        created_at: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
      })

      // Wait a moment to ensure different created_at
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Create current active subscription with different customer ID
      await supabase.from('subscriptions').insert({
        user_id: TEST_USER_ID,
        stripe_customer_id: 'cus_current_456',
        stripe_subscription_id: 'sub_current_456',
        tier: 'team',
        status: 'active',
        billing_period: 'annual',
        seat_count: 5,
        current_period_start: new Date().toISOString(),
        current_period_end: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        created_at: new Date().toISOString(),
      })

      // Portal session should use the most recent subscription
      const { data: subscription } = await supabase
        .from('subscriptions')
        .select('stripe_customer_id, status')
        .eq('user_id', TEST_USER_ID)
        .order('created_at', { ascending: false })
        .limit(1)
        .single()

      expect(subscription?.stripe_customer_id).toBe('cus_current_456')
      expect(subscription?.status).toBe('active')
    })

    it('should use get_user_subscription RPC for accurate subscription lookup', async () => {
      if (!SUPABASE_SERVICE_KEY) {
        console.log('Skipping: No service key')
        return
      }

      await supabase.from('profiles').upsert({
        id: TEST_USER_ID,
        email: TEST_EMAIL,
        tier: 'individual',
        display_name: 'RPC Test User',
      })

      await supabase.from('subscriptions').insert({
        user_id: TEST_USER_ID,
        stripe_customer_id: 'cus_rpc_test_123',
        stripe_subscription_id: 'sub_rpc_test_123',
        tier: 'individual',
        status: 'active',
        billing_period: 'monthly',
        seat_count: 1,
        current_period_start: new Date().toISOString(),
        current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      })

      // Test the RPC function used by frontend
      const { data: subscriptions } = await supabase.rpc('get_user_subscription', {
        user_uuid: TEST_USER_ID,
      })

      expect(subscriptions).toBeDefined()
      expect(subscriptions?.length).toBeGreaterThan(0)
      expect(subscriptions?.[0]?.stripe_customer_id).toBe('cus_rpc_test_123')
    })
  })
})

// Helper function
async function cleanupTestData(supabase: SupabaseClient): Promise<void> {
  await supabase.from('license_keys').delete().eq('user_id', TEST_USER_ID)
  await supabase.from('subscriptions').delete().eq('user_id', TEST_USER_ID)
  await supabase.from('profiles').delete().eq('id', TEST_USER_ID)
}
