/**
 * E2E: API usage counter via direct X-API-Key requests.
 *
 * SMI-4462 Step 5 — covers path #7 (direct curl/fetch with X-API-Key).
 *
 * The third-party / scripted-integration shape: the caller has a sk_live_*
 * key and hits the staging edge function directly, no SDK in between. Two
 * back-to-back requests must both increment user_api_usage.search_count
 * (i.e. the second call hits the tier cache and *still* fires the counter
 * — the SMI-2144 regression class).
 *
 * Tagged `@e2e-usage-counter`; tests/e2e/** is excluded from preflight.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  provisionTestUser,
  cleanupTestUser,
  getUsageRow,
  stagingFunctionUrl,
  stagingCredentialsAbsent,
  getStagingAnonKey,
  waitForCounterIncrement,
  type ProvisionedUser,
} from '../fixtures/usage-counter-fixture.js'

const skipIfNoCreds = stagingCredentialsAbsent()

describe.skipIf(skipIfNoCreds)('@e2e-usage-counter Direct X-API-Key → usage counter', () => {
  let user: ProvisionedUser

  beforeAll(async () => {
    user = await provisionTestUser({ tier: 'community' })
  }, 30_000)

  afterAll(async () => {
    if (user?.userId) {
      await cleanupTestUser(user.userId)
    }
  }, 30_000)

  it('two consecutive X-API-Key calls increment search_count by 2 (cache-hit regression)', async () => {
    const before = await getUsageRow(user.userId)

    const url = `${stagingFunctionUrl('skills-search')}?query=react&limit=5`
    const headers = {
      'X-API-Key': user.apiKey,
      apikey: getStagingAnonKey(),
      Accept: 'application/json',
    }

    // Call 1 — populates the tier cache.
    const r1 = await fetch(url, { headers })
    expect(r1.ok, `first call: ${r1.status}`).toBe(true)

    // Call 2 — hits the tier cache short-circuit. Pre-SMI-4461 this skipped
    // the counter; the test asserts both increments land.
    const r2 = await fetch(url, { headers })
    expect(r2.ok, `second call: ${r2.status}`).toBe(true)

    await waitForCounterIncrement(user.userId, 'search_count', before.search_count + 2)
    const after = await getUsageRow(user.userId)
    expect(after.search_count).toBe(before.search_count + 2)
  }, 45_000)
})
