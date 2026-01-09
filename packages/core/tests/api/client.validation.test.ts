/**
 * SMI-1258: API Client Response Validation Tests
 *
 * Tests for runtime validation of API responses using zod schemas.
 */

import { describe, it, expect } from 'vitest'
import {
  ApiSearchResultSchema,
  SearchResponseSchema,
  SingleSkillResponseSchema,
  TelemetryResponseSchema,
  TrustTierSchema,
} from '../../src/api/client.js'

describe('API Response Validation Schemas', () => {
  describe('TrustTierSchema', () => {
    it('should accept valid trust tiers', () => {
      expect(TrustTierSchema.safeParse('verified').success).toBe(true)
      expect(TrustTierSchema.safeParse('community').success).toBe(true)
      expect(TrustTierSchema.safeParse('experimental').success).toBe(true)
      expect(TrustTierSchema.safeParse('unknown').success).toBe(true)
    })

    it('should reject invalid trust tiers', () => {
      expect(TrustTierSchema.safeParse('invalid').success).toBe(false)
      expect(TrustTierSchema.safeParse('').success).toBe(false)
      expect(TrustTierSchema.safeParse(123).success).toBe(false)
    })
  })

  describe('ApiSearchResultSchema', () => {
    const validResult = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      name: 'test-skill',
      description: 'A test skill',
      author: 'test-author',
      repo_url: 'https://github.com/test/skill',
      quality_score: 85,
      trust_tier: 'verified',
      tags: ['testing', 'example'],
      stars: 100,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-02T00:00:00Z',
    }

    it('should accept valid search result', () => {
      const result = ApiSearchResultSchema.safeParse(validResult)
      expect(result.success).toBe(true)
    })

    it('should accept null values for optional fields', () => {
      const resultWithNulls = {
        ...validResult,
        description: null,
        author: null,
        repo_url: null,
        quality_score: null,
        stars: null,
      }
      const result = ApiSearchResultSchema.safeParse(resultWithNulls)
      expect(result.success).toBe(true)
    })

    it('should reject missing required fields', () => {
      const { id: _id, ...withoutId } = validResult
      expect(ApiSearchResultSchema.safeParse(withoutId).success).toBe(false)

      const { name: _name, ...withoutName } = validResult
      expect(ApiSearchResultSchema.safeParse(withoutName).success).toBe(false)
    })

    it('should reject invalid trust_tier', () => {
      const invalidResult = { ...validResult, trust_tier: 'invalid_tier' }
      expect(ApiSearchResultSchema.safeParse(invalidResult).success).toBe(false)
    })

    it('should reject invalid tags type', () => {
      const invalidResult = { ...validResult, tags: 'not-an-array' }
      expect(ApiSearchResultSchema.safeParse(invalidResult).success).toBe(false)
    })
  })

  describe('SearchResponseSchema', () => {
    const validSearchResponse = {
      data: [
        {
          id: '123',
          name: 'skill-1',
          description: 'First skill',
          author: 'author1',
          repo_url: null,
          quality_score: 80,
          trust_tier: 'community',
          tags: ['tag1'],
          stars: 50,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
        },
      ],
      meta: { total: 1, limit: 10, offset: 0 },
    }

    it('should accept valid search response', () => {
      const result = SearchResponseSchema.safeParse(validSearchResponse)
      expect(result.success).toBe(true)
    })

    it('should accept empty data array', () => {
      const emptyResponse = { data: [], meta: { total: 0 } }
      const result = SearchResponseSchema.safeParse(emptyResponse)
      expect(result.success).toBe(true)
    })

    it('should accept response without meta', () => {
      const noMeta = { data: [] }
      const result = SearchResponseSchema.safeParse(noMeta)
      expect(result.success).toBe(true)
    })

    it('should reject malformed response', () => {
      const invalidResponse = { results: [] } // 'results' instead of 'data'
      expect(SearchResponseSchema.safeParse(invalidResponse).success).toBe(false)
    })

    it('should reject invalid data items', () => {
      const invalidItems = {
        data: [{ invalid: 'structure' }],
      }
      expect(SearchResponseSchema.safeParse(invalidItems).success).toBe(false)
    })
  })

  describe('SingleSkillResponseSchema', () => {
    const validSkillResponse = {
      data: {
        id: '456',
        name: 'single-skill',
        description: 'A single skill',
        author: 'author',
        repo_url: 'https://github.com/test/skill',
        quality_score: 90,
        trust_tier: 'verified',
        tags: ['production'],
        stars: 200,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      },
    }

    it('should accept valid single skill response', () => {
      const result = SingleSkillResponseSchema.safeParse(validSkillResponse)
      expect(result.success).toBe(true)
    })

    it('should reject array data (expects single object)', () => {
      const arrayResponse = { data: [validSkillResponse.data] }
      expect(SingleSkillResponseSchema.safeParse(arrayResponse).success).toBe(false)
    })
  })

  describe('TelemetryResponseSchema', () => {
    it('should accept valid telemetry response', () => {
      const validResponse = { data: { ok: true } }
      const result = TelemetryResponseSchema.safeParse(validResponse)
      expect(result.success).toBe(true)
    })

    it('should accept telemetry response with meta', () => {
      const withMeta = { data: { ok: false }, meta: { timestamp: 12345 } }
      const result = TelemetryResponseSchema.safeParse(withMeta)
      expect(result.success).toBe(true)
    })

    it('should reject missing ok field', () => {
      const invalidResponse = { data: {} }
      expect(TelemetryResponseSchema.safeParse(invalidResponse).success).toBe(false)
    })

    it('should reject wrong ok type', () => {
      const invalidResponse = { data: { ok: 'yes' } }
      expect(TelemetryResponseSchema.safeParse(invalidResponse).success).toBe(false)
    })
  })

  describe('Validation Error Messages', () => {
    it('should provide descriptive error messages for invalid data', () => {
      const invalidResult = {
        id: 123, // Should be string
        name: 'test',
        description: null,
        author: null,
        repo_url: null,
        quality_score: null,
        trust_tier: 'verified',
        tags: [],
        stars: null,
        created_at: '2024-01-01',
        updated_at: '2024-01-01',
      }

      const result = ApiSearchResultSchema.safeParse(invalidResult)
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues.length).toBeGreaterThan(0)
        expect(result.error.issues[0].path).toContain('id')
      }
    })
  })
})
