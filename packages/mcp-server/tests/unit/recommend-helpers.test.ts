/**
 * @fileoverview Tests for recommend.helpers.ts
 * @module @skillsmith/mcp-server/tests/unit/recommend-helpers
 *
 * SMI-1719: Unit tests for extracted helper functions from Wave 3 refactor
 */

import { describe, it, expect } from 'vitest'
import {
  inferRolesFromTags,
  isSkillCollection,
  COLLECTION_PATTERNS,
  buildEmptyRecommendationSuggestion,
  buildDbFallbackRecommendation,
} from '../../src/tools/recommend.helpers.js'
import type { SkillData } from '../../src/tools/recommend.types.js'
import type { SkillMatchResult } from '@skillsmith/core'

describe('recommend.helpers', () => {
  describe('inferRolesFromTags', () => {
    it('returns empty array for empty tags', () => {
      expect(inferRolesFromTags([])).toEqual([])
    })

    // SMI-1725: Defensive null/undefined handling
    it('handles null input gracefully', () => {
      expect(inferRolesFromTags(null as unknown as string[])).toEqual([])
    })

    it('handles undefined input gracefully', () => {
      expect(inferRolesFromTags(undefined as unknown as string[])).toEqual([])
    })

    it('infers code-quality role from lint tags', () => {
      const result = inferRolesFromTags(['lint', 'eslint'])
      expect(result).toContain('code-quality')
    })

    it('infers testing role from test tags', () => {
      const result = inferRolesFromTags(['testing', 'jest', 'vitest'])
      expect(result).toContain('testing')
    })

    it('infers documentation role from docs tags', () => {
      const result = inferRolesFromTags(['documentation', 'readme', 'jsdoc'])
      expect(result).toContain('documentation')
    })

    it('infers workflow role from git/ci tags', () => {
      const result = inferRolesFromTags(['git', 'commit', 'ci-cd'])
      expect(result).toContain('workflow')
    })

    it('infers security role from security tags', () => {
      const result = inferRolesFromTags(['security', 'audit', 'vulnerability'])
      expect(result).toContain('security')
    })

    it('infers development-partner role from ai tags', () => {
      const result = inferRolesFromTags(['ai', 'assistant', 'copilot'])
      expect(result).toContain('development-partner')
    })

    it('handles multiple roles from mixed tags', () => {
      const result = inferRolesFromTags(['eslint', 'jest', 'git'])
      expect(result).toContain('code-quality')
      expect(result).toContain('testing')
      expect(result).toContain('workflow')
    })

    it('normalizes tags with hyphens and underscores', () => {
      const result = inferRolesFromTags(['code-review', 'pull_request'])
      expect(result).toContain('code-quality')
      expect(result).toContain('workflow')
    })

    it('handles case insensitivity', () => {
      const result = inferRolesFromTags(['ESLINT', 'Jest', 'GIT'])
      expect(result).toContain('code-quality')
      expect(result).toContain('testing')
      expect(result).toContain('workflow')
    })

    it('does not duplicate roles', () => {
      const result = inferRolesFromTags(['lint', 'linting', 'eslint', 'prettier'])
      const codeQualityCount = result.filter((r) => r === 'code-quality').length
      expect(codeQualityCount).toBe(1)
    })

    it('returns empty for unrecognized tags', () => {
      const result = inferRolesFromTags(['random', 'unknown', 'custom'])
      expect(result).toEqual([])
    })
  })

  describe('isSkillCollection', () => {
    it('returns true for skill names with -skills suffix', () => {
      expect(isSkillCollection('my-skills', '')).toBe(true)
    })

    it('returns true for skill names with -collection suffix', () => {
      expect(isSkillCollection('utils-collection', '')).toBe(true)
    })

    it('returns true for skill names with -pack suffix', () => {
      expect(isSkillCollection('dev-pack', '')).toBe(true)
    })

    it('returns true for skill names with skill-collection', () => {
      expect(isSkillCollection('my-skill-collection', '')).toBe(true)
    })

    it('returns true for skill names with skills-repo', () => {
      expect(isSkillCollection('company-skills-repo', '')).toBe(true)
    })

    it('returns true when description contains collection of skills', () => {
      expect(isSkillCollection('my-tool', 'A collection of useful skills for development')).toBe(
        true
      )
    })

    it('returns false for regular skill names', () => {
      expect(isSkillCollection('commit-helper', '')).toBe(false)
    })

    it('returns false for skills with similar but not matching patterns', () => {
      expect(isSkillCollection('skillful-coder', '')).toBe(false)
    })

    it('returns false when description mentions collection but not skill', () => {
      expect(isSkillCollection('my-tool', 'A collection of utilities')).toBe(false)
    })

    it('handles empty inputs', () => {
      expect(isSkillCollection('', '')).toBe(false)
    })
  })

  describe('COLLECTION_PATTERNS', () => {
    it('exports collection patterns constant', () => {
      expect(COLLECTION_PATTERNS).toBeDefined()
      expect(Array.isArray(COLLECTION_PATTERNS)).toBe(true)
      expect(COLLECTION_PATTERNS.length).toBeGreaterThan(0)
    })

    it('contains expected patterns', () => {
      expect(COLLECTION_PATTERNS).toContain('-skills')
      expect(COLLECTION_PATTERNS).toContain('-collection')
      expect(COLLECTION_PATTERNS).toContain('-pack')
    })
  })

  describe('buildEmptyRecommendationSuggestion (SMI-5556)', () => {
    it('always clarifies candidates_considered is not a registry/backend fault', () => {
      const out = buildEmptyRecommendationSuggestion({
        installedCount: 3,
        hasProjectContext: true,
      })
      expect(out).toContain('does not indicate a registry/backend problem')
      expect(out).toContain('search tool')
    })

    it('suggests passing installed_skills only when installedCount is 0', () => {
      const withZero = buildEmptyRecommendationSuggestion({
        installedCount: 0,
        hasProjectContext: true,
      })
      expect(withZero).toContain('Try passing installed_skills explicitly')

      const withSome = buildEmptyRecommendationSuggestion({
        installedCount: 2,
        hasProjectContext: true,
      })
      expect(withSome).not.toContain('Try passing installed_skills explicitly')
    })

    it('suggests providing project_context only when hasProjectContext is false', () => {
      const without = buildEmptyRecommendationSuggestion({
        installedCount: 1,
        hasProjectContext: false,
      })
      expect(without).toContain('Provide project_context for more relevant results')

      const withContext = buildEmptyRecommendationSuggestion({
        installedCount: 1,
        hasProjectContext: true,
      })
      expect(withContext).not.toContain('Provide project_context for more relevant results')
    })

    it('suggests removing the role filter only when one is set', () => {
      const withRole = buildEmptyRecommendationSuggestion({
        installedCount: 1,
        hasProjectContext: true,
        roleFilter: 'testing',
      })
      expect(withRole).toContain('Try removing the role filter (currently: testing)')

      const withoutRole = buildEmptyRecommendationSuggestion({
        installedCount: 1,
        hasProjectContext: true,
      })
      expect(withoutRole).not.toContain('role filter')
    })
  })

  describe('buildDbFallbackRecommendation (SMI-5562)', () => {
    function makeSkillData(overrides: Partial<SkillData> = {}): SkillData {
      return {
        id: 'author/skill',
        name: 'skill',
        description: 'A test skill',
        triggerPhrases: [],
        keywords: [],
        qualityScore: 0.8,
        trustTier: 'community',
        roles: [],
        installable: true,
        riskScore: null,
        securityFindingsCount: 0,
        securityScannedAt: null,
        securityPassed: null,
        ...overrides,
      }
    }

    function makeMatchResult(skill: SkillData): SkillMatchResult {
      return { skill, similarityScore: 0.75, matchReason: 'Matches your testing needs' }
    }

    it('omits `security` entirely for a never-scanned skill (securityScannedAt: null)', () => {
      const rec = buildDbFallbackRecommendation(makeMatchResult(makeSkillData()), undefined)
      expect(rec.security).toBeUndefined()
    })

    it('returns a defined security summary, passed straight through, once a skill has been scanned', () => {
      const rec = buildDbFallbackRecommendation(
        makeMatchResult(
          makeSkillData({
            riskScore: 15,
            securityFindingsCount: 2,
            securityScannedAt: '2026-07-01T00:00:00Z',
            securityPassed: true,
          })
        ),
        undefined
      )
      expect(rec.security).toEqual({
        passed: true,
        riskScore: 15,
        findingsCount: 2,
        scannedAt: '2026-07-01T00:00:00Z',
      })
    })

    it('never coerces a real null riskScore to 0 once scannedAt is set (scanned-no-verdict case)', () => {
      const rec = buildDbFallbackRecommendation(
        makeMatchResult(
          makeSkillData({
            riskScore: null,
            securityScannedAt: '2026-07-01T00:00:00Z',
            securityPassed: null,
          })
        ),
        undefined
      )
      expect(rec.security).toBeDefined()
      expect(rec.security?.riskScore).toBeNull()
      expect(rec.security?.passed).toBeNull()
    })
  })
})
