/**
 * account-page-load-guards.spec.ts
 *
 * SMI-5158 — `astro:page-load` listeners attach to `document` and persist across
 * ClientRouter view transitions. An account page's listener therefore re-fires on
 * EVERY subsequent client-side navigation; without a path guard it runs
 * `getElementById(...)` against a foreign page's DOM, gets `null`, and throws
 * `Cannot read properties of null (reading 'style')` (Ryan's report: the
 * `index.astro` listener firing on `/account/subscription`).
 *
 * Regression: each unguarded handler now early-returns unless the pathname matches
 * its own page (canonical guard, see the `astro:page-load` handler in
 * `account/index.astro` — SMI-6110 moved this pattern's reference page from the
 * now-deleted `account/team/index.astro`). This spec drives
 * real ClientRouter navigations between account pages and asserts the null-deref
 * signature never appears on the console or as an uncaught error.
 *
 * Pre-fix this spec fails (the leaked handler throws on every cross-page nav);
 * post-fix it passes. Auth + Supabase are mocked via complete-profile.helpers.ts
 * (no staging/prod network — prod ref vrcnzpmndtroqxxoqkzy, see CLAUDE.md).
 */

import { test, expect, type Page } from '@playwright/test'
import { buildSessionToken, injectSupabaseStub, mockSupabase } from './complete-profile.helpers'
import { refireAstroPageLoad } from './astro-helpers'

// The bug surfaces as a null property access, phrased differently per engine.
const NULL_DEREF = /Cannot read properties of null|null is not an object|reading 'style'/

// Sibling pages reachable via a real `<a>` in either the account sidebar
// (SMI-5475 — replaced the Quick Links grid) or the AccountHubNav tab row
// (SMI-6110 — Subscription and Email Address moved out of the sidebar and
// into the hub tabs, mounted on every account page including /account
// itself), so ClientRouter (not a full reload) performs the transition that
// re-fires `astro:page-load` on the previously-visited page's leaked
// listener. /account (Team Overview) is the loop's anchor page — it is not
// its own sibling, so it is not listed here; its own leaked-listener
// coverage comes from being the page every iteration navigates back to.
const SIBLINGS = [
  { href: '/account/billing', url: '/account/billing', nav: 'sidebar' as const },
  { href: '/account/subscription', url: '/account/subscription', nav: 'hub' as const },
  { href: '/account/profile', url: '/account/profile', nav: 'hub' as const },
  { href: '/account/cli-token/', url: '/account/cli-token', nav: 'sidebar' as const },
  {
    href: '/account/outreach-preferences',
    url: '/account/outreach-preferences',
    nav: 'sidebar' as const,
  },
  { href: '/account/telemetry', url: '/account/telemetry', nav: 'sidebar' as const },
  { href: '/account/skills', url: '/account/skills', nav: 'sidebar' as const },
]

/**
 * Click a sidebar or hub-tab link through ClientRouter. Below 1024px the
 * sidebar is CSS-hidden (matches /docs — SMI-5475 product decision) while
 * the hub tab row stays horizontally-scrollable-visible at every width
 * (H5), so on the mobile project a sidebar link needs a programmatic click
 * to still bubble to ClientRouter's document-level listener and drive a
 * real SPA navigation, preserving the leaked-listener regression net at
 * both viewports. Hub-tab links are always visible, so a normal click
 * suffices there.
 */
async function clickAccountNav(
  page: Page,
  href: string,
  nav: 'sidebar' | 'hub' = 'sidebar'
): Promise<void> {
  const containerClass = nav === 'hub' ? '.account-hub-nav' : '.account-sidebar'
  const link = page.locator(`${containerClass} a[href="${href}"]`)
  if (await link.isVisible()) {
    await link.click()
  } else {
    await link.evaluate((el) => (el as HTMLElement).click())
  }
}

function collectNullDerefs(page: Page): string[] {
  const hits: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error' && NULL_DEREF.test(msg.text())) hits.push(`console: ${msg.text()}`)
  })
  page.on('pageerror', (err) => {
    if (NULL_DEREF.test(err.message)) hits.push(`pageerror: ${err.message}`)
  })
  return hits
}

test.describe('account pages — astro:page-load path guards (SMI-5158)', () => {
  test.beforeEach(async ({ page }) => {
    await injectSupabaseStub(page, { session: buildSessionToken({ provider: 'email' }) })
    // Closed-default mocks: tables resolve to [] and RPCs 404 — enough for each
    // page's inline script (and thus its astro:page-load listener) to register.
    await mockSupabase(page, {})
  })

  test('no leaked handler throws null-deref when navigating /account → siblings → back', async ({
    page,
  }) => {
    const hits = collectNullDerefs(page)

    await page.goto('/account')
    await expect(page).toHaveURL(/\/account\/?$/)

    for (const sibling of SIBLINGS) {
      // Forward: ClientRouter SPA-nav. The /account (index) listener — and every
      // sibling listener registered on a prior iteration — re-fires here on the
      // foreign DOM. Pre-fix the index handler throws the null-deref.
      await clickAccountNav(page, sibling.href, sibling.nav)
      await expect(page).toHaveURL(new RegExp(`${sibling.url}/?$`))

      // Back to /account via history (ClientRouter intercepts popstate): the
      // sibling's own listener now re-fires on the /account DOM.
      await page.goBack()
      await expect(page).toHaveURL(/\/account\/?$/)
    }

    // Amplify: fire astro:page-load once more on /account so every accumulated
    // sibling listener runs against the index DOM in a single deterministic tick.
    await refireAstroPageLoad(page)

    expect(hits, hits.join('\n')).toEqual([])
  })
})
