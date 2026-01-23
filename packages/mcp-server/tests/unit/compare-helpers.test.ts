/**
 * @fileoverview Tests for compare.helpers.ts
 * @module @skillsmith/mcp-server/tests/unit/compare-helpers
 *
 * SMI-1719: Unit tests for extracted helper functions from Wave 3 refactor
 */

import { describe, it, expect } from 'vitest'
import {
  toSummary,
  generateDifferences,
  generateRecommendation,
  formatScoreBar,
  padEnd,
} from '../../src/tools/compare.helpers.js'
import type { ExtendedSkill } from '../../src/tools/compare.types.js'

// Test fixtures
const createSkill = (overrides: Partial<ExtendedSkill> = {}): ExtendedSkill => ({
  id: 'test/skill-a',
  name: 'skill-a',
  description: 'Test skill A',
  author: 'author-a',
  repository: 'https://github.com/test/skill-a',
  version: '1.0.0',
  category: 'development',
  trustTier: 'community',
  score: 75,
  scoreBreakdown: {
    quality: 80,
    popularity: 70,
    maintenance: 75,
    security: 80,
    documentation: 70,
  },
  tags: ['typescript', 'testing'],
  installCommand: 'claude skill add test/skill-a',
  createdAt: '2024-01-01',
  updatedAt: '2024-01-15',
  dependencies: ['dep-1'],
  features: ['feature-1', 'feature-2'],
  ...overrides,
})

describe('compare.helpers', () => {
  describe('toSummary', () => {
    it('converts ExtendedSkill to SkillSummary', () => {
      const skill = createSkill()
      const summary = toSummary(skill)

      expect(summary.id).toBe('test/skill-a')
      expect(summary.name).toBe('skill-a')
      expect(summary.description).toBe('Test skill A')
      expect(summary.author).toBe('author-a')
      expect(summary.quality_score).toBe(75)
      expect(summary.trust_tier).toBe('community')
      expect(summary.category).toBe('development')
      expect(summary.tags).toEqual(['typescript', 'testing'])
      expect(summary.version).toBe('1.0.0')
      expect(summary.dependencies).toEqual(['dep-1'])
    })

    it('handles null score breakdown', () => {
      const skill = createSkill({ scoreBreakdown: undefined })
      const summary = toSummary(skill)

      expect(summary.score_breakdown).toBeNull()
    })

    it('handles null version', () => {
      const skill = createSkill({ version: undefined })
      const summary = toSummary(skill)

      expect(summary.version).toBeNull()
    })
  })

  describe('generateDifferences', () => {
    it('compares quality scores', () => {
      const skillA = createSkill({ score: 80 })
      const skillB = createSkill({ score: 70 })

      const diffs = generateDifferences(skillA, skillB)
      const scoreDiff = diffs.find((d) => d.field === 'quality_score')

      expect(scoreDiff).toBeDefined()
      expect(scoreDiff?.a_value).toBe(80)
      expect(scoreDiff?.b_value).toBe(70)
      expect(scoreDiff?.winner).toBe('a')
    })

    it('compares trust tiers', () => {
      const skillA = createSkill({ trustTier: 'verified' })
      const skillB = createSkill({ trustTier: 'community' })

      const diffs = generateDifferences(skillA, skillB)
      const trustDiff = diffs.find((d) => d.field === 'trust_tier')

      expect(trustDiff).toBeDefined()
      expect(trustDiff?.a_value).toBe('verified')
      expect(trustDiff?.b_value).toBe('community')
      expect(trustDiff?.winner).toBe('a')
    })

    it('prefers fewer dependencies', () => {
      const skillA = createSkill({ dependencies: ['dep-1'] })
      const skillB = createSkill({ dependencies: ['dep-1', 'dep-2', 'dep-3'] })

      const diffs = generateDifferences(skillA, skillB)
      const depDiff = diffs.find((d) => d.field === 'dependencies_count')

      expect(depDiff).toBeDefined()
      expect(depDiff?.a_value).toBe(1)
      expect(depDiff?.b_value).toBe(3)
      expect(depDiff?.winner).toBe('a')
    })

    it('prefers more features', () => {
      const skillA = createSkill({ features: ['f1', 'f2', 'f3'] })
      const skillB = createSkill({ features: ['f1'] })

      const diffs = generateDifferences(skillA, skillB)
      const featureDiff = diffs.find((d) => d.field === 'features_count')

      expect(featureDiff).toBeDefined()
      expect(featureDiff?.a_value).toBe(3)
      expect(featureDiff?.b_value).toBe(1)
      expect(featureDiff?.winner).toBe('a')
    })

    it('handles ties', () => {
      const skillA = createSkill({ score: 75 })
      const skillB = createSkill({ score: 75 })

      const diffs = generateDifferences(skillA, skillB)
      const scoreDiff = diffs.find((d) => d.field === 'quality_score')

      expect(scoreDiff?.winner).toBe('tie')
    })

    it('compares score breakdown when available', () => {
      const skillA = createSkill({
        scoreBreakdown: {
          quality: 90,
          popularity: 80,
          maintenance: 85,
          security: 90,
          documentation: 80,
        },
      })
      const skillB = createSkill({
        scoreBreakdown: {
          quality: 70,
          popularity: 60,
          maintenance: 65,
          security: 70,
          documentation: 60,
        },
      })

      const diffs = generateDifferences(skillA, skillB)
      const qualityDiff = diffs.find((d) => d.field === 'score_quality')

      expect(qualityDiff).toBeDefined()
      expect(qualityDiff?.winner).toBe('a')
    })

    it('includes category difference when different', () => {
      const skillA = createSkill({ category: 'testing' })
      const skillB = createSkill({ category: 'development' })

      const diffs = generateDifferences(skillA, skillB)
      const categoryDiff = diffs.find((d) => d.field === 'category')

      expect(categoryDiff).toBeDefined()
      expect(categoryDiff?.a_value).toBe('testing')
      expect(categoryDiff?.b_value).toBe('development')
    })

    it('includes unique tags', () => {
      const skillA = createSkill({ tags: ['typescript', 'react'] })
      const skillB = createSkill({ tags: ['typescript', 'vue'] })

      const diffs = generateDifferences(skillA, skillB)
      const tagsDiff = diffs.find((d) => d.field === 'unique_tags')

      expect(tagsDiff).toBeDefined()
      expect(tagsDiff?.a_value).toEqual(['react'])
      expect(tagsDiff?.b_value).toEqual(['vue'])
    })
  })

  describe('generateRecommendation', () => {
    it('recommends skill A when it clearly wins', () => {
      const skillA = createSkill({ score: 90, trustTier: 'verified' })
      const skillB = createSkill({ score: 60, trustTier: 'community' })
      const diffs = generateDifferences(skillA, skillB)

      const result = generateRecommendation(skillA, skillB, diffs)

      expect(result.winner).toBe('a')
      expect(result.recommendation).toContain('skill-a')
      expect(result.recommendation).toContain('recommended')
    })

    it('recommends skill B when it clearly wins', () => {
      // SMI-1724: Use distinct names for clarity
      const skillA = createSkill({
        id: 'test/skill-a',
        name: 'skill-a',
        score: 50,
        trustTier: 'experimental',
      })
      const skillB = createSkill({
        id: 'test/skill-b',
        name: 'skill-b',
        score: 90,
        trustTier: 'verified',
      })
      const diffs = generateDifferences(skillA, skillB)

      const result = generateRecommendation(skillA, skillB, diffs)

      expect(result.winner).toBe('b')
      expect(result.recommendation).toContain('skill-b')
    })

    it('returns tie when skills are comparable', () => {
      const skillA = createSkill({ score: 75, trustTier: 'community' })
      const skillB = createSkill({ score: 75, trustTier: 'community' })
      const diffs = generateDifferences(skillA, skillB)

      const result = generateRecommendation(skillA, skillB, diffs)

      expect(result.winner).toBe('tie')
      expect(result.recommendation).toContain('comparable')
    })
  })

  describe('formatScoreBar', () => {
    it('formats 100% score', () => {
      const bar = formatScoreBar(100, 20)
      expect(bar).toContain('[==========]')
      expect(bar).toContain('100')
    })

    it('formats 0% score', () => {
      const bar = formatScoreBar(0, 20)
      expect(bar).toContain('[----------]')
      expect(bar).toContain('0')
    })

    it('formats 50% score', () => {
      const bar = formatScoreBar(50, 20)
      expect(bar).toContain('[=====-----]')
      expect(bar).toContain('50')
    })

    it('pads to specified width', () => {
      const bar = formatScoreBar(75, 25)
      expect(bar.length).toBe(25)
    })
  })

  describe('padEnd', () => {
    it('pads string to specified length', () => {
      expect(padEnd('test', 10)).toBe('test      ')
    })

    it('returns original if already long enough', () => {
      expect(padEnd('testing', 5)).toBe('testing')
    })

    it('handles empty string', () => {
      expect(padEnd('', 5)).toBe('     ')
    })
  })
})
