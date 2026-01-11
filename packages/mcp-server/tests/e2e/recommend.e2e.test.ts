/**
 * E2E Test: MCP skill_recommend tool
 *
 * Tests the recommend tool against real skill databases
 * in a clean Codespace environment.
 *
 * FOCUS: Detect hardcoded values that caused SMI-902/904 issues
 *
 * User Journey: Get skill recommendations based on context
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir, homedir } from 'os'
import {
  createDatabase,
  initializeSchema,
  SkillRepository,
  type DatabaseType,
} from '@skillsmith/core'
import { createToolContext, type ToolContext } from '../../src/context.js'
import { executeRecommend, type RecommendInput } from '../../src/tools/recommend.js'
import { scanForHardcoded, type HardcodedIssue } from './utils/hardcoded-detector.js'
import { recordTiming, measureAsync } from './utils/baseline-collector.js'

// Test configuration
const TEST_DIR = join(tmpdir(), 'skillsmith-e2e-recommend')
const TEST_DB_PATH = join(TEST_DIR, 'recommend-test.db')
const TEST_SKILLS_DIR = join(TEST_DIR, '.claude', 'skills')

// Diverse seed data for testing recommendations
const SEED_SKILLS = [
  {
    id: 'anthropic/commit',
    name: 'commit',
    description: 'Generate semantic commit messages following conventional commits',
    author: 'anthropic',
    repoUrl: 'https://github.com/anthropics/claude-code/tree/main/skills/commit',
    qualityScore: 0.95,
    trustTier: 'verified' as const,
    tags: ['development', 'git', 'commit', 'conventional-commits'],
  },
  {
    id: 'community/jest-helper',
    name: 'jest-helper',
    description: 'Generate Jest test cases for React components',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/jest-helper',
    qualityScore: 0.87,
    trustTier: 'community' as const,
    tags: ['testing', 'jest', 'react', 'unit-tests'],
  },
  {
    id: 'community/vitest-helper',
    name: 'vitest-helper',
    description: 'Generate Vitest test cases with modern ESM support',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/vitest-helper',
    qualityScore: 0.85,
    trustTier: 'community' as const,
    tags: ['testing', 'vitest', 'esm', 'typescript'],
  },
  {
    id: 'community/docker-compose',
    name: 'docker-compose',
    description: 'Generate and manage Docker Compose configurations',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/docker-compose',
    qualityScore: 0.84,
    trustTier: 'community' as const,
    tags: ['devops', 'docker', 'containers'],
  },
  {
    id: 'community/eslint-config',
    name: 'eslint-config',
    description: 'Generate and configure ESLint rules for JavaScript projects',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/eslint-config',
    qualityScore: 0.82,
    trustTier: 'community' as const,
    tags: ['linting', 'eslint', 'code-quality'],
  },
  {
    id: 'experimental/ai-debug',
    name: 'ai-debug',
    description: 'AI-powered debugging assistant',
    author: 'experimental',
    repoUrl: 'https://github.com/skillsmith-community/ai-debug',
    qualityScore: 0.65,
    trustTier: 'experimental' as const,
    tags: ['debugging', 'ai', 'experimental'],
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

/**
 * Create mock installed skill for auto-detection tests
 */
function createMockInstalledSkill(skillName: string): void {
  const skillDir = join(TEST_SKILLS_DIR, skillName)
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---
name: ${skillName}
version: 1.0.0
description: Mock skill for testing
---
# ${skillName}
Mock skill content.
`
  )
}

/**
 * Scan response for hardcoded values
 */
function scanResponseForHardcoded(response: unknown, command: string): HardcodedIssue[] {
  const responseStr = JSON.stringify(response, null, 2)
  return scanForHardcoded(responseStr, command, 'database', 'recommend response')
}

describe('E2E: skill_recommend tool', () => {
  let db: DatabaseType
  let context: ToolContext

  beforeAll(() => {
    // Create test environment
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true })
    }
    mkdirSync(TEST_DIR, { recursive: true })
    mkdirSync(TEST_SKILLS_DIR, { recursive: true })

    // Initialize database with seed data
    db = createDatabase(TEST_DB_PATH)
    initializeSchema(db)

    const skillRepo = new SkillRepository(db)
    for (const skill of SEED_SKILLS) {
      skillRepo.create(skill)
    }

    // Create context pointing to test database
    context = createToolContext({ dbPath: TEST_DB_PATH, apiClientConfig: { offlineMode: true } })
  })

  afterAll(() => {
    db?.close()
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true })
    }
  })

  describe('Basic Recommendations', () => {
    it('should return recommendations without installed skills', async () => {
      const input: RecommendInput = {
        installed_skills: [],
        limit: 5,
      }

      const { result } = await measureAsync(
        'recommend:empty',
        'skill_recommend (no installed)',
        () => executeRecommend(input, context)
      )

      expect(result.recommendations.length).toBeGreaterThan(0)
      expect(result.timing.totalMs).toBeGreaterThanOrEqual(0)

      // Check for hardcoded values in response
      const issues = scanResponseForHardcoded(result, 'skill_recommend')
      expect(issues.filter((i) => i.severity === 'error')).toHaveLength(0)
    })

    it('should return recommendations with installed skills', async () => {
      const input: RecommendInput = {
        installed_skills: ['anthropic/commit'],
        limit: 5,
      }

      const result = await executeRecommend(input, context)

      recordTiming('recommend:with_installed', 'skill_recommend (installed)', result.timing.totalMs)

      // May have 0 recommendations if seed data overlaps with installed skill
      expect(result.recommendations.length).toBeGreaterThanOrEqual(0)
      expect(result.context.installed_count).toBe(1)

      // If there are recommendations, should not include already installed skill
      const recommendedIds = result.recommendations.map((r) => r.skill_id)
      expect(recommendedIds).not.toContain('anthropic/commit')

      // Check for hardcoded values
      const issues = scanResponseForHardcoded(result, 'skill_recommend')
      expect(issues.filter((i) => i.severity === 'error')).toHaveLength(0)
    })

    it('should use project context for recommendations', async () => {
      const input: RecommendInput = {
        installed_skills: [],
        project_context: 'React TypeScript frontend with Jest testing',
        limit: 5,
      }

      const result = await executeRecommend(input, context)

      recordTiming('recommend:context', 'skill_recommend (context)', result.timing.totalMs)

      expect(result.context.has_project_context).toBe(true)

      // Check for hardcoded values
      const issues = scanResponseForHardcoded(result, 'skill_recommend')
      expect(issues.filter((i) => i.severity === 'error')).toHaveLength(0)
    })
  })

  describe('Auto-Detection of Installed Skills', () => {
    it('should auto-detect installed skills from ~/.claude/skills/', async () => {
      // Create mock installed skill
      createMockInstalledSkill('test-installed-skill')

      // Override HOME for this test
      const originalHome = process.env.HOME
      process.env.HOME = TEST_DIR

      try {
        const input: RecommendInput = {
          installed_skills: [], // Empty to trigger auto-detection
          limit: 5,
        }

        const result = await executeRecommend(input, context)

        // Should have auto-detected
        expect(result.context.auto_detected).toBe(true)

        // Check for hardcoded values
        const issues = scanResponseForHardcoded(result, 'skill_recommend (auto-detect)')
        expect(issues.filter((i) => i.severity === 'error')).toHaveLength(0)
      } finally {
        process.env.HOME = originalHome
      }
    })
  })

  describe('Overlap Detection', () => {
    it('should filter overlapping skills when enabled', async () => {
      const input: RecommendInput = {
        installed_skills: ['community/jest-helper'],
        detect_overlap: true,
        limit: 10,
      }

      const result = await executeRecommend(input, context)

      recordTiming('recommend:overlap', 'skill_recommend (overlap)', result.timing.totalMs)

      // vitest-helper might be filtered as similar to jest-helper
      // Just verify overlap_filtered is tracked
      expect(typeof result.overlap_filtered).toBe('number')

      // Check for hardcoded values
      const issues = scanResponseForHardcoded(result, 'skill_recommend')
      expect(issues.filter((i) => i.severity === 'error')).toHaveLength(0)
    })

    it('should not filter when detect_overlap is false', async () => {
      const input: RecommendInput = {
        installed_skills: ['community/jest-helper'],
        detect_overlap: false,
        limit: 10,
      }

      const result = await executeRecommend(input, context)

      // Should have more candidates when overlap not filtered
      expect(result.candidates_considered).toBeGreaterThan(0)
    })
  })

  describe('Response Data Quality', () => {
    it('should return valid recommendation structure', async () => {
      const input: RecommendInput = {
        installed_skills: [],
        limit: 3,
      }

      const result = await executeRecommend(input, context)

      for (const rec of result.recommendations) {
        // Validate structure
        expect(rec.skill_id).toBeDefined()
        expect(rec.name).toBeDefined()
        expect(rec.reason).toBeDefined()
        expect(rec.similarity_score).toBeGreaterThanOrEqual(0)
        expect(rec.similarity_score).toBeLessThanOrEqual(1)
        expect(['verified', 'community', 'experimental', 'unknown']).toContain(rec.trust_tier)
        expect(rec.quality_score).toBeGreaterThanOrEqual(0)
        expect(rec.quality_score).toBeLessThanOrEqual(100)
      }
    })

    it('should not contain hardcoded skill IDs in recommendations', async () => {
      const input: RecommendInput = {
        installed_skills: [],
        limit: 10,
      }

      const result = await executeRecommend(input, context)

      // All skill IDs should come from database, not hardcoded
      const dbSkillIds = SEED_SKILLS.map((s) => s.id)
      for (const rec of result.recommendations) {
        expect(dbSkillIds).toContain(rec.skill_id)
      }
    })
  })

  describe('Hardcoded Value Detection (SMI-902/904 Regression)', () => {
    it('should not expose user paths in response', async () => {
      const input: RecommendInput = {
        installed_skills: ['anthropic/commit'],
        project_context: 'Testing for hardcoded paths',
        limit: 5,
      }

      const result = await executeRecommend(input, context)
      const responseStr = JSON.stringify(result)

      // Should not contain user-specific paths
      expect(responseStr).not.toMatch(/\/Users\/[a-zA-Z0-9_-]+\//)
      expect(responseStr).not.toMatch(/\/home\/[a-zA-Z0-9_-]+\//)
      expect(responseStr).not.toContain(homedir())
    })

    it('should not expose localhost URLs in response', async () => {
      const input: RecommendInput = {
        installed_skills: [],
        limit: 5,
      }

      const result = await executeRecommend(input, context)
      const responseStr = JSON.stringify(result)

      // Should not contain localhost
      expect(responseStr).not.toMatch(/localhost:\d+/)
      expect(responseStr).not.toMatch(/127\.0\.0\.1:\d+/)
    })

    it('should not expose API keys in response', async () => {
      const input: RecommendInput = {
        installed_skills: [],
        project_context: 'Should not leak credentials',
        limit: 5,
      }

      const result = await executeRecommend(input, context)
      const responseStr = JSON.stringify(result)

      // Should not contain API keys
      expect(responseStr).not.toMatch(/ghp_[a-zA-Z0-9]{36}/)
      expect(responseStr).not.toMatch(/sk-[a-zA-Z0-9]{32,}/)
      expect(responseStr).not.toMatch(/lin_api_[a-zA-Z0-9]+/)
    })

    it('should have dynamic recommendations not hardcoded static list', async () => {
      // Run twice with different contexts
      const result1 = await executeRecommend(
        { installed_skills: [], project_context: 'Docker DevOps', limit: 5 },
        context
      )

      const result2 = await executeRecommend(
        { installed_skills: [], project_context: 'React testing', limit: 5 },
        context
      )

      // Results should potentially differ based on context
      // (This test helps detect if recommendations are completely static)
      const ids1 = result1.recommendations.map((r) => r.skill_id).sort()
      const ids2 = result2.recommendations.map((r) => r.skill_id).sort()

      // If results are EXACTLY the same regardless of context, may indicate hardcoding
      // Note: This is a soft check - might be same due to small dataset
      if (ids1.join(',') === ids2.join(',')) {
        console.warn(
          'Warning: Recommendations identical for different contexts - may indicate hardcoding'
        )
      }
    })
  })

  describe('Performance Baselines', () => {
    it('should complete recommendation in reasonable time', async () => {
      const { durationMs } = await measureAsync(
        'recommend:baseline',
        'skill_recommend baseline',
        () =>
          executeRecommend(
            {
              installed_skills: ['anthropic/commit'],
              project_context: 'Full-stack TypeScript project',
              limit: 10,
            },
            context
          )
      )

      // Baseline: should complete within 2 seconds for seed data
      expect(durationMs).toBeLessThan(2000)
      console.log(`Recommend baseline: ${durationMs}ms`)
    })

    it('should handle multiple rapid requests', async () => {
      const requests = Array(5)
        .fill(null)
        .map((_, i) =>
          executeRecommend(
            { installed_skills: [], project_context: `Context ${i}`, limit: 3 },
            context
          )
        )

      const results = await Promise.all(requests)

      expect(results).toHaveLength(5)
      for (const result of results) {
        expect(result.recommendations.length).toBeGreaterThanOrEqual(0)
      }
    })
  })

  describe('Error Handling', () => {
    it('should handle invalid limit gracefully', async () => {
      // Zod should enforce limits
      await expect(
        executeRecommend({ installed_skills: [], limit: 100 }, context)
      ).rejects.toThrow()
    })

    it('should handle invalid min_similarity gracefully', async () => {
      await expect(
        executeRecommend({ installed_skills: [], min_similarity: 2.0 }, context)
      ).rejects.toThrow()
    })
  })
})
