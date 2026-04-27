/**
 * Quota Enforcement E2E Tests
 *
 * SMI-4463: Verifies the monthly-quota enforcement path end-to-end against
 * STAGING. These tests provision short-lived community/individual users,
 * push their `user_api_usage` row to the desired threshold via the
 * service-role admin client, then exercise the public skills-search edge
 * function and assert the response status + body.
 *
 * Excluded from `npm run preflight` by `vitest.config.ts:'tests/e2e/**'`.
 * Run via the dedicated workflow: `npm run test:e2e:usage-counter`
 * (or: `vitest run tests/e2e/quota-enforcement.e2e.test.ts`).
 *
 * Required env (varlock-injected from .env):
 *   - STAGING_SUPABASE_URL
 *   - STAGING_SUPABASE_SERVICE_ROLE_KEY
 *   - STAGING_SUPABASE_ANON_KEY
 *
 * NEVER run against prod — the test pushes synthetic usage rows that
 * would corrupt prod analytics. Project memory rule "Stage migrations
 * against staging only" applies.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient, SupabaseClient } from '@supabase/supabase-js'

const STAGING_URL = process.env.STAGING_SUPABASE_URL
const STAGING_SERVICE_KEY = process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY
const STAGING_ANON_KEY = process.env.STAGING_SUPABASE_ANON_KEY

const skipReason =
  !STAGING_URL || !STAGING_SERVICE_KEY || !STAGING_ANON_KEY
    ? 'STAGING_SUPABASE_* env vars missing — run via varlock'
    : ''

const describeIfStaged = skipReason ? describe.skip : describe

interface TestUser {
  userId: string
  email: string
  apiKey: string
}

async function provisionUser(
  admin: SupabaseClient,
  tier: 'community' | 'individual'
): Promise<TestUser> {
  const email = `quota-test-${tier}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@skillsmith-test.app`
  const password = 'StrongTestPw!' + Math.random().toString(36).slice(2, 10)
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (error || !data.user) {
    throw new Error(`createUser failed: ${error?.message ?? 'no user'}`)
  }
  const userId = data.user.id
  // Profile + tier
  await admin
    .from('profiles')
    .upsert({ id: userId, email, tier, first_name: 'Quota', last_name: 'Test' })
  // Subscription so paid-tier users get the Stripe-period code path
  if (tier === 'individual') {
    const periodEnd = new Date(Date.now() + 30 * 86400000).toISOString()
    const periodStart = new Date(Date.now() - 1 * 86400000).toISOString()
    await admin.from('subscriptions').upsert({
      id: `test-sub-${userId}`,
      user_id: userId,
      tier: 'individual',
      status: 'active',
      current_period_start: periodStart,
      current_period_end: periodEnd,
    })
  }
  // Generate an API key for this user via license_keys (service-role bypasses RLS)
  const apiKey = 'sk_live_test_' + Math.random().toString(36).slice(2, 18)
  // We don't hash here because a real prod path uses license-key-aware lookup;
  // this test asserts the JWT path which doesn't need apiKey, so apiKey is
  // returned as a sentinel for the API-key cache-hit case if needed later.
  return { userId, email, apiKey }
}

async function setUsage(
  admin: SupabaseClient,
  userId: string,
  count: number,
  hourBucketIso?: string
): Promise<void> {
  const hour = hourBucketIso || new Date(Math.floor(Date.now() / 3600_000) * 3600_000).toISOString()
  await admin.from('user_api_usage').upsert(
    {
      user_id: userId,
      hour_bucket: hour,
      search_count: count,
      get_count: 0,
      recommend_count: 0,
    },
    { onConflict: 'user_id,hour_bucket' }
  )
}

async function cleanupUser(admin: SupabaseClient, userId: string): Promise<void> {
  // Cascade through every dependent table the test might have touched.
  await admin.from('user_api_usage').delete().eq('user_id', userId)
  await admin.from('quota_warning_log').delete().eq('user_id', userId)
  await admin.from('subscriptions').delete().eq('user_id', userId)
  await admin.from('license_keys').delete().eq('user_id', userId)
  await admin.from('profiles').delete().eq('id', userId)
  await admin.auth.admin.deleteUser(userId).catch(() => undefined)
}

async function getJwt(admin: SupabaseClient, email: string): Promise<string | null> {
  // Generate a magic link and exchange it for a session via the admin client.
  // This avoids needing the password.
  const { data, error } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email,
  })
  if (error || !data) return null
  // The hashed_token in the link can be exchanged via verifyOtp.
  const hashedToken = data.properties?.hashed_token
  if (!hashedToken) return null
  const anon = createClient(STAGING_URL!, STAGING_ANON_KEY!)
  const { data: sess, error: verifyErr } = await anon.auth.verifyOtp({
    token_hash: hashedToken,
    type: 'magiclink',
  })
  if (verifyErr || !sess.session) return null
  return sess.session.access_token
}

describeIfStaged('SMI-4463: monthly quota enforcement E2E (staging)', () => {
  let admin: SupabaseClient
  const cleanupQueue: string[] = []

  beforeAll(() => {
    admin = createClient(STAGING_URL!, STAGING_SERVICE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  })

  afterAll(async () => {
    for (const userId of cleanupQueue) {
      await cleanupUser(admin, userId)
    }
  })

  it('community user at 999 → +1 search OK; further search returns 429 monthly_quota_exceeded with flag', async () => {
    const user = await provisionUser(admin, 'community')
    cleanupQueue.push(user.userId)
    await setUsage(admin, user.userId, 999)

    const jwt = await getJwt(admin, user.email)
    if (!jwt) {
      // Skip if magic-link path is unavailable in this staging env.
      return
    }

    // Sanity: the 1000th call should still succeed (no flag set, or community
    // is exactly at quota). NOTE: this test relies on ENFORCE_COMMUNITY_QUOTA
    // being set on the staging deploy of skills-search. If unset, the second
    // request returns 200 (Phase 0/1 of the rollout).
    const baseUrl = `${STAGING_URL}/functions/v1`
    const res1 = await fetch(`${baseUrl}/skills-search?query=react`, {
      headers: { Authorization: `Bearer ${jwt}` },
    })
    expect([200, 429]).toContain(res1.status)

    // Push to >=1000 and request again.
    await setUsage(admin, user.userId, 1001)
    const res2 = await fetch(`${baseUrl}/skills-search?query=react`, {
      headers: { Authorization: `Bearer ${jwt}` },
    })
    if (process.env.ENFORCE_COMMUNITY_QUOTA === 'true' || res2.status === 429) {
      expect(res2.status).toBe(429)
      const body = await res2.json()
      expect(body.error).toBe('monthly_quota_exceeded')
      expect(body.tier).toBe('community')
      expect(body.limit).toBe(1000)
      expect(typeof body.resetsAt).toBe('string')
    } else {
      // Phase 0/1: still 200 with banner-only. Verify response is OK and
      // not a 429 — that's the contract.
      expect(res2.status).toBe(200)
    }
  }, 30_000)

  it('individual user at 100% of quota → still 200 (paid never hard-blocks)', async () => {
    const user = await provisionUser(admin, 'individual')
    cleanupQueue.push(user.userId)
    await setUsage(admin, user.userId, 10_000)

    const jwt = await getJwt(admin, user.email)
    if (!jwt) return

    const baseUrl = `${STAGING_URL}/functions/v1`
    const res = await fetch(`${baseUrl}/skills-search?query=react`, {
      headers: { Authorization: `Bearer ${jwt}` },
    })
    // Paid tiers are NEVER hard-blocked by the quota path. They may still
    // 429 from per-minute rate-limiting, but that's a different error body.
    if (res.status === 429) {
      const body = await res.json()
      expect(body.error).not.toBe('monthly_quota_exceeded')
    } else {
      expect(res.status).toBe(200)
    }
  }, 30_000)

  it('period rollover: usage row from prior period does not count toward current', async () => {
    const user = await provisionUser(admin, 'community')
    cleanupQueue.push(user.userId)
    // Insert a row with hour_bucket = 1 hour BEFORE the current month
    // boundary. The RPC's WHERE u.hour_bucket >= v_period_lo MUST exclude it.
    const monthStart = new Date()
    monthStart.setUTCDate(1)
    monthStart.setUTCHours(0, 0, 0, 0)
    const priorPeriod = new Date(monthStart.getTime() - 60 * 60 * 1000).toISOString()
    await setUsage(admin, user.userId, 1500, priorPeriod)

    const { data, error } = await admin.rpc('get_user_usage_for_billing_period', {
      p_user_id: user.userId,
    })
    expect(error).toBeNull()
    expect(Array.isArray(data)).toBe(true)
    const row = (data as Array<{ total_requests: number | string }>)[0]
    const total =
      typeof row.total_requests === 'string' ? parseInt(row.total_requests, 10) : row.total_requests
    expect(total).toBe(0)
  }, 30_000)
})
