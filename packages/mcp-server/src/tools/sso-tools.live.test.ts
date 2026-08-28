/**
 * @fileoverview Live SSO service tests — fetch() mapping, not RPC mapping
 * @see SMI-6204 Wave 3: `createLiveSSOService()` (`sso-tools.live.ts`)
 *
 * Mirrors `rbac-tools.live.test.ts`'s structure (hoisted fake JWT, `vi.mock` of
 * `./team-resolver.js`, a scripted transport double) but the transport is `global.fetch`, not a
 * Supabase `.rpc()` client — `team-sso-manage` is an edge function, called over HTTP
 * (`packages/core/src/sync/inventory-client.test.ts` is the fetch-mocking convention this file
 * follows: `vi.stubGlobal('fetch', fetchMock)` + a `jsonResponse()` helper).
 *
 * These are passthrough / mapping tests: every status-code branch in `sso-tools.live.ts`'s
 * `throwMappedError()` is exercised once, plus the success-path GoTrue -> flat `SSOConfig`
 * mapping, plus the explicit "never leak GoTrue's own raw fields" property — `SsoErrorBody` only
 * ever reads `error`/`message`/`domain`/`record_name`/`record_type`/`record_value`, never GoTrue's
 * own `msg`/`error_code` field names, so a response carrying both cannot leak the GoTrue-native
 * ones by construction. The test below proves that structurally rather than by convention.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { FAKE_JWT } = vi.hoisted(() => {
  const seg = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
  const userId = '11111111-2222-3333-4444-555555555555'
  return {
    FAKE_JWT: `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg({ sub: userId, role: 'authenticated' })}.sig`,
  }
})

vi.mock('./team-resolver.js', () => ({
  resolveUserAccessToken: vi.fn(async () => FAKE_JWT),
}))

import { executeConfigureSso, executeSsoSettings, setSSOConfigService } from './sso-tools.js'
import { createLiveSSOService } from './sso-tools.live.js'
import { isPermissionDeniedError, permissionErrorText } from './team-permission-error.js'
import type { ToolContext } from '../context.js'

const mockContext = {} as ToolContext
const fetchMock = vi.fn<typeof fetch>()

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('createLiveSSOService — team-sso-manage fetch() mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchMock)
    process.env.SUPABASE_URL = 'https://example.supabase.co'
    process.env.SUPABASE_ANON_KEY = 'anon-key-under-test'
    setSSOConfigService(createLiveSSOService())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.SUPABASE_URL
    delete process.env.SUPABASE_ANON_KEY
  })

  it('POSTs to team-sso-manage with the Authorization/apikey headers and the action in the body', async () => {
    // Real handleSet response shape (actions.config.ts): the provider is nested under `.provider`,
    // not the bare provider object — see sso-tools.live.ts's SetSsoProviderResponse.
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          ok: true,
          status: 'active',
          provider: {
            id: 'p1',
            disabled: false,
            saml: { entity_id: 'https://idp.example.com/entity' },
            domains: [{ domain: 'example.com' }],
            created_at: '2026-08-28T00:00:00Z',
          },
        },
        200
      )
    )

    const result = await executeConfigureSso(
      {
        action: 'set',
        idpMetadataUrl: 'https://idp.example.com/metadata',
        protocol: 'saml',
        domain: 'example.com',
      },
      mockContext
    )

    expect(result.success).toBe(true)
    expect(result.dataSource).toBe('live')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('https://example.supabase.co/functions/v1/team-sso-manage')
    const headers = init?.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Bearer ${FAKE_JWT}`)
    expect(headers.apikey).toBe('anon-key-under-test')
    expect(JSON.parse(String(init?.body))).toMatchObject({
      action: 'set',
      metadataUrl: 'https://idp.example.com/metadata',
      domain: 'example.com',
    })
  })

  it('maps a successful "set" response from GoTrue\'s nested shape to the flat SSOConfig', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          ok: true,
          status: 'active',
          provider: {
            id: 'p1',
            disabled: false,
            saml: {
              entity_id: 'https://idp.example.com/entity',
              metadata_url: 'https://idp.example.com/metadata',
            },
            domains: [{ domain: 'example.com' }, { domain: 'corp.example.com' }],
            created_at: '2026-08-28T00:00:00Z',
          },
        },
        200
      )
    )

    const result = await executeConfigureSso(
      {
        action: 'set',
        idpMetadataUrl: 'https://idp.example.com/metadata',
        protocol: 'saml',
        domain: 'example.com',
      },
      mockContext
    )

    expect(result.success).toBe(true)
    expect(result.config).toEqual({
      protocol: 'saml',
      idpEntityId: 'https://idp.example.com/entity',
      idpMetadataUrl: 'https://idp.example.com/metadata',
      configuredAt: '2026-08-28T00:00:00Z',
      status: 'active',
      domains: ['example.com', 'corp.example.com'],
    })
  })

  it('refuses "set" with protocol oidc locally, without calling fetch', async () => {
    const result = await executeConfigureSso(
      {
        action: 'set',
        idpMetadataUrl: 'https://idp.example.com/metadata',
        protocol: 'oidc',
        domain: 'example.com',
      },
      mockContext
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('SAML-only')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses "set" locally without a domain, without calling fetch', async () => {
    const result = await executeConfigureSso(
      { action: 'set', idpMetadataUrl: 'https://idp.example.com/metadata', protocol: 'saml' },
      mockContext
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('domain is required')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('401 -> a plain "not authenticated" error, not a permission denial', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 401))
    const result = await executeConfigureSso({ action: 'test', protocol: 'saml' }, mockContext)
    expect(result.success).toBe(false)
    expect(isPermissionDeniedError(result.error)).toBe(false)
    expect(result.error).toContain('Not authenticated')
  })

  it('403 forbidden -> the structured TeamPermissionDeniedError shape', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          error: 'forbidden',
          permission: 'team:manage_sso',
          message: 'You don\'t have the "team:manage_sso" permission for this team.',
        },
        403
      )
    )
    const result = await executeConfigureSso({ action: 'remove', protocol: 'saml' }, mockContext)
    expect(result.success).toBe(false)
    expect(isPermissionDeniedError(result.error)).toBe(true)
    expect(permissionErrorText(result.error)).toContain('team:manage_sso')
  })

  it('400 invalid_role_mapping -> a plain validation string, not a permission denial', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { error: 'invalid_role_mapping', message: 'role_mapping may not name "owner".' },
        400
      )
    )
    const result = await executeConfigureSso(
      {
        action: 'set',
        idpMetadataUrl: 'https://idp.example.com/metadata',
        protocol: 'saml',
        domain: 'example.com',
      },
      mockContext
    )
    expect(result.success).toBe(false)
    expect(isPermissionDeniedError(result.error)).toBe(false)
    expect(result.error).toContain('owner')
  })

  it('409 domain_not_verified -> carries the TXT record details in domainNotVerified', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          error: 'domain_not_verified',
          domain: 'example.com',
          record_name: '_skillsmith-verify.example.com',
          record_type: 'TXT',
          record_value: 'skillsmith-verify-abc123',
          message: 'Domain "example.com" is not yet verified.',
        },
        409
      )
    )
    const result = await executeConfigureSso(
      {
        action: 'set',
        idpMetadataUrl: 'https://idp.example.com/metadata',
        protocol: 'saml',
        domain: 'example.com',
      },
      mockContext
    )
    expect(result.success).toBe(false)
    expect(result.error).toBe('Domain "example.com" is not yet verified.')
    expect(result.domainNotVerified).toEqual({
      domain: 'example.com',
      recordName: '_skillsmith-verify.example.com',
      recordType: 'TXT',
      recordValue: 'skillsmith-verify-abc123',
    })
  })

  it('409 domain_verified_by_another_team -> a plain string, no domainNotVerified', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          error: 'domain_verified_by_another_team',
          message: 'This domain is already verified by another team.',
        },
        409
      )
    )
    const result = await executeConfigureSso(
      { action: 'verify_domain', domain: 'example.com', protocol: 'saml' },
      mockContext
    )
    expect(result.success).toBe(false)
    expect(result.error).toBe('This domain is already verified by another team.')
    expect(result.domainNotVerified).toBeUndefined()
  })

  it(
    'never leaks a GoTrue-native raw field (msg/error_code) even when the response body carries ' +
      'one alongside our own authored error/message',
    async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(
          {
            error: 'domain_verified_by_another_team',
            message: 'This domain is already verified by another team.',
            // Shaped like GoTrue's OWN duplicate-domain error, which names another team's
            // provider UUID — SsoErrorBody never reads these field names, so even if a response
            // carried them (a defensive scenario, not one the edge function should ever produce),
            // they cannot reach the typed error's .message.
            msg:
              'duplicate key value violates unique constraint "sso_providers_pkey": ' +
              'Key (id)=(9f6a2e10-aaaa-bbbb-cccc-1234567890ab) already exists.',
            error_code: 'sso_domain_already_exists',
          },
          409
        )
      )
      const result = await executeConfigureSso(
        { action: 'verify_domain', domain: 'example.com', protocol: 'saml' },
        mockContext
      )
      expect(result.success).toBe(false)
      expect(result.error).toBe('This domain is already verified by another team.')
      expect(String(result.error)).not.toContain('9f6a2e10')
      expect(String(result.error)).not.toContain('sso_providers_pkey')
      expect(String(result.error)).not.toContain('sso_domain_already_exists')
    }
  )

  it('501 sso_expire_unavailable -> a plain string naming SMI-6205', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          error: 'sso_expire_unavailable',
          message: 'Expiring members is not available yet (SMI-6205).',
        },
        501
      )
    )
    const result = await executeConfigureSso({ action: 'remove', protocol: 'saml' }, mockContext)
    expect(result.success).toBe(false)
    expect(result.error).toContain('SMI-6205')
  })

  it.each([500, 502, 503])(
    '%d -> a fixed generic message, never the raw response body text',
    async (status) => {
      fetchMock.mockResolvedValue(
        jsonResponse(
          { msg: 'internal GoTrue stack trace, never to be shown to a customer' },
          status
        )
      )
      const result = await executeConfigureSso({ action: 'test', protocol: 'saml' }, mockContext)
      expect(result.success).toBe(false)
      expect(result.error).toBe(`SSO service unavailable (HTTP ${status}). Try again shortly.`)
      expect(String(result.error)).not.toContain('stack trace')
    }
  )

  it('a network-level fetch failure maps to a transport error, not an outage code', async () => {
    fetchMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND example.supabase.co'))
    const result = await executeConfigureSso({ action: 'test', protocol: 'saml' }, mockContext)
    expect(result.success).toBe(false)
    expect(result.error).toContain('getaddrinfo ENOTFOUND')
  })

  it('sso_settings: a null settings row means not configured, not an error', async () => {
    // Real handleGet response shape (actions.config.ts): always 200, never a raw 404 — "not
    // configured" is conveyed by `settings: null`, not by the HTTP status.
    fetchMock.mockResolvedValue(jsonResponse({ settings: null, domains: [] }, 200))
    const result = await executeSsoSettings({ includeMetadata: false }, mockContext)
    expect(result.configured).toBe(false)
    expect(result.dataSource).toBe('live')
    expect(result.message).toContain('No SSO configuration found')
  })

  it('sso_settings: a populated settings row maps to a configured SSOConfig', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          settings: {
            supabase_provider_id: 'p1',
            reverify_days: 7,
            role_mapping: {},
            status: 'active',
            configured_by: '11111111-2222-3333-4444-555555555555',
            created_at: '2026-08-27T00:00:00Z',
            updated_at: '2026-08-28T00:00:00Z',
          },
          domains: [{ domain: 'example.com', verified_at: '2026-08-28T00:00:00Z' }],
        },
        200
      )
    )
    const result = await executeSsoSettings({ includeMetadata: false }, mockContext)
    expect(result.configured).toBe(true)
    expect(result.config?.status).toBe('active')
    expect(result.config?.domains).toEqual(['example.com'])
    expect(result.config?.configuredAt).toBe('2026-08-28T00:00:00Z')
  })

  it('sso_settings: an unverified domain claim is NOT reported as a configured domain (L-5)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          settings: {
            supabase_provider_id: 'p1',
            reverify_days: 7,
            role_mapping: {},
            status: 'active',
            configured_by: '11111111-2222-3333-4444-555555555555',
            created_at: '2026-08-27T00:00:00Z',
            updated_at: '2026-08-28T00:00:00Z',
          },
          domains: [
            { domain: 'verified.example.com', verified_at: '2026-08-28T00:00:00Z' },
            { domain: 'still-claiming.example.com', verified_at: null },
          ],
        },
        200
      )
    )
    const result = await executeSsoSettings({ includeMetadata: false }, mockContext)
    expect(result.config?.domains).toEqual(['verified.example.com'])
    expect(result.config?.domains).not.toContain('still-claiming.example.com')
  })

  it('sso_settings: a 403 from get() surfaces as a structured refusal, not a thrown exception (M-2)', async () => {
    // SMI-6204 (2026-08-28 adversarial review, M-2): executeSsoSettingsImpl previously had no
    // try/catch at all, unlike executeConfigureSsoImpl -- a TeamPermissionDeniedError thrown by
    // svc.get() (a live-path 403) would propagate out of the tool call entirely instead of
    // rendering the same structured refusal shape configure_sso already does. This must resolve
    // (not reject) with `configured: false` and a structured `error`.
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          error: 'forbidden',
          permission: 'team:manage_sso',
          message: 'You don\'t have the "team:manage_sso" permission for this team.',
        },
        403
      )
    )
    // If this rejected instead of resolving, `await` would propagate that rejection straight to
    // the test and fail it -- the assertion itself is proof this resolves rather than throws.
    const result = await executeSsoSettings({ includeMetadata: false }, mockContext)
    expect(result.configured).toBe(false)
    expect(result.dataSource).toBe('live')
    expect(isPermissionDeniedError(result.error)).toBe(true)
    expect(permissionErrorText(result.error)).toContain('team:manage_sso')
    expect(result.message).toContain('team:manage_sso')
  })

  it('claim_domain: maps a live response into domainClaim with no simulated flag', async () => {
    // Real handleClaimDomain response shape (actions.domain.ts): txtRecordName/txtRecordValue,
    // no recordType field at all (it is always 'TXT' — the edge function never sends it back).
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          ok: true,
          domain: 'example.com',
          verificationToken: 'tok_live_abc',
          txtRecordName: '_skillsmith-verify.example.com',
          txtRecordValue: 'tok_live_abc',
        },
        200
      )
    )
    const result = await executeConfigureSso(
      { action: 'claim_domain', domain: 'example.com', protocol: 'saml' },
      mockContext
    )
    expect(result.success).toBe(true)
    expect(result.domainClaim?.simulated).toBeUndefined()
    expect(result.domainClaim?.recordName).toBe('_skillsmith-verify.example.com')
    expect(result.domainClaim?.recordType).toBe('TXT')
    expect(result.domainClaim?.recordValue).toBe('tok_live_abc')
  })

  it('verify_domain: a successful verification reports verified: true with no simulated flag', async () => {
    // Real handleVerifyDomain response shape (actions.domain.ts): {ok, domain, verifiedAt} — there
    // is no `verified` boolean on the wire at all; a 200 response IS the success case (failure is
    // a distinct 409, exercised in the next test).
    fetchMock.mockResolvedValue(
      jsonResponse({ ok: true, domain: 'example.com', verifiedAt: '2026-08-28T00:00:00Z' }, 200)
    )
    const result = await executeConfigureSso(
      { action: 'verify_domain', domain: 'example.com', protocol: 'saml' },
      mockContext
    )
    expect(result.success).toBe(true)
    expect(result.domainVerification?.verified).toBe(true)
    expect(result.domainVerification?.verifiedAt).toBe('2026-08-28T00:00:00Z')
    expect(result.domainVerification?.simulated).toBeUndefined()
    expect(result.message).toContain('is verified')
  })

  it('verify_domain: a DNS mismatch/not-found result (409) renders the retry message, not success', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          error: 'domain_verification_failed',
          message:
            'No TXT record found at "_skillsmith-verify.example.com". Publish it and try again.',
        },
        409
      )
    )
    const result = await executeConfigureSso(
      { action: 'verify_domain', domain: 'example.com', protocol: 'saml' },
      mockContext
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('No TXT record found')
  })

  it('verify_domain: domain_not_claimed (404) is a plain string, not a fake outage', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          error: 'domain_not_claimed',
          message: 'No pending claim for "example.com" — call claim_domain first.',
        },
        404
      )
    )
    const result = await executeConfigureSso(
      { action: 'verify_domain', domain: 'example.com', protocol: 'saml' },
      mockContext
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('call claim_domain first')
  })
})
