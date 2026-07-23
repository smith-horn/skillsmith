/**
 * status-page-load-guards.spec.ts (SMI-5755)
 *
 * `status.astro` registers `astro:page-load` (poller init) and, on its own
 * `dataset.statusWired` guard, `astro:before-swap`/`visibilitychange`
 * listeners on `document` — the exact shape flagged by the governance
 * skill's Shared-State/Concurrency Audit (P-5) as requiring a synthetic
 * re-fire test (SMI-4902 helpers), following the precedent set by
 * `account-page-load-guards.spec.ts` and `device.spec.ts` D-6.
 *
 * This drives real `astro:page-load` re-fires (via `refireAstroPageLoad`)
 * against a mocked `status-public` route and asserts: (1) the rendered
 * overall-status banner is stable across a re-fire (no stale/torn-down
 * repaint), and (2) each re-fire's `initStatusPageInstance()` call produces
 * exactly one immediate fetch, not a duplicate/stacked one from two live
 * pollers both reacting to the same event. The deeper timer-accumulation
 * property (does the OLD poller's own next *scheduled* poll, ~45s out,
 * also get torn down, not just its immediate fetch) is covered at the unit
 * level in status-poller.test.ts's createStatusPoller suite with fake
 * timers — see that file's tests for the AbortController + generation-token
 * mechanism this page's poller relies on.
 */

import { test, expect } from '@playwright/test'
import { refireAstroPageLoad, assertStateStableAcrossRefire } from './astro-helpers'

const STATUS_PUBLIC_ROUTE = '**/functions/v1/status-public'

function mockPayload() {
  return {
    cached: false,
    data: {
      generated_at: new Date().toISOString(),
      overall_status: 'operational',
      components: [],
      incidents: [],
    },
  }
}

test.describe('status page — astro:page-load re-fire guards (SMI-5755)', () => {
  test('the overall-status banner is stable across a synthetic astro:page-load re-fire', async ({
    page,
  }) => {
    await page.route(STATUS_PUBLIC_ROUTE, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockPayload()),
      })
    })

    await page.goto('/status')
    await expect(page.locator('#status-overall-headline')).toHaveText('All systems operational')

    await assertStateStableAcrossRefire(page, '#status-overall-headline')
    await expect(page.locator('#status-overall-headline')).toHaveText('All systems operational')
  })

  test('each astro:page-load re-fire produces exactly one fresh poller, not an accumulating one', async ({
    page,
  }) => {
    // This proves the DOM/wiring-level contract: initStatusPageInstance()
    // runs exactly once per real astro:page-load event, and each run tears
    // down the previous poller before creating a new one — one immediate
    // fetch per re-fire, no duplicate/stacked immediate fetches from two
    // live pollers both reacting to the same re-fire.
    //
    // This is deliberately NOT trying to also prove the deeper "the OLD
    // poller's *next scheduled* poll, ~45s out, never fires" property here —
    // that's a timer-accumulation question already covered rigorously at the
    // unit level in status-poller.test.ts's createStatusPoller suite (fake
    // timers, vi.advanceTimersByTimeAsync), which exercises the exact same
    // AbortController + generation-token + recursive-setTimeout mechanism
    // this page's poller instance uses. Splitting it this way — e2e proves
    // real wiring, unit test proves real timing — is more reliable than
    // fighting Playwright's page.clock against a page.route-mocked fetch in
    // the same test.
    let hits = 0
    await page.route(STATUS_PUBLIC_ROUTE, async (route) => {
      hits += 1
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockPayload()),
      })
    })

    await page.goto('/status')
    await expect(page.locator('#status-overall-headline')).toHaveText('All systems operational')
    expect(hits, 'initial mount should fetch exactly once').toBe(1)

    for (let i = 0; i < 3; i += 1) {
      await refireAstroPageLoad(page)
      // eslint-disable-next-line no-await-in-loop -- each re-fire's fetch must settle before the next
      await expect.poll(() => hits).toBe(2 + i)
    }

    expect(hits, 'exactly one immediate fetch per re-fire — no duplicate/stacked pollers').toBe(4)
  })
})
