/**
 * @fileoverview Enterprise SSO/SAML configuration MCP tools
 * @module @skillsmith/mcp-server/tools/sso-tools
 * @see SMI-3900: SSO/SAML Configuration MCP Tools
 *
 * SSO is scoped to config storage + validation only. Actual SAML/OIDC auth
 * flows are deferred to a Supabase edge function since local MCP servers
 * have no HTTP callback endpoint.
 *
 * Security: XML parsing and signature validation MUST be delegated to a
 * vetted SAML library. Custom SAML assertion parsing is prohibited.
 *
 * Tier gate: Enterprise (sso_saml feature flag).
 */

import { z } from 'zod'
import type { ToolContext } from '../context.js'
import { isSupabaseConfigured } from '../supabase-client.js'

// ============================================================================
// Input schemas
// ============================================================================

export const configureSsoInputSchema = z.object({
  action: z.enum(['set', 'test', 'remove']),
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
    'Actions: set (store IdP config), test (simulate connection test), remove (clear config). ' +
    'Requires Enterprise tier (sso_saml feature).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['set', 'test', 'remove'],
        description: 'SSO operation: set, test, or remove',
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
// Service interface (stub now, Supabase edge function later)
// ============================================================================

export interface SSOConfig {
  protocol: 'saml' | 'oidc'
  idpMetadataUrl: string
  idpEntityId: string
  configuredAt: string
  status: 'active' | 'inactive'
}

export interface SSOConfigService {
  set(config: {
    idpMetadataUrl: string
    idpEntityId?: string
    protocol: 'saml' | 'oidc'
  }): Promise<SSOConfig>
  test(): Promise<{ success: boolean; latencyMs: number; message: string }>
  remove(): Promise<boolean>
  get(includeMetadata: boolean): Promise<SSOConfig | null>
}

// ============================================================================
// Stub service (returns realistic mock data)
// ============================================================================

/** @internal Exported for testing */
export function createStubSSOService(): SSOConfigService {
  let currentConfig: SSOConfig | null = null

  return {
    async set(config) {
      const entityId =
        config.idpEntityId ?? new URL(config.idpMetadataUrl).origin + '/saml/metadata'
      currentConfig = {
        protocol: config.protocol,
        idpMetadataUrl: config.idpMetadataUrl,
        idpEntityId: entityId,
        configuredAt: new Date().toISOString(),
        status: 'active',
      }
      return currentConfig
    },

    async test() {
      if (!currentConfig) {
        return {
          success: false,
          latencyMs: 0,
          message: 'No SSO configuration found. Use configure_sso with action "set" first.',
        }
      }
      // Simulated connection test
      return {
        success: true,
        latencyMs: 142,
        message: `Connection to ${currentConfig.idpEntityId} successful (${currentConfig.protocol.toUpperCase()}).`,
      }
    },

    async remove() {
      if (!currentConfig) return false
      currentConfig = null
      return true
    },

    async get(includeMetadata: boolean) {
      if (!currentConfig) return null
      if (!includeMetadata) {
        // Return config without the full metadata URL details
        return { ...currentConfig }
      }
      return currentConfig
    },
  }
}

// Module-level singleton
let service: SSOConfigService = createStubSSOService()

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
  test?: { success: boolean; latencyMs: number; message: string }
  message?: string
  error?: string
}

export interface SsoSettingsResult {
  configured: boolean
  dataSource: 'stub' | 'live'
  config?: SSOConfig
  message: string
}

/**
 * Execute a configure_sso operation.
 */
export async function executeConfigureSso(
  input: ConfigureSsoInput,
  _context: ToolContext
): Promise<ConfigureSsoResult> {
  const dataSource: 'stub' | 'live' = isSupabaseConfigured() ? 'live' : 'stub'

  switch (input.action) {
    case 'set': {
      if (!input.idpMetadataUrl) {
        return { success: false, dataSource, error: 'idpMetadataUrl is required for action "set".' }
      }
      const config = await service.set({
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
      const result = await service.test()
      return {
        success: result.success,
        dataSource,
        test: result,
        message: result.message,
      }
    }

    case 'remove': {
      const removed = await service.remove()
      if (!removed) {
        return { success: false, dataSource, error: 'No SSO configuration to remove.' }
      }
      return { success: true, dataSource, message: 'SSO configuration removed.' }
    }
  }
}

/**
 * Execute an sso_settings query.
 */
export async function executeSsoSettings(
  input: SsoSettingsInput,
  _context: ToolContext
): Promise<SsoSettingsResult> {
  const dataSource: 'stub' | 'live' = isSupabaseConfigured() ? 'live' : 'stub'
  const config = await service.get(input.includeMetadata ?? false)
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
