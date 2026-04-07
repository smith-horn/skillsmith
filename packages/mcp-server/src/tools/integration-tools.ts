/**
 * @fileoverview Custom integrations MCP tools (webhooks + API keys)
 * @module @skillsmith/mcp-server/tools/integration-tools
 * @see SMI-3903: Custom Integrations MCP Tools
 *
 * Webhook signing uses HMAC-SHA256. API keys are stored as SHA-256 hashes
 * only — the raw key is returned once on creation and never again.
 *
 * Tier gate: Enterprise (custom_integrations feature flag).
 */

import { z } from 'zod'
import type { ToolContext } from '../context.js'
import { isSupabaseConfigured } from '../supabase-client.js'
import { createStubIntegrationService } from './integration-tools.stub.js'

// Re-export stub factory for external consumers and tests
export { createStubIntegrationService } from './integration-tools.stub.js'

// ============================================================================
// Input schemas
// ============================================================================

export const webhookConfigureInputSchema = z.object({
  action: z.enum(['create', 'list', 'get', 'delete', 'test', 'rotate_secret']),
  url: z
    .string()
    .url('Must be a valid URL')
    .optional()
    .describe('Webhook URL (required for create)'),
  events: z
    .array(z.string())
    .optional()
    .describe('Event types to subscribe to (required for create)'),
  webhookId: z
    .string()
    .optional()
    .describe('Webhook ID (required for get/delete/test/rotate_secret)'),
  description: z.string().max(256).optional().describe('Webhook description'),
})

export type WebhookConfigureInput = z.infer<typeof webhookConfigureInputSchema>

export const apiKeyManageInputSchema = z.object({
  action: z.enum(['create', 'list', 'revoke', 'get']),
  name: z.string().min(1).max(128).optional().describe('Key name (required for create)'),
  keyId: z.string().optional().describe('Key ID (required for revoke/get)'),
  permissions: z.array(z.string()).optional().describe('Permission scopes (optional for create)'),
  expiresIn: z
    .enum(['30d', '90d', '365d', 'never'])
    .optional()
    .default('90d')
    .describe('Expiration period (default: 90d)'),
})

export type ApiKeyManageInput = z.infer<typeof apiKeyManageInputSchema>

// ============================================================================
// Tool schemas for MCP registration
// ============================================================================

export const webhookConfigureToolSchema = {
  name: 'webhook_configure' as const,
  description:
    'Configure webhooks for skill lifecycle events (skill.install, skill.publish, etc.). ' +
    'Webhooks are signed with HMAC-SHA256. ' +
    'Requires Enterprise tier (custom_integrations feature).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'list', 'get', 'delete', 'test', 'rotate_secret'],
        description: 'Webhook operation',
      },
      url: { type: 'string', description: 'Webhook URL (required for create)' },
      events: {
        type: 'array',
        items: { type: 'string' },
        description: 'Event types (required for create)',
      },
      webhookId: {
        type: 'string',
        description: 'Webhook ID (required for get/delete/test/rotate_secret)',
      },
      description: { type: 'string', description: 'Webhook description' },
    },
    required: ['action'],
  },
}

export const apiKeyManageToolSchema = {
  name: 'api_key_manage' as const,
  description:
    'Manage API keys for programmatic access. Keys are shown once on creation. ' +
    'Stored as SHA-256 hashes. Requires Enterprise tier (custom_integrations feature).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'list', 'revoke', 'get'],
        description: 'API key operation',
      },
      name: { type: 'string', description: 'Key name (required for create)' },
      keyId: { type: 'string', description: 'Key ID (required for revoke/get)' },
      permissions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Permission scopes',
      },
      expiresIn: {
        type: 'string',
        enum: ['30d', '90d', '365d', 'never'],
        description: 'Expiration period (default: 90d)',
      },
    },
    required: ['action'],
  },
}

// ============================================================================
// Service types
// ============================================================================

export interface Webhook {
  id: string
  url: string
  events: string[]
  description: string | null
  signingSecret: string
  status: 'active' | 'inactive'
  createdAt: string
  lastDeliveryAt: string | null
}

export interface WebhookMasked {
  id: string
  url: string
  events: string[]
  description: string | null
  signingSecretLast4: string
  status: 'active' | 'inactive'
  createdAt: string
  lastDeliveryAt: string | null
}

export interface ApiKey {
  id: string
  name: string
  keyValue: string
  keyPrefix: string
  permissions: string[]
  expiresAt: string | null
  createdAt: string
}

export interface ApiKeyMasked {
  id: string
  name: string
  keyLast4: string
  keyPrefix: string
  permissions: string[]
  expiresAt: string | null
  createdAt: string
  status: 'active' | 'revoked'
}

export interface IntegrationService {
  createWebhook(url: string, events: string[], description?: string): Promise<Webhook>
  listWebhooks(): Promise<WebhookMasked[]>
  getWebhook(webhookId: string): Promise<WebhookMasked | null>
  deleteWebhook(webhookId: string): Promise<boolean>
  testWebhook(webhookId: string): Promise<{ success: boolean; statusCode: number; message: string }>
  rotateSecret(webhookId: string): Promise<{ webhookId: string; newSigningSecret: string }>
  createApiKey(name: string, permissions?: string[], expiresIn?: string): Promise<ApiKey>
  listApiKeys(): Promise<ApiKeyMasked[]>
  getApiKey(keyId: string): Promise<ApiKeyMasked | null>
  revokeApiKey(keyId: string): Promise<boolean>
}

// Module-level singleton
let service: IntegrationService = createStubIntegrationService()

/** Replace the integration service implementation */
export function setIntegrationService(svc: IntegrationService): void {
  service = svc
}

// ============================================================================
// Result types
// ============================================================================

export interface WebhookConfigureResult {
  success: boolean
  dataSource: 'stub' | 'live'
  webhook?: Webhook | WebhookMasked
  webhooks?: WebhookMasked[]
  test?: { success: boolean; statusCode: number; message: string }
  rotated?: { webhookId: string; newSigningSecret: string }
  message?: string
  error?: string
}

export interface ApiKeyManageResult {
  success: boolean
  dataSource: 'stub' | 'live'
  key?: ApiKey | ApiKeyMasked
  keys?: ApiKeyMasked[]
  message?: string
  error?: string
}

// ============================================================================
// Handlers
// ============================================================================

/** Resolve the current data source based on Supabase configuration */
function getDataSource(): 'stub' | 'live' {
  return isSupabaseConfigured() ? 'live' : 'stub'
}

export async function executeWebhookConfigure(
  input: WebhookConfigureInput,
  _context: ToolContext
): Promise<WebhookConfigureResult> {
  const dataSource = getDataSource()

  switch (input.action) {
    case 'create': {
      if (!input.url)
        return { success: false, dataSource, error: 'url is required for action "create".' }
      if (!input.events?.length)
        return { success: false, dataSource, error: 'events is required for action "create".' }
      const wh = await service.createWebhook(input.url, input.events, input.description)
      return {
        success: true,
        dataSource,
        webhook: wh,
        message:
          `## Webhook Created\n\n` +
          `- **ID:** ${wh.id}\n` +
          `- **URL:** ${wh.url}\n` +
          `- **Events:** ${wh.events.join(', ')}\n` +
          `- **Signing Secret:** \`${wh.signingSecret}\`\n\n` +
          `> **Store this secret now** -- it will not be shown again.\n\n` +
          `### HMAC Verification\n\n` +
          'Each delivery includes an `X-Skillsmith-Signature` header computed as:\n\n' +
          '```\nHMAC-SHA256(signing_secret, request_body)\n```\n\n' +
          'Verify this signature before processing the payload.',
      }
    }
    case 'list': {
      const webhooks = await service.listWebhooks()
      return {
        success: true,
        dataSource,
        webhooks,
        message:
          `## Webhooks (${webhooks.length})\n\n` +
          (webhooks.length === 0
            ? 'No webhooks configured.'
            : webhooks.map((w) => `- **${w.id}**: ${w.url} (${w.events.join(', ')})`).join('\n')),
      }
    }
    case 'get': {
      if (!input.webhookId)
        return { success: false, dataSource, error: 'webhookId is required for action "get".' }
      const wh = await service.getWebhook(input.webhookId)
      if (!wh)
        return { success: false, dataSource, error: `Webhook "${input.webhookId}" not found.` }
      return { success: true, dataSource, webhook: wh }
    }
    case 'delete': {
      if (!input.webhookId)
        return { success: false, dataSource, error: 'webhookId is required for action "delete".' }
      const deleted = await service.deleteWebhook(input.webhookId)
      if (!deleted)
        return { success: false, dataSource, error: `Webhook "${input.webhookId}" not found.` }
      return { success: true, dataSource, message: `Webhook "${input.webhookId}" deleted.` }
    }
    case 'test': {
      if (!input.webhookId)
        return { success: false, dataSource, error: 'webhookId is required for action "test".' }
      const result = await service.testWebhook(input.webhookId)
      return { success: result.success, dataSource, test: result, message: result.message }
    }
    case 'rotate_secret': {
      if (!input.webhookId)
        return {
          success: false,
          dataSource,
          error: 'webhookId is required for action "rotate_secret".',
        }
      try {
        const rotated = await service.rotateSecret(input.webhookId)
        return {
          success: true,
          dataSource,
          rotated,
          message:
            `## Secret Rotated\n\n` +
            `- **Webhook:** ${rotated.webhookId}\n` +
            `- **New Secret:** \`${rotated.newSigningSecret}\`\n\n` +
            `> **Store this secret now** -- it will not be shown again.`,
        }
      } catch (e) {
        return {
          success: false,
          dataSource,
          error: e instanceof Error ? e.message : 'Unknown error',
        }
      }
    }
  }
}

export async function executeApiKeyManage(
  input: ApiKeyManageInput,
  _context: ToolContext
): Promise<ApiKeyManageResult> {
  const dataSource = getDataSource()

  switch (input.action) {
    case 'create': {
      if (!input.name)
        return { success: false, dataSource, error: 'name is required for action "create".' }
      const key = await service.createApiKey(input.name, input.permissions, input.expiresIn)
      return {
        success: true,
        dataSource,
        key,
        message:
          `## API Key Created\n\n` +
          `- **Name:** ${key.name}\n` +
          `- **Key ID:** ${key.id}\n` +
          `- **Key Value:** \`${key.keyValue}\`\n` +
          `- **Prefix:** ${key.keyPrefix}\n` +
          `- **Permissions:** ${key.permissions.join(', ')}\n` +
          `- **Expires:** ${key.expiresAt ?? 'never'}\n\n` +
          `> **Store it now -- it won't be shown again.**`,
      }
    }
    case 'list': {
      const keys = await service.listApiKeys()
      return {
        success: true,
        dataSource,
        keys,
        message:
          `## API Keys (${keys.length})\n\n` +
          (keys.length === 0
            ? 'No API keys found.'
            : keys
                .map((k) => `- **${k.name}** (${k.id}): ...${k.keyLast4} [${k.status}]`)
                .join('\n')),
      }
    }
    case 'get': {
      if (!input.keyId)
        return { success: false, dataSource, error: 'keyId is required for action "get".' }
      const key = await service.getApiKey(input.keyId)
      if (!key) return { success: false, dataSource, error: `API key "${input.keyId}" not found.` }
      return { success: true, dataSource, key }
    }
    case 'revoke': {
      if (!input.keyId)
        return { success: false, dataSource, error: 'keyId is required for action "revoke".' }
      const revoked = await service.revokeApiKey(input.keyId)
      if (!revoked)
        return {
          success: false,
          dataSource,
          error: `API key "${input.keyId}" not found or already revoked.`,
        }
      return { success: true, dataSource, message: `API key "${input.keyId}" has been revoked.` }
    }
  }
}
