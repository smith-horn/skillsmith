/**
 * Tests for recommend.ts's `formatRecommendations` CLI text renderer.
 *
 * Split out of recommend.test.ts (file-length gate, <500 lines) — mirrors
 * search.formatter.test.ts's split from search.test.ts.
 */

import { describe, it, expect } from 'vitest'
import { formatRecommendations } from '../tools/recommend.js'

describe('formatRecommendations', () => {
  it('should format results for terminal display', () => {
    const result = {
      recommendations: [
        {
          skill_id: 'acme/test-skill',
          name: 'test-skill',
          reason: 'Matches your testing needs',
          similarity_score: 0.75,
          trust_tier: 'community' as const,
          quality_score: 70,
        },
      ],
      candidates_considered: 1,
      overlap_filtered: 0,
      role_filtered: 0,
      context: {
        installed_count: 0,
        has_project_context: true,
        using_semantic_matching: true,
        auto_detected: false,
      },
      timing: { totalMs: 3 },
    }
    const formatted = formatRecommendations(result)

    expect(formatted).toContain('Skill Recommendations')
  })

  it('should show helpful message when no results', async () => {
    const emptyResult = {
      recommendations: [],
      candidates_considered: 0,
      overlap_filtered: 0,
      role_filtered: 0,
      context: {
        installed_count: 0,
        has_project_context: false,
        using_semantic_matching: true,
        auto_detected: false,
      },
      timing: { totalMs: 10 },
    }
    const formatted = formatRecommendations(emptyResult)

    expect(formatted).toContain('No recommendations found')
    expect(formatted).toContain('Suggestions:')
  })

  // SMI-5556: formatter prefers response.suggestion over re-deriving guidance.
  it('should surface response.suggestion when present instead of the hardcoded list', async () => {
    const emptyResult = {
      recommendations: [],
      candidates_considered: 3,
      overlap_filtered: 0,
      role_filtered: 0,
      suggestion: 'Custom empty-result guidance from the tool.',
      context: {
        installed_count: 0,
        has_project_context: false,
        using_semantic_matching: true,
        auto_detected: false,
      },
      timing: { totalMs: 10 },
    }
    const formatted = formatRecommendations(emptyResult)

    expect(formatted).toContain('Custom empty-result guidance from the tool.')
    expect(formatted).not.toContain('Suggestions:')
  })

  // SMI-5562: description + safety line rendering (CLI-consistency nice-to-have;
  // the primary fix is the JSON fields + tool description guidance).
  describe('description + security line (SMI-5562)', () => {
    const baseResponse = {
      candidates_considered: 1,
      overlap_filtered: 0,
      role_filtered: 0,
      context: {
        installed_count: 0,
        has_project_context: true,
        using_semantic_matching: true,
        auto_detected: false,
      },
      timing: { totalMs: 5 },
    }

    it('renders the description snippet and a PASS line for a clean scanned skill', () => {
      const formatted = formatRecommendations({
        ...baseResponse,
        recommendations: [
          {
            skill_id: 'acme/clean-skill',
            name: 'clean-skill',
            reason: 'Matches your stack: react',
            similarity_score: 0.8,
            trust_tier: 'verified',
            quality_score: 90,
            description: 'A well-tested skill for React projects.',
            security: {
              passed: true,
              riskScore: 0,
              findingsCount: 0,
              scannedAt: '2026-06-01T00:00:00.000Z',
            },
          },
        ],
      })

      expect(formatted).toContain('A well-tested skill for React projects.')
      expect(formatted).toContain('Security: PASS')
    })

    it('renders a FAIL line with the riskScore for a quarantined/failed skill', () => {
      const formatted = formatRecommendations({
        ...baseResponse,
        recommendations: [
          {
            skill_id: 'acme/risky-skill',
            name: 'risky-skill',
            reason: 'Matches your stack: react',
            similarity_score: 0.6,
            trust_tier: 'community',
            quality_score: 40,
            description: 'Has known security findings.',
            security: {
              passed: false,
              riskScore: 85,
              findingsCount: 2,
              scannedAt: '2026-06-01T00:00:00.000Z',
            },
          },
        ],
      })

      expect(formatted).toContain('Security: FAIL (85/100)')
    })

    it('renders "Scanned, no verdict yet" when passed is null', () => {
      const formatted = formatRecommendations({
        ...baseResponse,
        recommendations: [
          {
            skill_id: 'acme/pending-skill',
            name: 'pending-skill',
            reason: 'Matches your stack: react',
            similarity_score: 0.6,
            trust_tier: 'community',
            quality_score: 50,
            security: {
              passed: null,
              riskScore: null,
              findingsCount: 0,
              scannedAt: '2026-06-01T00:00:00.000Z',
            },
          },
        ],
      })

      expect(formatted).toContain('Security: Scanned, no verdict yet')
    })

    it('omits the Security line entirely when security is undefined (never scanned)', () => {
      const formatted = formatRecommendations({
        ...baseResponse,
        recommendations: [
          {
            skill_id: 'local/never-scanned',
            name: 'never-scanned',
            reason: 'Local skill matching: react',
            similarity_score: 0.7,
            trust_tier: 'local',
            quality_score: 70,
            description: 'A local skill.',
          },
        ],
      })

      expect(formatted).not.toContain('Security:')
      expect(formatted).toContain('A local skill.')
    })

    it('omits the description line when description is absent/empty', () => {
      const formatted = formatRecommendations({
        ...baseResponse,
        recommendations: [
          {
            skill_id: 'local/no-description',
            name: 'no-description',
            reason: 'Local skill matching: react',
            similarity_score: 0.7,
            trust_tier: 'local',
            quality_score: 70,
          },
        ],
      })

      expect(formatted).toContain('no-description')
      expect(formatted).toContain('ID: local/no-description')
    })
  })
})
