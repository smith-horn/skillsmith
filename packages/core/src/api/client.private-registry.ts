/**
 * @fileoverview Private-registry content fetch (SMI-5905 Wave 4).
 * @module @skillsmith/core/api/client.private-registry
 * @see docs/internal/implementation/private-registry-skill-install.md
 * @see supabase/functions/private-registry-get/index.ts (Wave 2 — the transport this calls)
 *
 * The CLI's only path to `private_registry_skills.content` — the CLI never
 * carries Supabase credentials directly, only reaches Supabase-backed data
 * through Edge Functions. Lives in its own file rather than `client.ts`
 * (already 479/500 lines), following the `client.health.ts`/`client.events.ts`
 * companion-module convention already used to split `SkillsmithApiClient`
 * functionality: a standalone function that reuses `buildRequestHeaders()` /
 * `DEFAULT_BASE_URL` / `PRODUCTION_ANON_KEY` from `./utils.js` rather than
 * adding a method onto the class itself.
 *
 * Deliberately does NOT reuse `SkillsmithApiClient.request()`'s retry-on-5xx/
 * 429 loop — this performs exactly one fetch. Retrying an unauthenticated,
 * forbidden, or not-found response would never succeed, and retrying a 429
 * would fight the endpoint's own tighter (30/min, IP-keyed) rate limiter.
 * Every failure surfaces as a typed result for the CLI to render directly.
 *
 * Auth contract (see supabase/functions/private-registry-get/access.ts):
 * the Edge Function 401s on anything but a real end-user JWT — an
 * `sk_live_*`/`sk_test_*` API key and the anon key both fail authentication
 * there. Callers MUST supply a JWT (e.g. via `resolveFreshAccessToken()`)
 * rather than the class's own apiKey/anonKey fallback chain.
 */

import { buildRequestHeaders, DEFAULT_BASE_URL, PRODUCTION_ANON_KEY } from './utils.js'

/**
 * Successful `data` shape from `GET /private-registry-get`
 * (supabase/functions/private-registry-get/index.ts's 200 response body).
 */
export interface PrivateRegistrySkillContent {
  skill_id: string
  team_id: string
  version: string
  description: string | null
  content_hash: string | null
  deprecated: boolean
  published_at: string
  /** Packaged skill files, `{ "SKILL.md": "...", ... }`. Never log this. */
  content: Record<string, string>
}

/**
 * Machine-readable error taxonomy — one per distinct outcome the Edge
 * Function's contract defines (`access.ts`'s `fail()` call sites in `index.ts`).
 */
export type PrivateRegistryGetErrorCode =
  | 'invalid_request' // 400 — malformed skillId/version
  | 'unauthenticated' // 401 — missing/invalid/expired JWT, or a non-JWT credential
  | 'forbidden' // 403 — authenticated, but the row's own team is not Enterprise-entitled
  | 'not_found' // 404 — no visible row (doesn't exist OR RLS filtered a cross-team id)
  | 'rate_limited' // 429 — IP-keyed pre-auth rate limit
  | 'server_error' // 405 / 5xx
  | 'network_error' // fetch threw, timed out, or the response body was unparseable

export type PrivateRegistryGetResult =
  | { ok: true; data: PrivateRegistrySkillContent }
  | { ok: false; code: PrivateRegistryGetErrorCode; status: number; message: string }

export interface GetPrivateRegistrySkillContentParams {
  /**
   * Real end-user JWT (e.g. from `resolveFreshAccessToken()`). Required — the
   * endpoint 401s on anything else, including an API key.
   */
  jwtToken: string
  /** Registry skill ID, `author/name` format. */
  skillId: string
  /** Pin a specific published version; omitted = most-recently-published. */
  version?: string
  baseUrl?: string
  anonKey?: string
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 30_000

function codeForStatus(status: number): PrivateRegistryGetErrorCode {
  switch (status) {
    case 400:
      return 'invalid_request'
    case 401:
      return 'unauthenticated'
    case 403:
      return 'forbidden'
    case 404:
      return 'not_found'
    case 429:
      return 'rate_limited'
    default:
      return 'server_error'
  }
}

/**
 * Fetch one private-registry skill's packaged content via the
 * `private-registry-get` Edge Function.
 *
 * Response contract (`supabase/functions/private-registry-get/index.ts`):
 *   200      → `{ data: PrivateRegistrySkillContent }`
 *   4xx/5xx  → `{ error: string }`
 */
export async function getPrivateRegistrySkillContent(
  params: GetPrivateRegistrySkillContentParams
): Promise<PrivateRegistryGetResult> {
  const baseUrl = params.baseUrl ?? DEFAULT_BASE_URL
  const anonKey = params.anonKey ?? PRODUCTION_ANON_KEY
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const query = new URLSearchParams({ skillId: params.skillId })
  if (params.version) query.set('version', params.version)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let response: Response
  try {
    response = await fetch(`${baseUrl}/private-registry-get?${query.toString()}`, {
      method: 'GET',
      headers: {
        ...buildRequestHeaders(anonKey),
        // Deliberately NOT the class's auth-mode priority chain (JWT > API
        // key > anon key) — this endpoint requires a real user JWT, always.
        Authorization: `Bearer ${params.jwtToken}`,
      },
      signal: controller.signal,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    clearTimeout(timer)
    return { ok: false, code: 'network_error', status: 0, message }
  }
  clearTimeout(timer)

  const body = (await response.json().catch(() => null)) as {
    data?: PrivateRegistrySkillContent
    error?: string
  } | null

  if (!response.ok) {
    const message = body?.error ?? `private-registry-get failed with status ${response.status}`
    return { ok: false, code: codeForStatus(response.status), status: response.status, message }
  }

  if (!body?.data) {
    return {
      ok: false,
      code: 'network_error',
      status: response.status,
      message: 'private-registry-get returned an unexpected response shape',
    }
  }

  return { ok: true, data: body.data }
}
