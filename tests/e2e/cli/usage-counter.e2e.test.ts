/**
 * E2E: API usage counter wire-up via the CLI's @skillsmith/core ApiClient.
 *
 * SMI-4462 Step 2 — covers paths #1 (CLI/JWT) and #2 (CLI/API-key cache hit).
 * SMI-4474 — adds Test C: full disk-backed JWT auto-load contract.
 *
 * The CLI's local commands (`search`, `info` after seeding) are SQLite-backed
 * and don't traverse the counted endpoints; the CLI hits skills-search/get/
 * recommend exclusively through `@skillsmith/core`'s `createApiClient`. So
 * "CLI E2E" here means exercising that exact factory + auth surface against
 * staging, the same code path `cli sync` / `cli recommend` / `cli info`
 * traverse in production.
 *
 * Test A — JWT path (explicit-config): build a `createApiClient({ jwtToken })`
 *   directly with the provisioned user's JWT and call `getSkill`. Confirms the
 *   Bearer-header → auth-middleware → incrementUsageCounter plumbing works
 *   independent of the storage layer.
 *
 * Test B — API-key cache hit: critical SMI-2144 regression. Two consecutive
 *   `getSkill` calls within 5s prove the tier-cache short-circuit doesn't skip
 *   the counter increment. If get_count !== 2 after two calls, the wire-up
 *   has regressed.
 *
 * Test C — JWT auto-load (SMI-4474): write a credentials file to a fixture
 *   HOME directory, repoint `process.env.HOME` so `os.homedir()` resolves to
 *   the fixture, then call `loadStoredAccessToken()` and feed the result into
 *   `createApiClient`. This is the exact wiring `skillsmith sync/info/recommend`
 *   now use, and proves a logged-in user's CLI calls land on their counter
 *   instead of going anonymous (the live regression from 2026-04-25).
 *
 * Tests A/B/C assert against `user_api_usage.get_count` because skills-get is
 * the cleanest single-call endpoint (skills-search response shape varies with
 * fixture state on staging; skills-recommend requires payload massaging).
 *
 * Tagged `@e2e-usage-counter`; excluded from `npm run preflight` via the
 * existing `tests/e2e/**` exclude in vitest.config.ts.
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createApiClient, loadStoredAccessToken } from '@skillsmith/core'
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

  it('SMI-4474 auto-load: loadStoredAccessToken → createApiClient increments get_count', async () => {
    const before = await getUsageRow(user.userId)

    // Build a fixture HOME containing a v2 credentials file. os.homedir() reads
    // $HOME on POSIX, so swapping process.env.HOME redirects loadCredentials()
    // to the fixture without touching the developer's real config.
    const fixtureHome = await mkdtemp(join(tmpdir(), 'smi-4474-'))
    await mkdir(join(fixtureHome, '.skillsmith'), { recursive: true })
    await writeFile(
      join(fixtureHome, '.skillsmith', 'config.json'),
      JSON.stringify(
        {
          accessToken: user.jwt,
          refreshToken: user.refreshToken,
          expiresAt: Date.now() + 3_600_000,
          version: 2,
        },
        null,
        2
      ),
      { mode: 0o600 }
    )

    const originalHome = process.env['HOME']
    process.env['HOME'] = fixtureHome
    try {
      const stored = await loadStoredAccessToken()
      expect(stored).toBe(user.jwt)

      // This is the exact pattern packages/cli/src/commands/{sync,info,recommend}.ts
      // now use after SMI-4474. If a future refactor drops the auto-load, the
      // counter assertion below will catch it.
      const client = createApiClient(
        stored ? { baseUrl: STAGING_BASE_URL, jwtToken: stored } : { baseUrl: STAGING_BASE_URL }
      )
      const res = await client.getSkill(STAGING_SKILL_ID)
      expect(res.data?.id).toBe(STAGING_SKILL_ID)

      await waitForCounterIncrement(user.userId, 'get_count', before.get_count + 1)
      const after = await getUsageRow(user.userId)
      expect(after.get_count).toBe(before.get_count + 1)
    } finally {
      if (originalHome === undefined) {
        delete process.env['HOME']
      } else {
        process.env['HOME'] = originalHome
      }
      await rm(fixtureHome, { recursive: true, force: true })
    }
  }, 30_000)
})
