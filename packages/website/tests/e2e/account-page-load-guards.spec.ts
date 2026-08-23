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
 * SMI-6128 note: the account area's navigation surface is now
 * `AccountSidebar.astro` (desktop) + `AccountMobileNav.astro` (mobile
 * disclosure, at/below 1024px) — the retired `AccountHubNav` tab row's
 * eight destinations all now live inside `AccountSidebar`'s Admin/Tools
 * groups, so every sibling link below is reachable through
 * `.account-sidebar` alone. Below 1024px the sidebar is CSS-hidden but
 * still present in the DOM, so `clickAccountNav()` still drives the same
 * real ClientRouter transition via a programmatic click when the link isn't
 * visible — this regression net doesn't need to click through the mobile
 * disclosure specifically to exercise the leaked-listener class it guards
 * against.
 *
 * Pre-fix this spec fails (the leaked handler throws on every cross-page nav);
 * post-fix it passes. Auth + Supabase are mocked via complete-profile.helpers.ts
 * (no staging/prod network — prod ref vrcnzpmndtroqxxoqkzy, see CLAUDE.md).
 */

import { test, expect, type Page, type Route } from '@playwright/test'
import {
  buildSessionToken,
  injectSupabaseStub,
  mockSupabase,
  SUPABASE_HOST,
} from './complete-profile.helpers'
import { refireAstroPageLoad } from './astro-helpers'

// The bug surfaces as a null property access, phrased differently per engine.
const NULL_DEREF = /Cannot read properties of null|null is not an object|reading 'style'/

// Sibling pages reachable via a real `<a>` in the account sidebar (SMI-5475
// — replaced the Quick Links grid; SMI-6128 — reorganized into Account /
// Admin / Tools / Preferences / Resources, absorbing every destination the
// retired AccountHubNav tab row used to own), so ClientRouter (not a full
// reload) performs the transition that re-fires `astro:page-load` on the
// previously-visited page's leaked listener. /account (Overview) is the
// loop's anchor page — it is not its own sibling, so it is not listed here;
// its own leaked-listener coverage comes from being the page every
// iteration navigates back to.
const SIBLINGS = [
  { href: '/account/billing', url: '/account/billing' },
  { href: '/account/subscription', url: '/account/subscription' },
  { href: '/account/profile', url: '/account/profile' },
  { href: '/account/cli-token/', url: '/account/cli-token' },
  { href: '/account/outreach-preferences', url: '/account/outreach-preferences' },
  { href: '/account/telemetry', url: '/account/telemetry' },
  { href: '/account/skills', url: '/account/skills' },
]

/**
 * Click a sidebar link through ClientRouter. Below 1024px the sidebar is
 * CSS-hidden (matches /docs — SMI-5475 product decision; `AccountMobileNav`
 * covers that range instead, SMI-6128) but still present in the DOM, so on
 * the mobile project a sidebar link needs a programmatic click to still
 * bubble to ClientRouter's document-level listener and drive a real SPA
 * navigation, preserving the leaked-listener regression net at both
 * viewports.
 */
async function clickAccountNav(page: Page, href: string): Promise<void> {
  const link = page.locator(`.account-sidebar a[href="${href}"]`)
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
      await clickAccountNav(page, sibling.href)
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

// ─── SMI-6112: navigation-epoch guard against stale async continuations ──
//
// Each `astro:page-load` handler on the five team-gated account pages now
// captures a navigation epoch after its entry-path guard and rechecks
// `isStale()` before every redirect / entitlement write / DOM write that
// follows an `await` (packages/website/src/lib/account-navigation-epoch.ts).
// These specs drive the real ClientRouter race the fix closes: holding the
// `check_team_tier_access` RPC response open, navigating away mid-flight,
// then releasing it — pre-fix, the stale handler would still redirect or
// write onto a page the user already left.

interface Deferred {
  promise: Promise<void>
  resolve: () => void
}

function makeDeferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/**
 * Route every Supabase call, holding each successive `check_team_tier_access`
 * RPC response behind its own release gate (`gates[0]` for the first call
 * made on the page, `gates[1]` for the second, and so on) so a test can
 * control exactly when a tier-check resolves relative to a real navigation.
 * Every other request (auth, REST) answers with the same closed-default
 * `mockSupabase()` uses (200/`{}`/`[]`) — these specs only care about
 * tier-check timing, not downstream data.
 */
async function mockDelayedTierCheck(
  page: Page,
  gateResponses: unknown[]
): Promise<{ gates: Deferred[]; callCount: () => number }> {
  const gates = gateResponses.map(() => makeDeferred())
  let callCount = 0

  await page.route(`${SUPABASE_HOST}/**`, async (route: Route) => {
    const url = new URL(route.request().url())
    const rpcMatch = url.pathname.match(/\/rest\/v1\/rpc\/([^/]+)/)

    if (rpcMatch && rpcMatch[1] === 'check_team_tier_access') {
      const index = callCount
      callCount += 1
      const gate = gates[index]
      const body = gateResponses[index]
      if (!gate || body === undefined) {
        await route.fulfill({
          status: 500,
          body: `mockDelayedTierCheck: unexpected extra check_team_tier_access call #${index + 1}`,
        })
        return
      }
      await gate.promise
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      })
      return
    }

    if (rpcMatch) {
      await route.fulfill({ status: 404, body: 'rpc not mocked: ' + rpcMatch[1] })
      return
    }

    if (url.pathname.startsWith('/auth/v1/')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
      return
    }

    // REST — closed-default empty array (keeps unrelated selects from
    // crashing whichever page the browser lands on).
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  })

  return { gates, callCount: () => callCount }
}

/**
 * Instrument the page to count real `astro:page-load` firings, independent
 * of any application code. `page.waitForURL()` resolves as soon as
 * ClientRouter updates `location.href`, which can happen before the
 * destination page's own `astro:page-load` has actually fired — under
 * `astro dev` a route's first-hit SSR compile can add multi-second lag
 * between those two moments (the same lag the real CI workflow pre-warms
 * routes for; see .github/workflows/website-account-e2e.yml). The
 * navigation-epoch guard only advances on the real event, so these
 * regressions must wait for the event itself, not just the URL, before
 * releasing a held response — otherwise a slow-to-fire destination
 * `astro:page-load` would make a genuinely-stale response look "not yet
 * stale" by coincidence of timing, independent of the guard's own logic.
 */
async function injectPageLoadCounter(page: Page): Promise<void> {
  await page.addInitScript(() => {
    ;(window as unknown as { __e2ePageLoadCount: number }).__e2ePageLoadCount = 0
    document.addEventListener('astro:page-load', () => {
      ;(window as unknown as { __e2ePageLoadCount: number }).__e2ePageLoadCount += 1
    })
  })
}

async function waitForPageLoadCount(page: Page, expected: number): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __e2ePageLoadCount: number }).__e2ePageLoadCount)
    )
    .toBeGreaterThanOrEqual(expected)
}

test.describe('SMI-6112 — navigation-epoch guard against stale async continuations', () => {
  test.beforeEach(async ({ page }) => {
    await injectPageLoadCounter(page)
    await injectSupabaseStub(page, { session: buildSessionToken({ provider: 'email' }) })
  })

  test('a stale /account tier-check never applies its Summary redirect after navigating away', async ({
    page,
  }) => {
    const { gates, callCount } = await mockDelayedTierCheck(page, [
      { ok: false, reason: 'not_team_tier', team_id: null, tier: 'community' },
    ])

    await page.goto('/account')
    await expect.poll(callCount).toBe(1)
    await waitForPageLoadCount(page, 1)

    // Real ClientRouter transition away from /account while the tier-check
    // is still in flight. Wait for the DESTINATION page's own
    // astro:page-load to have fired — not just for the URL to update — so
    // the epoch guard has actually advanced before we release the stale
    // response below.
    await clickAccountNav(page, '/account/billing')
    await expect(page).toHaveURL(/\/account\/billing\/?$/)
    await waitForPageLoadCount(page, 2)

    // Release the stale response. Pre-fix, /account's Decision #4 redirect
    // (not_team_tier -> /account/summary) would still fire here even though
    // the browser is on /account/billing.
    gates[0].resolve()
    await page.waitForTimeout(300)

    await expect(page).toHaveURL(/\/account\/billing\/?$/)
  })

  test('a stale team-admin page tier-check never applies its Subscription redirect after navigating away', async ({
    page,
  }) => {
    const { gates, callCount } = await mockDelayedTierCheck(page, [
      { ok: false, reason: 'not_team_tier', team_id: null, tier: 'community' },
    ])

    await page.goto('/account/team/members')
    await expect.poll(callCount).toBe(1)
    await waitForPageLoadCount(page, 1)

    await clickAccountNav(page, '/account/billing')
    await expect(page).toHaveURL(/\/account\/billing\/?$/)
    await waitForPageLoadCount(page, 2)

    // Pre-fix, members.astro's handler would still redirect to
    // /account/subscription?gated=not_team_tier even though the user left.
    gates[0].resolve()
    await page.waitForTimeout(300)

    await expect(page).toHaveURL(/\/account\/billing\/?$/)
  })

  test('A-B-A: a stale first check never applies once a fresher check has resolved for the same route', async ({
    page,
  }) => {
    const { gates, callCount } = await mockDelayedTierCheck(page, [
      { ok: false, reason: 'not_team_tier', team_id: null, tier: 'community' },
      { ok: true, reason: null, team_id: 'team_aba', tier: 'team' },
    ])

    await page.goto('/account')
    await expect.poll(callCount).toBe(1)
    await waitForPageLoadCount(page, 1)

    // Leave, then return to /account before the first check resolves — the
    // return visit issues a second, fresher check. Each wait is on the real
    // astro:page-load count, not just the URL, for the same reason as above.
    await clickAccountNav(page, '/account/billing')
    await expect(page).toHaveURL(/\/account\/billing\/?$/)
    await waitForPageLoadCount(page, 2)

    await page.goBack()
    await expect(page).toHaveURL(/\/account\/?$/)
    await waitForPageLoadCount(page, 3)
    await expect.poll(callCount).toBe(2)

    // Release the stale FIRST response. It must never apply — no redirect
    // to /account/summary triggered by the first, now-superseded check.
    gates[0].resolve()
    await page.waitForTimeout(300)
    await expect(page).toHaveURL(/\/account\/?$/)

    // Release the fresh SECOND (ok:true) response — this is the current
    // handler's own continuation, so it is free to proceed. The page
    // settles normally; nothing about the epoch guard blocks its own
    // non-stale check.
    gates[1].resolve()
    await page.waitForTimeout(300)
    await expect(page).toHaveURL(/\/account\/?$/)
  })
})
