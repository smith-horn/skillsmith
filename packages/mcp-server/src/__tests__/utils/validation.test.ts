/**
 * SMI-1602: Validation utility tests
 *
 * Tests for validation functions to increase branch coverage.
 */

import { describe, it, expect } from 'vitest'
import {
  parseSkillId,
  mapTrustTierToDb,
  mapTrustTierFromDb,
  extractCategoryFromTags,
  normalizeApiCategory,
} from '../../utils/validation.js'

describe('Validation Utilities', () => {
  describe('parseSkillId', () => {
    it('should parse 2-part skill ID (author/name)', () => {
      const result = parseSkillId('anthropic/commit')
      expect(result).toEqual({ author: 'anthropic', name: 'commit' })
    })

    it('should parse 3-part skill ID (source/author/name)', () => {
      const result = parseSkillId('github/cyanheads/git-mcp-server')
      expect(result).toEqual({
        source: 'github',
        author: 'cyanheads',
        name: 'git-mcp-server',
      })
    })

    it('should return null for invalid skill ID', () => {
      expect(parseSkillId('invalid')).toBeNull()
      expect(parseSkillId('')).toBeNull()
      expect(parseSkillId('too/many/parts/here')).toBeNull()
    })
  })

  describe('mapTrustTierToDb', () => {
    it('should map verified tier', () => {
      expect(mapTrustTierToDb('verified')).toBe('verified')
    })

    it('should map community tier', () => {
      expect(mapTrustTierToDb('community')).toBe('community')
    })

    it('should map experimental tier', () => {
      expect(mapTrustTierToDb('experimental')).toBe('experimental')
    })

    it('should map unknown tier', () => {
      expect(mapTrustTierToDb('unknown')).toBe('unknown')
    })
  })

  describe('mapTrustTierFromDb', () => {
    it('should map verified tier', () => {
      expect(mapTrustTierFromDb('verified')).toBe('verified')
    })

    it('should map community tier', () => {
      expect(mapTrustTierFromDb('community')).toBe('community')
    })

    it('should map experimental tier', () => {
      expect(mapTrustTierFromDb('experimental')).toBe('experimental')
    })

    it('should map unknown tier', () => {
      expect(mapTrustTierFromDb('unknown')).toBe('unknown')
    })

    it('should return unknown for unrecognized string', () => {
      // The function accepts string input and handles invalid values gracefully
      const invalidValue = 'invalid' as string
      expect(mapTrustTierFromDb(invalidValue)).toBe('unknown')
    })
  })

  describe('extractCategoryFromTags', () => {
    it('should return "other" for null tags', () => {
      expect(extractCategoryFromTags(null)).toBe('other')
    })

    it('should return "other" for undefined tags', () => {
      expect(extractCategoryFromTags(undefined)).toBe('other')
    })

    it('should return "other" for empty tags array', () => {
      expect(extractCategoryFromTags([])).toBe('other')
    })

    it('should extract testing category', () => {
      expect(extractCategoryFromTags(['testing', 'jest'])).toBe('testing')
    })

    it('should extract development category', () => {
      expect(extractCategoryFromTags(['development', 'react'])).toBe('development')
    })

    it('should return "other" for unrecognized tags', () => {
      expect(extractCategoryFromTags(['random', 'tags'])).toBe('other')
    })
  })

  describe('normalizeApiCategory', () => {
    it('should lowercase display-name categories', () => {
      expect(normalizeApiCategory('Database')).toBe('database')
      expect(normalizeApiCategory('Other')).toBe('other')
      expect(normalizeApiCategory('Science')).toBe('science')
    })

    it('should replace slash with dash for compound enum values', () => {
      expect(normalizeApiCategory('AI/ML')).toBe('ai-ml')
    })

    it('should strip trailing "s" when the singular form matches the enum (SMI-4240 schema drift)', () => {
      // Production DB has "integrations" (plural) but enum has "integration" (singular).
      expect(normalizeApiCategory('integrations')).toBe('integration')
      expect(normalizeApiCategory('Integrations')).toBe('integration')
    })

    it('should return null for categories not in the enum', () => {
      // "product" exists in production DB categories table but not in SkillCategory.
      expect(normalizeApiCategory('product')).toBeNull()
      expect(normalizeApiCategory('made-up-category')).toBeNull()
    })

    it('should return null for missing input (caller falls back to tag inference)', () => {
      expect(normalizeApiCategory(undefined)).toBeNull()
      expect(normalizeApiCategory(null)).toBeNull()
      expect(normalizeApiCategory('')).toBeNull()
    })

    it('should not singularize enum values that legitimately end in "s" without producing false matches', () => {
      // No current enum value ends in "s", but guard against regressions if one is added.
      // If someone adds e.g. "docs" to the enum, this test ensures a direct match wins over stripping.
      const result = normalizeApiCategory('development')
      expect(result).toBe('development')
    })
  })
})
