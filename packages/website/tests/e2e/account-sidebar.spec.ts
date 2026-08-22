/**
 * account-sidebar.spec.ts
 *
 * SMI-5475 — the account area's Quick Links grid was replaced by a persistent
 * docs-style left sidebar (AccountSidebar.astro). These tests assert:
 *   - the sidebar renders with exactly one active item per page (aria-current),
 *   - the Quick Links grid is gone,
 *   - visibility follows the docs breakpoint (hidden < 1024px — product
 *     decision: mobile matches /docs, no fallback nav).
 *
 * SMI-6110 — Dashboard, Email Address, Subscription, and the Team section
 * were removed from the sidebar (folded into the AccountHubNav tab row
 * instead). Hub-scoped pages (/account, /account/profile, /account/subscription,
 * /account/team/*) no longer own a sidebar item and must show zero active
 * items, not a stale match.
 *
 * Active-state assertions use attached-DOM checks (toHaveCount / attribute),
 * so they hold on the mobile project too, where the sidebar is CSS-hidden.
 * Auth + Supabase are mocked via complete-profile.helpers.ts (no network).
 */

import { test, expect } from '@playwright/test'
import { buildSessionToken, injectSupabaseStub, mockSupabase } from './complete-profile.helpers'

test.describe('account sidebar (SMI-5475, SMI-6110)', () => {
  test.beforeEach(async ({ page }) => {
    await injectSupabaseStub(page, { session: buildSessionToken({ provider: 'email' }) })
    await mockSupabase(page, {})
  })

  test('renders on /account (Team Overview) with the Quick Links grid gone and no active sidebar item', async ({
    page,
  }) => {
    await page.goto('/account')

    await expect(page.locator('.quick-links')).toHaveCount(0)

    // /account is now a hub tab (Team Overview), not a sidebar destination —
    // the sidebar itself still renders, but nothing in it should light up.
    const active = page.locator('.account-sidebar a[aria-current="page"]')
    await expect(active).toHaveCount(0)
  })

  test('renders the operational destinations that remain in the sidebar', async ({ page }) => {
    await page.goto('/account')

    for (const href of [
      '/account/cli-token/',
      '/account/skills',
      '/account/billing',
      '/account/outreach-preferences',
      '/account/telemetry',
      '/docs/quickstart',
      '/docs/api',
    ]) {
      await expect(page.locator(`.account-sidebar nav a[href="${href}"]`)).toHaveCount(1)
    }
    // Dashboard, Email Address, Subscription, and Team no longer appear —
    // those destinations moved into the AccountHubNav tab row (SMI-6110).
    for (const href of ['/account', '/account/profile', '/account/subscription', '/account/team']) {
      await expect(page.locator(`.account-sidebar nav a[href="${href}"]`)).toHaveCount(0)
    }
    await expect(page.locator('.account-sidebar nav a')).toHaveCount(7)
  })

  test('marks exactly one matching item active on subpages', async ({ page }) => {
    await page.goto('/account/billing')
    let active = page.locator('.account-sidebar a[aria-current="page"]')
    await expect(active).toHaveCount(1)
    await expect(active).toHaveAttribute('href', '/account/billing')

    // Trailing-slash normalization: the nav href is /account/cli-token/.
    await page.goto('/account/cli-token/')
    active = page.locator('.account-sidebar a[aria-current="page"]')
    await expect(active).toHaveCount(1)
    await expect(active).toHaveAttribute('href', '/account/cli-token/')

    await page.goto('/account/skills')
    active = page.locator('.account-sidebar a[aria-current="page"]')
    await expect(active).toHaveCount(1)
    await expect(active).toHaveAttribute('href', '/account/skills')
  })

  test('no sidebar item lights up on the hub-scoped Team pages (SMI-6110)', async ({ page }) => {
    // The old Team section-root prefix match (isActiveAccountNav) was removed
    // along with the Team sidebar section — these paths are hub tabs now,
    // not sidebar destinations, so nothing should be marked active.
    for (const path of ['/account/team', '/account/team/members', '/account/team/analytics']) {
      await page.goto(path)
      const active = page.locator('.account-sidebar a[aria-current="page"]')
      await expect(active).toHaveCount(0)
    }
  })

  test('formerly Nav-less pages render top Nav + sidebar', async ({ page }) => {
    // outreach-preferences shipped without <Nav> until SMI-5475 and still owns
    // a sidebar item. profile shipped without <Nav> until SMI-5475 too, but
    // Email Address moved into the hub tab row (SMI-6110) and no longer owns
    // a sidebar item — the sidebar itself must still render, just with
    // nothing active.
    await page.goto('/account/profile')
    await expect(page.locator('nav.nav-container')).toHaveCount(1)
    await expect(page.locator('.account-sidebar a[aria-current="page"]')).toHaveCount(0)

    await page.goto('/account/outreach-preferences')
    await expect(page.locator('nav.nav-container')).toHaveCount(1)
    const active = page.locator('.account-sidebar a[aria-current="page"]')
    await expect(active).toHaveCount(1)
    await expect(active).toHaveAttribute('href', '/account/outreach-preferences')
  })

  test('visibility follows the docs breakpoint (hidden below 1024px)', async ({ page }) => {
    await page.goto('/account')

    const sidebar = page.locator('.account-sidebar')
    const width = page.viewportSize()?.width ?? 0
    if (width > 1024) {
      await expect(sidebar).toBeVisible()
    } else {
      await expect(sidebar).toBeHidden()
    }
  })
})
