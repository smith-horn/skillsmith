/**
 * @fileoverview Enterprise SSO/SAML configuration MCP tools — action-handler implementations
 * @module @skillsmith/mcp-server/tools/sso-tools.action
 * @see SMI-5127: the `*.action.ts` sibling convention for a tool/command file whose
 *      `withTelemetry`-wrapped action handlers push it over the 500-line audit:standards
 *      budget — this file holds the implementations, the wrapped exports, the service
 *      singleton, and the two result-shape interfaces; `sso-tools.ts` keeps the MCP tool
 *      registration, JSON/Zod schema, and re-exports (SMI-6200 Wave 4 Step 0 split, done
 *      mechanically ahead of Wave 4's new SSO surface landing in `sso-tools.ts` itself —
 *      the same split `rbac-tools.ts` got in the same pass). Precedent: `search.ts` /
 *      `search.action.ts` for CLI commands, and
 *      `supabase/functions/team-sso-manage/actions.config.ts` / `actions.config.query.ts`
 *      for the same shape one layer down (Wave 3).
 * @see SMI-3900: SSO/SAML Configuration MCP Tools
 * @see SMI-6204 (Wave 3 of SMI-6200): live `set`/`test`/`remove`/`claim_domain`/`verify_domain`
 *      over the `team-sso-manage` edge function (`sso-tools.live.ts`); `sso_settings` reads over
 *      the same function. Live/stub selection mirrors `rbac-tools.action.ts`'s
 *      `isSupabaseConfigured()` switch below.
 *
 * Actual SAML/OIDC auth flows are deferred to a Supabase edge function since local MCP servers
 * have no HTTP callback endpoint — this file (plus `sso-tools.live.ts`) is a management interface
 * over that function, not a SAML implementation.
 *
 * Security: XML parsing and signature validation MUST be delegated to a
 * vetted SAML library. Custom SAML assertion parsing is prohibited.
 *
 * Tier gate: Enterprise (sso_saml feature flag).
 */

import type { ToolContext } from '../context.js'
import { withTelemetry } from '@skillsmith/core/telemetry'
import { dataSourceFor } from './stub-data-source.js'
import { isSupabaseConfigured } from '../supabase-client.js'
import { createLiveSSOService, SsoDomainNotVerifiedError } from './sso-tools.live.js'
import type { SsoDomainNotVerifiedDetails } from './sso-tools.live.js'
import { toPermissionDeniedError, permissionErrorText } from './team-permission-error.js'
import type { PermissionDeniedError } from './team-permission-error.js'
import { createStubSSOService } from './sso-tools.stub.js'
import type {
  SSOConfig,
  SSOConfigService,
  SsoDomainClaim,
  SsoDomainVerification,
} from './sso-tools.types.js'
import type { ConfigureSsoInput, SsoSettingsInput } from './sso-tools.js'

// Module-level singleton. Picks the live team-sso-manage-backed service when SUPABASE_URL +
// SUPABASE_ANON_KEY are configured; otherwise the in-memory stub (local dev / tests) — same
// pattern as rbac-tools.action.ts's own singleton.
let service: SSOConfigService = isSupabaseConfigured()
  ? createLiveSSOService()
  : createStubSSOService()

/** Replace the SSO config service implementation (for testing or production swap) */
export function setSSOConfigService(svc: SSOConfigService): void {
  service = svc
}

/** Get the current SSO config service instance */
export function getSSOConfigService(): SSOConfigService {
  return service
}

// ============================================================================
// Handlers
// ============================================================================

export interface ConfigureSsoResult {
  success: boolean
  dataSource: 'stub' | 'live'
  config?: SSOConfig
  test?: { success: boolean; latencyMs: number; message: string; simulated?: boolean }
  domainClaim?: SsoDomainClaim
  domainVerification?: SsoDomainVerification
  /**
   * Populated only when a `set` was refused because the domain is not yet verified — carries the
   * exact TXT record so the caller can act on it without re-parsing `error`. See
   * `sso-tools.live.ts`'s `SsoDomainNotVerifiedError`.
   */
  domainNotVerified?: SsoDomainNotVerifiedDetails
  message?: string
  /**
   * A structured permission refusal (same shape RBAC renders — `team-permission-error.ts`), or a
   * plain validation/transport string. Both render via `permissionErrorText()`.
   */
  error?: string | PermissionDeniedError
}

export interface SsoSettingsResult {
  configured: boolean
  dataSource: 'stub' | 'live'
  config?: SSOConfig
  message: string
  /**
   * A structured permission refusal (same shape RBAC/configure_sso render — `team-permission-
   * error.ts`), populated when `svc.get()` throws (SMI-6204 2026-08-28 adversarial review, M-2).
   * Mirrors `ConfigureSsoResult.error`.
   */
  error?: string | PermissionDeniedError
}

/**
 * Map a thrown service error to the tool's `error` (+ optional structured detail) fields.
 *
 * Mirrors `rbac-tools.action.ts`'s `toToolError()`: a `TeamPermissionDeniedError` (thrown by the
 * live path on a `team-sso-manage` 403 — `sso-tools.live.ts`) becomes the structured refusal
 * shape; an `SsoDomainNotVerifiedError` (409) carries its TXT-record details through as
 * `domainNotVerified`; anything else renders as a plain string.
 */
function toSsoToolError(err: unknown): {
  error: string | PermissionDeniedError
  domainNotVerified?: SsoDomainNotVerifiedDetails
} {
  const denied = toPermissionDeniedError(err, 'team:manage_sso')
  if (denied) return { error: denied }
  if (err instanceof SsoDomainNotVerifiedError) {
    return { error: err.message, domainNotVerified: err.details }
  }
  return { error: err instanceof Error ? err.message : 'Unexpected SSO error.' }
}

/**
 * Execute a configure_sso operation.
 */
async function executeConfigureSsoImpl(
  input: ConfigureSsoInput,
  _context: ToolContext
): Promise<ConfigureSsoResult> {
  // SMI-6203 (P-5 audit): capture the module-level singleton once, so a setSSOConfigService()
  // call landing between this read and any of the .method() calls below cannot produce a result
  // labelled with one service's dataSource and populated by another's.
  const svc = service
  const dataSource: 'stub' | 'live' = dataSourceFor(svc)

  try {
    switch (input.action) {
      case 'set': {
        if (!input.idpMetadataUrl) {
          return {
            success: false,
            dataSource,
            error: 'idpMetadataUrl is required for action "set".',
          }
        }
        // SMI-6204 (corrected 2026-08-28): a provider can only be registered against a domain
        // that has already been claimed and DNS-verified — see claim_domain/verify_domain above.
        // This check was previously missing entirely, so `set` had no way to tell the live
        // service which domain it was registering, and could never succeed end-to-end.
        if (!input.domain) {
          return {
            success: false,
            dataSource,
            error:
              'domain is required for action "set" — claim and verify a domain first ' +
              '(configure_sso action "claim_domain", then "verify_domain").',
          }
        }
        const config = await svc.set({
          idpMetadataUrl: input.idpMetadataUrl,
          idpEntityId: input.idpEntityId,
          protocol: input.protocol ?? 'saml',
          domain: input.domain,
        })
        return {
          success: true,
          dataSource,
          config,
          message:
            `SSO configured with ${config.protocol.toUpperCase()} protocol.\n` +
            `IdP Entity ID: ${config.idpEntityId}\n` +
            `Status: ${config.status}`,
        }
      }

      case 'test': {
        const result = await svc.test()
        return {
          success: result.success,
          dataSource,
          test: result,
          message: result.message,
        }
      }

      case 'remove': {
        // SMI-6204 Wave 3: "convert_to_manual" is the only supported disposition this wave, so
        // omitting it is not ambiguous — default to the one legal value rather than forcing every
        // caller to spell out a choice that isn't actually a choice yet.
        const memberDisposition = input.memberDisposition ?? 'convert_to_manual'
        const removed = await svc.remove(memberDisposition)
        if (!removed) {
          return { success: false, dataSource, error: 'No SSO configuration to remove.' }
        }
        return { success: true, dataSource, message: 'SSO configuration removed.' }
      }

      case 'claim_domain': {
        if (!input.domain) {
          return {
            success: false,
            dataSource,
            error: 'domain is required for action "claim_domain".',
          }
        }
        const claim = await svc.claimDomain(input.domain)
        return {
          success: true,
          dataSource,
          domainClaim: claim,
          message:
            `To verify ownership of \`${claim.domain}\`, publish this DNS TXT record:\n\n` +
            `- **Name:** \`${claim.recordName}\`\n- **Type:** \`${claim.recordType}\`\n` +
            `- **Value:** \`${claim.recordValue}\`\n\n` +
            'Once it has propagated, run configure_sso with action "verify_domain".' +
            (claim.simulated
              ? '\n\n_This is stub data — no real DNS record is required to proceed._'
              : ''),
        }
      }

      case 'verify_domain': {
        if (!input.domain) {
          return {
            success: false,
            dataSource,
            error: 'domain is required for action "verify_domain".',
          }
        }
        const verification = await svc.verifyDomain(input.domain)
        return {
          success: verification.verified,
          dataSource,
          domainVerification: verification,
          message: verification.verified
            ? `Domain \`${verification.domain}\` is verified.` +
              (verification.simulated ? ' (stub — no real DNS lookup was performed)' : '')
            : `Domain \`${verification.domain}\` could not be verified yet. Confirm the TXT ` +
              'record has propagated and try again.',
        }
      }
    }
  } catch (err) {
    return { success: false, dataSource, ...toSsoToolError(err) }
  }
}

/**
 * Execute an sso_settings query.
 */
async function executeSsoSettingsImpl(
  input: SsoSettingsInput,
  _context: ToolContext
): Promise<SsoSettingsResult> {
  // SMI-6203 (P-5 audit): see executeConfigureSsoImpl above.
  const svc = service
  const dataSource: 'stub' | 'live' = dataSourceFor(svc)
  // M-2 (SMI-6204 2026-08-28 adversarial review): `svc.get()` can throw
  // TeamPermissionDeniedError/SsoAuthError/SsoServiceUnavailableError on the live path -- unlike
  // executeConfigureSsoImpl, this had no try/catch at all, so a permission denial threw instead
  // of returning the same structured refusal shape configure_sso already renders.
  try {
    const config = await svc.get(input.includeMetadata ?? false)
    if (!config) {
      return {
        configured: false,
        dataSource,
        message:
          'No SSO configuration found.\n' +
          'Use configure_sso with action "set" to configure SSO for your organization.',
      }
    }
    return {
      configured: true,
      dataSource,
      config,
      message:
        `SSO is configured (${config.protocol.toUpperCase()}).\n` +
        `IdP Entity ID: ${config.idpEntityId}\n` +
        `Status: ${config.status}\n` +
        `Configured at: ${config.configuredAt}`,
    }
  } catch (err) {
    const { error } = toSsoToolError(err)
    return {
      configured: false,
      dataSource,
      message: permissionErrorText(error) || 'Could not load SSO settings.',
      error,
    }
  }
}

// SMI-5017 W2.S2: wrap at export boundary
export const executeConfigureSso = withTelemetry(executeConfigureSsoImpl, {
  source: 'mcp-tool',
  extractSkillId: () => 'configure_sso',
  extractFramework: () => 'unknown',
})
export const executeSsoSettings = withTelemetry(executeSsoSettingsImpl, {
  source: 'mcp-tool',
  extractSkillId: () => 'sso_settings',
  extractFramework: () => 'unknown',
})
