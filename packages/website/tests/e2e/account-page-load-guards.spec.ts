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
 * its own page (canonical guard, see `account/team/index.astro`). This spec drives
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

// Quick-link siblings reachable via a real `<a>` on the /account dashboard, so
// ClientRouter (not a full reload) performs the transition that re-fires
// `astro:page-load` on the previously-visited page's leaked listener.
const SIBLINGS = [
  { href: '/account/team', url: '/account/team' },
  { href: '/account/billing', url: '/account/billing' },
  { href: '/account/cli-token/', url: '/account/cli-token' },
  { href: '/account/outreach-preferences', url: '/account/outreach-preferences' },
  { href: '/account/telemetry', url: '/account/telemetry' },
]

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
      await page.click(`.quick-links a[href="${sibling.href}"]`)
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

  test('the new Team quick-link navigates to /account/team', async ({ page }) => {
    await page.goto('/account')
    await page.click('.quick-links a[href="/account/team"]')
    await expect(page).toHaveURL(/\/account\/team\/?$/)
  })
})
