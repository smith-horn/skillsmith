/**
 * Team Tier-Gate E2E Tests (SMI-4321)
 *
 * Verifies the client-side gate + redirect flow on /account/team/** pages.
 *
 * Boundary: we mock the Supabase `check_team_tier_access` RPC via page.route()
 * rather than provisioning a real downgraded test user. Rationale: (a) downgrading
 * a prod user is unsafe, (b) the RPC contract is pinned by the unit tests in
 * team-access.test.ts against the actual DB shape, (c) this spec asserts the
 * *page-level* behavior — that a given RPC response produces the expected
 * redirect and banner. Shape drift is covered by the unit test deserializer pin.
 *
 * The tests drive the local Astro preview server (port 4321 via playwright.config.ts
 * webServer). They DO NOT require a Supabase backend; every Supabase call made
 * by the page is intercepted.
 *
 * Run:
 *   cd packages/website
 *   npx playwright test tests/e2e/team-tier-gate.spec.ts
 */

import { test, expect, type Page, type Route } from '@playwright/test'

// Default config fallback for when the page reads __SUPABASE_CONFIG__.
// The URL host doesn't need to resolve — all requests to it are intercepted.
const SUPABASE_HOST = 'https://stub.supabase.co'
const SUPABASE_ANON = 'stub-anon-key'

/**
 * Inject a fake __SUPABASE_CONFIG__ before Astro's page script runs.
 * Must run via addInitScript so it's available by the time astro:page-load fires.
 */
async function injectSupabaseStub(page: Page): Promise<void> {
  await page.addInitScript(
    ({ url, anonKey }) => {
      ;(window as unknown as Record<string, unknown>).__SUPABASE_CONFIG__ = {
        url,
        anonKey,
      }
    },
    { url: SUPABASE_HOST, anonKey: SUPABASE_ANON }
  )
}

/**
 * Intercept Supabase RPC calls. `rpcResponses` maps RPC name → JSON body.
 * Non-RPC Supabase calls (e.g. REST on /rest/v1/team_members) are answered
 * with an empty array so downstream page logic does not crash.
 */
async function mockSupabase(page: Page, rpcResponses: Record<string, unknown>): Promise<void> {
  await page.route(`${SUPABASE_HOST}/**`, async (route: Route) => {
    const url = new URL(route.request().url())
    // RPC: /rest/v1/rpc/<fn_name>
    const rpcMatch = url.pathname.match(/\/rest\/v1\/rpc\/([^/]+)/)
    if (rpcMatch) {
      const fn = rpcMatch[1]
      const body = rpcResponses[fn]
      if (body !== undefined) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(body),
        })
        return
      }
      // Unmocked RPC — return 404 so the helper's closed-default kicks in.
      await route.fulfill({ status: 404, body: 'not mocked' })
      return
    }
    // REST query — return an empty array (keeps team_members/teams selects
    // from crashing the page on the happy path).
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '[]',
    })
  })
}

test.describe('Team tier-gate — /account/team', () => {
  test.beforeEach(async ({ page }) => {
    await injectSupabaseStub(page)
  })

  test('ok=true renders the dashboard (happy path)', async ({ page }) => {
    await mockSupabase(page, {
      check_team_tier_access: {
        ok: true,
        reason: null,
        team_id: 'team_test_happy',
        tier: 'team',
      },
    })
    await page.goto('/account/team')
    // The page should stay on /account/team (no redirect to /login or
    // /account/subscription). It may show an internal error banner because
    // downstream REST calls return empty — that is expected for this stub
    // and does not invalidate the tier-gate assertion.
    await expect(page).toHaveURL(/\/account\/team\/?$/)
  })

  test('downgraded tier redirects to subscription with gated=not_team_tier', async ({ page }) => {
    await mockSupabase(page, {
      check_team_tier_access: {
        ok: false,
        reason: 'not_team_tier',
        team_id: null,
        tier: 'community',
      },
    })
    await page.goto('/account/team')
    await page.waitForURL(/\/account\/subscription\?gated=not_team_tier/, {
      timeout: 10_000,
    })
    // Banner should render.
    await expect(page.locator('#team-gated-notice')).toBeVisible()
    await expect(page.locator('#team-gated-notice-text')).toContainText(
      /no longer includes team features/i
    )
  })

  test('expired subscription redirects to subscription with gated=no_active_subscription', async ({
    page,
  }) => {
    await mockSupabase(page, {
      check_team_tier_access: {
        ok: false,
        reason: 'no_active_subscription',
        team_id: null,
        tier: 'team',
      },
    })
    await page.goto('/account/team')
    await page.waitForURL(/\/account\/subscription\?gated=no_active_subscription/, {
      timeout: 10_000,
    })
    await expect(page.locator('#team-gated-notice')).toBeVisible()
    await expect(page.locator('#team-gated-notice-text')).toContainText(/not currently active/i)
  })

  test('paused subscription redirects with gated=subscription_paused', async ({ page }) => {
    await mockSupabase(page, {
      check_team_tier_access: {
        ok: false,
        reason: 'subscription_paused',
        team_id: null,
        tier: 'team',
      },
    })
    await page.goto('/account/team')
    await page.waitForURL(/\/account\/subscription\?gated=subscription_paused/, { timeout: 10_000 })
    await expect(page.locator('#team-gated-notice')).toBeVisible()
    await expect(page.locator('#team-gated-notice-text')).toContainText(/paused.*contact support/i)
  })

  test('not_authenticated redirects to /login with the current path', async ({ page }) => {
    await mockSupabase(page, {
      check_team_tier_access: {
        ok: false,
        reason: 'not_authenticated',
        team_id: null,
        tier: 'community',
      },
    })
    await page.goto('/account/team')
    await page.waitForURL(/\/login\?redirect=%2Faccount%2Fteam/, {
      timeout: 10_000,
    })
  })

  test('not_member renders the inline error state (no redirect)', async ({ page }) => {
    await mockSupabase(page, {
      check_team_tier_access: {
        ok: false,
        reason: 'not_member',
        team_id: null,
        tier: 'team',
      },
    })
    await page.goto('/account/team')
    // URL should not change.
    await expect(page).toHaveURL(/\/account\/team\/?$/)
    await expect(page.locator('#error-state')).toBeVisible()
    await expect(page.locator('#error-message')).toContainText(/not a member/i)
  })
})

test.describe('Team tier-gate — applies identically to sibling pages', () => {
  test.beforeEach(async ({ page }) => {
    await injectSupabaseStub(page)
  })

  for (const path of [
    '/account/team/members',
    '/account/team/workspaces',
    '/account/team/analytics',
  ] as const) {
    test(`${path} redirects on not_team_tier`, async ({ page }) => {
      await mockSupabase(page, {
        check_team_tier_access: {
          ok: false,
          reason: 'not_team_tier',
          team_id: null,
          tier: 'community',
        },
      })
      await page.goto(path)
      await page.waitForURL(/\/account\/subscription\?gated=not_team_tier/, { timeout: 10_000 })
    })
  }
})
