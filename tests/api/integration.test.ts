/**
 * API Integration Tests for Supabase Edge Functions
 * @module tests/api/integration
 *
 * SMI-1180: API Development - Wave 3
 *
 * These tests verify the Edge Functions against the Supabase API.
 * Run with: npm test -- --grep "API"
 *
 * Prerequisites:
 * - Supabase running locally: supabase start
 * - Functions served: supabase functions serve
 */

import { describe, it, expect } from 'vitest'

// Test configuration
const BASE_URL = process.env.SUPABASE_FUNCTIONS_URL || 'http://localhost:54321/functions/v1'
const ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'

/**
 * Helper to make authenticated requests
 */
async function apiRequest(path: string, options: RequestInit = {}): Promise<Response> {
  const url = `${BASE_URL}${path}`
  return fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${ANON_KEY}`,
      'Content-Type': 'application/json',
      'x-request-id': `test-${Date.now()}`,
      ...options.headers,
    },
  })
}

describe('API Integration Tests', () => {
  // Skip integration tests if Supabase is not available
  const skipIfNoSupabase = process.env.SKIP_INTEGRATION_TESTS === 'true'

  describe.skipIf(skipIfNoSupabase)('GET /skills-search', () => {
    it('should return 400 when no query and no filters provided', async () => {
      const response = await apiRequest('/skills-search')
      expect(response.status).toBe(400)

      const body = await response.json()
      // New behavior: error should mention needing query OR filter
      expect(body.error).toContain('query or')
      expect(body.error.toLowerCase()).toContain('filter')
    })

    it('should accept single character queries', async () => {
      // SMI-XXXX: Minimum query length removed - single char queries now valid
      const response = await apiRequest('/skills-search?query=a')
      expect(response.status).toBe(200)

      const body = await response.json()
      expect(body.data).toBeDefined()
      expect(Array.isArray(body.data)).toBe(true)
    })

    it('should return results for valid query', async () => {
      const response = await apiRequest('/skills-search?query=testing')
      expect(response.status).toBe(200)

      const body = await response.json()
      expect(body.data).toBeDefined()
      expect(Array.isArray(body.data)).toBe(true)
      expect(body.meta).toBeDefined()
      expect(body.meta.query).toBe('testing')
    })

    it('should return 400 for invalid trust_tier', async () => {
      const response = await apiRequest('/skills-search?query=test&trust_tier=invalid')
      expect(response.status).toBe(400)

      const body = await response.json()
      expect(body.error).toContain('Invalid trust_tier')
    })

    it('should filter by trust_tier', async () => {
      const response = await apiRequest('/skills-search?query=test&trust_tier=verified')
      expect(response.status).toBe(200)

      const body = await response.json()
      body.data.forEach((skill: { trust_tier: string }) => {
        expect(skill.trust_tier).toBe('verified')
      })
    })

    it('should include rate limit headers', async () => {
      const response = await apiRequest('/skills-search?query=testing')

      expect(response.headers.get('X-RateLimit-Limit')).toBeDefined()
      expect(response.headers.get('X-RateLimit-Remaining')).toBeDefined()
      expect(response.headers.get('X-RateLimit-Reset')).toBeDefined()
    })

    it('should include CORS headers', async () => {
      const response = await apiRequest('/skills-search?query=testing')

      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    })

    it('should handle OPTIONS for CORS preflight', async () => {
      const response = await fetch(`${BASE_URL}/skills-search`, {
        method: 'OPTIONS',
      })

      expect(response.status).toBe(204)
      expect(response.headers.get('Access-Control-Allow-Methods')).toContain('GET')
    })

    /**
     * SMI-XXXX: Filter-only search tests
     * These tests verify that search works with filters alone (no query required).
     * This is the TDD red phase - tests should FAIL until implementation is complete.
     */
    describe('Filter-only search', () => {
      it('should return skills when filtering by category without query', async () => {
        const response = await apiRequest('/skills-search?category=Security')
        expect(response.status).toBe(200)

        const body = await response.json()
        expect(body.data).toBeDefined()
        expect(Array.isArray(body.data)).toBe(true)
        expect(body.meta.filters.category).toBe('Security')
      })

      it('should return skills when filtering by trust_tier without query', async () => {
        const response = await apiRequest('/skills-search?trust_tier=verified')
        expect(response.status).toBe(200)

        const body = await response.json()
        expect(body.data).toBeDefined()
        expect(Array.isArray(body.data)).toBe(true)
      })

      it('should return skills when filtering by min_score without query', async () => {
        const response = await apiRequest('/skills-search?min_score=80')
        expect(response.status).toBe(200)

        const body = await response.json()
        expect(body.data).toBeDefined()
        expect(Array.isArray(body.data)).toBe(true)
        // All returned skills should have score >= 80
        body.data.forEach((skill: { quality_score?: number }) => {
          if (skill.quality_score !== undefined) {
            expect(skill.quality_score).toBeGreaterThanOrEqual(80)
          }
        })
      })

      it('should return filtered results when query and category provided', async () => {
        const response = await apiRequest('/skills-search?query=test&category=Testing')
        expect(response.status).toBe(200)

        const body = await response.json()
        expect(body.meta.query).toBe('test')
        expect(body.meta.filters.category).toBe('Testing')
      })

      it('should return filtered results when multiple filters provided without query', async () => {
        const response = await apiRequest('/skills-search?category=Testing&trust_tier=verified')
        expect(response.status).toBe(200)

        const body = await response.json()
        expect(body.data).toBeDefined()
        expect(body.meta.filters.category).toBe('Testing')
        expect(body.meta.filters.trust_tier).toBe('verified')
      })
    })
  })

  describe.skipIf(skipIfNoSupabase)('GET /skills-get', () => {
    it('should return 400 when id is missing', async () => {
      const response = await apiRequest('/skills-get')
      expect(response.status).toBe(400)

      const body = await response.json()
      expect(body.error).toContain('Skill ID required')
    })

    it('should return 404 for non-existent skill', async () => {
      const response = await apiRequest('/skills-get?id=non-existent-skill-id')
      expect(response.status).toBe(404)

      const body = await response.json()
      expect(body.error).toContain('not found')
    })

    it('should return skill by ID', async () => {
      // First search for a skill to get a valid ID
      const searchResponse = await apiRequest('/skills-search?query=test&limit=1')
      const searchBody = await searchResponse.json()

      if (searchBody.data && searchBody.data.length > 0) {
        const skillId = searchBody.data[0].id
        const response = await apiRequest(`/skills-get?id=${skillId}`)
        expect(response.status).toBe(200)

        const body = await response.json()
        expect(body.data).toBeDefined()
        expect(body.data.id).toBe(skillId)
      }
    })

    it('should include CORS headers', async () => {
      const response = await apiRequest('/skills-get?id=test')
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    })
  })

  // SMI-5896 Wave 3 Step 2: the two empty/missing-`stack` 400s below are
  // INTENTIONALLY still asserted — the edge function's hard non-empty
  // requirement is unchanged by that wave ("decided contract": defense in
  // depth, not the thing being relaxed). What changed is that CLI `recommend`
  // and MCP `skill_recommend` now detect an empty *derived* stack client-side
  // and never make this call in the first place — see
  // packages/core/src/services/recommend-guard.ts and its callers. The new
  // regression coverage for that guard lives on the CLI/MCP tools themselves
  // (packages/cli/tests/recommend.empty-stack.test.ts,
  // packages/mcp-server/src/__tests__/recommend.empty-stack.test.ts), not here.
  describe.skipIf(skipIfNoSupabase)('POST /skills-recommend', () => {
    it('should return 400 when stack is missing', async () => {
      const response = await apiRequest('/skills-recommend', {
        method: 'POST',
        body: JSON.stringify({}),
      })
      expect(response.status).toBe(400)

      const body = await response.json()
      expect(body.error).toContain('stack is required')
    })

    it('should return 400 when stack is empty', async () => {
      const response = await apiRequest('/skills-recommend', {
        method: 'POST',
        body: JSON.stringify({ stack: [] }),
      })
      expect(response.status).toBe(400)

      const body = await response.json()
      expect(body.error).toContain('non-empty array')
    })

    it('should return 400 when stack contains special characters', async () => {
      const response = await apiRequest('/skills-recommend', {
        method: 'POST',
        body: JSON.stringify({ stack: ['react","name.eq.secret'] }),
      })
      expect(response.status).toBe(400)

      const body = await response.json()
      expect(body.error).toContain('alphanumeric')
    })

    it('should return 400 when stack exceeds 10 items', async () => {
      const response = await apiRequest('/skills-recommend', {
        method: 'POST',
        body: JSON.stringify({
          stack: Array.from({ length: 15 }, (_, i) => `tech${i}`),
        }),
      })
      expect(response.status).toBe(400)

      const body = await response.json()
      expect(body.error).toContain('more than 10')
    })

    it('should return recommendations for valid stack', async () => {
      const response = await apiRequest('/skills-recommend', {
        method: 'POST',
        body: JSON.stringify({
          stack: ['typescript', 'react'],
          project_type: 'web',
        }),
      })
      expect(response.status).toBe(200)

      const body = await response.json()
      expect(body.data).toBeDefined()
      expect(Array.isArray(body.data)).toBe(true)
      expect(body.meta.stack).toEqual(['typescript', 'react'])
    })

    it('should return 400 for invalid project_type', async () => {
      const response = await apiRequest('/skills-recommend', {
        method: 'POST',
        body: JSON.stringify({
          stack: ['react'],
          project_type: 'invalid',
        }),
      })
      expect(response.status).toBe(400)

      const body = await response.json()
      expect(body.error).toContain('Invalid project_type')
    })

    it('should respect limit parameter', async () => {
      const response = await apiRequest('/skills-recommend', {
        method: 'POST',
        body: JSON.stringify({
          stack: ['javascript'],
          limit: 5,
        }),
      })
      expect(response.status).toBe(200)

      const body = await response.json()
      expect(body.data.length).toBeLessThanOrEqual(5)
      expect(body.meta.limit).toBe(5)
    })

    it('should include rate limit headers', async () => {
      const response = await apiRequest('/skills-recommend', {
        method: 'POST',
        body: JSON.stringify({ stack: ['test'] }),
      })

      expect(response.headers.get('X-RateLimit-Limit')).toBeDefined()
    })
  })

  describe.skipIf(skipIfNoSupabase)('POST /events (Telemetry)', () => {
    const validAnonymousId = 'a'.repeat(32)

    it('should return 400 when event is missing', async () => {
      const response = await apiRequest('/events', {
        method: 'POST',
        body: JSON.stringify({
          anonymous_id: validAnonymousId,
        }),
      })
      expect(response.status).toBe(400)

      const body = await response.json()
      expect(body.error).toContain('event is required')
    })

    it('should return 400 for invalid event type', async () => {
      const response = await apiRequest('/events', {
        method: 'POST',
        body: JSON.stringify({
          event: 'invalid_event',
          anonymous_id: validAnonymousId,
        }),
      })
      expect(response.status).toBe(400)

      const body = await response.json()
      expect(body.error).toContain('Invalid event type')
    })

    it('should return 400 when anonymous_id is missing', async () => {
      const response = await apiRequest('/events', {
        method: 'POST',
        body: JSON.stringify({
          event: 'search',
        }),
      })
      expect(response.status).toBe(400)

      const body = await response.json()
      expect(body.error).toContain('anonymous_id is required')
    })

    it('should return 400 for invalid anonymous_id format', async () => {
      const response = await apiRequest('/events', {
        method: 'POST',
        body: JSON.stringify({
          event: 'search',
          anonymous_id: 'too-short',
        }),
      })
      expect(response.status).toBe(400)
    })

    it('should accept valid telemetry event', async () => {
      const response = await apiRequest('/events', {
        method: 'POST',
        body: JSON.stringify({
          event: 'search',
          anonymous_id: validAnonymousId,
          metadata: {
            query: 'testing',
            results_count: 10,
          },
        }),
      })
      expect(response.status).toBe(200)

      const body = await response.json()
      expect(body.ok).toBe(true)
    })

    it('should accept skill_view event with skill_id', async () => {
      const response = await apiRequest('/events', {
        method: 'POST',
        body: JSON.stringify({
          event: 'skill_view',
          skill_id: 'test-skill-id',
          anonymous_id: validAnonymousId,
        }),
      })
      expect(response.status).toBe(200)

      const body = await response.json()
      expect(body.ok).toBe(true)
    })

    it('should include request ID header in response', async () => {
      const requestId = `test-${Date.now()}`
      const response = await fetch(`${BASE_URL}/events`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ANON_KEY}`,
          'Content-Type': 'application/json',
          'x-request-id': requestId,
        },
        body: JSON.stringify({
          event: 'search',
          anonymous_id: validAnonymousId,
        }),
      })

      expect(response.headers.get('X-Request-ID')).toBe(requestId)
    })
  })

  describe.skipIf(skipIfNoSupabase)('Error Handling', () => {
    it('should return 405 for unsupported methods', async () => {
      const response = await fetch(`${BASE_URL}/skills-search`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${ANON_KEY}`,
        },
      })
      expect(response.status).toBe(405)
    })

    it('should return JSON error responses', async () => {
      const response = await apiRequest('/skills-search')
      const body = await response.json()

      expect(body.error).toBeDefined()
      expect(typeof body.error).toBe('string')
    })
  })
})

// Unit tests that don't require Supabase now live in integration.unit.test.ts
// (split out to stay under CLAUDE.md's 500-line file cap).
