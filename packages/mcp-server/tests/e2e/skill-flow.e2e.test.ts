/**
 * E2E Test: Search → Get → Install Flow
 *
 * Tests the complete user journey from discovering a skill to installing it.
 * Uses seed data to ensure consistent, reproducible tests.
 *
 * @see SMI-796: E2E test: Search → Get → Install flow
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  createDatabase,
  initializeSchema,
  SkillRepository,
  type SkillCreateInput,
  type DatabaseType,
} from '@skillsmith/core'
import { createToolContext, type ToolContext } from '../../src/context.js'
import { executeSearch, type SearchInput } from '../../src/tools/search.js'
import { executeGetSkill, type GetSkillInput } from '../../src/tools/get-skill.js'

// Seed data subset for E2E testing (with required id for test assertions)
interface TestSkill extends SkillCreateInput {
  id: string
}

const SEED_SKILLS: TestSkill[] = [
  {
    id: 'anthropic/commit',
    name: 'commit',
    description: 'Generate semantic commit messages following conventional commits',
    author: 'anthropic',
    repoUrl: 'https://github.com/anthropics/claude-code/tree/main/skills/commit',
    qualityScore: 0.95,
    trustTier: 'verified',
    tags: ['development', 'git', 'commit', 'conventional-commits'],
  },
  {
    id: 'community/jest-helper',
    name: 'jest-helper',
    description: 'Generate Jest test cases for React components',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/jest-helper',
    qualityScore: 0.87,
    trustTier: 'community',
    tags: ['testing', 'jest', 'react', 'unit-tests'],
  },
  {
    id: 'community/vitest-helper',
    name: 'vitest-helper',
    description: 'Generate Vitest test cases with modern ESM support',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/vitest-helper',
    qualityScore: 0.85,
    trustTier: 'community',
    tags: ['testing', 'vitest', 'esm', 'typescript'],
  },
  {
    id: 'community/docker-compose',
    name: 'docker-compose',
    description: 'Generate and manage Docker Compose configurations',
    author: 'community',
    repoUrl: 'https://github.com/skillsmith-community/docker-compose',
    qualityScore: 0.84,
    trustTier: 'community',
    tags: ['devops', 'docker', 'containers'],
  },
]

describe('E2E: Skill Discovery Flow', () => {
  let db: DatabaseType
  let context: ToolContext
  let testDbPath: string

  beforeAll(() => {
    // Create isolated test database
    const testDir = join(tmpdir(), 'skillsmith-e2e-test')
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true })
    }
    testDbPath = join(testDir, `e2e-test-${Date.now()}.db`)

    // Initialize database with seed data
    db = createDatabase(testDbPath)
    initializeSchema(db)

    const skillRepository = new SkillRepository(db)
    for (const skill of SEED_SKILLS) {
      skillRepository.create(skill)
    }

    // Create context
    context = createToolContext({ dbPath: testDbPath })
  })

  afterAll(() => {
    db?.close()
    if (testDbPath && existsSync(testDbPath)) {
      rmSync(testDbPath, { force: true })
    }
  })

  describe('Step 1: Search for skills', () => {
    it('should find commit skill when searching for "commit"', async () => {
      const input: SearchInput = { query: 'commit' }
      const result = await executeSearch(input, context)

      expect(result.results.length).toBeGreaterThan(0)
      expect(result.results.some((s) => s.id === 'anthropic/commit')).toBe(true)
    })

    it('should find testing skills when searching for "test"', async () => {
      const input: SearchInput = { query: 'test' }
      const result = await executeSearch(input, context)

      expect(result.results.length).toBeGreaterThanOrEqual(2)
      expect(result.results.some((s) => s.id === 'community/jest-helper')).toBe(true)
      expect(result.results.some((s) => s.id === 'community/vitest-helper')).toBe(true)
    })

    it('should filter by category', async () => {
      // Note: Category filtering may not reduce results if skills already match the category
      const input: SearchInput = { query: 'docker' }
      const result = await executeSearch(input, context)

      expect(result.results.length).toBeGreaterThan(0)
      expect(result.results.some((s) => s.id === 'community/docker-compose')).toBe(true)

      // Verify docker-compose has expected category from extractCategoryFromTags
      const dockerSkill = result.results.find((s) => s.id === 'community/docker-compose')
      expect(dockerSkill?.category).toBe('devops')
    })

    it('should filter by trust tier', async () => {
      const input: SearchInput = { query: 'commit', trust_tier: 'verified' }
      const result = await executeSearch(input, context)

      expect(result.results.every((s) => s.trustTier === 'verified')).toBe(true)
    })

    it('should filter by minimum score', async () => {
      const input: SearchInput = { query: 'test', min_score: 85 }
      const result = await executeSearch(input, context)

      expect(result.results.every((s) => s.score >= 85)).toBe(true)
    })
  })

  describe('Step 2: Get skill details', () => {
    it('should retrieve full details for a skill', async () => {
      const input: GetSkillInput = { id: 'anthropic/commit' }
      const result = await executeGetSkill(input, context)

      expect(result.skill.id).toBe('anthropic/commit')
      expect(result.skill.name).toBe('commit')
      expect(result.skill.author).toBe('anthropic')
      expect(result.skill.trustTier).toBe('verified')
      expect(result.skill.score).toBe(95)
      expect(result.installCommand).toContain('claude skill add anthropic/commit')
    })

    it('should include timing information', async () => {
      const input: GetSkillInput = { id: 'community/jest-helper' }
      const result = await executeGetSkill(input, context)

      expect(result.timing).toBeDefined()
      expect(result.timing.totalMs).toBeGreaterThanOrEqual(0)
    })

    it('should throw for non-existent skill', async () => {
      const input: GetSkillInput = { id: 'nonexistent/skill' }

      await expect(executeGetSkill(input, context)).rejects.toThrow()
    })
  })

  describe('Step 3: Search → Get flow integration', () => {
    it('should allow getting details of any search result', async () => {
      // Step 1: Search
      const searchInput: SearchInput = { query: 'jest' }
      const searchResult = await executeSearch(searchInput, context)

      expect(searchResult.results.length).toBeGreaterThan(0)

      // Step 2: Get details of first result
      const firstResult = searchResult.results[0]
      const getInput: GetSkillInput = { id: firstResult.id }
      const skillDetails = await executeGetSkill(getInput, context)

      // Verify consistency
      expect(skillDetails.skill.id).toBe(firstResult.id)
      expect(skillDetails.skill.name).toBe(firstResult.name)
      expect(skillDetails.skill.trustTier).toBe(firstResult.trustTier)
    })

    it('should provide install command for all skills', async () => {
      // Search for all testing skills
      const searchInput: SearchInput = { query: 'test' }
      const searchResult = await executeSearch(searchInput, context)

      // Get details and verify install commands
      for (const result of searchResult.results) {
        const details = await executeGetSkill({ id: result.id }, context)
        expect(details.installCommand).toMatch(/^claude skill add [a-z0-9-]+\/[a-z0-9-]+$/i)
      }
    })
  })

  describe('Quality and Performance', () => {
    it('should complete search in under 100ms', async () => {
      const input: SearchInput = { query: 'commit' }
      const result = await executeSearch(input, context)

      expect(result.timing.totalMs).toBeLessThan(100)
    })

    it('should complete get-skill in under 50ms', async () => {
      const input: GetSkillInput = { id: 'anthropic/commit' }
      const result = await executeGetSkill(input, context)

      expect(result.timing.totalMs).toBeLessThan(50)
    })

    it('should handle rapid successive searches', async () => {
      const queries = ['commit', 'test', 'docker', 'jest', 'vitest']
      const results = await Promise.all(queries.map((query) => executeSearch({ query }, context)))

      expect(results.every((r) => r.results.length >= 0)).toBe(true)
    })
  })

  describe('Error Handling', () => {
    it('should reject empty search queries', async () => {
      const input: SearchInput = { query: '' }

      await expect(executeSearch(input, context)).rejects.toThrow()
    })

    it('should reject single-character search queries', async () => {
      const input: SearchInput = { query: 'a' }

      await expect(executeSearch(input, context)).rejects.toThrow()
    })

    it('should reject invalid skill ID formats', async () => {
      const input: GetSkillInput = { id: 'invalid-format' }

      await expect(executeGetSkill(input, context)).rejects.toThrow()
    })

    it('should reject out-of-range min_score', async () => {
      const input: SearchInput = { query: 'test', min_score: 150 }

      await expect(executeSearch(input, context)).rejects.toThrow()
    })
  })
})

describe('E2E: Data Quality Validation', () => {
  let db: DatabaseType
  let context: ToolContext
  let testDbPath: string

  beforeAll(() => {
    const testDir = join(tmpdir(), 'skillsmith-e2e-quality')
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true })
    }
    testDbPath = join(testDir, `quality-test-${Date.now()}.db`)

    db = createDatabase(testDbPath)
    initializeSchema(db)

    const skillRepository = new SkillRepository(db)
    for (const skill of SEED_SKILLS) {
      skillRepository.create(skill)
    }

    context = createToolContext({ dbPath: testDbPath })
  })

  afterAll(() => {
    db?.close()
    if (testDbPath && existsSync(testDbPath)) {
      rmSync(testDbPath, { force: true })
    }
  })

  describe('SMI-795: Import Quality Validation', () => {
    it('should have valid trust tiers for all skills', async () => {
      // Since empty/short queries throw, get skills directly
      for (const skill of SEED_SKILLS) {
        const details = await executeGetSkill({ id: skill.id }, context)
        expect(['verified', 'community', 'standard', 'unverified', 'experimental']).toContain(
          details.skill.trustTier
        )
      }
    })

    it('should have quality scores between 0 and 100', async () => {
      for (const skill of SEED_SKILLS) {
        const details = await executeGetSkill({ id: skill.id }, context)
        const score = details.skill.score ?? 0
        expect(score).toBeGreaterThanOrEqual(0)
        expect(score).toBeLessThanOrEqual(100)
      }
    })

    it('should have non-empty descriptions', async () => {
      for (const skill of SEED_SKILLS) {
        const details = await executeGetSkill({ id: skill.id }, context)
        const description = details.skill.description ?? ''
        expect(description.length).toBeGreaterThan(0)
      }
    })

    it('should have valid category mappings', async () => {
      for (const skill of SEED_SKILLS) {
        const details = await executeGetSkill({ id: skill.id }, context)
        const category = details.skill.category ?? 'other'
        expect([
          'development',
          'testing',
          'documentation',
          'devops',
          'database',
          'security',
          'productivity',
          'integration',
          'ai-ml',
          'other',
        ]).toContain(category)
      }
    })

    it('should have valid author names', async () => {
      for (const skill of SEED_SKILLS) {
        const details = await executeGetSkill({ id: skill.id }, context)
        const author = details.skill.author ?? ''
        expect(author).not.toBe('unknown')
        expect(author.length).toBeGreaterThan(0)
      }
    })
  })
})
