/** Internal helper functions and module constants for the usage-counter E2E fixture (SMI-4462). */

import { createHash, randomUUID } from 'node:crypto'
import type { ResolvedEnv, RestErrorShape, SignInResponse } from './usage-counter-fixture.types.js'

export const STAGING_PROJECT_REF = 'ovhcifugwqnzoebwfuku'

export function readEnv(name: string): string {
  const v = process.env[name]
  if (!v || v.length === 0) {
    throw new Error(
      `usage-counter-fixture: missing required env ${name}. ` +
        `Run under varlock (e.g. \`varlock run -- npm run test:e2e:usage-counter\`).`
    )
  }
  return v
}

export function resolveStagingEnv(): ResolvedEnv {
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

export async function readJsonOrText(res: Response): Promise<unknown> {
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
export async function adminCreateUser(
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

export async function adminDeleteUser(env: ResolvedEnv, userId: string): Promise<void> {
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

export async function signInWithPassword(
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
export async function postgrestWrite(
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

export async function postgrestDelete(
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
export function generateApiKey(): { plain: string; hash: string; prefix: string } {
  const random = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '').slice(0, 16)
  const plain = `sk_live_${random}`
  const hash = createHash('sha256').update(plain).digest('hex')
  return { plain, hash, prefix: plain.slice(0, 16) }
}
