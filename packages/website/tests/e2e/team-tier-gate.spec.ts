/**
 * Team Tier-Gate E2E Tests (SMI-4321, updated SMI-6110, SMI-6128)
 *
 * Verifies the client-side gate + redirect flow on /account (page title
 * "Account", Admin → Overview navigation label — formerly /account/team,
 * then "Team Overview" under SMI-6110, renamed again under SMI-6128; both
 * renames froze check_team_tier_access / resolveGateRedirect themselves)
 * and the sibling
 * /account/team/** pages, which keep the original gate-redirect contract.
 *
 * SMI-6110 / Decision #4 (plan-review issue C1): on /account specifically,
 * the three tier/subscription reasons (not_team_tier, no_active_subscription,
 * subscription_paused) now redirect to /account/summary instead of
 * /account/subscription?gated=<reason> — no gated notice is shown on this
 * path. The four sibling team-administration pages (members/workspaces/
 * registry/analytics) are unchanged and still redirect to
 * /account/subscription?gated=<reason> with the banner.
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

test.describe('Team tier-gate — /account (Overview)', () => {
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
    await page.goto('/account')
    // The page should stay on /account (no redirect to /login,
    // /account/summary, or /account/subscription). It may show an internal
    // error banner because downstream REST calls return empty — that is
    // expected for this stub and does not invalidate the tier-gate assertion.
    await expect(page).toHaveURL(/\/account\/?$/)
  })

  test('downgraded tier redirects to /account/summary, no gated notice (Decision #4/C1)', async ({
    page,
  }) => {
    await mockSupabase(page, {
      check_team_tier_access: {
        ok: false,
        reason: 'not_team_tier',
        team_id: null,
        tier: 'community',
      },
    })
    await page.goto('/account')
    await page.waitForURL(/\/account\/summary\/?$/, { timeout: 10_000 })
    // No gated notice on this path — the user lands somewhere useful
    // instead (the personal Summary dashboard), per Decision #4.
    await expect(page.locator('#team-gated-notice')).toHaveCount(0)
  })

  test('expired subscription redirects to /account/summary, no gated notice', async ({ page }) => {
    await mockSupabase(page, {
      check_team_tier_access: {
        ok: false,
        reason: 'no_active_subscription',
        team_id: null,
        tier: 'team',
      },
    })
    await page.goto('/account')
    await page.waitForURL(/\/account\/summary\/?$/, { timeout: 10_000 })
    await expect(page.locator('#team-gated-notice')).toHaveCount(0)
  })

  test('paused subscription redirects to /account/summary, no gated notice', async ({ page }) => {
    await mockSupabase(page, {
      check_team_tier_access: {
        ok: false,
        reason: 'subscription_paused',
        team_id: null,
        tier: 'team',
      },
    })
    await page.goto('/account')
    await page.waitForURL(/\/account\/summary\/?$/, { timeout: 10_000 })
    await expect(page.locator('#team-gated-notice')).toHaveCount(0)
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
    await page.goto('/account')
    await page.waitForURL(/\/login\?redirect=%2Faccount/, {
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
    await page.goto('/account')
    // URL should not change.
    await expect(page).toHaveURL(/\/account\/?$/)
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
    '/account/team/registry',
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
