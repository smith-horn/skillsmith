/**
 * Performance Validation Tests
 *
 * Validates that search and retrieval operations meet performance requirements.
 * Tests are designed to catch performance regressions.
 *
 * @see SMI-797: Performance validation
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
import { executeSearch } from '../../src/tools/search.js'
import { executeGetSkill } from '../../src/tools/get-skill.js'

// Generate bulk test data
function generateSkills(count: number): SkillCreateInput[] {
  const trustTiers: ('verified' | 'community' | 'experimental')[] = [
    'verified',
    'community',
    'experimental',
  ]
  const categories = ['development', 'testing', 'devops', 'database', 'security']

  return Array.from({ length: count }, (_, i) => ({
    id: `test-org/skill-${i}`,
    name: `skill-${i}`,
    description: `Test skill number ${i} for performance testing. This skill helps with ${categories[i % categories.length]} tasks.`,
    author: `author-${i % 10}`,
    repoUrl: `https://github.com/test-org/skill-${i}`,
    qualityScore: 0.5 + (i % 50) / 100,
    trustTier: trustTiers[i % trustTiers.length],
    tags: [categories[i % categories.length], `tag-${i % 20}`, `group-${i % 5}`],
  }))
}

describe('SMI-797: Performance Validation', () => {
  let db: DatabaseType
  let context: ToolContext
  let testDbPath: string
  const SKILL_COUNT = 500

  beforeAll(() => {
    // Create isolated test database
    const testDir = join(tmpdir(), 'skillsmith-perf-test')
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true })
    }
    testDbPath = join(testDir, `perf-test-${Date.now()}.db`)

    // Initialize database with bulk data
    db = createDatabase(testDbPath)
    initializeSchema(db)

    const skillRepository = new SkillRepository(db)
    const skills = generateSkills(SKILL_COUNT)

    // Batch insert for performance
    for (const skill of skills) {
      skillRepository.create(skill)
    }

    // Create context with offline API client for performance testing
    // SMI-1183: Use offline mode to avoid API calls during performance tests
    context = createToolContext({
      dbPath: testDbPath,
      apiClientConfig: { offlineMode: true },
    })
  })

  afterAll(() => {
    db?.close()
    if (testDbPath && existsSync(testDbPath)) {
      rmSync(testDbPath, { force: true })
    }
  })

  describe('Search Performance', () => {
    it('should complete single search under 50ms with 500 skills', async () => {
      const start = performance.now()
      const result = await executeSearch({ query: 'test' }, context)
      const elapsed = performance.now() - start

      expect(elapsed).toBeLessThan(50)
      expect(result.results.length).toBeGreaterThan(0)
    })

    it('should complete filtered search under 50ms', async () => {
      const start = performance.now()
      await executeSearch(
        {
          query: 'development',
          min_score: 60,
        },
        context
      )
      const elapsed = performance.now() - start

      expect(elapsed).toBeLessThan(50)
    })

    it('should handle 10 concurrent searches under 200ms total', async () => {
      const queries = [
        'test',
        'development',
        'testing',
        'devops',
        'database',
        'skill',
        'security',
        'author',
        'group',
        'tag',
      ]

      const start = performance.now()
      const results = await Promise.all(queries.map((query) => executeSearch({ query }, context)))
      const elapsed = performance.now() - start

      expect(elapsed).toBeLessThan(200)
      expect(results.every((r) => r.results !== undefined)).toBe(true)
    })

    it('should maintain sub-100ms response for repeated searches', async () => {
      const timings: number[] = []

      for (let i = 0; i < 20; i++) {
        const start = performance.now()
        await executeSearch({ query: `skill-${i * 10}` }, context)
        timings.push(performance.now() - start)
      }

      const avgTime = timings.reduce((a, b) => a + b, 0) / timings.length
      const maxTime = Math.max(...timings)

      expect(avgTime).toBeLessThan(30)
      expect(maxTime).toBeLessThan(100)
    })
  })

  describe('Get Skill Performance', () => {
    it('should complete single get-skill under 20ms', async () => {
      const start = performance.now()
      const result = await executeGetSkill({ id: 'test-org/skill-0' }, context)
      const elapsed = performance.now() - start

      expect(elapsed).toBeLessThan(20)
      expect(result.skill.id).toBe('test-org/skill-0')
    })

    it('should handle 50 sequential get-skill calls under 500ms', async () => {
      const start = performance.now()

      for (let i = 0; i < 50; i++) {
        await executeGetSkill({ id: `test-org/skill-${i}` }, context)
      }

      const elapsed = performance.now() - start
      expect(elapsed).toBeLessThan(500)
    })

    it('should handle 20 concurrent get-skill calls under 100ms', async () => {
      const ids = Array.from({ length: 20 }, (_, i) => `test-org/skill-${i}`)

      const start = performance.now()
      const results = await Promise.all(ids.map((id) => executeGetSkill({ id }, context)))
      const elapsed = performance.now() - start

      expect(elapsed).toBeLessThan(100)
      expect(results.every((r) => r.skill !== undefined)).toBe(true)
    })
  })

  describe('Combined Flow Performance', () => {
    it('should complete search → get flow under 50ms', async () => {
      const start = performance.now()

      // Search
      const searchResult = await executeSearch({ query: 'test' }, context)
      expect(searchResult.results.length).toBeGreaterThan(0)

      // Get first result
      const firstId = searchResult.results[0].id
      await executeGetSkill({ id: firstId }, context)

      const elapsed = performance.now() - start
      expect(elapsed).toBeLessThan(50)
    })

    it('should complete search → get all results flow under 200ms', async () => {
      const start = performance.now()

      // Search with limit
      const searchResult = await executeSearch({ query: 'test' }, context)

      // Get all results (up to 10)
      const ids = searchResult.results.slice(0, 10).map((r) => r.id)
      await Promise.all(ids.map((id) => executeGetSkill({ id }, context)))

      const elapsed = performance.now() - start
      expect(elapsed).toBeLessThan(200)
    })
  })

  describe('Memory and Resource Usage', () => {
    it('should not leak memory across repeated operations', async () => {
      const initialMemory = process.memoryUsage().heapUsed

      // Perform 100 search operations
      for (let i = 0; i < 100; i++) {
        await executeSearch({ query: `skill-${i}` }, context)
      }

      // Force garbage collection if available
      if (global.gc) {
        global.gc()
      }

      const finalMemory = process.memoryUsage().heapUsed
      const memoryIncrease = (finalMemory - initialMemory) / 1024 / 1024 // MB

      // Allow up to 50MB increase (generous for test stability)
      expect(memoryIncrease).toBeLessThan(50)
    })
  })

  describe('Performance Benchmarks Summary', () => {
    it('should report performance metrics', async () => {
      const metrics = {
        singleSearch: 0,
        singleGet: 0,
        concurrentSearches: 0,
        searchGetFlow: 0,
      }

      // Single search
      let start = performance.now()
      await executeSearch({ query: 'test' }, context)
      metrics.singleSearch = performance.now() - start

      // Single get
      start = performance.now()
      await executeGetSkill({ id: 'test-org/skill-0' }, context)
      metrics.singleGet = performance.now() - start

      // Concurrent searches (10)
      start = performance.now()
      await Promise.all(
        Array.from({ length: 10 }, (_, i) => executeSearch({ query: `skill-${i}` }, context))
      )
      metrics.concurrentSearches = performance.now() - start

      // Search + Get flow
      start = performance.now()
      const result = await executeSearch({ query: 'test' }, context)
      await executeGetSkill({ id: result.results[0].id }, context)
      metrics.searchGetFlow = performance.now() - start

      console.log('Performance Metrics (ms):')
      console.log(`  Single Search: ${metrics.singleSearch.toFixed(2)}`)
      console.log(`  Single Get: ${metrics.singleGet.toFixed(2)}`)
      console.log(`  10 Concurrent Searches: ${metrics.concurrentSearches.toFixed(2)}`)
      console.log(`  Search + Get Flow: ${metrics.searchGetFlow.toFixed(2)}`)

      // Assertions
      expect(metrics.singleSearch).toBeLessThan(50)
      expect(metrics.singleGet).toBeLessThan(20)
      expect(metrics.concurrentSearches).toBeLessThan(200)
      expect(metrics.searchGetFlow).toBeLessThan(50)
    })
  })
})
