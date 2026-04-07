/**
 * @fileoverview Stub service for custom integrations MCP tools
 * @module @skillsmith/mcp-server/tools/integration-tools.stub
 * @see SMI-3903: Custom Integrations MCP Tools
 * @see SMI-3914: Wave 0 stub extraction
 *
 * Extracted from integration-tools.ts for file-size compliance.
 * Provides in-memory stub implementations for webhook and API key management.
 */

import type {
  IntegrationService,
  Webhook,
  WebhookMasked,
  ApiKey,
  ApiKeyMasked,
} from './integration-tools.js'

// ============================================================================
// Mock data generation helpers
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

// ============================================================================
// Stub service factory
// ============================================================================

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
