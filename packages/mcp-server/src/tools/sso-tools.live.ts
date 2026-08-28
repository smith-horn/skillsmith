/**
 * @fileoverview Live SSO configuration service — `team-sso-manage` edge-function client
 * @module @skillsmith/mcp-server/tools/sso-tools.live
 * @see SMI-6204 (Wave 3 of SMI-6200): real SSO configuration over the Supabase Auth Admin SSO API
 * @see docs/internal/implementation/smi-6200-enterprise-rbac-sso-real-implementation.md, Wave 3
 *      Step 2 (`team-sso-manage`) and Step 4 (this file), including the 2026-08-28 design-review
 *      corrections block
 *
 * MECHANISM: `fetch()`, not `.rpc()` — unlike `rbac-tools.live.ts`. `team-sso-manage` is a
 * gateway-JWT-verified edge function that wraps GoTrue's Auth Admin SSO API using the FUNCTION's
 * own service-role key; the MCP server never holds that key (SMI-6109's entire point — see
 * `registry-tools.live.ts`'s header for the "documented, live threat vector" framing this design
 * avoids repeating). This file follows `packages/core/src/sync/inventory-client.ts:108-127` as the
 * calling pattern: resolve a bearer token via one of `sso-tools.live.auth.ts`'s two named getters,
 * `fetch()` the edge function, map the response to a typed error or a domain result.
 *
 * ERROR MAPPING is an allowlist, not a passthrough — matching `team-permission-error.ts`'s own
 * convention and this plan's explicit finding that "GoTrue's duplicate-domain error message leaks
 * another team's provider UUID." Every status code below maps to exactly one typed error class,
 * and GoTrue's own raw text NEVER reaches a caller: the 40x branches use only the edge function's
 * OWN authored `message` field (never GoTrue's), and the 500/502/503 branch is a single fixed
 * sentence with no server-supplied text of any kind.
 *
 * `SET|GET`'s response shape (`GoTrueSamlProviderResponse`) matches the nested GoTrue provider
 * shape verbatim (`{ id, disabled, saml: { entity_id, metadata_xml, metadata_url,
 * attribute_mapping, name_id_format }, domains: [{ domain }], created_at, updated_at }`) and is
 * mapped down into the existing flat `SSOConfig` (`sso-tools.types.ts`) at {@link mapProviderToConfig} —
 * see that function's own comment for why the shared interface stays flat rather than being
 * reshaped to match GoTrue everywhere.
 *
 * AUTHORED CONTRACT, NOT A COPY OF THE EDGE FUNCTION'S OWN CODE. `team-sso-manage` is built by a
 * different wave/agent working in `supabase/functions/`; this file was written from the Wave 3
 * plan doc's Step 2 (which fixes the error-body shapes exactly — see {@link SsoErrorBody} — and
 * the GoTrue response shape given in this task) but the plan doc does not fix byte-exact SUCCESS
 * request/response field names for `set`/`get`/`claim_domain`/`verify_domain` beyond that. The
 * names chosen below (`metadataUrl`, `entityId`, `recordName`/`recordType`/`recordValue`, etc.)
 * are this file's own authored choice and MUST be cross-checked against `team-sso-manage`'s actual
 * implementation before this wave ships — a contract mismatch here would compile and pass every
 * unit test in this file (which mocks `fetch()`) while failing integration silently.
 */

import { getSsoManageUserClient, getSsoReadUserClient } from './sso-tools.live.auth.js'
import type { SsoUserAuthBinding } from './sso-tools.live.auth.js'
import { TeamPermissionDeniedError } from './team-permission-error.js'
import type {
  SSOConfig,
  SSOConfigService,
  SsoDomainClaim,
  SsoDomainVerification,
} from './sso-tools.types.js'

// ============================================================================
// Typed errors — one per mapped status/error code (task D5), plus a catch-all
// ============================================================================

/** HTTP 401 — no session, or the stored session has expired/been revoked. */
export class SsoAuthError extends Error {
  constructor(message = 'Not authenticated. Run `skillsmith login` and try again.') {
    super(message)
    this.name = 'SsoAuthError'
  }
}

/** HTTP 400 `invalid_role_mapping` (or any other authored 400 refusal). */
export class SsoValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SsoValidationError'
  }
}

/** The DNS TXT record the caller must publish, carried by {@link SsoDomainNotVerifiedError}. */
export interface SsoDomainNotVerifiedDetails {
  domain: string
  recordName: string
  recordType: string
  recordValue: string
}

/**
 * HTTP 409 `domain_not_verified` — `set` was attempted (or the reverify sweep tripped) before the
 * domain's ownership was proven. Carries the exact TXT record so the MCP tool response can render
 * it, per the Wave 3 plan's `set` refusal requirement ("refuses with an actionable message naming
 * the exact TXT record").
 */
export class SsoDomainNotVerifiedError extends Error {
  readonly details: SsoDomainNotVerifiedDetails
  constructor(details: SsoDomainNotVerifiedDetails, message: string) {
    super(message)
    this.name = 'SsoDomainNotVerifiedError'
    this.details = details
  }
}

/** HTTP 409 `domain_verified_by_another_team` — the partial-unique-index loser (Wave 3 Step 1). */
export class SsoDomainClaimedByAnotherTeamError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SsoDomainClaimedByAnotherTeamError'
  }
}

/** HTTP 501 `sso_expire_unavailable` — `expire_stale_sso_members()` is a Wave 4 deliverable. */
export class SsoExpireUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SsoExpireUnavailableError'
  }
}

/**
 * Catch-all for 500/502/503 and network-level transport failures. `status === 0` marks the
 * transport-failure case (no HTTP response was ever received) — its `detail`, when present,
 * originates locally (Node's `fetch()` error message), never from GoTrue or the edge function, so
 * including it does not violate the "never leak raw GoTrue text" rule the status-code branches
 * enforce.
 */
export class SsoServiceUnavailableError extends Error {
  constructor(status: number, detail?: string) {
    super(
      status === 0
        ? `SSO service request failed${detail ? `: ${detail}` : ''}.`
        : `SSO service unavailable (HTTP ${status}). Try again shortly.`
    )
    this.name = 'SsoServiceUnavailableError'
  }
}

// ============================================================================
// fetch() plumbing
// ============================================================================

/**
 * Deliberately does NOT duplicate `supabase-client.ts`'s `PRODUCTION_SUPABASE_URL` /
 * `PRODUCTION_ANON_KEY` fallback constants (which are themselves already a documented duplicate of
 * `packages/core/src/api/utils.ts`'s originals — seesupabase-client.ts's own header). This factory
 * is only ever selected by `sso-tools.ts`'s `isSupabaseConfigured() ? createLiveSSOService() : ...`
 * switch, which already guarantees both env vars are set before any method here runs. Reading them
 * directly and throwing loudly if that invariant is ever violated is more honest than re-deriving
 * a THIRD copy of the anon key fallback in a file scoped to `packages/mcp-server/src/tools/`.
 */
function functionsBaseUrl(): string {
  const url = process.env.SUPABASE_URL
  if (!url) {
    throw new Error(
      'SUPABASE_URL is not configured — createLiveSSOService() must only run when ' +
        'isSupabaseConfigured() is true.'
    )
  }
  return `${url}/functions/v1`
}

function supabaseAnonKey(): string {
  const key = process.env.SUPABASE_ANON_KEY
  if (!key) {
    throw new Error(
      'SUPABASE_ANON_KEY is not configured — createLiveSSOService() must only run when ' +
        'isSupabaseConfigured() is true.'
    )
  }
  return key
}

/** Best-effort JSON body read — `null` on an empty or unparseable body. */
async function readJson<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T
  } catch {
    return null
  }
}

/** The error body shapes named in the Wave 3 plan / this task's D5 mapping table. */
interface SsoErrorBody {
  error?: string
  permission?: string
  message?: string
  domain?: string
  record_name?: string
  record_type?: string
  record_value?: string
}

/**
 * Map a non-2xx `team-sso-manage` response to exactly one typed error and throw it. Never reads
 * anything from the body except the fields the plan's D5 table names, and the 500/502/503 branch
 * reads nothing from the body at all — see this file's header.
 */
async function throwMappedError(res: Response): Promise<never> {
  const body = await readJson<SsoErrorBody>(res)
  switch (res.status) {
    case 401:
      throw new SsoAuthError()
    case 403:
      throw new TeamPermissionDeniedError(body?.permission ?? 'team:manage_sso', body?.message)
    case 400:
      throw new SsoValidationError(body?.message ?? 'Invalid SSO configuration.')
    case 409:
      if (body?.error === 'domain_not_verified') {
        const domain = body.domain ?? ''
        throw new SsoDomainNotVerifiedError(
          {
            domain,
            recordName: body.record_name ?? `_skillsmith-verify.${domain}`,
            recordType: body.record_type ?? 'TXT',
            recordValue: body.record_value ?? '',
          },
          body.message ??
            `Domain "${domain}" is not yet verified. Publish the TXT record and retry.`
        )
      }
      if (body?.error === 'domain_verified_by_another_team') {
        throw new SsoDomainClaimedByAnotherTeamError(
          body.message ?? 'This domain is already verified by another team.'
        )
      }
      // An unrecognized 409 shape is a transport-layer surprise, not a domain refusal we know how
      // to render — fail the same way an outage would rather than fabricate a domain error.
      throw new SsoServiceUnavailableError(res.status)
    case 501:
      throw new SsoExpireUnavailableError(
        body?.message ??
          'Expiring SSO-provisioned members is not available yet (SMI-6205). Use ' +
            '"convert_to_manual" instead.'
      )
    default:
      throw new SsoServiceUnavailableError(res.status)
  }
}

/** POST `payload` to `team-sso-manage` as `binding`'s caller, returning the raw `Response`. */
async function fetchSsoManage(
  binding: SsoUserAuthBinding,
  payload: Record<string, unknown>
): Promise<Response> {
  try {
    return await fetch(`${functionsBaseUrl()}/team-sso-manage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseAnonKey(),
        Authorization: `Bearer ${binding.accessToken}`,
      },
      body: JSON.stringify(payload),
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new SsoServiceUnavailableError(0, detail)
  }
}

/** `fetchSsoManage()` plus the standard non-2xx mapping and a typed, non-null JSON body. */
async function callSsoManage<T>(
  binding: SsoUserAuthBinding,
  payload: Record<string, unknown>
): Promise<T> {
  const res = await fetchSsoManage(binding, payload)
  if (!res.ok) await throwMappedError(res)
  const body = await readJson<T>(res)
  if (body === null) {
    throw new SsoServiceUnavailableError(res.status, 'response body was empty or unreadable')
  }
  return body
}

// ============================================================================
// GoTrue response mapping
// ============================================================================

/** GoTrue's real nested SAML provider shape — see the GOTRUE RESPONSE SHAPE note in this task. */
interface GoTrueSamlProviderResponse {
  id: string
  disabled?: boolean
  saml: {
    entity_id: string
    metadata_xml?: string | null
    metadata_url?: string | null
    attribute_mapping?: unknown
    name_id_format?: string | null
  }
  domains?: Array<{ domain: string }>
  created_at: string
  updated_at?: string
}

/**
 * GoTrue's nested shape is mapped DOWN into the existing flat `SSOConfig` (`sso-tools.types.ts`) rather
 * than reshaping the shared interface to match GoTrue everywhere. Chosen over reshaping because:
 * (1) `SSOConfigService` is implemented by BOTH the stub and this live service, and the stub's
 * flat shape already has test coverage across `sso-tools.test.ts` — reshaping it would be a
 * breaking change to every existing stub-mode assertion for a Wave that owns only the live path;
 * (2) `sso-tools.ts`'s message-building (`config.idpEntityId`, `config.status`, ...) stays
 * unchanged for both paths. The cost is real and is called out rather than hidden: a provider
 * registered via `metadata_xml` (no `metadata_url`) has no losslessly-representable
 * `idpMetadataUrl` in the flat shape — `idpMetadataUrl` falls back to `''` in that case. `domains`
 * is the one genuinely new piece of information the flat shape had no room for; it is added as an
 * additive, optional field (`SSOConfig.domains?: string[]`) rather than smuggled into an existing
 * one.
 */
function mapProviderToConfig(row: GoTrueSamlProviderResponse): SSOConfig {
  return {
    protocol: 'saml',
    idpEntityId: row.saml.entity_id,
    idpMetadataUrl: row.saml.metadata_url ?? '',
    configuredAt: row.created_at,
    status: row.disabled ? 'inactive' : 'active',
    domains: (row.domains ?? []).map((d) => d.domain),
  }
}

// ============================================================================
// Service factory
// ============================================================================

/**
 * Create a live, `team-sso-manage`-backed SSOConfigService. Every method resolves a user-bound
 * bearer token via one of `sso-tools.live.auth.ts`'s two named getters, `fetch()`s exactly one
 * request, and maps the response — the authorization decision (`team:manage_sso`) and the GoTrue
 * call are both made entirely inside the edge function, never re-implemented here. No client-side
 * audit write, mirroring `rbac-tools.live.ts`'s own "NO CLIENT-SIDE AUDIT WRITE" convention: the
 * edge function writes its own `audit_logs` row per request (Wave 3 plan doc, Step 2, item 6).
 */
export function createLiveSSOService(): SSOConfigService {
  return {
    async set(config): Promise<SSOConfig> {
      // GoTrue's real Auth Admin SSO API is SAML-only (project config `saml_enabled`) — there is
      // no live OIDC surface to call. Refuse with a typed error rather than silently registering a
      // SAML provider for an `oidc` request, which would be a config the caller never asked for.
      if (config.protocol !== 'saml') {
        throw new SsoValidationError(
          'Only the "saml" protocol is available today — the live SSO service wraps GoTrue\'s ' +
            'Auth Admin SSO API, which is SAML-only. OIDC is not supported.'
        )
      }
      const binding = await getSsoManageUserClient('configure SSO')
      const body = await callSsoManage<GoTrueSamlProviderResponse>(binding, {
        action: 'set',
        metadataUrl: config.idpMetadataUrl,
        entityId: config.idpEntityId,
      })
      return mapProviderToConfig(body)
    },

    async test() {
      const binding = await getSsoManageUserClient('test the SSO connection')
      const res = await fetchSsoManage(binding, { action: 'test' })
      if (res.status === 404) {
        // Mirrors the stub's own "no config" message (sso-tools.stub.ts) so the two paths read the
        // same way to a caller who has never run `set`.
        return {
          success: false,
          latencyMs: 0,
          message: 'No SSO configuration found. Use configure_sso with action "set" first.',
        }
      }
      if (!res.ok) await throwMappedError(res)
      const body = await readJson<{ success: boolean; latencyMs: number; message: string }>(res)
      if (body === null) {
        throw new SsoServiceUnavailableError(res.status, 'response body was empty or unreadable')
      }
      return body
    },

    async remove(memberDisposition): Promise<boolean> {
      const binding = await getSsoManageUserClient('remove SSO configuration')
      const res = await fetchSsoManage(binding, { action: 'remove', memberDisposition })
      if (res.status === 404) return false
      if (!res.ok) await throwMappedError(res)
      const body = await readJson<{ removed: boolean }>(res)
      return body?.removed ?? true
    },

    async get(includeMetadata): Promise<SSOConfig | null> {
      const binding = await getSsoReadUserClient('view SSO settings')
      const res = await fetchSsoManage(binding, { action: 'get', includeMetadata })
      if (res.status === 404) return null
      if (!res.ok) await throwMappedError(res)
      const body = await readJson<GoTrueSamlProviderResponse | null>(res)
      return body ? mapProviderToConfig(body) : null
    },

    async claimDomain(domain): Promise<SsoDomainClaim> {
      const binding = await getSsoManageUserClient('claim a domain for SSO')
      return callSsoManage<SsoDomainClaim>(binding, { action: 'claim_domain', domain })
    },

    async verifyDomain(domain): Promise<SsoDomainVerification> {
      const binding = await getSsoManageUserClient('verify a domain for SSO')
      return callSsoManage<SsoDomainVerification>(binding, { action: 'verify_domain', domain })
    },
  }
}
