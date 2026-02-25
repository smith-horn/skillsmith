/**
 * Tests for SMI-743: Skill Compare Tool
 *
 * SMI-2755 Wave 2: New test file covering formatComparisonResults formatting
 * paths — score_breakdown rendering, winner indicator, and version row.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { executeCompare, formatComparisonResults } from '../tools/compare.js'
import type { CompareResponse, SkillSummary } from '../tools/compare.js'
import { SkillsmithError } from '@skillsmith/core'
import { createSeededTestContext, type ToolContext } from './test-utils.js'

let context: ToolContext

beforeAll(() => {
  context = createSeededTestContext()
})

afterAll(() => {
  context.db.close()
})

// ============================================================================
// Helpers
// ============================================================================

function makeSkillSummary(overrides: Partial<SkillSummary> = {}): SkillSummary {
  return {
    id: 'community/test-skill',
    name: 'test-skill',
    description: 'A test skill',
    author: 'community',
    quality_score: 80,
    score_breakdown: null,
    trust_tier: 'community',
    category: 'testing',
    tags: ['testing'],
    version: null,
    dependencies: [],
    ...overrides,
  }
}

function makeCompareResponse(
  overrides: Partial<CompareResponse> = {},
  summaryA: Partial<SkillSummary> = {},
  summaryB: Partial<SkillSummary> = {}
): CompareResponse {
  return {
    comparison: {
      a: makeSkillSummary({ name: 'skill-a', id: 'community/skill-a', ...summaryA }),
      b: makeSkillSummary({ name: 'skill-b', id: 'community/skill-b', ...summaryB }),
    },
    differences: [
      {
        field: 'quality_score',
        a_value: 80,
        b_value: 75,
        winner: 'a',
      },
    ],
    recommendation: 'skill-a is recommended.',
    winner: 'a',
    timing: { totalMs: 5 },
    ...overrides,
  }
}

// ============================================================================
// executeCompare — integration tests using seeded test data
// ============================================================================

describe('executeCompare', () => {
  it('returns comparison when both skills exist in the database', async () => {
    const result = await executeCompare(
      { skill_a: 'community/jest-helper', skill_b: 'community/vitest-helper' },
      context
    )

    expect(result.comparison.a).toBeDefined()
    expect(result.comparison.b).toBeDefined()
    expect(result.comparison.a.name).toBe('jest-helper')
    expect(result.comparison.b.name).toBe('vitest-helper')
    expect(result.differences).toBeDefined()
    expect(Array.isArray(result.differences)).toBe(true)
    expect(typeof result.recommendation).toBe('string')
    expect(result.recommendation.length).toBeGreaterThan(0)
    expect(['a', 'b', 'tie']).toContain(result.winner)
  })

  it('throws SkillsmithError when skill_a is not found', async () => {
    await expect(
      executeCompare(
        { skill_a: 'community/nonexistent-skill', skill_b: 'community/jest-helper' },
        context
      )
    ).rejects.toThrow(SkillsmithError)
  })

  it('throws SkillsmithError when skill_b is not found', async () => {
    await expect(
      executeCompare(
        { skill_a: 'community/jest-helper', skill_b: 'community/nonexistent-skill' },
        context
      )
    ).rejects.toThrow(SkillsmithError)
  })

  it('throws SkillsmithError when comparing a skill with itself', async () => {
    await expect(
      executeCompare(
        { skill_a: 'community/jest-helper', skill_b: 'community/jest-helper' },
        context
      )
    ).rejects.toThrow(SkillsmithError)
  })
})

// ============================================================================
// formatComparisonResults — unit tests for formatting branches
// ============================================================================

describe('formatComparisonResults - score_breakdown rendering', () => {
  it('renders score breakdown bars when both skills have score_breakdown', () => {
    const scoreBreakdown = {
      quality: 85,
      popularity: 70,
      maintenance: 90,
      security: 80,
      documentation: 75,
    }

    const response = makeCompareResponse(
      {},
      { score_breakdown: scoreBreakdown },
      { score_breakdown: scoreBreakdown }
    )

    const formatted = formatComparisonResults(response)

    expect(formatted).toContain('Score Breakdown:')
    expect(formatted).toContain('Quality')
    expect(formatted).toContain('Popularity')
    expect(formatted).toContain('Maintenance')
    expect(formatted).toContain('Security')
    expect(formatted).toContain('Documentation')
  })

  it('omits score breakdown section when score_breakdown is null', () => {
    const response = makeCompareResponse({}, { score_breakdown: null }, { score_breakdown: null })

    const formatted = formatComparisonResults(response)

    expect(formatted).not.toContain('Score Breakdown:')
  })

  it('omits score breakdown section when only one skill has score_breakdown', () => {
    const scoreBreakdown = {
      quality: 85,
      popularity: 70,
      maintenance: 90,
      security: 80,
      documentation: 75,
    }

    // Only skill A has score_breakdown
    const response = makeCompareResponse(
      {},
      { score_breakdown: scoreBreakdown },
      { score_breakdown: null }
    )

    const formatted = formatComparisonResults(response)

    // Formatter requires BOTH to have breakdown
    expect(formatted).not.toContain('Score Breakdown:')
  })
})

describe('formatComparisonResults - winner indicator', () => {
  it('renders winner label for skill A when winner is "a"', () => {
    const response = makeCompareResponse(
      { winner: 'a', recommendation: 'skill-a is recommended.' },
      { name: 'jest-helper' },
      { name: 'vitest-helper' }
    )

    const formatted = formatComparisonResults(response)

    expect(formatted).toContain('Winner: jest-helper')
  })

  it('renders winner label for skill B when winner is "b"', () => {
    const response = makeCompareResponse(
      { winner: 'b', recommendation: 'skill-b is recommended.' },
      { name: 'jest-helper' },
      { name: 'vitest-helper' }
    )

    const formatted = formatComparisonResults(response)

    expect(formatted).toContain('Winner: vitest-helper')
  })

  it('renders "TIE" label when winner is "tie"', () => {
    const response = makeCompareResponse(
      { winner: 'tie', recommendation: 'Both are comparable.' },
      { name: 'jest-helper' },
      { name: 'vitest-helper' }
    )

    const formatted = formatComparisonResults(response)

    expect(formatted).toContain('Winner: TIE')
  })
})

describe('formatComparisonResults - version row', () => {
  it('includes version row when skill A has a version', () => {
    const response = makeCompareResponse(
      {},
      { version: '1.2.3', name: 'skill-a' },
      { version: null, name: 'skill-b' }
    )

    const formatted = formatComparisonResults(response)

    expect(formatted).toContain('Version')
    expect(formatted).toContain('1.2.3')
    expect(formatted).toContain('N/A')
  })

  it('includes version row when skill B has a version', () => {
    const response = makeCompareResponse(
      {},
      { version: null, name: 'skill-a' },
      { version: '2.0.0', name: 'skill-b' }
    )

    const formatted = formatComparisonResults(response)

    expect(formatted).toContain('Version')
    expect(formatted).toContain('2.0.0')
    expect(formatted).toContain('N/A')
  })

  it('omits version row when neither skill has a version', () => {
    const response = makeCompareResponse(
      {},
      { version: null, name: 'skill-a' },
      { version: null, name: 'skill-b' }
    )

    const formatted = formatComparisonResults(response)

    expect(formatted).not.toContain('Version')
  })
})
