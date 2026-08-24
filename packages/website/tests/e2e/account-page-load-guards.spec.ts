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

// The bug surfaces as a null property access, phrased differently per
// engine AND per read-vs-write (SMI-6154 discovery: V8/Chromium phrases a
// null property WRITE — e.g. `document.getElementById(x)!.textContent =
// ...` — as "Cannot set properties of null (setting '...')", distinct from
// its own "Cannot read properties of null (reading '...')" wording for a
// null property READ; WebKit uses "null is not an object (evaluating
// '...')" for both. Every null-deref this file's tests were written
// against before SMI-6154 happened to be WebKit-only or a read, so this
// gap went undetected — a Chromium-side null-property-WRITE crash would
// have silently passed collectNullDerefs() as "no hits" instead of
// failing loudly.
const NULL_DEREF =
  /Cannot read properties of null|Cannot set properties of null|null is not an object|reading 'style'/

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

// SMI-6134 regression guard: populated by mockSupabase() whenever a request
// reaches a real (non-stub) Supabase-shaped host — see mockSupabase()'s
// catch-all route in complete-profile.helpers.ts. Reset before every test;
// asserted empty after every test, file-wide (a top-level test.afterEach()
// applies to every test in this file, including inside test.describe()
// blocks below). Tests in this file that never call mockSupabase() directly
// (the SMI-6112 block, which uses its own mockDelayedTierCheck() route
// instead) leave this at its reset [] and the assertion passes vacuously —
// their coverage against this bug comes from Step 1's immutable-injection
// fix itself, not from this collector.
let unexpectedSupabaseRequests: string[] = []

test.beforeEach(() => {
  unexpectedSupabaseRequests = []
})

test.afterEach(() => {
  expect(
    unexpectedSupabaseRequests,
    `Unexpected request(s) reached a real (non-stub) Supabase host instead of the test stub — ` +
      `window.__SUPABASE_CONFIG__ should be immutable (SMI-6134); something bypassed it. ` +
      `Captured URL(s):\n${unexpectedSupabaseRequests.join('\n')}`
  ).toEqual([])
})

test.describe('account pages — astro:page-load path guards (SMI-5158)', () => {
  test.beforeEach(async ({ page }) => {
    await injectSupabaseStub(page, { session: buildSessionToken({ provider: 'email' }) })
    // SMI-6134 correction: previously `mockSupabase(page, {})` (fully
    // closed-default — check_team_tier_access unmocked, 404) was enough
    // because the pre-fix bug (this very file's regression target) meant
    // /account's own inline script silently emptied window.__SUPABASE_CONFIG__
    // before its astro:page-load handler ran, so index.astro's own
    // `if (!config.url || !config.anonKey)` guard (index.astro:390) bailed
    // out before ever calling checkTeamAccess() — masking that this mock was
    // always missing a check_team_tier_access response. Now that the stub
    // config correctly survives (the fix under test here), /account's
    // astro:page-load handler actually reaches checkTeamAccess(); an
    // unmocked (404) RPC response there degrades to `not_authenticated`
    // (team-access.ts) and immediately redirects to /login, which this
    // test's own navigation loop never expects. An entitled response keeps
    // /account rendering normally, matching account-sidebar.spec.ts's first
    // describe block, which already does this for the same reason.
    ;({ unexpectedSupabaseRequests } = await mockSupabase(page, {
      rpcResponses: {
        check_team_tier_access: {
          ok: true,
          reason: null,
          team_id: 'team_smi5158_fixture',
          tier: 'team',
        },
      },
    }))
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

/**
 * SMI-6137: instrument the page to count real `astro:before-swap`
 * firings — mirrors `injectPageLoadCounter()` above but for the earlier
 * lifecycle event the SMI-6137 fix also advances the navigation epoch on.
 * `astro:before-swap` fires once per real SPA transition, strictly before
 * `astro:page-load` (never after, and never on the very first non-SPA
 * `page.goto()` load — see `account-navigation-epoch.ts`'s module doc
 * comment). Used to release a held response inside the specific
 * pre-`astro:page-load` window SMI-6137 closes, rather than after it
 * (which is what the existing SMI-6112 tests below do via
 * `waitForPageLoadCount`, and why they don't exercise this gap).
 */
async function injectBeforeSwapCounter(page: Page): Promise<void> {
  await page.addInitScript(() => {
    ;(window as unknown as { __e2eBeforeSwapCount: number }).__e2eBeforeSwapCount = 0
    document.addEventListener('astro:before-swap', () => {
      ;(window as unknown as { __e2eBeforeSwapCount: number }).__e2eBeforeSwapCount += 1
    })
  })
}

async function waitForBeforeSwapCount(page: Page, expected: number): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __e2eBeforeSwapCount: number }).__e2eBeforeSwapCount
      )
    )
    .toBeGreaterThanOrEqual(expected)
}

/**
 * SMI-6137: route Supabase calls so `check_team_tier_access` resolves
 * immediately with an entitled response (getting `/account`'s handler
 * past the tier gate quickly) while the `team_members` REST call —
 * `loadTeamOverviewData()`'s own first network request
 * (`account-overview-data.ts`) — is held open behind a release gate. This
 * targets the DOM-write path specifically (`index.astro:440`,
 * `document.getElementById('team-name')!.textContent = data.teamName`),
 * unlike `mockDelayedTierCheck()` above, which targets the redirect path
 * by holding the tier check itself. Every other REST/RPC call gets a
 * fixed, immediate closed-default response — this test only cares about
 * timing the one call that gates the DOM write.
 */
async function mockDelayedTeamData(
  page: Page
): Promise<{ release: () => void; callCount: () => number }> {
  const gate = makeDeferred()
  let callCount = 0

  await page.route(`${SUPABASE_HOST}/**`, async (route: Route) => {
    const url = new URL(route.request().url())
    const rpcMatch = url.pathname.match(/\/rest\/v1\/rpc\/([^/]+)/)

    if (rpcMatch && rpcMatch[1] === 'check_team_tier_access') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          reason: null,
          team_id: 'team_smi6137_fixture',
          tier: 'team',
        }),
      })
      return
    }

    if (rpcMatch) {
      // Closed-default `[]`, not `{}`: every RPC this route doesn't
      // special-case (e.g. `get_effective_subscription_summary`,
      // `get_user_subscription` on /account/billing's own handler) is
      // consumed as an array (`rows?.[0]`) by its caller — `[]` makes that
      // access resolve to `undefined` explicitly, same as a real "no rows"
      // response, rather than relying on `{}[0]` coincidentally doing the
      // same thing.
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
      return
    }

    if (url.pathname.startsWith('/auth/v1/')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
      return
    }

    const restMatch = url.pathname.match(/\/rest\/v1\/([^/?]+)/)
    // Scoped to /account's own loadTeamOverviewData() query specifically
    // (`select=team_id,role&team_id=eq.<id>`, no `user_id` filter) — NOT
    // /account/billing's own, differently-shaped `team_members` query
    // (`.eq('team_id', ...).eq('user_id', ...).maybeSingle()`), which must
    // reach its own closed-default below undisturbed so the destination
    // page's own handler isn't accidentally held by this gate too.
    if (restMatch && restMatch[1] === 'team_members' && !url.searchParams.has('user_id')) {
      callCount += 1
      await gate.promise
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ team_id: 'team_smi6137_fixture', role: 'member' }]),
      })
      return
    }

    if (restMatch && restMatch[1] === 'teams') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'team_smi6137_fixture',
          name: 'SMI-6137 Fixture Team',
          slug: 'smi-6137-fixture',
          max_members: 10,
        }),
      })
      return
    }

    // Closed-default: empty array for any other REST table.
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  })

  return { release: () => gate.resolve(), callCount: () => callCount }
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

  test('SMI-6137: a stale team-data write never lands on the destination DOM after navigating away', async ({
    page,
  }) => {
    await injectBeforeSwapCounter(page)
    const hits = collectNullDerefs(page)
    const { release, callCount } = await mockDelayedTeamData(page)

    // In-page-triggered release, not expect.poll(): `expect.poll()`'s
    // ~100ms default interval is real wall-clock latency between the
    // moment `astro:before-swap` actually fires and the moment Node
    // observes it and calls `release()` — on this route, `runScripts()`
    // has no external-`src` script to await (verified via grep, see the
    // plan doc), so the in-page `runScripts()` -> `astro:page-load` chain
    // has no I/O of its own and could plausibly complete inside that
    // ~100ms window regardless of which counter a poll waited on, making
    // the test pass vacuously even against the pre-fix code. Exposing the
    // release directly to an `astro:before-swap` listener cuts that gap
    // to a single CDP round-trip instead.
    let released = false
    await page.exposeFunction('__smi6137ReleaseGate', () => {
      released = true
      release()
    })
    await page.addInitScript(() => {
      document.addEventListener(
        'astro:before-swap',
        () => {
          ;(window as unknown as { __smi6137ReleaseGate: () => void }).__smi6137ReleaseGate()
        },
        { once: true }
      )
    })

    await page.goto('/account')
    await waitForPageLoadCount(page, 1)
    await expect.poll(callCount).toBe(1)

    // Real ClientRouter transition away from /account while
    // loadTeamOverviewData()'s team_members query is still held open. The
    // in-page listener above releases it the instant astro:before-swap
    // fires for this transition — the earlier point in the window
    // SMI-6137's fix closes (contrast with the three tests above, which
    // correctly target the redirect path by waiting for the later
    // astro:page-load count instead).
    await clickAccountNav(page, '/account/billing')
    await expect(page).toHaveURL(/\/account\/billing\/?$/)
    await expect
      .poll(() => released, {
        message: 'astro:before-swap never fired for this transition (release never triggered)',
      })
      .toBe(true)

    // Independent sanity check that the release really was tied to a real
    // astro:before-swap firing (not, say, a typo'd event name that
    // happened to leave `released` stuck false in a way `expect.poll`
    // above would already have caught, but this pins the specific event
    // rather than only the exposeFunction side effect).
    await waitForBeforeSwapCount(page, 1)

    // Give the released response's network round-trip and the handler's
    // remaining continuation a moment to actually run before asserting.
    await page.waitForTimeout(300)

    // Pre-fix, /account's handler would still reach
    // `document.getElementById('team-name')!.textContent = data.teamName`
    // (index.astro:440) here — even though the browser is already on
    // /account/billing — throwing because #team-name no longer exists in
    // the live document, caught and logged at index.astro:467-471
    // (`console.error('Team dashboard load failed:', err)`, matched by
    // `NULL_DEREF` above).
    expect(hits, hits.join('\n')).toEqual([])
    await expect(page).toHaveURL(/\/account\/billing\/?$/)
    // Destination page's own content actually rendered (plan review, VP
    // Design) — guards against a self-invalidation timing bug on
    // /account/billing's own handler going uncaught by the assertions
    // above. #billing-content starts `display: none` and only becomes
    // visible once billing.astro's own astro:page-load handler completes
    // (`billing.astro:97`, `showState('content')`).
    await expect(page.locator('#billing-content')).toBeVisible()
  })
})

// ─── SMI-6154: orphaned astro:page-load dispatch during a URL/DOM desync ──
//
// Distinct from SMI-6137 (a stale continuation racing a completed
// navigation) and from SMI-5158 (leaked listeners re-firing on a foreign
// route). Root cause (see the SMI-6154 Linear issue for the full traced
// investigation): on a browser back/forward navigation, `location.href`
// reverts to the destination URL natively, before Astro's ClientRouter has
// swapped the DOM to match. Astro's own `updateCallbackDone.finally(...)`
// continuation (`runScripts()` + `onPageLoad()`,
// `node_modules/astro/dist/transitions/router.js` as of `astro@7.2.0`) is
// never awaited, cancelled, or checked against a newer navigation — so an
// EARLIER, already-superseded transition's `astro:page-load` dispatch can
// arrive late and land squarely in that desync window: `location.pathname`
// already reads the destination route, but the live DOM still belongs to
// whatever page the user was leaving. `isCurrentAccountPath()` passes on
// the reverted URL; the SMI-6112/SMI-6137 navigation-epoch guard also can't
// catch it, since the orphaned dispatch's own firing is itself the most
// recent epoch-advancing event — a guard captured inside it is fresh by
// construction. Fixed by `isAccountPageMounted()` (`account-page-path.ts`):
// each of the five gated pages also checks a `data-account-page` DOM
// marker is actually live before proceeding, closing the gap the pathname-
// only entry check cannot.
test.describe('SMI-6154 — orphaned astro:page-load dispatch during URL/DOM desync', () => {
  test.beforeEach(async ({ page }) => {
    await injectSupabaseStub(page, { session: buildSessionToken({ provider: 'email' }) })
    await mockSupabase(page, {
      rpcResponses: {
        check_team_tier_access: {
          ok: true,
          reason: null,
          team_id: 'team_smi6154_fixture',
          tier: 'team',
        },
        // billing.astro's own astro:page-load handler makes these two RPC
        // calls independently of /account's — mockSupabase()'s closed-
        // default is a 404 for any unmocked RPC, which billing.astro's
        // `if (effectiveError) throw effectiveError` / `if (subscriptionError)
        // throw` turn into its error state (not a bug — just this test's
        // own fixture needing to cover the destination page's requests
        // too, since the test navigates there and asserts its content
        // rendered).
        get_effective_subscription_summary: [],
        get_user_subscription: [],
      },
    })
  })

  test('an orphaned dispatch landing while the URL already reads /account but the DOM is still a sibling page is rejected', async ({
    page,
  }) => {
    const hits = collectNullDerefs(page)

    await page.goto('/account')
    await expect(page).toHaveURL(/\/account\/?$/)
    // Confirm /account's own handler actually ran successfully first —
    // otherwise a false pass below could just mean nothing ever loaded.
    await expect(page.locator('#team-name')).not.toHaveText('—')

    // Real ClientRouter transition away — the DOM is now billing's, and
    // index.astro's leaked `astro:page-load` listener persists (SMI-5158).
    await clickAccountNav(page, '/account/billing')
    await expect(page).toHaveURL(/\/account\/billing\/?$/)
    // Confirm billing's own handler actually finished rendering before we
    // manipulate anything below — checked here, right after the real
    // navigation, rather than after the pushState maneuver next: under
    // `astro dev` a route's first-hit SSR compile can add lag (see
    // `injectPageLoadCounter()`'s doc comment above), and this is a real
    // async load worth giving room to settle on its own timeline.
    await expect(page.locator('#billing-content')).toBeVisible()

    // Engineer the exact desync state deterministically, rather than
    // racing the real timing that produces it in the wild (a page.goBack()
    // colliding with a still-in-flight forward transition's orphaned
    // page-load tail — flaky by nature, and already covered non-
    // deterministically by the SMI-5158 test above). history.pushState()
    // updates location.href WITHOUT firing `popstate` or triggering any
    // Astro transition — exactly the "URL says /account, DOM is billing's"
    // state a real orphaned dispatch lands in, isolated from the timing
    // that produces it.
    await page.evaluate(() => history.pushState({}, '', '/account'))
    await expect(page).toHaveURL(/\/account\/?$/)

    // Fire the orphaned dispatch itself. Pre-fix, index.astro's leaked
    // handler passes isCurrentAccountPath() (pathname already reverted)
    // and crashes on `document.getElementById('team-name')` being null —
    // billing's DOM has no such element.
    await refireAstroPageLoad(page)
    await page.waitForTimeout(300)

    expect(hits, hits.join('\n')).toEqual([])
    // Still genuinely showing billing's own content, undisturbed by the
    // orphaned dispatch — the URL itself stays at /account (this test's
    // own history.pushState() call above set it there and nothing reverts
    // it; that's expected, not a bug: pushState never triggered a real
    // Astro transition, so the DOM was never touched by anything other
    // than the orphaned dispatch this test fires next).
    await expect(page).toHaveURL(/\/account\/?$/)
    await expect(page.locator('#billing-content')).toBeVisible()
  })
})
