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

// ============================================================================
// Stub service
// ============================================================================

function generateStubSecret(): string {
  const chars = 'abcdef0123456789'
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}

function generateStubKey(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  return (
    'sk_int_' +
    Array.from({ length: 40 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
  )
}

function computeExpiry(expiresIn?: string): string | null {
  if (!expiresIn || expiresIn === 'never') return null
  const days = parseInt(expiresIn, 10)
  if (isNaN(days)) return null
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
}

/** @internal Exported for testing */
export function createStubIntegrationService(): IntegrationService {
  const webhooks = new Map<string, Webhook>()
  const apiKeys = new Map<string, ApiKey & { revoked: boolean }>()
  let nextId = 1

  function maskWebhook(wh: Webhook): WebhookMasked {
    return {
      id: wh.id,
      url: wh.url,
      events: wh.events,
      description: wh.description,
      signingSecretLast4: wh.signingSecret.slice(-4),
      status: wh.status,
      createdAt: wh.createdAt,
      lastDeliveryAt: wh.lastDeliveryAt,
    }
  }

  function maskApiKey(key: ApiKey & { revoked: boolean }): ApiKeyMasked {
    return {
      id: key.id,
      name: key.name,
      keyLast4: key.keyValue.slice(-4),
      keyPrefix: key.keyPrefix,
      permissions: key.permissions,
      expiresAt: key.expiresAt,
      createdAt: key.createdAt,
      status: key.revoked ? 'revoked' : 'active',
    }
  }

  return {
    async createWebhook(url, events, description) {
      const id = `wh_${nextId++}`
      const wh: Webhook = {
        id,
        url,
        events,
        description: description ?? null,
        signingSecret: `whsec_${generateStubSecret()}`,
        status: 'active',
        createdAt: new Date().toISOString(),
        lastDeliveryAt: null,
      }
      webhooks.set(id, wh)
      return wh
    },
    async listWebhooks() {
      return [...webhooks.values()].map(maskWebhook)
    },
    async getWebhook(webhookId) {
      const wh = webhooks.get(webhookId)
      return wh ? maskWebhook(wh) : null
    },
    async deleteWebhook(webhookId) {
      return webhooks.delete(webhookId)
    },
    async testWebhook(webhookId) {
      const wh = webhooks.get(webhookId)
      if (!wh) return { success: false, statusCode: 0, message: 'Webhook not found.' }
      return { success: true, statusCode: 200, message: `Test delivery to ${wh.url} succeeded.` }
    },
    async rotateSecret(webhookId) {
      const wh = webhooks.get(webhookId)
      if (!wh) throw new Error(`Webhook "${webhookId}" not found.`)
      wh.signingSecret = `whsec_${generateStubSecret()}`
      return { webhookId, newSigningSecret: wh.signingSecret }
    },
    async createApiKey(name, permissions, expiresIn) {
      const id = `key_${nextId++}`
      const keyValue = generateStubKey()
      const key: ApiKey & { revoked: boolean } = {
        id,
        name,
        keyValue,
        keyPrefix: keyValue.slice(0, 10),
        permissions: permissions ?? ['read'],
        expiresAt: computeExpiry(expiresIn),
        createdAt: new Date().toISOString(),
        revoked: false,
      }
      apiKeys.set(id, key)
      return key
    },
    async listApiKeys() {
      return [...apiKeys.values()].map(maskApiKey)
    },
    async getApiKey(keyId) {
      const key = apiKeys.get(keyId)
      return key ? maskApiKey(key) : null
    },
    async revokeApiKey(keyId) {
      const key = apiKeys.get(keyId)
      if (!key || key.revoked) return false
      key.revoked = true
      return true
    },
  }
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
  webhook?: Webhook | WebhookMasked
  webhooks?: WebhookMasked[]
  test?: { success: boolean; statusCode: number; message: string }
  rotated?: { webhookId: string; newSigningSecret: string }
  message?: string
  error?: string
}

export interface ApiKeyManageResult {
  success: boolean
  key?: ApiKey | ApiKeyMasked
  keys?: ApiKeyMasked[]
  message?: string
  error?: string
}

// ============================================================================
// Handlers
// ============================================================================

export async function executeWebhookConfigure(
  input: WebhookConfigureInput,
  _context: ToolContext
): Promise<WebhookConfigureResult> {
  switch (input.action) {
    case 'create': {
      if (!input.url) return { success: false, error: 'url is required for action "create".' }
      if (!input.events?.length)
        return { success: false, error: 'events is required for action "create".' }
      const wh = await service.createWebhook(input.url, input.events, input.description)
      return {
        success: true,
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
        return { success: false, error: 'webhookId is required for action "get".' }
      const wh = await service.getWebhook(input.webhookId)
      if (!wh) return { success: false, error: `Webhook "${input.webhookId}" not found.` }
      return { success: true, webhook: wh }
    }
    case 'delete': {
      if (!input.webhookId)
        return { success: false, error: 'webhookId is required for action "delete".' }
      const deleted = await service.deleteWebhook(input.webhookId)
      if (!deleted) return { success: false, error: `Webhook "${input.webhookId}" not found.` }
      return { success: true, message: `Webhook "${input.webhookId}" deleted.` }
    }
    case 'test': {
      if (!input.webhookId)
        return { success: false, error: 'webhookId is required for action "test".' }
      const result = await service.testWebhook(input.webhookId)
      return { success: result.success, test: result, message: result.message }
    }
    case 'rotate_secret': {
      if (!input.webhookId)
        return { success: false, error: 'webhookId is required for action "rotate_secret".' }
      try {
        const rotated = await service.rotateSecret(input.webhookId)
        return {
          success: true,
          rotated,
          message:
            `## Secret Rotated\n\n` +
            `- **Webhook:** ${rotated.webhookId}\n` +
            `- **New Secret:** \`${rotated.newSigningSecret}\`\n\n` +
            `> **Store this secret now** -- it will not be shown again.`,
        }
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : 'Unknown error' }
      }
    }
  }
}

export async function executeApiKeyManage(
  input: ApiKeyManageInput,
  _context: ToolContext
): Promise<ApiKeyManageResult> {
  switch (input.action) {
    case 'create': {
      if (!input.name) return { success: false, error: 'name is required for action "create".' }
      const key = await service.createApiKey(input.name, input.permissions, input.expiresIn)
      return {
        success: true,
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
      if (!input.keyId) return { success: false, error: 'keyId is required for action "get".' }
      const key = await service.getApiKey(input.keyId)
      if (!key) return { success: false, error: `API key "${input.keyId}" not found.` }
      return { success: true, key }
    }
    case 'revoke': {
      if (!input.keyId) return { success: false, error: 'keyId is required for action "revoke".' }
      const revoked = await service.revokeApiKey(input.keyId)
      if (!revoked)
        return { success: false, error: `API key "${input.keyId}" not found or already revoked.` }
      return { success: true, message: `API key "${input.keyId}" has been revoked.` }
    }
  }
}
