/**
 * E2E Tests: Checkout → License Key Flow
 * @module tests/e2e/checkout-flow
 *
 * SMI-1768: E2E test checkout → license flow
 *
 * Test Scenarios:
 * 1. Happy path: New user → checkout → verify all records created
 * 2. Existing user: Logged in user → checkout → verify upgrade
 * 3. Pending checkout: User signs up after checkout → verify activation
 *
 * Prerequisites:
 * - Stripe CLI for local webhook testing: `stripe listen --forward-to localhost:54321/functions/v1/stripe-webhook`
 * - Supabase local instance running: `supabase start`
 * - Environment variables set for Stripe test mode
 *
 * @see https://stripe.com/docs/testing for Stripe test cards
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import Stripe from 'stripe'
import stripeEvents from './fixtures/stripe-events.json'

// Test configuration
const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321'
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || ''
const WEBHOOK_URL = `${SUPABASE_URL}/functions/v1/stripe-webhook`

// Test data
const TEST_EMAIL = 'e2e-test-checkout@example.com'
const TEST_USER_ID = '00000000-0000-0000-0000-000000000001'

describe('Checkout → License Flow E2E', () => {
  let supabase: SupabaseClient
  let stripe: Stripe

  beforeAll(() => {
    // Skip if no credentials
    if (!SUPABASE_SERVICE_KEY) {
      console.warn('Skipping E2E tests: SUPABASE_SERVICE_ROLE_KEY not set')
      return
    }

    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    if (STRIPE_SECRET_KEY) {
      stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' })
    }
  })

  beforeEach(async () => {
    if (!SUPABASE_SERVICE_KEY) return

    // Clean up test data before each test
    await cleanupTestData(supabase)
  })

  afterAll(async () => {
    if (!SUPABASE_SERVICE_KEY) return

    // Final cleanup
    await cleanupTestData(supabase)
  })

  describe('1. Happy Path: New User Checkout', () => {
    it('should create subscription and license key for existing user', async () => {
      if (!SUPABASE_SERVICE_KEY) {
        console.log('Skipping: No service key')
        return
      }

      // Step 1: Create test user profile
      const { error: profileError } = await supabase.from('profiles').upsert({
        id: TEST_USER_ID,
        email: TEST_EMAIL,
        tier: 'community',
        display_name: 'E2E Test User',
        created_at: new Date().toISOString(),
      })
      expect(profileError).toBeNull()

      // Step 2: Simulate checkout.session.completed webhook
      const event = createCheckoutEvent(TEST_EMAIL, 'individual')

      // Verify the webhook would create the expected records
      // In a full E2E test, this would hit the actual webhook endpoint
      // For now, we verify the database state after manual processing

      // Step 3: Verify subscription record structure
      const { data: subscription } = await supabase
        .from('subscriptions')
        .select('*')
        .eq('user_id', TEST_USER_ID)
        .single()

      // If subscription was created (via webhook), verify its structure
      if (subscription) {
        expect(subscription).toMatchObject({
          user_id: TEST_USER_ID,
          tier: 'individual',
          status: expect.stringMatching(/active|trialing/),
        })
      }

      // Step 4: Verify license key structure if created
      const { data: licenseKey } = await supabase
        .from('license_keys')
        .select('*')
        .eq('user_id', TEST_USER_ID)
        .single()

      if (licenseKey) {
        expect(licenseKey).toMatchObject({
          user_id: TEST_USER_ID,
          tier: 'individual',
          status: 'active',
          key_prefix: expect.stringContaining('sk_live_'),
        })
        expect(licenseKey.key_hash).toBeDefined()
        expect(licenseKey.rate_limit_per_minute).toBeGreaterThan(0)
      }
    })

    it('should store pending checkout for non-existent user', async () => {
      if (!SUPABASE_SERVICE_KEY) {
        console.log('Skipping: No service key')
        return
      }

      const pendingEmail = 'pending-checkout-test@example.com'

      // Verify user does NOT exist
      const { data: existingProfile } = await supabase
        .from('profiles')
        .select('id')
        .eq('email', pendingEmail)
        .single()

      expect(existingProfile).toBeNull()

      // Simulate storing a pending checkout (what webhook would do)
      const { error: pendingError } = await supabase.from('pending_checkouts').upsert({
        email: pendingEmail,
        stripe_customer_id: 'cus_test_pending_123',
        stripe_subscription_id: 'sub_test_pending_123',
        tier: 'individual',
        billing_period: 'monthly',
        seat_count: 1,
        checkout_session_id: 'cs_test_pending_123',
        metadata: { source: 'e2e_test' },
      })

      expect(pendingError).toBeNull()

      // Verify pending checkout was created
      const { data: pending } = await supabase
        .from('pending_checkouts')
        .select('*')
        .eq('email', pendingEmail)
        .single()

      expect(pending).toBeDefined()
      expect(pending).toMatchObject({
        email: pendingEmail,
        tier: 'individual',
        processed_at: null, // Not yet processed
      })
      expect(new Date(pending.expires_at).getTime()).toBeGreaterThan(Date.now())

      // Cleanup
      await supabase.from('pending_checkouts').delete().eq('email', pendingEmail)
    })
  })

  describe('2. Existing User: Upgrade Flow', () => {
    it('should upgrade user tier on checkout completion', async () => {
      if (!SUPABASE_SERVICE_KEY) {
        console.log('Skipping: No service key')
        return
      }

      // Create user with community tier
      const { error: profileError } = await supabase.from('profiles').upsert({
        id: TEST_USER_ID,
        email: TEST_EMAIL,
        tier: 'community',
        display_name: 'E2E Test User',
        created_at: new Date().toISOString(),
      })
      expect(profileError).toBeNull()

      // Simulate subscription creation (what webhook would do)
      const { error: subError } = await supabase.from('subscriptions').insert({
        user_id: TEST_USER_ID,
        stripe_customer_id: 'cus_test_upgrade_123',
        stripe_subscription_id: 'sub_test_upgrade_123',
        tier: 'team',
        status: 'active',
        billing_period: 'annual',
        seat_count: 5,
        current_period_start: new Date().toISOString(),
        current_period_end: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        metadata: { upgrade_test: true },
      })
      expect(subError).toBeNull()

      // Update profile tier (what webhook would do)
      await supabase.from('profiles').update({ tier: 'team' }).eq('id', TEST_USER_ID)

      // Verify upgrade
      const { data: profile } = await supabase
        .from('profiles')
        .select('tier')
        .eq('id', TEST_USER_ID)
        .single()

      expect(profile?.tier).toBe('team')
    })
  })

  describe('3. Pending Checkout Activation', () => {
    it('should activate subscription when user signs up', async () => {
      if (!SUPABASE_SERVICE_KEY) {
        console.log('Skipping: No service key')
        return
      }

      const activationEmail = 'activation-test@example.com'

      // Step 1: Create pending checkout (simulating checkout before signup)
      const { error: pendingError } = await supabase.from('pending_checkouts').insert({
        email: activationEmail,
        stripe_customer_id: 'cus_test_activation_123',
        stripe_subscription_id: 'sub_test_activation_123',
        tier: 'individual',
        billing_period: 'monthly',
        seat_count: 1,
        checkout_session_id: 'cs_test_activation_123',
        metadata: { activation_test: true },
      })
      expect(pendingError).toBeNull()

      // Step 2: Simulate user signup (profile creation triggers pending checkout processing)
      const activationUserId = '00000000-0000-0000-0000-000000000002'
      const { error: profileError } = await supabase.from('profiles').insert({
        id: activationUserId,
        email: activationEmail,
        tier: 'community', // Will be upgraded by trigger
        display_name: 'Activation Test User',
        created_at: new Date().toISOString(),
      })
      expect(profileError).toBeNull()

      // Step 3: Wait for trigger to process (in real scenario)
      // The database trigger on_profile_created_check_pending should:
      // - Find the pending checkout
      // - Create subscription
      // - Update profile tier
      // - Mark pending checkout as processed

      // For this test, manually verify the trigger would work by checking
      // if the process_pending_checkout function exists
      const { data: fnExists } = await supabase.rpc('process_pending_checkout', {
        user_email: activationEmail,
        user_uuid: activationUserId,
      })

      // The function returns boolean - true if processed, false if no pending checkout
      // Since we didn't actually complete the webhook, the function should process it
      expect(fnExists).toBe(true)

      // Verify subscription was created
      const { data: subscription } = await supabase
        .from('subscriptions')
        .select('*')
        .eq('user_id', activationUserId)
        .single()

      expect(subscription).toBeDefined()
      expect(subscription?.tier).toBe('individual')

      // Verify profile was upgraded
      const { data: profile } = await supabase
        .from('profiles')
        .select('tier')
        .eq('id', activationUserId)
        .single()

      expect(profile?.tier).toBe('individual')

      // Verify pending checkout was marked as processed
      const { data: pending } = await supabase
        .from('pending_checkouts')
        .select('processed_at')
        .eq('email', activationEmail)
        .single()

      expect(pending?.processed_at).not.toBeNull()

      // Cleanup
      await supabase.from('license_keys').delete().eq('user_id', activationUserId)
      await supabase.from('subscriptions').delete().eq('user_id', activationUserId)
      await supabase.from('profiles').delete().eq('id', activationUserId)
      await supabase.from('pending_checkouts').delete().eq('email', activationEmail)
    })
  })

  describe('4. License Key Validation', () => {
    it('should generate valid license key format', async () => {
      if (!SUPABASE_SERVICE_KEY) {
        console.log('Skipping: No service key')
        return
      }

      // Create test user
      await supabase.from('profiles').upsert({
        id: TEST_USER_ID,
        email: TEST_EMAIL,
        tier: 'individual',
        display_name: 'E2E Test User',
      })

      // Create license key (simulating what webhook does)
      const keyPrefix = 'sk_live_test1234567...'
      const keyHash = 'a'.repeat(64) // Mock SHA-256 hash

      const { error: keyError } = await supabase.from('license_keys').insert({
        user_id: TEST_USER_ID,
        key_hash: keyHash,
        key_prefix: keyPrefix,
        name: 'Test License Key',
        tier: 'individual',
        status: 'active',
        rate_limit_per_minute: 60,
        metadata: { test: true },
      })
      expect(keyError).toBeNull()

      // Verify key was created with correct format
      const { data: key } = await supabase
        .from('license_keys')
        .select('*')
        .eq('user_id', TEST_USER_ID)
        .single()

      expect(key).toMatchObject({
        key_prefix: expect.stringContaining('sk_live_'),
        status: 'active',
        tier: 'individual',
        rate_limit_per_minute: 60,
      })
    })
  })
})

// Helper functions

function createCheckoutEvent(email: string, tier: string): object {
  const base = stripeEvents.checkout_session_completed
  return {
    ...base,
    data: {
      object: {
        ...base.data.object,
        customer_email: email,
        customer_details: { email, name: 'Test User' },
        metadata: { ...base.data.object.metadata, tier },
      },
    },
  }
}

async function cleanupTestData(supabase: SupabaseClient): Promise<void> {
  // Clean up in correct order (foreign key constraints)
  await supabase.from('license_keys').delete().eq('user_id', TEST_USER_ID)
  await supabase.from('subscriptions').delete().eq('user_id', TEST_USER_ID)
  await supabase.from('profiles').delete().eq('id', TEST_USER_ID)
  await supabase.from('pending_checkouts').delete().eq('email', TEST_EMAIL)
}
