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
 * Active-state assertions use attached-DOM checks (toHaveCount / attribute),
 * so they hold on the mobile project too, where the sidebar is CSS-hidden.
 * Auth + Supabase are mocked via complete-profile.helpers.ts (no network).
 */

import { test, expect } from '@playwright/test'
import { buildSessionToken, injectSupabaseStub, mockSupabase } from './complete-profile.helpers'

test.describe('account sidebar (SMI-5475)', () => {
  test.beforeEach(async ({ page }) => {
    await injectSupabaseStub(page, { session: buildSessionToken({ provider: 'email' }) })
    await mockSupabase(page, {})
  })

  test('replaces Quick Links on /account and marks Dashboard active', async ({ page }) => {
    await page.goto('/account')

    await expect(page.locator('.quick-links')).toHaveCount(0)

    const active = page.locator('.account-sidebar a[aria-current="page"]')
    await expect(active).toHaveCount(1)
    await expect(active).toHaveAttribute('href', '/account')
  })

  test('renders every account destination the Quick Links grid used to offer', async ({ page }) => {
    await page.goto('/account')

    for (const href of [
      '/account',
      '/account/profile',
      '/account/cli-token/',
      '/account/skills',
      '/account/subscription',
      '/account/billing',
      '/account/team',
      '/account/outreach-preferences',
      '/account/telemetry',
      '/docs/quickstart',
      '/docs/api',
    ]) {
      await expect(page.locator(`.account-sidebar nav a[href="${href}"]`)).toHaveCount(1)
    }
    await expect(page.locator('.account-sidebar nav a')).toHaveCount(11)
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

  test('keeps Team active across the TeamNav sub-tabs (prefix match)', async ({ page }) => {
    for (const path of ['/account/team', '/account/team/members', '/account/team/analytics']) {
      await page.goto(path)
      const active = page.locator('.account-sidebar a[aria-current="page"]')
      await expect(active).toHaveCount(1)
      await expect(active).toHaveAttribute('href', '/account/team')
    }
  })

  test('formerly Nav-less pages now render top Nav + sidebar', async ({ page }) => {
    // profile and outreach-preferences shipped without <Nav> until SMI-5475.
    for (const { path, href } of [
      { path: '/account/profile', href: '/account/profile' },
      { path: '/account/outreach-preferences', href: '/account/outreach-preferences' },
    ]) {
      await page.goto(path)
      await expect(page.locator('nav.nav-container')).toHaveCount(1)
      const active = page.locator('.account-sidebar a[aria-current="page"]')
      await expect(active).toHaveCount(1)
      await expect(active).toHaveAttribute('href', href)
    }
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
