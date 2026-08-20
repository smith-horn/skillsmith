/**
 * Non-owner team member subscription visibility (SMI-6086)
 *
 * check_team_tier_access() and get_user_subscription() previously only
 * resolved a subscription keyed on the viewer's own user_id, so a non-owner
 * team member (no personal subscriptions row) saw an incorrectly-empty
 * /account/subscription page even with an active team subscription. The fix
 * adds get_effective_subscription_summary() — tier/status/team_id only, no
 * billing fields — for non-owner members, while owners keep the existing
 * full-detail get_user_subscription() RPC.
 *
 * Boundary: same as team-tier-gate.spec.ts — Supabase calls are mocked via
 * page.route(), not a real backend. This asserts page-level behavior for a
 * given RPC response shape, not the RPC's own SQL correctness (covered by
 * the migration's own smoke block).
 *
 * Run:
 *   cd packages/website
 *   npx playwright test tests/e2e/subscription-non-owner-visibility.spec.ts
 */

import { test, expect } from '@playwright/test'
import { buildSessionToken, injectSupabaseStub, mockSupabase } from './complete-profile.helpers'

const TEAM_ID = 'team_test_smi6086'

test.describe('Non-owner team member — /account/subscription', () => {
  test('sees tier and status only, never calls get_user_subscription', async ({ page }) => {
    let getUserSubscriptionCalled = false

    await injectSupabaseStub(page, { session: buildSessionToken() })
    await mockSupabase(page, {
      rpcResponses: {
        get_effective_subscription_summary: [
          { tier: 'enterprise', status: 'active', team_id: TEAM_ID },
        ],
        get_user_subscription: [
          {
            subscription_id: 'sub_owner_only',
            tier: 'enterprise',
            status: 'active',
            billing_period: 'monthly',
            seat_count: 5,
            current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
            cancel_at_period_end: false,
          },
        ],
      },
      restResponses: {
        profiles: [{ tier: 'enterprise' }],
        team_members: [{ role: 'admin' }],
      },
      onRequest: (url) => {
        if (url.includes('/rpc/get_user_subscription')) getUserSubscriptionCalled = true
      },
    })

    await page.goto('/account/subscription')
    await expect(page.locator('#current-tier-badge')).toHaveText(/enterprise/i)
    await expect(page.locator('#subscription-status')).toHaveText(/active/i)

    // Billing-detail rows and owner-only controls must be hidden.
    await expect(page.locator('#billing-period').locator('..')).toBeHidden()
    await expect(page.locator('#next-billing').locator('..')).toBeHidden()
    await expect(page.locator('#seat-count-row')).toBeHidden()
    await expect(page.locator('#seat-management-section')).toBeHidden()
    await expect(page.locator('#cancel-section')).toBeHidden()

    expect(getUserSubscriptionCalled).toBe(false)
  })
})

test.describe('Team owner (role=owner on the winning team) — /account/subscription', () => {
  test('role lookup resolves owner → full billing detail, get_user_subscription called', async ({
    page,
  }) => {
    let getUserSubscriptionCalled = false

    await injectSupabaseStub(page, { session: buildSessionToken() })
    await mockSupabase(page, {
      rpcResponses: {
        // Winning entitlement IS team-correlated — the page must do the
        // team_members role lookup and, on role=owner, keep the full RPC.
        get_effective_subscription_summary: [
          { tier: 'enterprise', status: 'active', team_id: TEAM_ID },
        ],
        get_user_subscription: [
          {
            subscription_id: 'sub_owner',
            tier: 'enterprise',
            status: 'active',
            billing_period: 'annual',
            seat_count: 5,
            current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
            cancel_at_period_end: false,
          },
        ],
      },
      restResponses: {
        profiles: [{ tier: 'enterprise' }],
        team_members: [{ role: 'owner' }],
      },
      onRequest: (url) => {
        if (url.includes('/rpc/get_user_subscription')) getUserSubscriptionCalled = true
      },
    })

    await page.goto('/account/subscription')
    await expect(page.locator('#current-tier-badge')).toHaveText(/enterprise/i)
    await expect(page.locator('#billing-period')).toHaveText(/annual/i)
    await expect(page.locator('#seat-count-row')).toBeVisible()
    await expect(page.locator('#cancel-section')).toBeVisible()

    expect(getUserSubscriptionCalled).toBe(true)
  })
})

test.describe('Personal-subscription user (no team correlation) — /account/subscription', () => {
  test('keeps full billing detail (regression)', async ({ page }) => {
    await injectSupabaseStub(page, { session: buildSessionToken() })
    await mockSupabase(page, {
      rpcResponses: {
        // Owner's own subscription — no team_id correlation, so the page
        // never even attempts the team_members role lookup.
        get_effective_subscription_summary: [
          { tier: 'enterprise', status: 'active', team_id: null },
        ],
        get_user_subscription: [
          {
            subscription_id: 'sub_owner',
            tier: 'enterprise',
            status: 'active',
            billing_period: 'annual',
            seat_count: 5,
            current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
            cancel_at_period_end: false,
          },
        ],
      },
      restResponses: {
        profiles: [{ tier: 'enterprise' }],
      },
    })

    await page.goto('/account/subscription')
    await expect(page.locator('#current-tier-badge')).toHaveText(/enterprise/i)
    await expect(page.locator('#billing-period')).toHaveText(/annual/i)
    await expect(page.locator('#seat-count-row')).toBeVisible()
    await expect(page.locator('#cancel-section')).toBeVisible()
  })
})
