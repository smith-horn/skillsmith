/**
 * @fileoverview Enterprise SSO/SAML configuration MCP tools
 * @module @skillsmith/mcp-server/tools/sso-tools
 * @see SMI-3900: SSO/SAML Configuration MCP Tools
 * @see SMI-6204 (Wave 3 of SMI-6200): live `set`/`test`/`remove`/`claim_domain`/`verify_domain`
 *      over the `team-sso-manage` edge function (`sso-tools.live.ts`); `sso_settings` reads over
 *      the same function. Live/stub selection mirrors `rbac-tools.ts`'s
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

import { z } from 'zod'
import type { ToolContext } from '../context.js'
import { withTelemetry } from '@skillsmith/core/telemetry'
import { dataSourceFor } from './stub-data-source.js'
import { isSupabaseConfigured } from '../supabase-client.js'
import { createLiveSSOService, SsoDomainNotVerifiedError } from './sso-tools.live.js'
import type { SsoDomainNotVerifiedDetails } from './sso-tools.live.js'
import { toPermissionDeniedError } from './team-permission-error.js'
import type { PermissionDeniedError } from './team-permission-error.js'
import { createStubSSOService } from './sso-tools.stub.js'
import type {
  SSOConfig,
  SSOConfigService,
  SsoDomainClaim,
  SsoDomainVerification,
} from './sso-tools.types.js'

// Re-export types and stub factory for external consumers — same shape as rbac-tools.ts's own
// re-export block (rbac-tools.types.ts / rbac-tools.stub.ts).
export type {
  SSOConfig,
  SSOConfigService,
  SsoDomainClaim,
  SsoDomainVerification,
} from './sso-tools.types.js'
export { createStubSSOService } from './sso-tools.stub.js'

// ============================================================================
// Input schemas
// ============================================================================

export const configureSsoInputSchema = z.object({
  action: z.enum(['set', 'test', 'remove', 'claim_domain', 'verify_domain']),
  idpMetadataUrl: z
    .string()
    .url('Must be a valid URL')
    .optional()
    .describe('IdP metadata URL (required for set)'),
  idpEntityId: z.string().optional().describe('IdP entity ID (extracted from metadata if omitted)'),
  protocol: z
    .enum(['saml', 'oidc'])
    .optional()
    .default('saml')
    .describe('SSO protocol (default: saml)'),
  domain: z
    .string()
    .optional()
    .describe(
      'Domain to claim or verify for SSO auto-discovery (required for claim_domain/verify_domain)'
    ),
  // SMI-6204 Wave 3 corrected plan: `expire_stale_sso_members()` is a Wave 4 deliverable, so
  // "expire" is not offered here — only "convert_to_manual" exists this wave. Optional because
  // it is the only legal value today; omitted, `remove` defaults to it (see the handler below).
  memberDisposition: z
    .enum(['convert_to_manual'])
    .optional()
    .describe(
      'How to handle existing SSO-provisioned team members when removing SSO (default: convert_to_manual)'
    ),
})

export type ConfigureSsoInput = z.infer<typeof configureSsoInputSchema>

export const ssoSettingsInputSchema = z.object({
  includeMetadata: z
    .boolean()
    .optional()
    .default(false)
    .describe('Include full IdP metadata in response'),
})

export type SsoSettingsInput = z.infer<typeof ssoSettingsInputSchema>

// ============================================================================
// Tool schemas for MCP registration
// ============================================================================

export const configureSsoToolSchema = {
  name: 'configure_sso' as const,
  description:
    'Configure SSO/SAML integration for your organization. ' +
    'Actions: set (store IdP config), test (connection test), remove (clear config), ' +
    'claim_domain (issue a DNS TXT verification token), verify_domain (check the TXT record). ' +
    'Requires Enterprise tier (sso_saml feature).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['set', 'test', 'remove', 'claim_domain', 'verify_domain'],
        description: 'SSO operation: set, test, remove, claim_domain, or verify_domain',
      },
      idpMetadataUrl: {
        type: 'string',
        description: 'IdP metadata URL (required for set)',
      },
      idpEntityId: {
        type: 'string',
        description: 'IdP entity ID (optional, extracted from metadata)',
      },
      protocol: {
        type: 'string',
        enum: ['saml', 'oidc'],
        description: 'SSO protocol (default: saml)',
      },
      domain: {
        type: 'string',
        description: 'Domain to claim or verify (required for claim_domain/verify_domain)',
      },
      memberDisposition: {
        type: 'string',
        enum: ['convert_to_manual'],
        description:
          'How to handle existing SSO-provisioned members on remove (default: convert_to_manual)',
      },
    },
    required: ['action'],
  },
}

export const ssoSettingsToolSchema = {
  name: 'sso_settings' as const,
  description:
    'View current SSO/SAML configuration for your organization. ' +
    'Requires Enterprise tier (sso_saml feature).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      includeMetadata: {
        type: 'boolean',
        description: 'Include full IdP metadata in response (default: false)',
      },
    },
  },
}

// ============================================================================
// Service interface + stub service
// ============================================================================
// SMI-6204: moved to sso-tools.types.ts (SSOConfig / SSOConfigService / SsoDomainClaim /
// SsoDomainVerification) and sso-tools.stub.ts (createStubSSOService), both re-exported above —
// this file's own 500-line audit:standards budget, the same split rbac-tools.ts made into
// rbac-tools.types.ts / rbac-tools.stub.ts.

// Module-level singleton. Picks the live team-sso-manage-backed service when SUPABASE_URL +
// SUPABASE_ANON_KEY are configured; otherwise the in-memory stub (local dev / tests) — same
// pattern as rbac-tools.ts:85-87.
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
}

/**
 * Map a thrown service error to the tool's `error` (+ optional structured detail) fields.
 *
 * Mirrors `rbac-tools.ts`'s `toToolError()`: a `TeamPermissionDeniedError` (thrown by the live
 * path on a `team-sso-manage` 403 — `sso-tools.live.ts`) becomes the structured refusal shape;
 * an `SsoDomainNotVerifiedError` (409) carries its TXT-record details through as
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
        const config = await svc.set({
          idpMetadataUrl: input.idpMetadataUrl,
          idpEntityId: input.idpEntityId,
          protocol: input.protocol ?? 'saml',
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
