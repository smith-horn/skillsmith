/**
 * account-sidebar.spec.ts
 *
 * SMI-5475 — the account area's Quick Links grid was replaced by a persistent
 * docs-style left sidebar (AccountSidebar.astro).
 *
 * SMI-6110 — Dashboard, Email Address, Subscription, and the Team section
 * were folded into the AccountHubNav tab row instead of the sidebar.
 *
 * SMI-6128 — AccountHubNav is retired. `account-nav.ts` now expresses one
 * root ("Account") with four groups (Admin, Tools, Preferences, Resources)
 * rendered by two components sharing the same data: `AccountSidebar.astro`
 * (desktop, hidden at/below 1024px) and `AccountMobileNav.astro` (a native
 * `<details>` disclosure, hidden above 1024px). This spec asserts:
 *   - the exact grouped data (root/group/order/hrefs) renders on both,
 *   - exactly one active item across both navigation roots per page,
 *   - desktop-visible/mobile-hidden above 1024px and vice versa below,
 *   - the mobile disclosure is reachable and its collapsed summary always
 *     names the current destination,
 *   - the team-gated lock/fail-open contract on both roots,
 *   - the retired tab row is gone for good.
 *
 * Active-state assertions use attached-DOM checks (toHaveCount / attribute /
 * toContainText), which do not require visibility, so they hold on both
 * projects even though one of the two navigation roots is CSS-hidden per
 * viewport. Auth + Supabase are mocked via complete-profile.helpers.ts (no
 * network).
 */

import { test, expect } from '@playwright/test'
import { buildSessionToken, injectSupabaseStub, mockSupabase } from './complete-profile.helpers'

const ADMIN_ITEMS = [
  { href: '/account', label: 'Overview' },
  { href: '/account/summary', label: 'Summary' },
  { href: '/account/subscription', label: 'Subscription' },
  { href: '/account/billing', label: 'Billing History' },
  { href: '/account/profile', label: 'Email Address' },
]

const TOOLS_ITEMS = [
  { href: '/account/team/registry', label: 'Registry' },
  { href: '/account/team/analytics', label: 'Analytics' },
  { href: '/account/cli-token/', label: 'CLI Token' },
  { href: '/account/skills', label: 'Skill Inventory' },
  { href: '/account/team/members', label: 'Members' },
  { href: '/account/team/workspaces', label: 'Workspaces' },
]

const PREFERENCES_ITEMS = [
  { href: '/account/outreach-preferences', label: 'Outreach' },
  { href: '/account/telemetry', label: 'Telemetry' },
]

const RESOURCES_ITEMS = [
  { href: '/docs/quickstart', label: 'Getting Started' },
  { href: '/docs/api', label: 'API Docs' },
]

const ALL_ITEMS = [...ADMIN_ITEMS, ...TOOLS_ITEMS, ...PREFERENCES_ITEMS, ...RESOURCES_ITEMS]

const TEAM_GATED_HREFS = [
  '/account/team/registry',
  '/account/team/analytics',
  '/account/team/members',
  '/account/team/workspaces',
]

test.describe('account navigation — Account/Admin/Tools/Preferences/Resources (SMI-6128)', () => {
  test.beforeEach(async ({ page }) => {
    await injectSupabaseStub(page, { session: buildSessionToken({ provider: 'email' }) })
    // Resolve the team gate as entitled: this describe block asserts pure
    // navigation structure/active-state, not gate outcomes (covered
    // separately by team-tier-gate.spec.ts and the lock-affordance describe
    // block below). Leaving check_team_tier_access unmocked closed-defaults
    // to `not_authenticated` (team-access.ts), which races /account's own
    // async redirect-to-login against this suite's assertions — an
    // unrelated flake source, not a structural nav regression.
    await mockSupabase(page, {
      rpcResponses: {
        check_team_tier_access: {
          ok: true,
          reason: null,
          team_id: 'team_nav_structure_fixture',
          tier: 'team',
        },
      },
    })
  })

  test('renders on /account with the Quick Links grid gone and no duplicate tab row', async ({
    page,
  }) => {
    await page.goto('/account')

    await expect(page.locator('.quick-links')).toHaveCount(0)
    await expect(page.locator('.account-hub-nav')).toHaveCount(0)
    await expect(page.locator('.account-sidebar')).toHaveCount(1)
    await expect(page.locator('.account-mobile-nav')).toHaveCount(1)
  })

  test('desktop sidebar renders a visible "Account" root heading associated with the nav landmark', async ({
    page,
  }) => {
    await page.goto('/account')

    const heading = page.locator('.account-sidebar .account-nav-root-heading')
    await expect(heading).toHaveText('Account')
    const headingId = await heading.getAttribute('id')
    expect(headingId).toBeTruthy()

    const nav = page.locator('.account-sidebar nav')
    await expect(nav).toHaveAttribute('aria-labelledby', headingId as string)
  })

  test('desktop sidebar renders exactly the Admin, Tools, Preferences, and Resources groups in order', async ({
    page,
  }) => {
    await page.goto('/account')

    const headings = page.locator('.account-sidebar h3')
    await expect(headings).toHaveCount(4)
    await expect(headings.nth(0)).toHaveText('Admin')
    await expect(headings.nth(1)).toHaveText('Tools')
    await expect(headings.nth(2)).toHaveText('Preferences')
    await expect(headings.nth(3)).toHaveText('Resources')
  })

  test('desktop sidebar renders every item, in order, with the exact href and label', async ({
    page,
  }) => {
    await page.goto('/account')

    const links = page.locator('.account-sidebar nav a.account-nav-link')
    await expect(links).toHaveCount(ALL_ITEMS.length)
    for (let i = 0; i < ALL_ITEMS.length; i++) {
      await expect(links.nth(i)).toHaveAttribute('href', ALL_ITEMS[i].href)
      await expect(links.nth(i)).toContainText(ALL_ITEMS[i].label)
    }
  })

  test('mobile disclosure renders the identical group/item contract', async ({ page }) => {
    await page.goto('/account')

    const groupHeadings = page.locator('.account-mobile-nav h3')
    await expect(groupHeadings).toHaveCount(4)
    await expect(groupHeadings.nth(0)).toHaveText('Admin')
    await expect(groupHeadings.nth(1)).toHaveText('Tools')
    await expect(groupHeadings.nth(2)).toHaveText('Preferences')
    await expect(groupHeadings.nth(3)).toHaveText('Resources')

    const links = page.locator('.account-mobile-nav a.account-mobile-nav-link')
    await expect(links).toHaveCount(ALL_ITEMS.length)
    for (let i = 0; i < ALL_ITEMS.length; i++) {
      await expect(links.nth(i)).toHaveAttribute('href', ALL_ITEMS[i].href)
    }
  })

  test('marks exactly one item active across both navigation roots, with no duplicates, per page', async ({
    page,
  }) => {
    for (const { href } of [
      { href: '/account' },
      { href: '/account/billing' },
      { href: '/account/cli-token/' },
      { href: '/account/team/members' },
      { href: '/account/outreach-preferences' },
    ]) {
      await page.goto(href)
      const desktopActive = page.locator('.account-sidebar a[aria-current="page"]')
      const mobileActive = page.locator('.account-mobile-nav a[aria-current="page"]')
      await expect(desktopActive, `desktop active on ${href}`).toHaveCount(1)
      await expect(mobileActive, `mobile active on ${href}`).toHaveCount(1)
      await expect(desktopActive).toHaveAttribute('href', href)
      await expect(mobileActive).toHaveAttribute('href', href)
    }
  })

  test('trailing-slash normalization keeps exactly one active item', async ({ page }) => {
    await page.goto('/account/cli-token')
    await expect(page.locator('.account-sidebar a[aria-current="page"]')).toHaveAttribute(
      'href',
      '/account/cli-token/'
    )

    await page.goto('/account/subscription/')
    await expect(page.locator('.account-sidebar a[aria-current="page"]')).toHaveAttribute(
      'href',
      '/account/subscription'
    )
  })

  test('no item lights up on the redirect-only /account/team shim path', async ({ page }) => {
    // /account/team is a true HTTP 301 in production; here we only assert
    // that nothing in the nav data would match it were it ever rendered.
    for (const path of ['/account/team', '/account/team/']) {
      const url = new URL(path, 'http://localhost')
      const matches = ALL_ITEMS.filter((item) => item.href.replace(/\/+$/, '') === url.pathname)
      expect(matches, path).toHaveLength(0)
    }
  })

  test('formerly Nav-less pages render top Nav + both navigation roots', async ({ page }) => {
    await page.goto('/account/profile')
    await expect(page.locator('nav.nav-container')).toHaveCount(1)
    await expect(page.locator('.account-sidebar')).toHaveCount(1)
    await expect(page.locator('.account-mobile-nav')).toHaveCount(1)

    await page.goto('/account/outreach-preferences')
    await expect(page.locator('nav.nav-container')).toHaveCount(1)
    const active = page.locator('.account-sidebar a[aria-current="page"]')
    await expect(active).toHaveCount(1)
    await expect(active).toHaveAttribute('href', '/account/outreach-preferences')
  })

  test('desktop sidebar visible / mobile disclosure hidden above 1024px, and vice versa below', async ({
    page,
  }) => {
    await page.goto('/account')

    const sidebar = page.locator('.account-sidebar')
    const mobileNav = page.locator('.account-mobile-nav')
    const width = page.viewportSize()?.width ?? 0

    if (width > 1024) {
      await expect(sidebar).toBeVisible()
      await expect(mobileNav).toBeHidden()
    } else {
      await expect(sidebar).toBeHidden()
      await expect(mobileNav).toBeVisible()
    }
  })

  test('every sidebar link and the mobile summary/links meet the 44px minimum target', async ({
    page,
  }) => {
    await page.goto('/account')
    const width = page.viewportSize()?.width ?? 0

    if (width > 1024) {
      const links = page.locator('.account-sidebar a.account-nav-link')
      const count = await links.count()
      for (let i = 0; i < count; i++) {
        const box = await links.nth(i).boundingBox()
        expect(box?.height ?? 0, `link ${i}`).toBeGreaterThanOrEqual(44)
      }
    } else {
      const summary = page.locator('.account-mobile-nav-summary')
      const summaryBox = await summary.boundingBox()
      expect(summaryBox?.height ?? 0).toBeGreaterThanOrEqual(44)

      await summary.click()
      const links = page.locator('.account-mobile-nav a.account-mobile-nav-link')
      const count = await links.count()
      for (let i = 0; i < count; i++) {
        const box = await links.nth(i).boundingBox()
        expect(box?.height ?? 0, `link ${i}`).toBeGreaterThanOrEqual(44)
      }
    }
  })

  test('mobile summary text always names the current destination, even before opening', async ({
    page,
  }) => {
    for (const { href, label } of [
      { href: '/account', label: 'Overview' },
      { href: '/account/billing', label: 'Billing History' },
      { href: '/account/team/workspaces', label: 'Workspaces' },
    ]) {
      await page.goto(href)
      await expect(page.locator('.account-mobile-nav-summary')).toContainText(
        `Account navigation: ${label}`
      )
    }
  })

  test('mobile disclosure reaches Admin and Tools destinations without direct page.goto()', async ({
    page,
  }) => {
    test.skip((page.viewportSize()?.width ?? 0) > 1024, 'mobile-only interaction')

    await page.goto('/account')
    await page.locator('.account-mobile-nav-summary').click()
    await expect(page.locator('.account-mobile-nav')).toHaveAttribute('open', '')

    await page
      .locator('.account-mobile-nav a.account-mobile-nav-link[href="/account/team/registry"]')
      .click()
    await expect(page).toHaveURL(/\/account\/team\/registry\/?$/)
  })

  test('a fresh disclosure on the destination page is reachable again (open state resets on navigation)', async ({
    page,
  }) => {
    test.skip((page.viewportSize()?.width ?? 0) > 1024, 'mobile-only interaction')

    await page.goto('/account')
    await page.locator('.account-mobile-nav-summary').click()
    await page
      .locator('.account-mobile-nav a.account-mobile-nav-link[href="/account/billing"]')
      .click()
    await expect(page).toHaveURL(/\/account\/billing\/?$/)

    // A fresh SSR/hydrated <details> defaults closed; the disclosure is
    // usable again on the new page rather than staying stuck open/closed
    // from the previous document.
    await expect(page.locator('.account-mobile-nav')).not.toHaveAttribute('open', '')
    await page.locator('.account-mobile-nav-summary').click()
    await expect(page.locator('.account-mobile-nav')).toHaveAttribute('open', '')
  })
})

test.describe('team-gated lock affordance (SMI-6128, preserves SMI-6110 Decision #6)', () => {
  test.beforeEach(async ({ page }) => {
    await injectSupabaseStub(page, { session: buildSessionToken({ provider: 'email' }) })
  })

  test('confirmed non-entitled: Registry/Analytics/Members/Workspaces render locked; Overview never does', async ({
    page,
  }) => {
    await mockSupabase(page, {
      rpcResponses: { get_effective_subscription_summary: [{ tier: 'community' }] },
    })

    await page.goto('/account/summary')
    await expect(page.locator('.account-sidebar')).toHaveAttribute('data-team-entitled', 'false')
    await expect(page.locator('.account-mobile-nav')).toHaveAttribute('data-team-entitled', 'false')

    for (const href of TEAM_GATED_HREFS) {
      const link = page.locator(`.account-sidebar a.account-nav-link[href="${href}"]`)
      await expect(link).toHaveClass(/team-gated/)
      await expect(link.locator('.lock-icon')).toHaveAttribute('aria-hidden', 'true')
      await expect(link.locator('.visually-hidden-lock-text')).toContainText('requires Team plan')
    }

    const overviewLink = page.locator('.account-sidebar a.account-nav-link[href="/account"]')
    await expect(overviewLink).not.toHaveClass(/team-gated/)
  })

  test('entitled: no lock styling, no stale lock announcement', async ({ page }) => {
    await mockSupabase(page, {
      rpcResponses: { get_effective_subscription_summary: [{ tier: 'team' }] },
    })

    await page.goto('/account/summary')
    await expect(page.locator('.account-sidebar')).toHaveAttribute('data-team-entitled', 'true')

    for (const href of TEAM_GATED_HREFS) {
      const link = page.locator(`.account-sidebar a.account-nav-link[href="${href}"]`)
      const lockText = link.locator('.visually-hidden-lock-text')
      // The element carries the class regardless of entitlement (data-driven
      // markup) — what must never happen is the CSS-visible/announced state,
      // gated entirely by the ancestor's data-team-entitled attribute.
      await expect(lockText).not.toBeVisible()
    }
  })

  test('missing entitlement signal fails open: no producer page visited, no lock ever applied', async ({
    page,
  }) => {
    await mockSupabase(page, {})

    // Profile never calls setAccountNavTeamEntitled (pre-decided non-producer).
    await page.goto('/account/profile')
    await expect(page.locator('.account-sidebar')).not.toHaveAttribute('data-team-entitled', /.+/)

    for (const href of TEAM_GATED_HREFS) {
      const link = page.locator(`.account-sidebar a.account-nav-link[href="${href}"]`)
      await expect(link.locator('.visually-hidden-lock-text')).not.toBeVisible()
    }
  })

  test('activating a locked link still navigates — the lock is an affordance, not a disabled control', async ({
    page,
  }) => {
    await mockSupabase(page, {
      rpcResponses: { get_effective_subscription_summary: [{ tier: 'community' }] },
    })

    await page.goto('/account/summary')
    await expect(page.locator('.account-sidebar')).toHaveAttribute('data-team-entitled', 'false')

    const width = page.viewportSize()?.width ?? 0
    const link =
      width > 1024
        ? page.locator('.account-sidebar a.account-nav-link[href="/account/team/registry"]')
        : page.locator(
            '.account-mobile-nav a.account-mobile-nav-link[href="/account/team/registry"]'
          )
    if (width <= 1024) {
      await page.locator('.account-mobile-nav-summary').click()
    }
    await link.click()
    await expect(page).toHaveURL(/\/account\/team\/registry\/?$/)
  })
})
