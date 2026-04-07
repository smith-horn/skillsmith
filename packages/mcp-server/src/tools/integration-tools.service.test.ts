/**
 * @fileoverview Tests for real IntegrationService (Supabase-backed)
 * @see SMI-3915: Wave 1 — Webhooks + API Keys (Real Implementation)
 *
 * All tests mock the Supabase client — no real database needed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHmac } from 'node:crypto'
import {
  createRealIntegrationService,
  hashApiKey,
  computeHmacSignature,
  type SupabaseClient,
} from './integration-tools.service.js'

// ============================================================================
// Supabase mock factory
// ============================================================================

function createMockChain(resolvedValue: { data: unknown; error: unknown }) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {}
  const handler = () => chain

  chain.insert = vi.fn().mockReturnValue(chain)
  chain.update = vi.fn().mockReturnValue(chain)
  chain.delete = vi.fn().mockReturnValue(chain)
  chain.select = vi.fn().mockReturnValue(chain)
  chain.eq = vi.fn().mockReturnValue(chain)
  chain.is = vi.fn().mockReturnValue(chain)
  chain.order = vi.fn().mockReturnValue(chain)
  chain.single = vi.fn().mockResolvedValue(resolvedValue)

  // Make the chain itself thenable for non-.single() queries (list, delete)
  chain.then = vi.fn().mockImplementation((resolve: (v: unknown) => void) => {
    resolve(resolvedValue)
    return Promise.resolve(resolvedValue)
  })

  return { chain, handler }
}

function createMockSupabase(
  resolvedValue: { data: unknown; error: unknown } = { data: null, error: null }
): { supabase: SupabaseClient; chain: Record<string, ReturnType<typeof vi.fn>> } {
  const { chain } = createMockChain(resolvedValue)
  const supabase = {
    from: vi.fn().mockReturnValue(chain),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  } as unknown as SupabaseClient
  return { supabase, chain }
}

const TEAM_ID = 'team-001'

// ============================================================================
// Crypto helper tests
// ============================================================================

describe('hashApiKey', () => {
  it('should produce a deterministic SHA-256 HMAC hex hash', () => {
    const key = 'sk_int_testkey123'
    const hash = hashApiKey(key)

    // Verify it matches raw crypto
    const expected = createHmac('sha256', 'skillsmith-api-key').update(key).digest('hex')
    expect(hash).toBe(expected)
    expect(hash).toHaveLength(64)
  })

  it('should produce different hashes for different keys', () => {
    expect(hashApiKey('key-a')).not.toBe(hashApiKey('key-b'))
  })
})

describe('computeHmacSignature', () => {
  it('should produce correct HMAC-SHA256 signature', () => {
    const secret = 'whsec_abc123'
    const payload = '{"event":"test"}'
    const sig = computeHmacSignature(secret, payload)

    const expected = createHmac('sha256', secret).update(payload).digest('hex')
    expect(sig).toBe(expected)
  })
})

// ============================================================================
// createWebhook
// ============================================================================

describe('createRealIntegrationService', () => {
  describe('createWebhook', () => {
    it('should create a webhook and return signing secret', async () => {
      const row = {
        id: 'wh-uuid-1',
        url: 'https://example.com/hook',
        events: ['skill.install'],
        description: 'test',
        signing_secret: 'whsec_placeholder',
        status: 'active',
        created_at: '2026-04-06T00:00:00Z',
        last_delivery_at: null,
      }
      const { supabase } = createMockSupabase({ data: row, error: null })
      const svc = createRealIntegrationService(supabase, TEAM_ID)

      const wh = await svc.createWebhook('https://example.com/hook', ['skill.install'], 'test')

      expect(wh.id).toBe('wh-uuid-1')
      expect(wh.signingSecret).toMatch(/^whsec_[a-f0-9]{64}$/)
      expect(wh.status).toBe('active')
      expect(supabase.from).toHaveBeenCalledWith('webhook_endpoints')
    })

    it('should reject private IP URLs (SSRF)', async () => {
      const { supabase } = createMockSupabase()
      const svc = createRealIntegrationService(supabase, TEAM_ID)

      await expect(
        svc.createWebhook('https://192.168.1.1/hook', ['skill.install'])
      ).rejects.toThrow('Invalid webhook URL')
    })

    it('should reject HTTP URLs', async () => {
      const { supabase } = createMockSupabase()
      const svc = createRealIntegrationService(supabase, TEAM_ID)

      await expect(svc.createWebhook('http://example.com/hook', ['skill.install'])).rejects.toThrow(
        'Invalid webhook URL'
      )
    })

    it('should throw on Supabase error', async () => {
      const { supabase } = createMockSupabase({
        data: null,
        error: { message: 'unique violation' },
      })
      const svc = createRealIntegrationService(supabase, TEAM_ID)

      await expect(
        svc.createWebhook('https://example.com/hook', ['skill.install'])
      ).rejects.toThrow('Failed to create webhook')
    })
  })

  // ==========================================================================
  // listWebhooks
  // ==========================================================================

  describe('listWebhooks', () => {
    it('should return masked webhooks', async () => {
      const rows = [
        {
          id: 'wh-1',
          url: 'https://a.com/hook',
          events: ['skill.install'],
          description: null,
          signing_secret: 'whsec_abcdef1234567890',
          status: 'active',
          created_at: '2026-04-06T00:00:00Z',
          last_delivery_at: null,
        },
      ]
      const { supabase } = createMockSupabase({ data: rows, error: null })
      const svc = createRealIntegrationService(supabase, TEAM_ID)

      const list = await svc.listWebhooks()

      expect(list).toHaveLength(1)
      expect(list[0].signingSecretLast4).toBe('7890')
      // Ensure raw secret is NOT in the masked object
      expect('signingSecret' in list[0]).toBe(false)
    })
  })

  // ==========================================================================
  // getWebhook
  // ==========================================================================

  describe('getWebhook', () => {
    it('should return null for nonexistent webhook', async () => {
      const { supabase } = createMockSupabase({ data: null, error: { message: 'not found' } })
      const svc = createRealIntegrationService(supabase, TEAM_ID)

      const result = await svc.getWebhook('wh-nonexistent')
      expect(result).toBeNull()
    })
  })

  // ==========================================================================
  // deleteWebhook
  // ==========================================================================

  describe('deleteWebhook', () => {
    it('should return true on successful delete', async () => {
      const { supabase } = createMockSupabase({ data: null, error: null })
      const svc = createRealIntegrationService(supabase, TEAM_ID)

      const result = await svc.deleteWebhook('wh-1')
      expect(result).toBe(true)
    })
  })

  // ==========================================================================
  // testWebhook
  // ==========================================================================

  describe('testWebhook', () => {
    beforeEach(() => {
      vi.restoreAllMocks()
    })

    it('should rate limit test deliveries', async () => {
      const row = {
        id: 'wh-1',
        url: 'https://example.com/hook',
        events: ['skill.install'],
        signing_secret: 'whsec_secret',
        status: 'active',
        created_at: '2026-04-06T00:00:00Z',
        last_delivery_at: null,
      }
      const { supabase } = createMockSupabase({ data: row, error: null })
      const svc = createRealIntegrationService(supabase, TEAM_ID)

      // Mock global fetch
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 })
      vi.stubGlobal('fetch', mockFetch)

      // First call succeeds
      const first = await svc.testWebhook('wh-1')
      expect(first.success).toBe(true)
      expect(first.statusCode).toBe(200)

      // Second call within 1 minute is rate limited
      const second = await svc.testWebhook('wh-1')
      expect(second.success).toBe(false)
      expect(second.message).toContain('Rate limited')

      vi.unstubAllGlobals()
    })

    it('should include HMAC signature header in delivery', async () => {
      const row = {
        id: 'wh-1',
        url: 'https://example.com/hook',
        events: ['skill.install'],
        signing_secret: 'whsec_testsecret',
        status: 'active',
        created_at: '2026-04-06T00:00:00Z',
        last_delivery_at: null,
      }
      const { supabase } = createMockSupabase({ data: row, error: null })
      const svc = createRealIntegrationService(supabase, TEAM_ID)

      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 })
      vi.stubGlobal('fetch', mockFetch)

      await svc.testWebhook('wh-1')

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const [, fetchOptions] = mockFetch.mock.calls[0]
      expect(fetchOptions.headers['X-Skillsmith-Signature']).toMatch(/^sha256=[a-f0-9]{64}$/)
      expect(fetchOptions.headers['X-Skillsmith-Timestamp']).toBeTruthy()
      expect(fetchOptions.headers['Content-Type']).toBe('application/json')

      vi.unstubAllGlobals()
    })

    it('should return failure on fetch error', async () => {
      const row = {
        id: 'wh-2',
        url: 'https://example.com/hook',
        events: ['skill.install'],
        signing_secret: 'whsec_s',
        status: 'active',
        created_at: '2026-04-06T00:00:00Z',
        last_delivery_at: null,
      }
      const { supabase } = createMockSupabase({ data: row, error: null })
      const svc = createRealIntegrationService(supabase, TEAM_ID)

      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Connection refused')))

      const result = await svc.testWebhook('wh-2')
      expect(result.success).toBe(false)
      expect(result.message).toContain('Connection refused')

      vi.unstubAllGlobals()
    })

    it('should block SSRF on stored URL', async () => {
      const row = {
        id: 'wh-3',
        url: 'https://10.0.0.1/hook',
        events: ['skill.install'],
        signing_secret: 'whsec_s',
        status: 'active',
        created_at: '2026-04-06T00:00:00Z',
        last_delivery_at: null,
      }
      const { supabase } = createMockSupabase({ data: row, error: null })
      const svc = createRealIntegrationService(supabase, TEAM_ID)

      const result = await svc.testWebhook('wh-3')
      expect(result.success).toBe(false)
      expect(result.message).toContain('URL blocked')
    })

    it('should return not found when webhook missing', async () => {
      const { supabase } = createMockSupabase({ data: null, error: { message: 'not found' } })
      const svc = createRealIntegrationService(supabase, TEAM_ID)

      const result = await svc.testWebhook('wh-missing')
      expect(result.success).toBe(false)
      expect(result.message).toContain('not found')
    })
  })

  // ==========================================================================
  // rotateSecret
  // ==========================================================================

  describe('rotateSecret', () => {
    it('should generate a new whsec_ secret', async () => {
      const { supabase } = createMockSupabase({ data: null, error: null })
      const svc = createRealIntegrationService(supabase, TEAM_ID)

      const result = await svc.rotateSecret('wh-1')
      expect(result.webhookId).toBe('wh-1')
      expect(result.newSigningSecret).toMatch(/^whsec_[a-f0-9]{64}$/)
    })

    it('should throw when Supabase returns error', async () => {
      const { supabase } = createMockSupabase({
        data: null,
        error: { message: 'row not found' },
      })
      const svc = createRealIntegrationService(supabase, TEAM_ID)

      await expect(svc.rotateSecret('wh-missing')).rejects.toThrow('not found')
    })
  })

  // ==========================================================================
  // createApiKey
  // ==========================================================================

  describe('createApiKey', () => {
    it('should create a key with hashed storage and return raw value', async () => {
      const row = {
        id: 'key-uuid-1',
        name: 'ci-key',
        key_hash: 'placeholder',
        key_prefix: 'sk_int_abcdefg',
        permissions: ['read', 'write'],
        expires_at: '2026-07-06T00:00:00Z',
        created_at: '2026-04-06T00:00:00Z',
        revoked_at: null,
      }
      const { supabase, chain } = createMockSupabase({ data: row, error: null })
      const svc = createRealIntegrationService(supabase, TEAM_ID)

      const key = await svc.createApiKey('ci-key', ['read', 'write'], '90d')

      expect(key.id).toBe('key-uuid-1')
      expect(key.keyValue).toMatch(/^sk_int_/)
      expect(key.keyPrefix).toHaveLength(15)
      expect(key.permissions).toEqual(['read', 'write'])

      // Verify the hash passed to Supabase matches the raw key
      const insertCall = chain.insert.mock.calls[0][0] as Record<string, unknown>
      const expectedHash = hashApiKey(key.keyValue)
      expect(insertCall.key_hash).toBe(expectedHash)
    })

    it('should default permissions to read', async () => {
      const row = {
        id: 'key-uuid-2',
        name: 'ro-key',
        key_hash: 'h',
        key_prefix: 'sk_int_abcdefg',
        permissions: ['read'],
        expires_at: null,
        created_at: '2026-04-06T00:00:00Z',
        revoked_at: null,
      }
      const { supabase, chain } = createMockSupabase({ data: row, error: null })
      const svc = createRealIntegrationService(supabase, TEAM_ID)

      await svc.createApiKey('ro-key', undefined, 'never')

      const insertCall = chain.insert.mock.calls[0][0] as Record<string, unknown>
      expect(insertCall.permissions).toEqual(['read'])
      expect(insertCall.expires_at).toBeNull()
    })
  })

  // ==========================================================================
  // listApiKeys
  // ==========================================================================

  describe('listApiKeys', () => {
    it('should return masked keys without raw values', async () => {
      const rows = [
        {
          id: 'key-1',
          name: 'my-key',
          key_hash: 'hash',
          key_prefix: 'sk_int_abcdefgh',
          permissions: ['read'],
          expires_at: null,
          created_at: '2026-04-06T00:00:00Z',
          revoked_at: null,
        },
      ]
      const { supabase } = createMockSupabase({ data: rows, error: null })
      const svc = createRealIntegrationService(supabase, TEAM_ID)

      const keys = await svc.listApiKeys()

      expect(keys).toHaveLength(1)
      expect(keys[0].keyLast4).toBe('efgh')
      expect(keys[0].keyPrefix).toBe('sk_int_abcdefgh')
      expect(keys[0].status).toBe('active')
      expect('keyValue' in keys[0]).toBe(false)
      expect('key_hash' in keys[0]).toBe(false)
    })
  })

  // ==========================================================================
  // revokeApiKey
  // ==========================================================================

  describe('revokeApiKey', () => {
    it('should return true on successful revoke', async () => {
      const { supabase } = createMockSupabase({ data: null, error: null })
      const svc = createRealIntegrationService(supabase, TEAM_ID)

      const result = await svc.revokeApiKey('key-1')
      expect(result).toBe(true)
    })
  })

  // ==========================================================================
  // getApiKey
  // ==========================================================================

  describe('getApiKey', () => {
    it('should return masked key', async () => {
      const row = {
        id: 'key-1',
        name: 'test-key',
        key_prefix: 'sk_int_xyz12345',
        permissions: ['read'],
        expires_at: null,
        created_at: '2026-04-06T00:00:00Z',
        revoked_at: null,
      }
      const { supabase } = createMockSupabase({ data: row, error: null })
      const svc = createRealIntegrationService(supabase, TEAM_ID)

      const key = await svc.getApiKey('key-1')

      expect(key).not.toBeNull()
      expect(key!.keyLast4).toBe('2345')
      expect(key!.status).toBe('active')
    })

    it('should return null for nonexistent key', async () => {
      const { supabase } = createMockSupabase({ data: null, error: { message: 'not found' } })
      const svc = createRealIntegrationService(supabase, TEAM_ID)

      const result = await svc.getApiKey('key-missing')
      expect(result).toBeNull()
    })

    it('should show revoked status', async () => {
      const row = {
        id: 'key-1',
        name: 'revoked-key',
        key_prefix: 'sk_int_xyz12345',
        permissions: ['read'],
        expires_at: null,
        created_at: '2026-04-06T00:00:00Z',
        revoked_at: '2026-04-06T01:00:00Z',
      }
      const { supabase } = createMockSupabase({ data: row, error: null })
      const svc = createRealIntegrationService(supabase, TEAM_ID)

      const key = await svc.getApiKey('key-1')
      expect(key!.status).toBe('revoked')
    })
  })
})
