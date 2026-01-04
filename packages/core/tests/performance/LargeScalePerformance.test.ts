/**
 * SMI-867: Performance test suite for large-scale data
 *
 * Benchmarks:
 * - Search latency at different scales (100, 1000, 4000 skills)
 * - Concurrent search performance (10, 50 concurrent searches)
 * - Memory usage monitoring (idle and during search)
 * - FTS5 index rebuild performance
 *
 * Uses Vitest with performance.now() for timing
 * Exports results to JSON for tracking/CI integration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createDatabase, closeDatabase } from '../../src/db/schema.js'
import { SkillRepository } from '../../src/repositories/SkillRepository.js'
import { SearchService } from '../../src/services/SearchService.js'
import { calculateLatencyStats, type LatencyStats } from '../../src/benchmarks/stats.js'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

/**
 * Performance targets from SMI-867 specification
 */
const PERFORMANCE_TARGETS = {
  searchLatency100: { p95_ms: 100 },
  searchLatency1000: { p95_ms: 200 },
  searchLatency4000: { p95_ms: 500 },
  concurrentSearches10: { total_ms: 1000 },
  concurrentSearches50: { total_ms: 3000 },
  memoryIdle: { max_mb: 100 },
  memorySearch: { max_mb: 300 },
  fts5IndexRebuild: { max_ms: 30000 },
}

/**
 * Test results structure for export
 */
interface PerformanceResults {
  timestamp: string
  environment: {
    nodeVersion: string
    platform: string
    arch: string
  }
  tests: Record<string, TestResult>
  summary: {
    passed: number
    failed: number
    total: number
  }
}

interface TestResult {
  name: string
  passed: boolean
  target: Record<string, number>
  actual: Record<string, number>
  stats?: LatencyStats
}

/**
 * Skill factory for generating test data
 */
class SkillFactory {
  private static readonly LANGUAGES = [
    'TypeScript',
    'JavaScript',
    'Python',
    'Go',
    'Rust',
    'Java',
    'Ruby',
    'PHP',
    'CSharp',
    'Kotlin',
  ]

  private static readonly CATEGORIES = [
    'formatting',
    'linting',
    'testing',
    'deployment',
    'documentation',
    'security',
    'debugging',
    'profiling',
    'bundling',
    'monitoring',
  ]

  private static readonly TRUST_TIERS: Array<
    'verified' | 'community' | 'experimental' | 'unknown'
  > = ['verified', 'community', 'experimental', 'unknown']

  private static readonly AUTHORS = [
    'developer-one',
    'developer-two',
    'developer-three',
    'org-alpha',
    'org-beta',
    'team-gamma',
    'contributor-delta',
    'maintainer-epsilon',
  ]

  private static readonly ADJECTIVES = [
    'advanced',
    'simple',
    'fast',
    'comprehensive',
    'lightweight',
    'powerful',
    'modern',
    'classic',
    'enhanced',
    'optimized',
  ]

  /**
   * Generate a batch of unique skills
   */
  static generateSkills(count: number): Array<{
    name: string
    description: string
    author: string
    tags: string[]
    qualityScore: number
    trustTier: 'verified' | 'community' | 'experimental' | 'unknown'
  }> {
    return Array.from({ length: count }, (_, i) => {
      const lang = this.LANGUAGES[i % this.LANGUAGES.length]
      const category = this.CATEGORIES[i % this.CATEGORIES.length]
      const tier = this.TRUST_TIERS[i % this.TRUST_TIERS.length]
      const adjective = this.ADJECTIVES[i % this.ADJECTIVES.length]
      const author = this.AUTHORS[i % this.AUTHORS.length]

      // Create unique identifier using letter combinations instead of numbers
      const uniqueId = this.generateUniqueId(i)

      return {
        name: `${adjective} ${lang} ${category} skill ${uniqueId}`,
        description:
          `A comprehensive ${category} skill for ${lang} code with ${adjective} features. ` +
          `Includes best practices support, customizable configuration, and seamless integration. ` +
          `This skill helps developers improve their ${lang} workflow with ${category} capabilities.`,
        author,
        tags: [
          lang.toLowerCase(),
          category,
          'skill',
          i % 2 === 0 ? 'popular' : 'niche',
          i % 3 === 0 ? 'recommended' : 'standard',
        ],
        qualityScore: 0.5 + Math.random() * 0.5, // 0.5 to 1.0
        trustTier: tier,
      }
    })
  }

  /**
   * Generate unique ID using letter combinations (avoids FTS5 numeric parsing issues)
   */
  private static generateUniqueId(index: number): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz'
    let result = ''
    let n = index

    // Convert index to base-26 letter representation
    do {
      result = chars[n % 26] + result
      n = Math.floor(n / 26)
    } while (n > 0)

    return result.padStart(3, 'a')
  }
}

/**
 * Memory monitoring utility
 */
class MemoryMonitor {
  private baseline: NodeJS.MemoryUsage | null = null

  /**
   * Capture baseline memory usage
   */
  captureBaseline(): void {
    if (global.gc) {
      global.gc()
    }
    this.baseline = process.memoryUsage()
  }

  /**
   * Get current memory usage in MB
   */
  getCurrentMB(): number {
    const usage = process.memoryUsage()
    return usage.heapUsed / (1024 * 1024)
  }

  /**
   * Get memory delta from baseline in MB
   */
  getDeltaMB(): number {
    if (!this.baseline) return this.getCurrentMB()

    const current = process.memoryUsage()
    return (current.heapUsed - this.baseline.heapUsed) / (1024 * 1024)
  }

  /**
   * Get RSS (Resident Set Size) in MB
   */
  getRssMB(): number {
    return process.memoryUsage().rss / (1024 * 1024)
  }

  /**
   * Force garbage collection if available
   */
  forceGC(): void {
    if (global.gc) {
      global.gc()
    }
  }
}

/**
 * Results exporter
 */
class ResultsExporter {
  private results: PerformanceResults

  constructor() {
    this.results = {
      timestamp: new Date().toISOString(),
      environment: {
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
      },
      tests: {},
      summary: {
        passed: 0,
        failed: 0,
        total: 0,
      },
    }
  }

  addResult(result: TestResult): void {
    this.results.tests[result.name] = result
    this.results.summary.total++
    if (result.passed) {
      this.results.summary.passed++
    } else {
      this.results.summary.failed++
    }
  }

  export(outputPath: string): void {
    const dir = dirname(outputPath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    writeFileSync(outputPath, JSON.stringify(this.results, null, 2))
  }

  getResults(): PerformanceResults {
    return this.results
  }
}

// Module-level state for test coordination
let resultsExporter: ResultsExporter

describe('SMI-867: Large-Scale Performance Tests', () => {
  beforeAll(() => {
    resultsExporter = new ResultsExporter()
  })

  afterAll(() => {
    // Export results to JSON
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const outputPath = join(__dirname, '../../output/performance-results.json')
    resultsExporter.export(outputPath)

    // Log summary
    const results = resultsExporter.getResults()
    console.log('\n--- Performance Test Summary ---')
    console.log(`Passed: ${results.summary.passed}/${results.summary.total}`)
    console.log(`Output: ${outputPath}`)
  })

  describe('Search Latency Benchmarks', () => {
    /**
     * Helper to run search latency benchmark
     */
    async function runLatencyBenchmark(
      skillCount: number,
      targetP95Ms: number,
      iterations: number = 100
    ): Promise<{ stats: LatencyStats; passed: boolean }> {
      const db = createDatabase(':memory:')
      const repo = new SkillRepository(db)
      const search = new SearchService(db, { cacheTtl: 0 }) // Disable cache for accurate measurement

      try {
        // Seed data
        const skills = SkillFactory.generateSkills(skillCount)
        repo.createBatch(skills)

        // Warmup (5 iterations)
        for (let i = 0; i < 5; i++) {
          search.search({ query: 'typescript' })
          search.clearCache()
        }

        // Collect latencies
        const latencies: number[] = []
        const queries = ['typescript', 'python', 'testing', 'security', 'skill']

        for (let i = 0; i < iterations; i++) {
          const query = queries[i % queries.length]
          search.clearCache()

          const start = performance.now()
          search.search({ query, limit: 20 })
          const end = performance.now()

          latencies.push(end - start)
        }

        const stats = calculateLatencyStats(latencies)
        const passed = stats.p95 <= targetP95Ms

        return { stats, passed }
      } finally {
        closeDatabase(db)
      }
    }

    it('should search 100 skills with p95 < 100ms', async () => {
      const { stats, passed } = await runLatencyBenchmark(100, 100)

      resultsExporter.addResult({
        name: 'searchLatency100',
        passed,
        target: { p95_ms: 100 },
        actual: { p95_ms: Math.round(stats.p95 * 100) / 100 },
        stats,
      })

      expect(stats.p95).toBeLessThanOrEqual(PERFORMANCE_TARGETS.searchLatency100.p95_ms)
    })

    it('should search 1000 skills with p95 < 200ms', async () => {
      const { stats, passed } = await runLatencyBenchmark(1000, 200)

      resultsExporter.addResult({
        name: 'searchLatency1000',
        passed,
        target: { p95_ms: 200 },
        actual: { p95_ms: Math.round(stats.p95 * 100) / 100 },
        stats,
      })

      expect(stats.p95).toBeLessThanOrEqual(PERFORMANCE_TARGETS.searchLatency1000.p95_ms)
    })

    it('should search 4000 skills with p95 < 500ms', async () => {
      const { stats, passed } = await runLatencyBenchmark(4000, 500, 50) // Fewer iterations for larger dataset

      resultsExporter.addResult({
        name: 'searchLatency4000',
        passed,
        target: { p95_ms: 500 },
        actual: { p95_ms: Math.round(stats.p95 * 100) / 100 },
        stats,
      })

      expect(stats.p95).toBeLessThanOrEqual(PERFORMANCE_TARGETS.searchLatency4000.p95_ms)
    })
  })

  describe('Concurrent Search Benchmarks', () => {
    /**
     * Helper to run concurrent search benchmark
     */
    async function runConcurrentBenchmark(
      concurrency: number,
      maxTotalMs: number
    ): Promise<{ totalMs: number; passed: boolean; individualLatencies: number[] }> {
      const db = createDatabase(':memory:')
      const repo = new SkillRepository(db)
      const search = new SearchService(db, { cacheTtl: 60 })

      try {
        // Seed data with 1000 skills
        const skills = SkillFactory.generateSkills(1000)
        repo.createBatch(skills)

        // Warmup
        search.search({ query: 'typescript' })

        const queries = [
          'typescript formatting',
          'python testing',
          'javascript linting',
          'security analysis',
          'rust performance',
          'go deployment',
          'java debugging',
          'ruby documentation',
        ]

        const individualLatencies: number[] = []

        // Run concurrent searches
        const start = performance.now()

        const promises = Array.from({ length: concurrency }, async (_, i) => {
          const query = queries[i % queries.length]
          const searchStart = performance.now()
          const result = search.search({ query, limit: 10 })
          const searchEnd = performance.now()
          individualLatencies.push(searchEnd - searchStart)
          return result
        })

        await Promise.all(promises)

        const end = performance.now()
        const totalMs = end - start
        const passed = totalMs <= maxTotalMs

        return { totalMs, passed, individualLatencies }
      } finally {
        closeDatabase(db)
      }
    }

    it('should complete 10 concurrent searches in < 1s', async () => {
      const { totalMs, passed, individualLatencies } = await runConcurrentBenchmark(10, 1000)

      const stats = calculateLatencyStats(individualLatencies)

      resultsExporter.addResult({
        name: 'concurrentSearches10',
        passed,
        target: { total_ms: 1000 },
        actual: { total_ms: Math.round(totalMs * 100) / 100 },
        stats,
      })

      expect(totalMs).toBeLessThanOrEqual(PERFORMANCE_TARGETS.concurrentSearches10.total_ms)
    })

    it('should complete 50 concurrent searches in < 3s', async () => {
      const { totalMs, passed, individualLatencies } = await runConcurrentBenchmark(50, 3000)

      const stats = calculateLatencyStats(individualLatencies)

      resultsExporter.addResult({
        name: 'concurrentSearches50',
        passed,
        target: { total_ms: 3000 },
        actual: { total_ms: Math.round(totalMs * 100) / 100 },
        stats,
      })

      expect(totalMs).toBeLessThanOrEqual(PERFORMANCE_TARGETS.concurrentSearches50.total_ms)
    })
  })

  describe('Memory Usage Benchmarks', () => {
    const memoryMonitor = new MemoryMonitor()

    it('should use < 100MB memory when idle', () => {
      memoryMonitor.forceGC()

      const db = createDatabase(':memory:')
      const repo = new SkillRepository(db)
      const _search = new SearchService(db, { cacheTtl: 60 })

      try {
        // Seed with 1000 skills
        const skills = SkillFactory.generateSkills(1000)
        repo.createBatch(skills)

        memoryMonitor.forceGC()

        const heapUsedMB = memoryMonitor.getCurrentMB()
        const passed = heapUsedMB <= PERFORMANCE_TARGETS.memoryIdle.max_mb

        resultsExporter.addResult({
          name: 'memoryIdle',
          passed,
          target: { max_mb: 100 },
          actual: { heap_mb: Math.round(heapUsedMB * 100) / 100 },
        })

        expect(heapUsedMB).toBeLessThanOrEqual(PERFORMANCE_TARGETS.memoryIdle.max_mb)
      } finally {
        closeDatabase(db)
      }
    })

    it('should use < 300MB memory during search operations', () => {
      memoryMonitor.forceGC()
      memoryMonitor.captureBaseline()

      const db = createDatabase(':memory:')
      const repo = new SkillRepository(db)
      const search = new SearchService(db, { cacheTtl: 0 }) // Disable cache to force full searches

      try {
        // Seed with 4000 skills
        const skills = SkillFactory.generateSkills(4000)
        repo.createBatch(skills)

        // Track peak memory during searches
        let peakMemoryMB = 0

        // Perform many searches to stress memory
        const queries = ['typescript', 'python', 'testing', 'security', 'deployment']

        for (let i = 0; i < 100; i++) {
          const query = queries[i % queries.length]
          search.search({ query, limit: 50 })
          search.clearCache()

          const currentMB = memoryMonitor.getCurrentMB()
          if (currentMB > peakMemoryMB) {
            peakMemoryMB = currentMB
          }
        }

        const passed = peakMemoryMB <= PERFORMANCE_TARGETS.memorySearch.max_mb

        resultsExporter.addResult({
          name: 'memorySearch',
          passed,
          target: { max_mb: 300 },
          actual: { peak_mb: Math.round(peakMemoryMB * 100) / 100 },
        })

        expect(peakMemoryMB).toBeLessThanOrEqual(PERFORMANCE_TARGETS.memorySearch.max_mb)
      } finally {
        closeDatabase(db)
        memoryMonitor.forceGC()
      }
    })
  })

  describe('FTS5 Index Rebuild Benchmark', () => {
    it('should rebuild FTS5 index for 4000 skills in < 30s', () => {
      const db = createDatabase(':memory:')
      const repo = new SkillRepository(db)

      try {
        // First, populate the database without FTS triggers
        // Then manually rebuild the FTS index

        // Seed data
        const skills = SkillFactory.generateSkills(4000)

        // Insert via batch (this uses triggers)
        const insertStart = performance.now()
        repo.createBatch(skills)
        const insertEnd = performance.now()
        const insertTimeMs = insertEnd - insertStart

        // Now test FTS rebuild by:
        // 1. Dropping and recreating the FTS table
        // 2. Repopulating from skills table
        const rebuildStart = performance.now()

        // Drop existing FTS data
        db.exec("INSERT INTO skills_fts(skills_fts) VALUES('delete-all')")

        // Rebuild from scratch
        db.exec(`
          INSERT INTO skills_fts(rowid, name, description, tags, author)
          SELECT rowid, name, description, tags, author FROM skills
        `)

        const rebuildEnd = performance.now()
        const rebuildTimeMs = rebuildEnd - rebuildStart
        const totalTimeMs = insertTimeMs + rebuildTimeMs

        const passed = totalTimeMs <= PERFORMANCE_TARGETS.fts5IndexRebuild.max_ms

        resultsExporter.addResult({
          name: 'fts5IndexRebuild',
          passed,
          target: { max_ms: 30000 },
          actual: {
            total_ms: Math.round(totalTimeMs * 100) / 100,
            insert_ms: Math.round(insertTimeMs * 100) / 100,
            rebuild_ms: Math.round(rebuildTimeMs * 100) / 100,
          },
        })

        expect(totalTimeMs).toBeLessThanOrEqual(PERFORMANCE_TARGETS.fts5IndexRebuild.max_ms)

        // Verify index is functional
        const searchService = new SearchService(db, { cacheTtl: 0 })
        const results = searchService.search({ query: 'typescript' })
        expect(results.total).toBeGreaterThan(0)
      } finally {
        closeDatabase(db)
      }
    })
  })

  describe('Detailed Statistics', () => {
    it('should capture p50, p95, p99 latencies for 1000 skills', async () => {
      const db = createDatabase(':memory:')
      const repo = new SkillRepository(db)
      const search = new SearchService(db, { cacheTtl: 0 })

      try {
        // Seed data
        const skills = SkillFactory.generateSkills(1000)
        repo.createBatch(skills)

        // Warmup
        for (let i = 0; i < 10; i++) {
          search.search({ query: 'typescript' })
          search.clearCache()
        }

        // Collect latencies from multiple query types
        const latencies: number[] = []
        const queryTypes = [
          { query: 'typescript' }, // Simple term
          { query: 'python testing' }, // Multi-term
          { query: 'skill', trustTier: 'verified' as const }, // Filtered
          { query: 'formatting', limit: 50 }, // Large result set
          { query: 'nonexistent' }, // No results
        ]

        // 200 iterations total (40 per query type)
        for (let i = 0; i < 200; i++) {
          const queryConfig = queryTypes[i % queryTypes.length]
          search.clearCache()

          const start = performance.now()
          search.search(queryConfig)
          const end = performance.now()

          latencies.push(end - start)
        }

        const stats = calculateLatencyStats(latencies)

        resultsExporter.addResult({
          name: 'detailedLatencyStats',
          passed: true,
          target: {},
          actual: {
            p50_ms: stats.p50,
            p95_ms: stats.p95,
            p99_ms: stats.p99,
            mean_ms: stats.mean,
            stddev_ms: stats.stddev,
            min_ms: stats.min,
            max_ms: stats.max,
            count: stats.count,
          },
          stats,
        })

        // Log detailed stats
        console.log('\n--- Detailed Latency Statistics (1000 skills) ---')
        console.log(`  p50: ${stats.p50.toFixed(2)}ms`)
        console.log(`  p95: ${stats.p95.toFixed(2)}ms`)
        console.log(`  p99: ${stats.p99.toFixed(2)}ms`)
        console.log(`  mean: ${stats.mean.toFixed(2)}ms`)
        console.log(`  stddev: ${stats.stddev.toFixed(2)}ms`)
        console.log(`  min: ${stats.min.toFixed(2)}ms`)
        console.log(`  max: ${stats.max.toFixed(2)}ms`)

        // Sanity checks
        expect(stats.p50).toBeLessThan(stats.p95)
        expect(stats.p95).toBeLessThan(stats.p99)
        expect(stats.min).toBeLessThanOrEqual(stats.p50)
        expect(stats.p99).toBeLessThanOrEqual(stats.max)
      } finally {
        closeDatabase(db)
      }
    })
  })
})
