/**
 * E2E Test: skill_compare tool
 *
 * Tests the compare tool against real database data
 * in a clean Codespace environment.
 *
 * User Journey: Compare skills to make informed choices
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir, homedir } from 'os'
import {
  createDatabase,
  initializeSchema,
  SkillRepository,
  type DatabaseType,
} from '@skillsmith/core'
import { createToolContext, type ToolContext } from '../../src/context.js'
import { executeCompare, type CompareInput } from '../../src/tools/compare.js'
import { scanForHardcoded } from './utils/hardcoded-detector.js'
import { measureAsync, recordTiming } from './utils/baseline-collector.js'

// Test configuration
const TEST_DIR = join(tmpdir(), 'skillsmith-e2e-compare')
const TEST_DB_PATH = join(TEST_DIR, 'compare-test.db')

// Seed data for comparison tests
const SEED_SKILLS = [
  {
    id: 'anthropic/commit',
    name: 'commit',
    description: 'Generate semantic commit messages',
    author: 'anthropic',
    repoUrl: 'https://github.com/anthropics/claude-code/tree/main/skills/commit',
    qualityScore: 0.95,
    trustTier: 'verified' as const,
    tags: ['git', 'commit'],
  },
  {
    id: 'community/jest-helper',
    name: 'jest-helper',
    description: 'Generate Jest test cases',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/jest-helper',
    qualityScore: 0.87,
    trustTier: 'community' as const,
    tags: ['testing', 'jest'],
  },
  {
    id: 'community/vitest-helper',
    name: 'vitest-helper',
    description: 'Generate Vitest test cases',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/vitest-helper',
    qualityScore: 0.85,
    trustTier: 'community' as const,
    tags: ['testing', 'vitest'],
  },
  {
    id: 'community/commitizen',
    name: 'commitizen',
    description: 'Interactive commit message prompts',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/commitizen',
    qualityScore: 0.82,
    trustTier: 'community' as const,
    tags: ['git', 'commit'],
  },
  {
    id: 'experimental/ai-commit',
    name: 'ai-commit',
    description: 'AI-powered commit message generation',
    author: 'experimental',
    repoUrl: 'https://github.com/skillsmith-experimental/ai-commit',
    qualityScore: 0.75,
    trustTier: 'experimental' as const,
    tags: ['git', 'ai', 'commit'],
  },
  {
    id: 'unknown/untested-tool',
    name: 'untested-tool',
    description: 'A newly submitted skill not yet reviewed or assessed',
    author: 'unknown-contributor',
    repoUrl: 'https://github.com/unknown-contributor/untested-tool',
    qualityScore: 0.45,
    trustTier: 'unknown' as const,
    tags: ['development', 'utility', 'unverified'],
  },
]

describe('E2E: skill_compare tool', () => {
  let db: DatabaseType
  let context: ToolContext

  beforeAll(() => {
    // Create isolated test directory
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true })
    }
    mkdirSync(TEST_DIR, { recursive: true })

    // Initialize database with seed data
    db = createDatabase(TEST_DB_PATH)
    initializeSchema(db)

    const skillRepo = new SkillRepository(db)
    for (const skill of SEED_SKILLS) {
      skillRepo.create(skill)
    }

    context = createToolContext({ dbPath: TEST_DB_PATH, apiClientConfig: { offlineMode: true } })
  })

  afterAll(() => {
    db?.close()
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true })
    }
  })

  describe('Basic Comparison', () => {
    it('should compare two skills', async () => {
      const input: CompareInput = {
        skill_a: 'community/jest-helper',
        skill_b: 'community/vitest-helper',
      }

      const { result, durationMs } = await measureAsync('compare:two', 'skill_compare (two)', () =>
        executeCompare(input, context)
      )

      expect(result.comparison.a).toBeDefined()
      expect(result.comparison.b).toBeDefined()
      expect(result.differences).toBeDefined()
      expect(result.recommendation).toBeDefined()

      recordTiming('compare:two_skills', 'skill_compare', durationMs)

      // Check for hardcoded values
      const responseStr = JSON.stringify(result)
      const issues = scanForHardcoded(responseStr, 'skill_compare', 'database')
      expect(issues.filter((i) => i.severity === 'error')).toHaveLength(0)
    })

    it('should compare commit-related skills', async () => {
      const input: CompareInput = {
        skill_a: 'anthropic/commit',
        skill_b: 'community/commitizen',
      }

      const result = await executeCompare(input, context)

      expect(result.comparison.a.id).toBe('anthropic/commit')
      expect(result.comparison.b.id).toBe('community/commitizen')

      // Check for hardcoded values
      const responseStr = JSON.stringify(result)
      const issues = scanForHardcoded(responseStr, 'skill_compare (commit)', 'database')
      expect(issues.filter((i) => i.severity === 'error')).toHaveLength(0)
    })
  })

  describe('Comparison Data Quality', () => {
    it('should return accurate quality scores from database', async () => {
      const input: CompareInput = {
        skill_a: 'anthropic/commit',
        skill_b: 'community/jest-helper',
      }

      const result = await executeCompare(input, context)

      // Scores should match seed data (verified > community)
      expect(result.comparison.a.quality_score).toBeGreaterThan(result.comparison.b.quality_score)
    })

    it('should return accurate trust tiers', async () => {
      const input: CompareInput = {
        skill_a: 'anthropic/commit',
        skill_b: 'experimental/ai-commit',
      }

      const result = await executeCompare(input, context)

      expect(result.comparison.a.trust_tier).toBe('verified')
      // Experimental may map to 'standard' or 'experimental' depending on impl
      expect(['experimental', 'standard', 'unverified']).toContain(result.comparison.b.trust_tier)
    })
  })

  describe('Hardcoded Value Detection', () => {
    it('should not expose user paths in comparison', async () => {
      const input: CompareInput = {
        skill_a: 'community/jest-helper',
        skill_b: 'community/vitest-helper',
      }

      const result = await executeCompare(input, context)
      const responseStr = JSON.stringify(result)

      // Should not contain user paths
      expect(responseStr).not.toMatch(/\/Users\/[a-zA-Z0-9_-]+\//)
      expect(responseStr).not.toMatch(/\/home\/[a-zA-Z0-9_-]+\//)
      expect(responseStr).not.toContain(homedir())
    })

    it('should not expose localhost URLs in comparison', async () => {
      const input: CompareInput = {
        skill_a: 'anthropic/commit',
        skill_b: 'community/commitizen',
      }

      const result = await executeCompare(input, context)
      const responseStr = JSON.stringify(result)

      expect(responseStr).not.toMatch(/localhost:\d+/)
      expect(responseStr).not.toMatch(/127\.0\.0\.1:\d+/)
    })

    it('should use database data not hardcoded comparison logic', async () => {
      const input: CompareInput = {
        skill_a: 'community/jest-helper',
        skill_b: 'community/vitest-helper',
      }

      const result = await executeCompare(input, context)

      // Verify skills come from our seed data
      const dbIds = SEED_SKILLS.map((s) => s.id)
      expect(dbIds).toContain(result.comparison.a.id)
      expect(dbIds).toContain(result.comparison.b.id)
    })
  })

  describe('Error Handling', () => {
    it('should handle non-existent skill in comparison', async () => {
      const input: CompareInput = {
        skill_a: 'anthropic/commit',
        skill_b: 'nonexistent/skill',
      }

      // Should throw for non-existent skill
      await expect(executeCompare(input, context)).rejects.toThrow()
    })

    it('should handle both skills non-existent', async () => {
      const input: CompareInput = {
        skill_a: 'nonexistent/skill-a',
        skill_b: 'nonexistent/skill-b',
      }

      await expect(executeCompare(input, context)).rejects.toThrow()
    })
  })

  describe('Performance Baselines', () => {
    it('should complete comparison in reasonable time', async () => {
      const { durationMs } = await measureAsync('compare:baseline', 'skill_compare baseline', () =>
        executeCompare(
          {
            skill_a: 'anthropic/commit',
            skill_b: 'community/commitizen',
          },
          context
        )
      )

      // Comparison should be fast (database lookups)
      expect(durationMs).toBeLessThan(500)
      console.log(`Compare baseline: ${durationMs}ms`)
    })

    it('should handle rapid comparison requests', async () => {
      const comparisons: CompareInput[] = [
        { skill_a: 'community/jest-helper', skill_b: 'community/vitest-helper' },
        { skill_a: 'anthropic/commit', skill_b: 'community/commitizen' },
        { skill_a: 'anthropic/commit', skill_b: 'experimental/ai-commit' },
      ]

      const results = await Promise.all(comparisons.map((input) => executeCompare(input, context)))

      expect(results).toHaveLength(3)
      for (const result of results) {
        expect(result.comparison.a).toBeDefined()
        expect(result.comparison.b).toBeDefined()
      }
    })
  })

  describe('Comparison Output Format', () => {
    it('should include comparison summary', async () => {
      const input: CompareInput = {
        skill_a: 'community/jest-helper',
        skill_b: 'community/vitest-helper',
      }

      const result = await executeCompare(input, context)

      // Should have structured comparison
      expect(result.comparison).toBeDefined()
      expect(result.timing).toBeDefined()
      expect(result.timing.totalMs).toBeGreaterThanOrEqual(0)
    })

    it('should include skill details for each compared skill', async () => {
      const input: CompareInput = {
        skill_a: 'anthropic/commit',
        skill_b: 'community/commitizen',
      }

      const result = await executeCompare(input, context)

      // Skill A details (via comparison.a)
      expect(result.comparison.a.id).toBeDefined()
      expect(result.comparison.a.name).toBeDefined()
      expect(result.comparison.a.description).toBeDefined()
      expect(result.comparison.a.quality_score).toBeDefined()
      expect(result.comparison.a.trust_tier).toBeDefined()

      // Skill B details (via comparison.b)
      expect(result.comparison.b.id).toBeDefined()
      expect(result.comparison.b.name).toBeDefined()
      expect(result.comparison.b.description).toBeDefined()
      expect(result.comparison.b.quality_score).toBeDefined()
      expect(result.comparison.b.trust_tier).toBeDefined()
    })

    it('should include winner and recommendation', async () => {
      const input: CompareInput = {
        skill_a: 'anthropic/commit',
        skill_b: 'community/commitizen',
      }

      const result = await executeCompare(input, context)

      // Should have winner
      expect(['a', 'b', 'tie']).toContain(result.winner)

      // Should have recommendation text
      expect(result.recommendation).toBeDefined()
      expect(typeof result.recommendation).toBe('string')
      expect(result.recommendation.length).toBeGreaterThan(0)
    })

    it('should include differences array', async () => {
      const input: CompareInput = {
        skill_a: 'anthropic/commit',
        skill_b: 'community/commitizen',
      }

      const result = await executeCompare(input, context)

      // Should have differences array
      expect(Array.isArray(result.differences)).toBe(true)

      // Each difference should have expected structure
      for (const diff of result.differences) {
        expect(diff.field).toBeDefined()
        expect(diff.a_value !== undefined || diff.b_value !== undefined).toBe(true)
      }
    })
  })
})
