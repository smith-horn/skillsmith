/**
 * Test fixture: provision/cleanup test users for usage-counter E2E tests.
 *
 * SMI-4462 — shared by:
 *   - packages/cli/tests/e2e/usage-counter.e2e.test.ts
 *   - packages/mcp-server/tests/e2e/usage-counter.e2e.test.ts
 *   - packages/website/tests/e2e/account-usage.spec.ts
 *   - tests/e2e/api/skills-search-direct.e2e.test.ts
 *
 * Runs ONLY against staging (project ref ovhcifugwqnzoebwfuku — see CLAUDE.md
 * "Prod vs staging Supabase project refs"). Each helper validates that
 * `STAGING_SUPABASE_URL` is the staging ref before issuing destructive ops, so
 * an accidental prod-creds environment fails loud rather than mutating prod.
 *
 * Required env (Varlock-loaded):
 *   STAGING_SUPABASE_URL                — staging project URL
 *   STAGING_SUPABASE_SERVICE_ROLE_KEY   — staging service role (RLS-bypass)
 *   STAGING_SUPABASE_ANON_KEY           — staging anon key (sign-in flow)
 *
 * Identity-store layout per SMI-4462 plan:
 *   - auth.users        — auth user; cleanup via Auth Admin API DELETE /admin/users/{id}
 *   - profiles          — tier; cleanup via PostgREST DELETE
 *   - license_keys      — sk_live_* mapping; cleanup via PostgREST DELETE
 *   - user_api_usage    — counter; cleanup via PostgREST DELETE
 *   - quota_warning_log — Wave 2 (SMI-4463); table may not exist; tolerate
 *                         "relation does not exist" (PG 42P01) per plan §1.
 *
 * Implementation note: this fixture talks to Supabase via raw fetch against the
 * documented Auth Admin API (`/auth/v1/admin/users`) and PostgREST
 * (`/rest/v1/<table>`) so it has zero npm dependencies. That keeps it cheap
 * to import from any test workspace without bloating the root devDependency
 * surface (package-lock churn was prohibitive for SMI-4462 Wave 1).
 */

import { randomUUID } from 'node:crypto'
import type {
  UserTier,
  ProvisionedUser,
  ProvisionOptions,
  UsageRow,
  CounterColumn,
  SkillRow,
} from './usage-counter-fixture.types.js'
import {
  resolveStagingEnv,
  readEnv,
  readJsonOrText,
  adminCreateUser,
  adminDeleteUser,
  signInWithPassword,
  postgrestWrite,
  postgrestDelete,
  generateApiKey,
} from './usage-counter-fixture.helpers.js'

export type { UserTier, CounterColumn } from './usage-counter-fixture.types.js'
export type { ProvisionedUser, ProvisionOptions, UsageRow } from './usage-counter-fixture.types.js'

/**
 * Provision a fresh staging user with profile + license_keys row + auth JWT.
 *
 * The email uses a UUID suffix to avoid collisions when concurrent test files
 * run against the same staging project.
 *
 * Caller MUST `cleanupTestUser(userId)` in afterAll to leave staging tidy.
 */
export async function provisionTestUser(options: ProvisionOptions = {}): Promise<ProvisionedUser> {
  const tier: UserTier = options.tier ?? 'community'
  const env = resolveStagingEnv()

  const suffix = randomUUID()
  const email = `e2e-usage-counter+${suffix}@skillsmith.test`
  // bcrypt's input cap is 72 bytes — Supabase Auth rejects longer passwords.
  // The previous `${randomUUID()}-${randomUUID()}` was 73 chars and made
  // /auth/v1/admin/users return a generic 500 unexpected_failure (SMI-4525).
  // 32 hex × 2 = 64 chars, 244 bits of entropy (2 × 122-bit UUID v4), well under the limit.
  const password = `${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`

  // 1. Create auth user with confirmed email (skip verification).
  const created = await adminCreateUser(env, {
    email,
    password,
    email_confirm: true,
    user_metadata: { source: 'e2e-usage-counter', tier },
  })
  const userId = created.id

  try {
    // 2. Profile row (tier). The post-signup trigger inserts a default 'community'
    //    profile; upsert overrides for non-default tiers.
    await postgrestWrite(env, 'profiles', { id: userId, email, tier }, { upsertOnConflict: 'id' })

    // 3. License key (sk_live_*) for API-key path tests.
    const apiKey = generateApiKey()
    const apiKeyName = options.apiKeyName ?? 'CLI Token'
    await postgrestWrite(env, 'license_keys', {
      user_id: userId,
      key_hash: apiKey.hash,
      key_prefix: apiKey.prefix,
      name: apiKeyName,
      tier,
      status: 'active',
      rate_limit_per_minute: 60,
    })

    // 4. Sign in to obtain a JWT for the JWT-path tests.
    const session = await signInWithPassword(env, email, password)

    return {
      userId,
      email,
      password,
      jwt: session.access_token,
      refreshToken: session.refresh_token,
      apiKey: apiKey.plain,
    }
  } catch (err) {
    // Roll back the auth user so cleanup has nothing left to do on the failure path.
    await adminDeleteUser(env, userId).catch(() => undefined)
    throw err
  }
}

/**
 * Best-effort cascade cleanup. Order:
 *   1. user_api_usage (FK to auth.users via user_id)
 *   2. quota_warning_log (Wave 2; tolerate 42P01 if table absent)
 *   3. license_keys (FK to profiles)
 *   4. profiles (FK to auth.users)
 *   5. auth.users via Auth Admin API (cascades the rest defensively)
 *
 * Each step swallows errors after logging so a partial failure doesn't mask
 * the root cause in the test report.
 */
export async function cleanupTestUser(userId: string): Promise<void> {
  if (!userId) return
  const env = resolveStagingEnv()
  const filter = `user_id=eq.${userId}`

  const usageErr = await postgrestDelete(env, 'user_api_usage', filter)
  if (usageErr) {
    console.warn(`[cleanupTestUser] user_api_usage delete: ${JSON.stringify(usageErr)}`)
  }

  const quotaErr = await postgrestDelete(env, 'quota_warning_log', filter)
  if (quotaErr && quotaErr.code !== '42P01' && quotaErr.code !== 'PGRST205') {
    // 42P01 = relation does not exist (PostgreSQL); PGRST205 = relation not in schema cache.
    console.warn(`[cleanupTestUser] quota_warning_log delete: ${JSON.stringify(quotaErr)}`)
  }

  const subscriptionErr = await postgrestDelete(env, 'subscriptions', filter)
  if (subscriptionErr) {
    console.warn(`[cleanupTestUser] subscriptions delete: ${JSON.stringify(subscriptionErr)}`)
  }

  const licenseErr = await postgrestDelete(env, 'license_keys', filter)
  if (licenseErr) {
    console.warn(`[cleanupTestUser] license_keys delete: ${JSON.stringify(licenseErr)}`)
  }

  const profileErr = await postgrestDelete(env, 'profiles', `id=eq.${userId}`)
  if (profileErr) {
    console.warn(`[cleanupTestUser] profiles delete: ${JSON.stringify(profileErr)}`)
  }

  await adminDeleteUser(env, userId)
}

/**
 * Read the month-to-date aggregated usage row for a test user.
 * Returns the sum of all hour-bucket rows for the current calendar month
 * (matches `get_user_usage_summary` semantics).
 */
export async function getUsageRow(userId: string): Promise<UsageRow> {
  const env = resolveStagingEnv()

  const monthStart = new Date()
  monthStart.setUTCDate(1)
  monthStart.setUTCHours(0, 0, 0, 0)
  const monthStartIso = monthStart.toISOString()

  const select = encodeURIComponent('user_id,hour_bucket,search_count,get_count,recommend_count')
  const url = `${env.url}/rest/v1/user_api_usage?user_id=eq.${userId}&hour_bucket=gte.${encodeURIComponent(monthStartIso)}&select=${select}`
  const res = await fetch(url, {
    headers: {
      apikey: env.serviceRoleKey,
      Authorization: `Bearer ${env.serviceRoleKey}`,
    },
  })
  if (!res.ok) {
    const body = await readJsonOrText(res)
    throw new Error(`getUsageRow failed (${res.status}): ${JSON.stringify(body)}`)
  }
  const rows = (await res.json()) as Array<{
    search_count?: number
    get_count?: number
    recommend_count?: number
  }>
  const aggregate: UsageRow = {
    user_id: userId,
    hour_bucket: monthStartIso,
    search_count: 0,
    get_count: 0,
    recommend_count: 0,
  }
  for (const row of rows ?? []) {
    aggregate.search_count += row.search_count ?? 0
    aggregate.get_count += row.get_count ?? 0
    aggregate.recommend_count += row.recommend_count ?? 0
  }
  return aggregate
}

/**
 * Build the staging edge-function URL for a given function name.
 * Wraps the project memory rule: "When verifying a prod edge function via
 * curl, always use $SUPABASE_URL". Tests must call staging here.
 */
export function stagingFunctionUrl(fn: string): string {
  const env = resolveStagingEnv()
  return `${env.url}/functions/v1/${fn}`
}

/** Memoized resolved staging skill identifier — see resolveStagingSkillId. */
let resolvedStagingSkillId: string | undefined

const NO_VERIFIED_SKILL_ERROR = 'staging has no verified skill — cannot run the usage-counter suite'

/**
 * Resolve a staging skill identifier (`author/name`) for the usage-counter
 * E2E suites, with runtime discovery so the suite self-heals against staging
 * seed-data drift (SMI-4970). A hard-coded constant has rotted twice now
 * (`anthropic/commit`, then `anthropics/web-artifacts-builder`).
 *
 * Resolution order:
 *   1. `SKILLSMITH_E2E_SKILL_ID` env override — escape hatch, preserved.
 *   2. Otherwise read the staging `skills` table directly via PostgREST.
 *
 * The query goes to the database (`/rest/v1/skills`) with the service-role
 * key, NOT through the `skills-search` edge function. `skills-search` enforces
 * an IP-scoped anonymous-trial gate (401 "Free trial exhausted") that a busy
 * CI runner trips routinely — discovery must not depend on that quota.
 * Service-role bypasses RLS; the read is plain and unmetered.
 *
 * Memoized module-scoped (including the env-override path) so the query runs
 * at most once per suite run. The fetch has a short timeout and 1 retry,
 * matching `adminCreateUser`'s 2s-backoff idiom.
 *
 * Fail-fast, with two distinct messages so triage stays honest:
 *   - empty result          → genuinely un-runnable suite (no verified skill).
 *   - network error / timeout / non-2xx → transient outage, not seed drift.
 * A malformed row with a null/empty `author` or `name` also throws rather than
 * yielding a `null/...` identifier and a misleading downstream 404.
 */
export async function resolveStagingSkillId(): Promise<string> {
  if (resolvedStagingSkillId !== undefined) return resolvedStagingSkillId

  const override = process.env['SKILLSMITH_E2E_SKILL_ID']
  if (override && override.length > 0) {
    resolvedStagingSkillId = override
    return resolvedStagingSkillId
  }

  const env = resolveStagingEnv()
  const url =
    `${env.url}/rest/v1/skills` +
    `?select=author,name&trust_tier=eq.verified&quarantined=eq.false&limit=1`

  const MAX_ATTEMPTS = 2
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          apikey: env.serviceRoleKey,
          Authorization: `Bearer ${env.serviceRoleKey}`,
        },
        signal: AbortSignal.timeout(8_000),
      })
      if (!res.ok) {
        throw new Error(`skills query returned ${res.status}`)
      }
      // PostgREST returns a bare JSON array of rows.
      const rows = (await readJsonOrText(res)) as SkillRow[] | undefined
      const results: SkillRow[] = Array.isArray(rows) ? rows : []
      if (results.length === 0) {
        throw new Error(NO_VERIFIED_SKILL_ERROR)
      }
      const first = results[0]
      const author = first?.author
      const name = first?.name
      if (!author || author.length === 0 || !name || name.length === 0) {
        throw new Error(NO_VERIFIED_SKILL_ERROR)
      }
      resolvedStagingSkillId = `${author}/${name}`
      return resolvedStagingSkillId
    } catch (err) {
      // The empty-staging / malformed-row error is a deterministic
      // un-runnable-suite signal — never retry it and never reclassify it.
      if (err instanceof Error && err.message === NO_VERIFIED_SKILL_ERROR) {
        throw err
      }
      lastError = err
      if (attempt === MAX_ATTEMPTS) break
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  }
  throw new Error(
    `staging skills query unreachable — transient outage, not seed drift ` +
      `(${lastError instanceof Error ? lastError.message : String(lastError)})`
  )
}

/** SMI-4741: Insert stale sub row (status='active', current_period_end=yesterday). */
export async function setStaleSubscriptionRow(userId: string): Promise<void> {
  const env = resolveStagingEnv()
  const startIso = new Date(Date.now() - 32 * 24 * 60 * 60 * 1000).toISOString()
  const endIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  await postgrestWrite(env, 'subscriptions', {
    user_id: userId,
    stripe_customer_id: `cus_e2e_stale_${userId.slice(0, 8)}`,
    stripe_subscription_id: `sub_e2e_stale_${userId.slice(0, 8)}`,
    tier: 'individual',
    status: 'active',
    billing_period: 'monthly',
    seat_count: 1,
    current_period_start: startIso,
    current_period_end: endIso,
    cancel_at_period_end: false,
    metadata: {},
  })
}

/**
 * Ergonomic guard for vitest `it.skipIf` — returns true when staging creds
 * are absent (e.g. local dev box without varlock).
 */
export function stagingCredentialsAbsent(): boolean {
  return !(
    process.env['STAGING_SUPABASE_URL'] &&
    process.env['STAGING_SUPABASE_SERVICE_ROLE_KEY'] &&
    process.env['STAGING_SUPABASE_ANON_KEY']
  )
}

/**
 * Read STAGING_SUPABASE_ANON_KEY with the same fail-loud semantics the rest
 * of the fixture uses for service-role / URL. Tests that build raw fetch
 * headers (`apikey: ...`) must use this rather than `process.env[...] ?? ''`
 * — an empty `apikey` header surfaces as a confusing 401 instead of a clear
 * "missing env" error (SMI-4466).
 */
export function getStagingAnonKey(): string {
  return readEnv('STAGING_SUPABASE_ANON_KEY')
}

export function getStagingServiceRoleKey(): string {
  return readEnv('STAGING_SUPABASE_SERVICE_ROLE_KEY')
}

/**
 * Polling helper — `increment_api_usage` is fire-and-forget downstream of the
 * response. Read the row up to N times, 250ms apart, until the expected
 * counter value lands or we time out. The caller's subsequent `expect(...)`
 * produces the actual diff if the target wasn't reached.
 *
 * Centralized in the fixture so all four E2E suites share one implementation
 * (SMI-4466 — was previously duplicated 4×).
 */
export async function waitForCounterIncrement(
  userId: string,
  column: CounterColumn,
  target: number,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const row = await getUsageRow(userId)
    if (row[column] >= target) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}
