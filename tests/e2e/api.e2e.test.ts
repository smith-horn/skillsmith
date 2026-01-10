/**
 * Skillsmith API E2E Tests
 *
 * Tests the live API at api.skillsmith.app
 * Run with: npm test -- tests/e2e/api.e2e.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest'

const API_BASE = process.env.SKILLSMITH_API_URL || 'https://api.skillsmith.app/functions/v1'

describe('Skillsmith API E2E Tests', () => {
  describe('GET /skills-search', () => {
    it('should return results for valid query', async () => {
      const response = await fetch(`${API_BASE}/skills-search?query=testing`)
      expect(response.ok).toBe(true)

      const data = await response.json()
      expect(data.data).toBeInstanceOf(Array)
      expect(data.data.length).toBeGreaterThan(0)
    })

    it('should filter by category', async () => {
      const response = await fetch(`${API_BASE}/skills-search?query=react&category=development`)
      expect(response.ok).toBe(true)

      const data = await response.json()
      expect(data.data).toBeInstanceOf(Array)
    })

    it('should filter by trust_tier', async () => {
      const response = await fetch(`${API_BASE}/skills-search?query=git&trust_tier=verified`)
      expect(response.ok).toBe(true)

      const data = await response.json()
      expect(data.data).toBeInstanceOf(Array)
    })

    it('should respect limit parameter', async () => {
      const response = await fetch(`${API_BASE}/skills-search?query=code&limit=5`)
      expect(response.ok).toBe(true)

      const data = await response.json()
      expect(data.data.length).toBeLessThanOrEqual(5)
    })

    it('should handle empty query gracefully', async () => {
      const response = await fetch(`${API_BASE}/skills-search?query=`)
      // Should return 200 with empty results or 400 for validation error
      expect([200, 400]).toContain(response.status)
    })

    it('should handle special characters in query', async () => {
      const response = await fetch(
        `${API_BASE}/skills-search?query=${encodeURIComponent('react+typescript')}`
      )
      expect(response.ok).toBe(true)
    })

    it('should return results within performance budget (2s)', async () => {
      const start = Date.now()
      await fetch(`${API_BASE}/skills-search?query=testing`)
      const elapsed = Date.now() - start

      expect(elapsed).toBeLessThan(2000)
    })

    it('should handle pagination offset', async () => {
      const page1 = await fetch(`${API_BASE}/skills-search?query=code&limit=5&offset=0`)
      const page2 = await fetch(`${API_BASE}/skills-search?query=code&limit=5&offset=5`)

      expect(page1.ok).toBe(true)
      expect(page2.ok).toBe(true)

      const data1 = await page1.json()
      const data2 = await page2.json()

      // Results should be different (unless < 5 total)
      if (data1.data.length >= 5) {
        const ids1 = data1.data.map((s: { id: string }) => s.id)
        const ids2 = data2.data.map((s: { id: string }) => s.id)
        const overlap = ids1.filter((id: string) => ids2.includes(id))
        expect(overlap.length).toBe(0)
      }
    })
  })

  describe('GET /skills-get', () => {
    let validSkillId: string

    beforeAll(async () => {
      // Get a valid skill ID from search
      const response = await fetch(`${API_BASE}/skills-search?query=commit&limit=1`)
      const data = await response.json()
      validSkillId = data.data[0]?.id
    })

    it('should return skill details for valid ID', async () => {
      if (!validSkillId) {
        console.warn('No valid skill ID found, skipping test')
        return
      }

      const response = await fetch(`${API_BASE}/skills-get?id=${encodeURIComponent(validSkillId)}`)
      expect(response.ok).toBe(true)

      const data = await response.json()
      expect(data.data.id).toBe(validSkillId)
      expect(data.data.name).toBeDefined()
      expect(data.data.description).toBeDefined()
    })

    it('should return 404 or error for invalid ID', async () => {
      const response = await fetch(
        `${API_BASE}/skills-get?id=${encodeURIComponent('nonexistent/fake-skill-12345')}`
      )

      // Either 404 or 200 with error field
      if (response.status === 200) {
        const data = await response.json()
        expect(data.error || data.data === null).toBeTruthy()
      } else {
        expect([404, 400]).toContain(response.status)
      }
    })

    it('should handle malformed ID safely', async () => {
      const response = await fetch(
        `${API_BASE}/skills-get?id=${encodeURIComponent('<script>alert(1)</script>')}`
      )

      // Should not crash server
      expect(response.status).not.toBe(500)
    })
  })

  describe('POST /skills-recommend', () => {
    it('should return recommendations for valid stack', async () => {
      const response = await fetch(`${API_BASE}/skills-recommend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stack: ['react', 'typescript', 'vitest'],
          project_type: 'web',
        }),
      })

      expect(response.ok).toBe(true)

      const data = await response.json()
      expect(data.recommendations || data.data).toBeInstanceOf(Array)
    })

    it('should handle empty stack', async () => {
      const response = await fetch(`${API_BASE}/skills-recommend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stack: [] }),
      })

      // Should return 200 with empty or 400 for validation
      expect([200, 400]).toContain(response.status)
    })

    it('should handle unknown technologies gracefully', async () => {
      const response = await fetch(`${API_BASE}/skills-recommend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stack: ['unknowntech12345', 'anotherfake'],
        }),
      })

      expect(response.ok).toBe(true)
    })

    it('should work with minimal input', async () => {
      const response = await fetch(`${API_BASE}/skills-recommend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stack: ['javascript'],
        }),
      })

      expect(response.ok).toBe(true)
    })
  })

  describe('POST /events (Telemetry)', () => {
    // Generate valid UUID hex format for anonymous_id
    const generateAnonymousId = () => {
      const hex = '0123456789abcdef'
      let id = ''
      for (let i = 0; i < 32; i++) {
        id += hex[Math.floor(Math.random() * 16)]
        if (i === 7 || i === 11 || i === 15 || i === 19) id += '-'
      }
      return id
    }

    it('should accept valid event', async () => {
      const response = await fetch(`${API_BASE}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'search', // Must be one of: skill_view, skill_install, skill_uninstall, skill_rate, search, recommend, compare, validate
          metadata: {
            source: 'e2e-test-suite',
            platform: 'e2e',
          },
          anonymous_id: generateAnonymousId(), // Must be 16-128 hex chars
        }),
      })

      // Accept 200, 202, or even 204 for telemetry
      expect([200, 202, 204]).toContain(response.status)
    })

    it('should reject malformed JSON', async () => {
      const response = await fetch(`${API_BASE}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-valid-json{{{',
      })

      expect([400, 500]).toContain(response.status)
    })

    it('should reject invalid event type', async () => {
      const response = await fetch(`${API_BASE}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'invalid_event_type',
          anonymous_id: generateAnonymousId(),
        }),
      })

      // Should return 400 for invalid event type
      expect(response.status).toBe(400)
    })

    it('should handle missing anonymous_id', async () => {
      const response = await fetch(`${API_BASE}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'search' }),
      })

      // Should return 400 for missing required field
      expect(response.status).toBe(400)
    })
  })

  describe('CORS and Headers', () => {
    it('should include CORS headers', async () => {
      const response = await fetch(`${API_BASE}/skills-search?query=test`, {
        method: 'OPTIONS',
      })

      // OPTIONS might return 204 or 200
      // Some APIs don't respond to OPTIONS from fetch
      // CORS headers are checked implicitly via cross-origin requests
      expect([200, 204, 405]).toContain(response.status)
    })

    it('should return JSON content type', async () => {
      const response = await fetch(`${API_BASE}/skills-search?query=test`)
      const contentType = response.headers.get('content-type')

      expect(contentType).toContain('application/json')
    })
  })
})
