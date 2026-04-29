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

import { createHash, randomUUID } from 'node:crypto'

const STAGING_PROJECT_REF = 'ovhcifugwqnzoebwfuku'

export type UserTier = 'community' | 'individual' | 'team' | 'enterprise'

export interface ProvisionedUser {
  userId: string
  email: string
  password: string
  /** Supabase access JWT (Bearer-style) issued by signInWithPassword. */
  jwt: string
  /** Supabase refresh token, written into the CLI ~/.skillsmith/config.json. */
  refreshToken: string
  /** Plain sk_live_* license key — write to X-API-Key / Bearer header. */
  apiKey: string
}

export interface ProvisionOptions {
  tier?: UserTier
  /** Optional name for the license_keys row (defaults to 'CLI Token'). */
  apiKeyName?: string
}

export interface UsageRow {
  user_id: string
  hour_bucket: string
  search_count: number
  get_count: number
  recommend_count: number
}

interface ResolvedEnv {
  url: string
  serviceRoleKey: string
  anonKey: string
}

function readEnv(name: string): string {
  const v = process.env[name]
  if (!v || v.length === 0) {
    throw new Error(
      `usage-counter-fixture: missing required env ${name}. ` +
        `Run under varlock (e.g. \`varlock run -- npm run test:e2e:usage-counter\`).`
    )
  }
  return v
}

function resolveStagingEnv(): ResolvedEnv {
  const url = readEnv('STAGING_SUPABASE_URL').replace(/\/$/, '')
  const serviceRoleKey = readEnv('STAGING_SUPABASE_SERVICE_ROLE_KEY')
  const anonKey = readEnv('STAGING_SUPABASE_ANON_KEY')

  // Defense-in-depth: refuse to run on a non-staging URL even if a caller
  // somehow injected prod creds via the staging-named env (CLAUDE.md memory:
  // 2026-04-17 prod-vs-staging confusion burned ~7 minutes).
  if (!url.includes(STAGING_PROJECT_REF)) {
    throw new Error(
      `usage-counter-fixture: STAGING_SUPABASE_URL must point at staging ref ${STAGING_PROJECT_REF}; got ${url}.`
    )
  }
  return { url, serviceRoleKey, anonKey }
}

interface RestErrorShape {
  code?: string
  message?: string
  details?: string
}

async function readJsonOrText(res: Response): Promise<unknown> {
  const text = await res.text()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * Service-role wrapper around the Supabase Auth Admin API.
 * https://supabase.com/docs/reference/api/admin-create-user
 *
 * Retries once on 5xx with a 2s backoff. The signup endpoint surfaces
 * password-validation as a clean 400, but admin/users masks pre-validation
 * failures (e.g. bcrypt's 72-char input limit) as a generic 500
 * unexpected_failure (SMI-4525). A single retry keeps the suite resilient
 * to genuinely transient GoTrue 5xx without papering over deterministic
 * client-side bugs.
 */
async function adminCreateUser(
  env: ResolvedEnv,
  body: Record<string, unknown>
): Promise<{ id: string }> {
  const MAX_ATTEMPTS = 2
  let lastStatus = 0
  let lastBody: unknown = '<no response>'
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(`${env.url}/auth/v1/admin/users`, {
      method: 'POST',
      headers: {
        apikey: env.serviceRoleKey,
        Authorization: `Bearer ${env.serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    const data = (await readJsonOrText(res)) as { id?: string; msg?: string; error?: string }
    if (res.ok && data && typeof data === 'object' && data.id) {
      return { id: data.id }
    }
    lastStatus = res.status
    lastBody = data ?? '<empty>'
    const isRetriable = res.status >= 500 && res.status < 600
    if (!isRetriable || attempt === MAX_ATTEMPTS) break
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  throw new Error(`adminCreateUser failed (${lastStatus}): ${JSON.stringify(lastBody)}`)
}

async function adminDeleteUser(env: ResolvedEnv, userId: string): Promise<void> {
  const res = await fetch(`${env.url}/auth/v1/admin/users/${userId}`, {
    method: 'DELETE',
    headers: {
      apikey: env.serviceRoleKey,
      Authorization: `Bearer ${env.serviceRoleKey}`,
    },
  })
  if (!res.ok && res.status !== 404) {
    const body = await readJsonOrText(res)
    console.warn(
      `[cleanupTestUser] auth.admin DELETE failed (${res.status}): ${JSON.stringify(body)}`
    )
  }
}

interface SignInResponse {
  access_token: string
  refresh_token: string
}

async function signInWithPassword(
  env: ResolvedEnv,
  email: string,
  password: string
): Promise<SignInResponse> {
  const res = await fetch(`${env.url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      apikey: env.anonKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password }),
  })
  const data = (await readJsonOrText(res)) as Partial<SignInResponse> & RestErrorShape
  if (!res.ok || !data?.access_token || !data?.refresh_token) {
    throw new Error(
      `signInWithPassword failed (${res.status}): ${data?.message ?? JSON.stringify(data ?? '<empty>')}`
    )
  }
  return { access_token: data.access_token, refresh_token: data.refresh_token }
}

/** PostgREST insert/upsert via service-role. Returns parsed JSON or throws. */
async function postgrestWrite(
  env: ResolvedEnv,
  table: string,
  body: unknown,
  opts: { upsertOnConflict?: string } = {}
): Promise<void> {
  const headers: Record<string, string> = {
    apikey: env.serviceRoleKey,
    Authorization: `Bearer ${env.serviceRoleKey}`,
    'Content-Type': 'application/json',
    Prefer: 'return=minimal',
  }
  if (opts.upsertOnConflict) {
    headers['Prefer'] = 'resolution=merge-duplicates,return=minimal'
  }
  const url = opts.upsertOnConflict
    ? `${env.url}/rest/v1/${table}?on_conflict=${encodeURIComponent(opts.upsertOnConflict)}`
    : `${env.url}/rest/v1/${table}`
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const errBody = (await readJsonOrText(res)) as RestErrorShape
    throw new Error(
      `postgrestWrite ${table} failed (${res.status} ${errBody?.code ?? ''}): ${errBody?.message ?? JSON.stringify(errBody ?? '<empty>')}`
    )
  }
}

async function postgrestDelete(
  env: ResolvedEnv,
  table: string,
  filter: string
): Promise<RestErrorShape | null> {
  const res = await fetch(`${env.url}/rest/v1/${table}?${filter}`, {
    method: 'DELETE',
    headers: {
      apikey: env.serviceRoleKey,
      Authorization: `Bearer ${env.serviceRoleKey}`,
      Prefer: 'return=minimal',
    },
  })
  if (res.ok) return null
  return (await readJsonOrText(res)) as RestErrorShape
}

/**
 * Generate a sk_live_* style key. Format mirrors production
 * (`sk_live_<48-hex>`); the value isn't pretty-printed anywhere user-visible.
 */
function generateApiKey(): { plain: string; hash: string; prefix: string } {
  const random = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '').slice(0, 16)
  const plain = `sk_live_${random}`
  const hash = createHash('sha256').update(plain).digest('hex')
  return { plain, hash, prefix: plain.slice(0, 16) }
}

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

type CounterColumn = 'search_count' | 'get_count' | 'recommend_count'

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
