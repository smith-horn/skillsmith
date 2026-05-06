/**
 * E2E: API usage counter via website auth surfaces.
 *
 * SMI-4462 Step 4 — covers paths #4 (authed browser-side fetch) and
 * #5 (anonymous SSR proxy negative case).
 *
 * Why vitest + raw fetch instead of Playwright with the existing
 * packages/website/playwright.config.ts:
 *   - The existing Playwright suite mocks Supabase entirely (see
 *     packages/website/tests/e2e/complete-profile.helpers.ts) — there is no
 *     established pattern for authed real-staging Playwright runs in this
 *     repo, and standing one up is more infrastructure than the SMI-4462
 *     plan budgets for Wave 1.
 *   - The actual browser-side path that increments user_api_usage is well
 *     defined: every authed `/skills` / `/account` page builds an
 *     `Authorization: Bearer ${session.access_token}` header (see
 *     packages/website/src/pages/account/index.astro,
 *     packages/website/src/pages/account/cli-token.astro,
 *     packages/website/src/pages/account/billing.astro) and calls the
 *     skills-search / skills-get edge functions. Reproducing that exact
 *     header → edge-function → auth-middleware → incrementUsageCounter
 *     pipeline via fetch covers the path without simulating the UI shell.
 *
 * Path #4 (authed): provision user → call staging skills-search with the
 *   user's Bearer JWT → assert user_api_usage.search_count += 1.
 * Path #5 (anon SSR negative): hit /functions/v1/skills-search with no
 *   auth header (mirrors packages/website/src/pages/api/skills-search.ts
 *   which proxies upstream without forwarding any user identity) → assert
 *   user_api_usage row count for the test user is unchanged.
 *
 * Tagged `@e2e-usage-counter`; tests/e2e/** is excluded from preflight.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  provisionTestUser,
  cleanupTestUser,
  getUsageRow,
  setStaleSubscriptionRow,
  stagingFunctionUrl,
  stagingCredentialsAbsent,
  getStagingAnonKey,
  getStagingServiceRoleKey,
  waitForCounterIncrement,
  type ProvisionedUser,
} from '../fixtures/usage-counter-fixture.js'

const skipIfNoCreds = stagingCredentialsAbsent()

describe.skipIf(skipIfNoCreds)('@e2e-usage-counter Website auth surface → usage counter', () => {
  let user: ProvisionedUser

  beforeAll(async () => {
    user = await provisionTestUser({ tier: 'community' })
  }, 30_000)

  afterAll(async () => {
    if (user?.userId) {
      await cleanupTestUser(user.userId)
    }
  }, 30_000)

  it('authed Bearer JWT increments user_api_usage.search_count by 1 (path #4)', async () => {
    const before = await getUsageRow(user.userId)

    const url = `${stagingFunctionUrl('skills-search')}?query=react&limit=5`
    const res = await fetch(url, {
      headers: {
        // Mirrors the headers built by packages/website/src/pages/account/*.astro
        // and packages/website/src/pages/skills/index.astro before they hit the
        // edge function.
        Authorization: `Bearer ${user.jwt}`,
        apikey: getStagingAnonKey(),
        Accept: 'application/json',
      },
    })
    expect(res.ok, `skills-search returned ${res.status}`).toBe(true)

    await waitForCounterIncrement(user.userId, 'search_count', before.search_count + 1)
    const after = await getUsageRow(user.userId)
    expect(after.search_count).toBe(before.search_count + 1)
  }, 30_000)

  it('anonymous SSR proxy does NOT increment any counter for the test user (path #5)', async () => {
    const before = await getUsageRow(user.userId)

    // The website's /api/skills-search SSR proxy
    // (packages/website/src/pages/api/skills-search.ts) hits the upstream edge
    // function with no Authorization / X-API-Key header — only an Accept hint.
    // We replicate the exact request to prove that path doesn't and shouldn't
    // bump the test user's counter.
    const url = `${stagingFunctionUrl('skills-search')}?query=react&limit=5`
    const res = await fetch(url, {
      headers: {
        // Anon key required by the function gateway, but no user identity.
        apikey: getStagingAnonKey(),
        Accept: 'application/json',
      },
    })
    // Anonymous calls succeed under the trial limit; a 200 here is fine,
    // a 429 also satisfies the negative assertion (no row mutation either way).
    expect([200, 429]).toContain(res.status)

    // Allow the same 1.5s window any successful counter increment would
    // need before sampling — gives a real bug a chance to surface.
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    const after = await getUsageRow(user.userId)
    expect(after.search_count).toBe(before.search_count)
    expect(after.get_count).toBe(before.get_count)
    expect(after.recommend_count).toBe(before.recommend_count)
  }, 30_000)
})

// SMI-4741: stale billing period fallback.
// Verifies that get_user_usage_for_billing_period returns the calendar month
// window (not 0) when the user's subscription.current_period_end is in the past.
describe.skipIf(skipIfNoCreds)(
  '@e2e-usage-counter Stale billing period → calendar month fallback',
  () => {
    let paidUser: ProvisionedUser

    beforeAll(async () => {
      paidUser = await provisionTestUser({ tier: 'individual' })
      await setStaleSubscriptionRow(paidUser.userId)
    }, 30_000)

    afterAll(async () => {
      if (paidUser?.userId) {
        await cleanupTestUser(paidUser.userId)
      }
    }, 30_000)

    it('returns calendar-month period_start when subscription period is expired', async () => {
      const stagingUrl = stagingFunctionUrl('').replace('/functions/v1/', '/rest/v1/rpc/')
      const rpcUrl = `${stagingUrl}get_user_usage_for_billing_period`
      // service_role needed: GRANT EXECUTE ... TO service_role (not anon).
      const serviceKey = getStagingServiceRoleKey()
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ p_user_id: paidUser.userId }),
      })
      expect(res.ok, `RPC returned ${res.status}`).toBe(true)

      const rows = (await res.json()) as Array<{ period_start?: string; period_end?: string }>
      expect(rows.length).toBeGreaterThan(0)

      const currentMonthStart = new Date()
      currentMonthStart.setUTCDate(1)
      currentMonthStart.setUTCHours(0, 0, 0, 0)

      // period_start must equal the first of the current calendar month —
      // proving the stale-period guard fired and fell back (not the expired Stripe period).
      const returnedStart = new Date(rows[0]?.period_start ?? '')
      expect(returnedStart.getUTCDate()).toBe(1)
      expect(returnedStart.getUTCMonth()).toBe(currentMonthStart.getUTCMonth())
      expect(returnedStart.getUTCFullYear()).toBe(currentMonthStart.getUTCFullYear())

      // period_end must be strictly after now (calendar month end is in the future).
      const returnedEnd = new Date(rows[0]?.period_end ?? '')
      expect(returnedEnd.getTime()).toBeGreaterThan(Date.now())
    }, 30_000)
  }
)
