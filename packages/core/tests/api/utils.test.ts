/**
 * SMI-1948: API Utils Tests
 *
 * Tests for API utility functions including DEFAULT_BASE_URL configuration.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

describe('API Utils', () => {
  describe('DEFAULT_BASE_URL', () => {
    const originalEnv = process.env

    beforeEach(() => {
      // Reset module cache to re-evaluate DEFAULT_BASE_URL
      vi.resetModules()
      process.env = { ...originalEnv }
    })

    afterEach(() => {
      process.env = originalEnv
    })

    it('should never be undefined - always has production fallback', async () => {
      // Clear all URL-related env vars to simulate user environment
      delete process.env.SKILLSMITH_API_URL
      delete process.env.SUPABASE_URL

      const { DEFAULT_BASE_URL } = await import('../../src/api/utils.js')

      expect(DEFAULT_BASE_URL).toBeDefined()
      expect(DEFAULT_BASE_URL).not.toBe('')
      expect(DEFAULT_BASE_URL).toBe('https://api.skillsmith.app/functions/v1')
    })

    it('should use SKILLSMITH_API_URL if provided', async () => {
      process.env.SKILLSMITH_API_URL = 'https://custom.api.example.com'
      delete process.env.SUPABASE_URL

      const { DEFAULT_BASE_URL } = await import('../../src/api/utils.js')

      expect(DEFAULT_BASE_URL).toBe('https://custom.api.example.com')
    })

    it('should use SUPABASE_URL for local development', async () => {
      delete process.env.SKILLSMITH_API_URL
      process.env.SUPABASE_URL = 'http://localhost:54321'

      const { DEFAULT_BASE_URL } = await import('../../src/api/utils.js')

      expect(DEFAULT_BASE_URL).toBe('http://localhost:54321/functions/v1')
    })

    it('should prefer SKILLSMITH_API_URL over SUPABASE_URL', async () => {
      process.env.SKILLSMITH_API_URL = 'https://custom.api.example.com'
      process.env.SUPABASE_URL = 'http://localhost:54321'

      const { DEFAULT_BASE_URL } = await import('../../src/api/utils.js')

      expect(DEFAULT_BASE_URL).toBe('https://custom.api.example.com')
    })

    it('should treat empty SKILLSMITH_API_URL as not set', async () => {
      process.env.SKILLSMITH_API_URL = ''
      delete process.env.SUPABASE_URL

      const { DEFAULT_BASE_URL } = await import('../../src/api/utils.js')

      // Empty string is falsy, should fall through to production URL
      expect(DEFAULT_BASE_URL).toBe('https://api.skillsmith.app/functions/v1')
    })

    it('should treat empty SUPABASE_URL as not set', async () => {
      delete process.env.SKILLSMITH_API_URL
      process.env.SUPABASE_URL = ''

      const { DEFAULT_BASE_URL } = await import('../../src/api/utils.js')

      // Empty string is falsy, should fall through to production URL
      expect(DEFAULT_BASE_URL).toBe('https://api.skillsmith.app/functions/v1')
    })
  })

  describe('PRODUCTION_API_URL', () => {
    it('should be the correct production URL', async () => {
      const { PRODUCTION_API_URL } = await import('../../src/api/utils.js')

      expect(PRODUCTION_API_URL).toBe('https://api.skillsmith.app/functions/v1')
    })
  })

  describe('calculateBackoff', () => {
    it('should calculate exponential backoff', async () => {
      const { calculateBackoff } = await import('../../src/api/utils.js')

      // First attempt: ~1000ms
      const delay0 = calculateBackoff(0, 1000)
      expect(delay0).toBeGreaterThanOrEqual(1000)
      expect(delay0).toBeLessThanOrEqual(1300) // Max 30% jitter

      // Second attempt: ~2000ms
      const delay1 = calculateBackoff(1, 1000)
      expect(delay1).toBeGreaterThanOrEqual(2000)
      expect(delay1).toBeLessThanOrEqual(2600)
    })

    it('should cap at 30 seconds', async () => {
      const { calculateBackoff } = await import('../../src/api/utils.js')

      const delay = calculateBackoff(10, 1000) // Would be 1024000ms without cap
      expect(delay).toBeLessThanOrEqual(30000)
    })
  })

  describe('generateAnonymousId', () => {
    it('should generate valid UUID format', async () => {
      const { generateAnonymousId } = await import('../../src/api/utils.js')

      const id = generateAnonymousId()

      // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    })

    it('should generate unique IDs', async () => {
      const { generateAnonymousId } = await import('../../src/api/utils.js')

      const ids = new Set<string>()
      for (let i = 0; i < 100; i++) {
        ids.add(generateAnonymousId())
      }

      expect(ids.size).toBe(100)
    })
  })

  describe('buildRequestHeaders', () => {
    it('should include content type and request ID', async () => {
      const { buildRequestHeaders } = await import('../../src/api/utils.js')

      const headers = buildRequestHeaders()

      expect(headers['Content-Type']).toBe('application/json')
      expect(headers['x-request-id']).toMatch(/^client-\d+-[a-z0-9]+$/)
    })

    it('should include auth headers when anonKey provided', async () => {
      const { buildRequestHeaders } = await import('../../src/api/utils.js')

      const headers = buildRequestHeaders('test-anon-key')

      expect(headers['Authorization']).toBe('Bearer test-anon-key')
      expect(headers['apikey']).toBe('test-anon-key')
    })

    it('should not include auth headers when anonKey not provided', async () => {
      const { buildRequestHeaders } = await import('../../src/api/utils.js')

      const headers = buildRequestHeaders()

      expect(headers['Authorization']).toBeUndefined()
      expect(headers['apikey']).toBeUndefined()
    })
  })
})
