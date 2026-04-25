/**
 * E2E: API usage counter wire-up via the CLI's @skillsmith/core ApiClient.
 *
 * SMI-4462 Step 2 — covers paths #1 (CLI/JWT) and #2 (CLI/API-key cache hit).
 *
 * The CLI's local commands (`search`, `info` after seeding) are SQLite-backed
 * and don't traverse the counted endpoints; the CLI hits skills-search/get/
 * recommend exclusively through `@skillsmith/core`'s `createApiClient`. So
 * "CLI E2E" here means exercising that exact factory + auth surface against
 * staging, the same code path `cli sync` / `cli recommend` / `cli info`
 * traverse in production.
 *
 * Test A — JWT path: build a `createApiClient({ jwtToken })` directly with the
 *   provisioned user's JWT and call `getSkill`. SMI-4399 Wave 4 (paste-flow
 *   removal) hasn't yet wired auto-load of `loadStoredAccessToken()` into the
 *   factory, so writing JWT to ~/.skillsmith/config.json doesn't currently
 *   propagate; the explicit-config form is the supported surface today and
 *   exercises the same Bearer-header → auth-middleware → incrementUsageCounter
 *   plumbing. (See the SMI-4462 PR body — gap tracked for Wave 4 follow-up.)
 *
 * Test B — API-key cache hit: critical SMI-2144 regression. Two consecutive
 *   `getSkill` calls within 5s prove the tier-cache short-circuit doesn't skip
 *   the counter increment. If get_count !== 2 after two calls, the wire-up
 *   has regressed.
 *
 * Both tests assert against `user_api_usage.get_count` because skills-get is
 * the cleanest single-call endpoint (skills-search response shape varies with
 * fixture state on staging; skills-recommend requires payload massaging).
 *
 * Tagged `@e2e-usage-counter`; excluded from `npm run preflight` via the
 * existing `tests/e2e/**` exclude in vitest.config.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createApiClient } from '@skillsmith/core'
import {
  provisionTestUser,
  cleanupTestUser,
  getUsageRow,
  stagingCredentialsAbsent,
  waitForCounterIncrement,
  type ProvisionedUser,
} from '../fixtures/usage-counter-fixture.js'

// Skill the staging registry is guaranteed to have. Falls back to env override
// if the seed data ever rotates. `anthropic/commit` is verified-tier and has
// been present since the initial registry seed.
const STAGING_BASE_URL = process.env['STAGING_SUPABASE_URL']?.replace(/\/$/, '') + '/functions/v1'
const STAGING_SKILL_ID = process.env['SKILLSMITH_E2E_SKILL_ID'] ?? 'anthropic/commit'

const skipIfNoCreds = stagingCredentialsAbsent()

describe.skipIf(skipIfNoCreds)('@e2e-usage-counter CLI ApiClient → usage counter', () => {
  let user: ProvisionedUser

  beforeAll(async () => {
    user = await provisionTestUser({ tier: 'community' })
  }, 30_000)

  afterAll(async () => {
    if (user?.userId) {
      await cleanupTestUser(user.userId)
    }
  }, 30_000)

  it('JWT path: createApiClient({ jwtToken }) increments get_count by 1', async () => {
    const before = await getUsageRow(user.userId)

    const client = createApiClient({
      baseUrl: STAGING_BASE_URL,
      jwtToken: user.jwt,
    })
    const res = await client.getSkill(STAGING_SKILL_ID)
    expect(res).toBeDefined()
    expect(res.data?.id).toBe(STAGING_SKILL_ID)

    // Counter increment lands asynchronously after the response — give the
    // RPC up to ~2s to commit before reading user_api_usage.
    await waitForCounterIncrement(user.userId, 'get_count', before.get_count + 1)
    const after = await getUsageRow(user.userId)
    expect(after.get_count).toBe(before.get_count + 1)
  }, 30_000)

  it('API-key cache hit: two consecutive calls increment get_count by 2 (SMI-2144 regression)', async () => {
    const before = await getUsageRow(user.userId)

    const client = createApiClient({
      baseUrl: STAGING_BASE_URL,
      apiKey: user.apiKey,
    })

    // First call — populates the tier cache.
    const r1 = await client.getSkill(STAGING_SKILL_ID)
    expect(r1.data?.id).toBe(STAGING_SKILL_ID)

    // Second call within the cache TTL — must still increment. Pre-SMI-4461,
    // the tier-cache short-circuit returned before incrementUsageCounter was
    // ever called, silently undercounting from `2` to `1`.
    const r2 = await client.getSkill(STAGING_SKILL_ID)
    expect(r2.data?.id).toBe(STAGING_SKILL_ID)

    await waitForCounterIncrement(user.userId, 'get_count', before.get_count + 2)
    const after = await getUsageRow(user.userId)
    expect(after.get_count).toBe(before.get_count + 2)
  }, 45_000)
})
