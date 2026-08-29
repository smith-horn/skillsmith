/**
 * @fileoverview Enterprise SSO/SAML configuration MCP tools
 * @module @skillsmith/mcp-server/tools/sso-tools
 * @see SMI-3900: SSO/SAML Configuration MCP Tools
 * @see SMI-6204 (Wave 3 of SMI-6200): live `set`/`test`/`remove`/`claim_domain`/`verify_domain`
 *      over the `team-sso-manage` edge function (`sso-tools.live.ts`); `sso_settings` reads over
 *      the same function. Live/stub selection mirrors `rbac-tools.ts`'s
 *      `isSupabaseConfigured()` switch (now in `rbac-tools.action.ts`) below.
 * @see SMI-5127 / SMI-6200 Wave 4 Step 0: the action-handler implementations, the
 *      `withTelemetry`-wrapped exports, the service singleton, and the `ConfigureSsoResult`/
 *      `SsoSettingsResult` result shapes moved to the sibling `sso-tools.action.ts` (same
 *      500-line audit:standards budget split `rbac-tools.ts` got in the same pass — done
 *      mechanically ahead of Wave 4's own new SSO surface landing in this file) —
 *      re-exported below so every existing import site (index.ts, tool-dispatch.ts,
 *      sso-tools.test.ts, sso-tools.live.test.ts) reaches them unchanged. This file now
 *      holds only the MCP tool registration / Zod input schemas / JSON tool schemas and
 *      the public re-export surface.
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
      'Domain to claim, verify, or register for SSO auto-discovery ' +
        '(required for set/claim_domain/verify_domain)'
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
        description:
          'Domain to claim, verify, or register (required for set/claim_domain/verify_domain)',
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

// SMI-5127 / SMI-6200 Wave 4 Step 0: action-handler implementations, the withTelemetry-wrapped
// dispatcher exports, the service singleton (setSSOConfigService/getSSOConfigService), and the
// ConfigureSsoResult/SsoSettingsResult result shapes now live in sso-tools.action.ts —
// re-exported here unchanged. See that file's header for the split rationale; see
// sso-tools.action.ts's own JSDoc for setSSOConfigService/getSSOConfigService/each handler/type.
export type { ConfigureSsoResult, SsoSettingsResult } from './sso-tools.action.js'
export {
  setSSOConfigService,
  getSSOConfigService,
  executeConfigureSso,
  executeSsoSettings,
} from './sso-tools.action.js'
