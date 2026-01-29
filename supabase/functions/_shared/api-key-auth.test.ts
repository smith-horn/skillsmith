/**
 * API Key Authentication Tests
 * @module _shared/api-key-auth.test
 *
 * SMI-1872: Unit tests for API key authentication module
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock Deno global before imports
vi.stubGlobal('Deno', {
  env: {
    get: vi.fn(),
  },
})

// Mock dependencies with factory functions
vi.mock('./supabase.ts', () => ({
  createSupabaseAdminClient: vi.fn(() => ({
    rpc: vi.fn(),
  })),
}))

vi.mock('./license.ts', () => ({
  hashLicenseKey: vi.fn(async (key: string) => `hashed_${key}`),
  isValidKeyFormat: vi.fn((key: string) => key.startsWith('sk_live_')),
}))

import { extractApiKey, authenticateRequest, getRateLimitForTier } from './api-key-auth.ts'
import { createSupabaseAdminClient } from './supabase.ts'

describe('extractApiKey', () => {
  describe('X-API-Key header', () => {
    it('should extract valid API key from X-API-Key header', () => {
      const req = new Request('https://example.com', {
        headers: { 'X-API-Key': 'sk_live_test123' },
      })

      const result = extractApiKey(req)

      expect(result).toBe('sk_live_test123')
    })

    it('should extract API key from lowercase x-api-key header', () => {
      const req = new Request('https://example.com', {
        headers: { 'x-api-key': 'sk_live_lowercase' },
      })

      const result = extractApiKey(req)

      expect(result).toBe('sk_live_lowercase')
    })

    it('should return null for invalid key format in X-API-Key', () => {
      const req = new Request('https://example.com', {
        headers: { 'X-API-Key': 'invalid_key' },
      })

      const result = extractApiKey(req)

      expect(result).toBeNull()
    })
  })

  describe('Bearer token', () => {
    it('should extract valid API key from Bearer token', () => {
      const req = new Request('https://example.com', {
        headers: { Authorization: 'Bearer sk_live_bearer123' },
      })

      const result = extractApiKey(req)

      expect(result).toBe('sk_live_bearer123')
    })

    it('should return null for Bearer token without sk_live_ prefix', () => {
      const req = new Request('https://example.com', {
        headers: { Authorization: 'Bearer some_other_token' },
      })

      const result = extractApiKey(req)

      expect(result).toBeNull()
    })
  })

  // SMI-1875: Malformed Bearer token tests
  describe('malformed Bearer tokens', () => {
    it('should return null for Bearer without key', () => {
      const req = new Request('https://example.com', {
        headers: { Authorization: 'Bearer' },
      })

      const result = extractApiKey(req)

      expect(result).toBeNull()
    })

    it('should return null for Bearer with only space', () => {
      const req = new Request('https://example.com', {
        headers: { Authorization: 'Bearer ' },
      })

      const result = extractApiKey(req)

      expect(result).toBeNull()
    })

    it('should return null for Bearer with whitespace key', () => {
      const req = new Request('https://example.com', {
        headers: { Authorization: 'Bearer   ' },
      })

      const result = extractApiKey(req)

      expect(result).toBeNull()
    })
  })

  describe('no API key', () => {
    it('should return null when no headers present', () => {
      const req = new Request('https://example.com')

      const result = extractApiKey(req)

      expect(result).toBeNull()
    })

    it('should return null for empty X-API-Key', () => {
      const req = new Request('https://example.com', {
        headers: { 'X-API-Key': '' },
      })

      const result = extractApiKey(req)

      expect(result).toBeNull()
    })
  })

  describe('header priority', () => {
    it('should prefer X-API-Key over Bearer token', () => {
      const req = new Request('https://example.com', {
        headers: {
          'X-API-Key': 'sk_live_xapikey',
          Authorization: 'Bearer sk_live_bearer',
        },
      })

      const result = extractApiKey(req)

      expect(result).toBe('sk_live_xapikey')
    })
  })
})

describe('authenticateRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should return unauthenticated when no API key present', async () => {
    const req = new Request('https://example.com')

    const result = await authenticateRequest(req)

    expect(result).toEqual({ authenticated: false })
  })

  // SMI-1950: Anon key authentication tests
  describe('Supabase anon key authentication', () => {
    const ANON_KEY =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZyY256cG1uZHRyb3F4eG9xa3p5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc4MzgwNzQsImV4cCI6MjA4MzQxNDA3NH0.WNK5jaNG3twxApOva5A1ZlCaZb5hVqBYtNJezRrR4t8'

    it('should return community-tier authenticated for anon key', async () => {
      const req = new Request('https://example.com', {
        headers: { Authorization: `Bearer ${ANON_KEY}` },
      })

      const result = await authenticateRequest(req)

      expect(result.authenticated).toBe(true)
      expect(result.tier).toBe('community')
      expect(result.rateLimit).toBe(30)
      expect(result.keyPrefix).toBe('anon_key')
    })

    it('should return unauthenticated for non-matching JWT', async () => {
      const req = new Request('https://example.com', {
        headers: { Authorization: 'Bearer eyJsomeotherinvalidjwt' },
      })

      const result = await authenticateRequest(req)

      expect(result.authenticated).toBe(false)
    })

    it('should prefer sk_live_ API key over anon key', async () => {
      const mockRpc = vi.fn().mockResolvedValue({
        data: [
          {
            is_valid: true,
            tier: 'team',
            rate_limit: 120,
            user_id: 'user-123',
          },
        ],
        error: null,
      })
      vi.mocked(createSupabaseAdminClient).mockReturnValue({
        rpc: mockRpc,
      } as ReturnType<typeof createSupabaseAdminClient>)

      const req = new Request('https://example.com', {
        headers: {
          'X-API-Key': 'sk_live_valid',
          Authorization: `Bearer ${ANON_KEY}`,
        },
      })

      const result = await authenticateRequest(req)

      // Should use the sk_live_ key, not the anon key
      expect(result.tier).toBe('team')
      expect(result.rateLimit).toBe(120)
    })
  })

  it('should return authenticated with tier info for valid key', async () => {
    const mockRpc = vi.fn().mockResolvedValue({
      data: [
        {
          is_valid: true,
          tier: 'team',
          rate_limit: 120,
          user_id: 'user-123',
        },
      ],
      error: null,
    })
    vi.mocked(createSupabaseAdminClient).mockReturnValue({
      rpc: mockRpc,
    } as ReturnType<typeof createSupabaseAdminClient>)

    const req = new Request('https://example.com', {
      headers: { 'X-API-Key': 'sk_live_valid' },
    })

    const result = await authenticateRequest(req)

    expect(result.authenticated).toBe(true)
    expect(result.tier).toBe('team')
    expect(result.rateLimit).toBe(120)
    expect(result.userId).toBe('user-123')
    // Hash is "hashed_sk_live_valid" (20 chars), first 16 = "hashed_sk_live_v"
    expect(result.keyPrefix).toBe('hashed_sk_live_v')
  })

  it('should return unauthenticated for invalid key', async () => {
    const mockRpc = vi.fn().mockResolvedValue({
      data: [{ is_valid: false }],
      error: null,
    })
    vi.mocked(createSupabaseAdminClient).mockReturnValue({
      rpc: mockRpc,
    } as ReturnType<typeof createSupabaseAdminClient>)

    const req = new Request('https://example.com', {
      headers: { 'X-API-Key': 'sk_live_invalid' },
    })

    const result = await authenticateRequest(req)

    expect(result.authenticated).toBe(false)
  })

  it('should return unauthenticated on RPC error', async () => {
    const mockRpc = vi.fn().mockResolvedValue({
      data: null,
      error: { message: 'Database error' },
    })
    vi.mocked(createSupabaseAdminClient).mockReturnValue({
      rpc: mockRpc,
    } as ReturnType<typeof createSupabaseAdminClient>)

    const req = new Request('https://example.com', {
      headers: { 'X-API-Key': 'sk_live_error' },
    })

    const result = await authenticateRequest(req)

    expect(result.authenticated).toBe(false)
  })

  it('should return unauthenticated on exception', async () => {
    vi.mocked(createSupabaseAdminClient).mockImplementation(() => {
      throw new Error('Connection failed')
    })

    const req = new Request('https://example.com', {
      headers: { 'X-API-Key': 'sk_live_exception' },
    })

    const result = await authenticateRequest(req)

    expect(result.authenticated).toBe(false)
  })

  it('should return unauthenticated when no data returned', async () => {
    const mockRpc = vi.fn().mockResolvedValue({
      data: [],
      error: null,
    })
    vi.mocked(createSupabaseAdminClient).mockReturnValue({
      rpc: mockRpc,
    } as ReturnType<typeof createSupabaseAdminClient>)

    const req = new Request('https://example.com', {
      headers: { 'X-API-Key': 'sk_live_nodata' },
    })

    const result = await authenticateRequest(req)

    expect(result.authenticated).toBe(false)
  })
})

describe('getRateLimitForTier', () => {
  it('should return 300 for enterprise tier', () => {
    expect(getRateLimitForTier('enterprise')).toBe(300)
  })

  it('should return 120 for team tier', () => {
    expect(getRateLimitForTier('team')).toBe(120)
  })

  it('should return 60 for individual tier', () => {
    expect(getRateLimitForTier('individual')).toBe(60)
  })

  it('should return 30 for community tier', () => {
    expect(getRateLimitForTier('community')).toBe(30)
  })

  it('should return 30 for unknown tier', () => {
    expect(getRateLimitForTier('unknown')).toBe(30)
  })
})
