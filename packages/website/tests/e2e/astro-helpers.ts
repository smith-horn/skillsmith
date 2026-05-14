/**
 * astro-helpers.ts — reusable Playwright helpers for Astro client-side races.
 *
 * Extracted in SMI-4902 from D-6 in `device.spec.ts`. These helpers codify the
 * `astro:page-load` re-fire + handler-accumulation patterns that surface as
 * recurring bugs in client-side Astro pages with ClientRouter view transitions.
 *
 * Motivating incidents:
 *   - SMI-4895 (device-login race: window.__SUPABASE_CLIENT__ read outside producer)
 *   - SMI-4896 (post-approve state rollback: astro:page-load re-fire clobbered state)
 *   - SMI-4897 (auto-close countdown removed; FTUE honesty)
 *   - SMI-4893 (LoginButton handler accumulation, open / regression-tracked)
 *
 * Naming convention (cluster-commented for discoverability):
 *
 *   • Verb-prefix utilities (`refire…`, `dispatch…`) DO an action. They have
 *     observable side effects on `page` and return `Promise<void>`.
 *
 *   • Assert-prefix utilities (`assert…`) make a claim that throws on
 *     violation. They drive Playwright `expect()` under the hood and surface
 *     human-readable failure messages.
 *
 * Adding helpers? Match an existing prefix or document the new prefix here.
 */

import { expect, type Page } from '@playwright/test'

// ─── Verb-prefix utilities (do an action) ────────────────────────────────

/**
 * Synthetically dispatch `astro:page-load` on `document`, simulating a
 * ClientRouter view transition that re-fires the lifecycle event on the same
 * page (no real navigation). This is the canonical reproduction of the
 * idempotency-guard failure mode SMI-4896 fixed in `device.astro`.
 *
 * Usage:
 *   await refireAstroPageLoad(page)
 *
 * Implementation note: `document.dispatchEvent(new Event('astro:page-load'))`
 * is intentionally identical to what `ClientRouter` does on transition; we
 * are NOT calling Astro internals.
 */
export async function refireAstroPageLoad(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.dispatchEvent(new Event('astro:page-load'))
  })
}

// ─── Assert-prefix utilities (make a claim, throw on violation) ──────────

/**
 * Asserts that the element matched by `stateLocator` remains visible across a
 * synthetic `astro:page-load` re-fire. The canonical state-rollback regression
 * test: in SMI-4896, the post-approve `#state-approved` element was clobbered
 * back to `#state-preview` because `init()` re-ran on every re-fire without an
 * idempotency guard.
 *
 * Usage (D-6 idiom):
 *   await page.locator('#btn-approve').click()
 *   await expect(page.locator('#state-approved')).toBeVisible()
 *   await assertStateStableAcrossRefire(page, '#state-approved')
 *
 * The helper does NOT verify the negative ("preview is hidden") — pass that
 * assertion separately if the page has mutually-exclusive states. This
 * decouples the helper from page-specific state machines.
 */
export async function assertStateStableAcrossRefire(
  page: Page,
  stateLocator: string
): Promise<void> {
  // Pre-condition: the target state must be visible BEFORE we re-fire, else
  // the assertion would be a tautology (asserting a thing was never there).
  await expect(page.locator(stateLocator)).toBeVisible()
  await refireAstroPageLoad(page)
  await expect(page.locator(stateLocator)).toBeVisible()
}

/**
 * Asserts that a button does NOT accumulate handlers across synthetic
 * `astro:page-load` re-fires.
 *
 * Contract: `clicks === routeHits regardless of refires`.
 *
 *   Bind handler on initial mount.
 *   Fire `refires` synthetic re-fires (post-mount, with no real navigation).
 *   Click `clicks` times.
 *   Expect EXACTLY `clicks` route hits to `routeMockUrl` — not `clicks *
 *   (1 + refires)`, not `clicks + refires`, just `clicks`.
 *
 * The N+1 bug shape (SMI-4896): each re-fire added one new click handler;
 * clicking the button fired all handlers; a button bound once + re-fired N
 * times → N+1 handlers → N+1 route hits per click → quota/idempotency
 * violations.
 *
 * Naming note: the contract is `clicks === routeHits regardless of refires`
 * — NOT `N² vs N`. Helper consumers MUST NOT assert quadratic shape; that's
 * over-fitting to a specific bug variant.
 *
 * Usage:
 *   await assertNoHandlerAccumulation(page, '#btn-approve',
 *     '** /functions/v1/auth-device-approve', { clicks: 3, refires: 5 })
 *
 * @param page          The Playwright Page under test.
 * @param buttonSelector The CSS selector for the button that should bind once.
 * @param routeMockUrl  The URL pattern (string glob or RegExp) routed by the
 *                      test. Playwright's `page.route` API contract: glob
 *                      strings match by `URL` semantics; RegExps match full URL.
 * @param opts.clicks   Number of times to click the button (>= 1).
 * @param opts.refires  Number of synthetic `astro:page-load` re-fires to
 *                      perform AFTER initial mount, BEFORE clicking (>= 0).
 */
export async function assertNoHandlerAccumulation(
  page: Page,
  buttonSelector: string,
  routeMockUrl: string | RegExp,
  opts: { clicks: number; refires: number }
): Promise<void> {
  if (!Number.isInteger(opts.clicks) || opts.clicks < 1) {
    throw new Error(
      `assertNoHandlerAccumulation: clicks must be a positive integer, got ${opts.clicks}`
    )
  }
  if (!Number.isInteger(opts.refires) || opts.refires < 0) {
    throw new Error(
      `assertNoHandlerAccumulation: refires must be a non-negative integer, got ${opts.refires}`
    )
  }

  let routeHits = 0
  await page.route(routeMockUrl, async (route) => {
    routeHits += 1
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  })

  for (let i = 0; i < opts.refires; i += 1) {
    await refireAstroPageLoad(page)
  }

  const button = page.locator(buttonSelector)
  for (let i = 0; i < opts.clicks; i += 1) {
    await button.click()
  }

  // Drain any in-flight network microtasks so routeHits has settled.
  await page.waitForLoadState('networkidle').catch(() => {
    // networkidle can time out on pages with long-poll connections — that's
    // fine for our counting purposes; the route handler has already fired.
  })

  expect(
    routeHits,
    `expected exactly ${opts.clicks} route hit(s) regardless of ${opts.refires} re-fire(s); ` +
      `got ${routeHits} — handler accumulation suspected`
  ).toBe(opts.clicks)
}
