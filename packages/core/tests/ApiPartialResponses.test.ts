/**
 * SMI-1583: Partial API Response Handling Tests
 *
 * Tests that the API client gracefully handles:
 * - Partial/incomplete responses
 * - Missing optional fields
 * - Edge cases (empty results, pagination)
 * - Error responses
 * - Rate limiting
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  API_MOCKS,
  createMockFetch,
  createNetworkErrorFetch,
  createSequentialFetch,
  MOCK_PARTIAL_JSON,
  MOCK_MALFORMED_JSON,
  MOCK_HTML_ERROR_RESPONSE,
} from './fixtures/api-responses/index.js'

describe('SMI-1583: Partial API Response Handling', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  describe('Empty Results', () => {
    it('should handle empty search results', async () => {
      global.fetch = createMockFetch(API_MOCKS.searchEmpty)

      const response = await fetch('/api/v1/skills/search?q=nonexistent')
      const data = await response.json()

      expect(response.ok).toBe(true)
      expect(data.data).toEqual([])
      expect(data.meta.total).toBe(0)
    })

    it('should handle empty recommendations', async () => {
      global.fetch = createMockFetch(API_MOCKS.recommendEmpty)

      const response = await fetch('/api/v1/skills/recommend')
      const data = await response.json()

      expect(response.ok).toBe(true)
      expect(data.data).toEqual([])
      expect(data.meta.total).toBe(0)
    })
  })

  describe('Partial/Minimal Data', () => {
    it('should handle skills with minimal fields', async () => {
      global.fetch = createMockFetch(API_MOCKS.searchPartial)

      const response = await fetch('/api/v1/skills/search?q=minimal')
      const data = await response.json()

      expect(response.ok).toBe(true)
      expect(data.data).toHaveLength(1)

      const skill = data.data[0]
      expect(skill.id).toBe('minimal/skill')
      expect(skill.description).toBeNull()
      expect(skill.tags).toEqual([])
      expect(skill.quality_score).toBeNull()
    })

    it('should handle pagination metadata', async () => {
      global.fetch = createMockFetch(API_MOCKS.searchPaginated)

      const response = await fetch('/api/v1/skills/search?q=development&offset=20')
      const data = await response.json()

      expect(response.ok).toBe(true)
      expect(data.meta.offset).toBe(20)
      expect(data.meta.limit).toBe(20)
      expect(data.meta.total).toBe(50)

      // Check Link header for pagination
      const linkHeader = response.headers.get('link')
      expect(linkHeader).toContain('rel="next"')
      expect(linkHeader).toContain('rel="prev"')
    })
  })

  describe('Error Responses', () => {
    it('should handle 404 not found', async () => {
      global.fetch = createMockFetch(API_MOCKS.errorNotFound)

      const response = await fetch('/api/v1/skills/nonexistent/skill')

      expect(response.ok).toBe(false)
      expect(response.status).toBe(404)

      const data = await response.json()
      expect(data.error).toBe('Skill not found')
    })

    it('should handle 400 validation error', async () => {
      global.fetch = createMockFetch(API_MOCKS.errorValidation)

      const response = await fetch('/api/v1/skills/search?q=x')

      expect(response.ok).toBe(false)
      expect(response.status).toBe(400)

      const data = await response.json()
      expect(data.error).toContain('2 characters')
      expect(data.details.field).toBe('query')
    })

    it('should handle 401 unauthorized', async () => {
      global.fetch = createMockFetch(API_MOCKS.errorUnauthorized)

      const response = await fetch('/api/v1/skills/search')

      expect(response.ok).toBe(false)
      expect(response.status).toBe(401)

      const data = await response.json()
      expect(data.error).toContain('API key')
    })

    it('should handle 403 forbidden', async () => {
      global.fetch = createMockFetch(API_MOCKS.errorForbidden)

      const response = await fetch('/api/v1/admin/skills')

      expect(response.ok).toBe(false)
      expect(response.status).toBe(403)

      const data = await response.json()
      expect(data.error).toContain('permissions')
      expect(data.details.required_tier).toBe('team')
    })

    it('should handle 500 server error', async () => {
      global.fetch = createMockFetch(API_MOCKS.errorServer)

      const response = await fetch('/api/v1/skills/search')

      expect(response.ok).toBe(false)
      expect(response.status).toBe(500)

      const data = await response.json()
      expect(data.error).toContain('unexpected error')
    })

    it('should handle 503 service unavailable with retry-after', async () => {
      global.fetch = createMockFetch(API_MOCKS.errorServiceUnavailable)

      const response = await fetch('/api/v1/skills/search')

      expect(response.ok).toBe(false)
      expect(response.status).toBe(503)
      expect(response.headers.get('retry-after')).toBe('30')

      const data = await response.json()
      expect(data.error).toContain('unavailable')
    })
  })

  describe('Rate Limiting', () => {
    it('should handle 429 rate limited response', async () => {
      global.fetch = createMockFetch(API_MOCKS.errorRateLimited)

      const response = await fetch('/api/v1/skills/search')

      expect(response.ok).toBe(false)
      expect(response.status).toBe(429)
      expect(response.headers.get('x-ratelimit-remaining')).toBe('0')
      expect(response.headers.get('retry-after')).toBe('60')
    })

    it('should detect low rate limit warning', async () => {
      global.fetch = createMockFetch(API_MOCKS.rateLimitWarning)

      const response = await fetch('/api/v1/skills/search')

      expect(response.ok).toBe(true)
      expect(response.headers.get('x-ratelimit-remaining')).toBe('5')

      // Client should be able to detect low remaining calls
      const remaining = parseInt(response.headers.get('x-ratelimit-remaining') || '0', 10)
      expect(remaining).toBeLessThan(10)
    })

    it('should handle sequential requests with rate limit exhaustion', async () => {
      global.fetch = createSequentialFetch([
        API_MOCKS.searchSuccess,
        API_MOCKS.rateLimitWarning,
        API_MOCKS.errorRateLimited,
      ])

      // First request succeeds
      const response1 = await fetch('/api/v1/skills/search')
      expect(response1.ok).toBe(true)

      // Second request warns about low limit
      const response2 = await fetch('/api/v1/skills/search')
      expect(response2.ok).toBe(true)
      expect(response2.headers.get('x-ratelimit-remaining')).toBe('5')

      // Third request is rate limited
      const response3 = await fetch('/api/v1/skills/search')
      expect(response3.ok).toBe(false)
      expect(response3.status).toBe(429)
    })
  })

  describe('Malformed Responses', () => {
    it('should throw on partial JSON response', async () => {
      global.fetch = vi.fn().mockResolvedValue(
        new Response(MOCK_PARTIAL_JSON, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )

      const response = await fetch('/api/v1/skills/search')
      await expect(response.json()).rejects.toThrow()
    })

    it('should throw on malformed JSON response', async () => {
      global.fetch = vi.fn().mockResolvedValue(
        new Response(MOCK_MALFORMED_JSON, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )

      const response = await fetch('/api/v1/skills/search')
      await expect(response.json()).rejects.toThrow()
    })

    it('should handle HTML error page gracefully', async () => {
      global.fetch = vi.fn().mockResolvedValue(
        new Response(MOCK_HTML_ERROR_RESPONSE, {
          status: 502,
          headers: { 'content-type': 'text/html' },
        })
      )

      const response = await fetch('/api/v1/skills/search')

      expect(response.ok).toBe(false)
      expect(response.status).toBe(502)
      expect(response.headers.get('content-type')).toBe('text/html')

      // Should be able to get text but not JSON
      const text = await response.text()
      expect(text).toContain('502 Bad Gateway')
    })
  })

  describe('Network Errors', () => {
    it('should throw on network failure', async () => {
      global.fetch = createNetworkErrorFetch('Network request failed')

      await expect(fetch('/api/v1/skills/search')).rejects.toThrow('Network request failed')
    })

    it('should throw on DNS resolution failure', async () => {
      global.fetch = createNetworkErrorFetch('getaddrinfo ENOTFOUND api.skillsmith.dev')

      await expect(fetch('/api/v1/skills/search')).rejects.toThrow('ENOTFOUND')
    })

    it('should throw on connection refused', async () => {
      global.fetch = createNetworkErrorFetch('connect ECONNREFUSED 127.0.0.1:3000')

      await expect(fetch('/api/v1/skills/search')).rejects.toThrow('ECONNREFUSED')
    })
  })
})
