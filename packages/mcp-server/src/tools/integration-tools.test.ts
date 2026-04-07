/**
 * @fileoverview Tests for custom integrations MCP tools
 * @see SMI-3903: Custom Integrations MCP Tools
 */

import { describe, it, expect, beforeEach } from 'vitest'
import type { ToolContext } from '../context.js'
import {
  webhookConfigureInputSchema,
  apiKeyManageInputSchema,
  executeWebhookConfigure,
  executeApiKeyManage,
  createStubIntegrationService,
  setIntegrationService,
  type WebhookConfigureInput,
  type ApiKeyManageInput,
} from './integration-tools.js'

const mockContext = {} as ToolContext

describe('integration-tools', () => {
  beforeEach(() => {
    setIntegrationService(createStubIntegrationService())
  })

  // ==========================================================================
  // Schema validation
  // ==========================================================================

  describe('webhookConfigureInputSchema', () => {
    it('should accept valid create input', () => {
      const parsed = webhookConfigureInputSchema.parse({
        action: 'create',
        url: 'https://example.com/webhook',
        events: ['skill.install'],
      })
      expect(parsed.action).toBe('create')
      expect(parsed.url).toBe('https://example.com/webhook')
    })

    it('should accept list action', () => {
      const parsed = webhookConfigureInputSchema.parse({ action: 'list' })
      expect(parsed.action).toBe('list')
    })

    it('should reject invalid action', () => {
      expect(() => webhookConfigureInputSchema.parse({ action: 'bad' })).toThrow()
    })

    it('should reject invalid URL', () => {
      expect(() =>
        webhookConfigureInputSchema.parse({
          action: 'create',
          url: 'not-a-url',
          events: ['skill.install'],
        })
      ).toThrow()
    })
  })

  describe('apiKeyManageInputSchema', () => {
    it('should accept valid create input', () => {
      const parsed = apiKeyManageInputSchema.parse({ action: 'create', name: 'ci-key' })
      expect(parsed.action).toBe('create')
      expect(parsed.expiresIn).toBe('90d')
    })

    it('should accept custom expiration', () => {
      const parsed = apiKeyManageInputSchema.parse({
        action: 'create',
        name: 'long-lived',
        expiresIn: 'never',
      })
      expect(parsed.expiresIn).toBe('never')
    })

    it('should reject invalid action', () => {
      expect(() => apiKeyManageInputSchema.parse({ action: 'bad' })).toThrow()
    })

    it('should reject invalid expiration', () => {
      expect(() =>
        apiKeyManageInputSchema.parse({ action: 'create', name: 'test', expiresIn: '7d' })
      ).toThrow()
    })
  })

  // ==========================================================================
  // webhook_configure handler
  // ==========================================================================

  describe('executeWebhookConfigure', () => {
    it('should create a webhook', async () => {
      const input: WebhookConfigureInput = {
        action: 'create',
        url: 'https://example.com/webhook',
        events: ['skill.install', 'skill.publish'],
        description: 'CI webhook',
      }
      const result = await executeWebhookConfigure(input, mockContext)
      expect(result.success).toBe(true)
      expect(result.dataSource).toBe('stub')
      expect(result.webhook).toBeDefined()
      expect(result.webhook!.url).toBe('https://example.com/webhook')
      // Full signing secret is returned on create
      expect('signingSecret' in result.webhook!).toBe(true)
      expect(result.message).toContain('Webhook Created')
      expect(result.message).toContain('HMAC-SHA256')
      expect(result.message).toContain('Store this secret now')
    })

    it('should fail create without url', async () => {
      const result = await executeWebhookConfigure(
        { action: 'create', events: ['skill.install'] },
        mockContext
      )
      expect(result.success).toBe(false)
      expect(result.error).toContain('url is required')
    })

    it('should fail create without events', async () => {
      const result = await executeWebhookConfigure(
        { action: 'create', url: 'https://example.com/wh' },
        mockContext
      )
      expect(result.success).toBe(false)
      expect(result.error).toContain('events is required')
    })

    it('should list webhooks', async () => {
      await executeWebhookConfigure(
        {
          action: 'create',
          url: 'https://example.com/wh1',
          events: ['skill.install'],
        },
        mockContext
      )
      const result = await executeWebhookConfigure({ action: 'list' }, mockContext)
      expect(result.success).toBe(true)
      expect(result.webhooks).toHaveLength(1)
      // List returns masked secrets
      expect('signingSecretLast4' in result.webhooks![0]).toBe(true)
    })

    it('should list empty webhooks', async () => {
      const result = await executeWebhookConfigure({ action: 'list' }, mockContext)
      expect(result.success).toBe(true)
      expect(result.webhooks).toHaveLength(0)
      expect(result.message).toContain('No webhooks')
    })

    it('should get a webhook by ID', async () => {
      const createResult = await executeWebhookConfigure(
        { action: 'create', url: 'https://example.com/wh', events: ['skill.install'] },
        mockContext
      )
      const webhookId = (createResult.webhook as { id: string }).id

      const result = await executeWebhookConfigure({ action: 'get', webhookId }, mockContext)
      expect(result.success).toBe(true)
      expect(result.webhook).toBeDefined()
    })

    it('should fail get without webhookId', async () => {
      const result = await executeWebhookConfigure({ action: 'get' }, mockContext)
      expect(result.success).toBe(false)
      expect(result.error).toContain('webhookId is required')
    })

    it('should fail get for nonexistent webhook', async () => {
      const result = await executeWebhookConfigure(
        { action: 'get', webhookId: 'wh_999' },
        mockContext
      )
      expect(result.success).toBe(false)
      expect(result.error).toContain('not found')
    })

    it('should delete a webhook', async () => {
      const createResult = await executeWebhookConfigure(
        { action: 'create', url: 'https://example.com/wh', events: ['skill.install'] },
        mockContext
      )
      const webhookId = (createResult.webhook as { id: string }).id

      const result = await executeWebhookConfigure({ action: 'delete', webhookId }, mockContext)
      expect(result.success).toBe(true)
      expect(result.message).toContain('deleted')
    })

    it('should fail delete without webhookId', async () => {
      const result = await executeWebhookConfigure({ action: 'delete' }, mockContext)
      expect(result.success).toBe(false)
      expect(result.error).toContain('webhookId is required')
    })

    it('should test a webhook', async () => {
      const createResult = await executeWebhookConfigure(
        { action: 'create', url: 'https://example.com/wh', events: ['skill.install'] },
        mockContext
      )
      const webhookId = (createResult.webhook as { id: string }).id

      const result = await executeWebhookConfigure({ action: 'test', webhookId }, mockContext)
      expect(result.success).toBe(true)
      expect(result.test).toBeDefined()
      expect(result.test!.statusCode).toBe(200)
    })

    it('should fail test without webhookId', async () => {
      const result = await executeWebhookConfigure({ action: 'test' }, mockContext)
      expect(result.success).toBe(false)
      expect(result.error).toContain('webhookId is required')
    })

    it('should rotate webhook secret', async () => {
      const createResult = await executeWebhookConfigure(
        { action: 'create', url: 'https://example.com/wh', events: ['skill.install'] },
        mockContext
      )
      const webhookId = (createResult.webhook as { id: string }).id

      const result = await executeWebhookConfigure(
        { action: 'rotate_secret', webhookId },
        mockContext
      )
      expect(result.success).toBe(true)
      expect(result.rotated).toBeDefined()
      expect(result.rotated!.newSigningSecret).toContain('whsec_')
      expect(result.message).toContain('Secret Rotated')
    })

    it('should fail rotate_secret without webhookId', async () => {
      const result = await executeWebhookConfigure({ action: 'rotate_secret' }, mockContext)
      expect(result.success).toBe(false)
      expect(result.error).toContain('webhookId is required')
    })

    it('should fail rotate_secret for nonexistent webhook', async () => {
      const result = await executeWebhookConfigure(
        { action: 'rotate_secret', webhookId: 'wh_999' },
        mockContext
      )
      expect(result.success).toBe(false)
      expect(result.error).toContain('not found')
    })
  })

  // ==========================================================================
  // api_key_manage handler
  // ==========================================================================

  describe('executeApiKeyManage', () => {
    it('should create an API key', async () => {
      const input: ApiKeyManageInput = {
        action: 'create',
        name: 'ci-key',
        permissions: ['read', 'write'],
        expiresIn: '90d',
      }
      const result = await executeApiKeyManage(input, mockContext)
      expect(result.success).toBe(true)
      expect(result.key).toBeDefined()
      // Full key value returned on create
      expect('keyValue' in result.key!).toBe(true)
      expect(result.message).toContain('API Key Created')
      expect(result.message).toContain("won't be shown again")
    })

    it('should create key with never expiration', async () => {
      const result = await executeApiKeyManage(
        { action: 'create', name: 'forever-key', expiresIn: 'never' },
        mockContext
      )
      expect(result.success).toBe(true)
      const key = result.key as { expiresAt: string | null }
      expect(key.expiresAt).toBeNull()
    })

    it('should fail create without name', async () => {
      const result = await executeApiKeyManage({ action: 'create', expiresIn: '90d' }, mockContext)
      expect(result.success).toBe(false)
      expect(result.error).toContain('name is required')
    })

    it('should list API keys with masked values', async () => {
      await executeApiKeyManage({ action: 'create', name: 'key-1', expiresIn: '90d' }, mockContext)
      const result = await executeApiKeyManage({ action: 'list', expiresIn: '90d' }, mockContext)
      expect(result.success).toBe(true)
      expect(result.keys).toHaveLength(1)
      // Masked: keyLast4 not full keyValue
      expect('keyLast4' in result.keys![0]).toBe(true)
      expect('keyValue' in result.keys![0]).toBe(false)
    })

    it('should list empty keys', async () => {
      const result = await executeApiKeyManage({ action: 'list', expiresIn: '90d' }, mockContext)
      expect(result.success).toBe(true)
      expect(result.keys).toHaveLength(0)
      expect(result.message).toContain('No API keys')
    })

    it('should get a key by ID', async () => {
      const createResult = await executeApiKeyManage(
        { action: 'create', name: 'test-key', expiresIn: '90d' },
        mockContext
      )
      const keyId = (createResult.key as { id: string }).id

      const result = await executeApiKeyManage(
        { action: 'get', keyId, expiresIn: '90d' },
        mockContext
      )
      expect(result.success).toBe(true)
      expect(result.key).toBeDefined()
      // Get returns masked
      expect('keyLast4' in result.key!).toBe(true)
    })

    it('should fail get without keyId', async () => {
      const result = await executeApiKeyManage({ action: 'get', expiresIn: '90d' }, mockContext)
      expect(result.success).toBe(false)
      expect(result.error).toContain('keyId is required')
    })

    it('should fail get for nonexistent key', async () => {
      const result = await executeApiKeyManage(
        { action: 'get', keyId: 'key_999', expiresIn: '90d' },
        mockContext
      )
      expect(result.success).toBe(false)
      expect(result.error).toContain('not found')
    })

    it('should revoke a key', async () => {
      const createResult = await executeApiKeyManage(
        { action: 'create', name: 'revokable', expiresIn: '90d' },
        mockContext
      )
      const keyId = (createResult.key as { id: string }).id

      const result = await executeApiKeyManage(
        { action: 'revoke', keyId, expiresIn: '90d' },
        mockContext
      )
      expect(result.success).toBe(true)
      expect(result.message).toContain('revoked')
    })

    it('should fail revoke without keyId', async () => {
      const result = await executeApiKeyManage({ action: 'revoke', expiresIn: '90d' }, mockContext)
      expect(result.success).toBe(false)
      expect(result.error).toContain('keyId is required')
    })

    it('should fail double revoke', async () => {
      const createResult = await executeApiKeyManage(
        { action: 'create', name: 'double-revoke', expiresIn: '90d' },
        mockContext
      )
      const keyId = (createResult.key as { id: string }).id

      await executeApiKeyManage({ action: 'revoke', keyId, expiresIn: '90d' }, mockContext)
      const result = await executeApiKeyManage(
        { action: 'revoke', keyId, expiresIn: '90d' },
        mockContext
      )
      expect(result.success).toBe(false)
      expect(result.error).toContain('already revoked')
    })
  })
})
