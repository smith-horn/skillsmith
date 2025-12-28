/**
 * SMI-632: IndexBenchmark - Indexing throughput benchmarks
 *
 * Features:
 * - Batch insert performance
 * - Update performance
 * - Database size impact
 * - FTS5 index maintenance
 */

import type { Database as DatabaseType } from 'better-sqlite3'
import { createDatabase, closeDatabase } from '../db/schema.js'
import { SkillRepository } from '../repositories/SkillRepository.js'
import { BenchmarkRunner, type BenchmarkReport, type BenchmarkConfig } from './BenchmarkRunner.js'
import { percentile, mean } from './stats.js'

/**
 * Index benchmark configuration
 */
export interface IndexBenchmarkConfig extends BenchmarkConfig {
  /** Batch size for insert operations */
  batchSize?: number
  /** Number of skills for size impact tests */
  baseDatabaseSize?: number
}

const DEFAULT_CONFIG: Required<IndexBenchmarkConfig> = {
  warmupIterations: 3,
  iterations: 100,
  measureMemory: true,
  suiteName: 'index',
  batchSize: 100,
  baseDatabaseSize: 1000,
}

/**
 * Performance targets for indexing operations
 */
export const INDEX_TARGETS = {
  /** Skills indexed per second for batch inserts */
  throughput_skills_per_sec: 100,
  /** Maximum time for single insert (ms) */
  single_insert_max_ms: 50,
  /** Maximum time for batch of 100 inserts (ms) */
  batch_100_max_ms: 500,
}

/**
 * Indexing benchmark suite
 */
export class IndexBenchmark {
  private config: Required<IndexBenchmarkConfig>
  private db: DatabaseType | null = null
  private repo: SkillRepository | null = null
  private skillCounter: number = 0

  constructor(config: IndexBenchmarkConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Run all indexing benchmarks
   */
  async run(): Promise<BenchmarkReport> {
    const runner = new BenchmarkRunner({
      warmupIterations: this.config.warmupIterations,
      iterations: this.config.iterations,
      measureMemory: this.config.measureMemory,
      suiteName: this.config.suiteName,
    })

    // Single insert benchmark
    runner.add({
      name: 'single_insert',
      setup: async () => {
        await this.setup()
        this.skillCounter = 0
      },
      fn: () => {
        this.skillCounter++
        this.repo!.create({
          name: `Benchmark Skill ${this.skillCounter}`,
          description: `Description for skill ${this.skillCounter}`,
          author: 'benchmark',
          tags: ['benchmark', 'test'],
        })
      },
      teardown: async () => {
        await this.teardown()
      },
    })

    // Batch insert benchmark (100 skills)
    runner.add({
      name: 'batch_insert_100',
      setup: async () => {
        await this.setup()
        this.skillCounter = 0
      },
      fn: () => {
        const skills = this.generateBatchSkills(100)
        this.repo!.createBatch(skills)
      },
      teardown: async () => {
        await this.teardown()
      },
    })

    // Batch insert benchmark (1000 skills)
    runner.add({
      name: 'batch_insert_1000',
      setup: async () => {
        await this.setup()
        this.skillCounter = 0
      },
      fn: () => {
        const skills = this.generateBatchSkills(1000)
        this.repo!.createBatch(skills)
      },
      teardown: async () => {
        await this.teardown()
      },
    })

    // Update benchmark
    runner.add({
      name: 'update_skill',
      setup: async () => {
        await this.setup()
        // Seed skills to update
        const skills = this.generateBatchSkills(this.config.iterations + 100)
        this.repo!.createBatch(skills)
        this.skillCounter = 0
      },
      fn: () => {
        const skills = this.repo!.findAll(1, this.skillCounter)
        if (skills.items.length > 0) {
          this.repo!.update(skills.items[0].id, {
            description: `Updated description ${Date.now()}`,
            qualityScore: Math.random(),
          })
        }
        this.skillCounter++
      },
      teardown: async () => {
        await this.teardown()
      },
    })

    // Delete benchmark
    runner.add({
      name: 'delete_skill',
      setup: async () => {
        await this.setup()
        // Seed skills to delete
        const skills = this.generateBatchSkills(this.config.iterations + 100)
        this.repo!.createBatch(skills)
      },
      fn: () => {
        const skills = this.repo!.findAll(1, 0)
        if (skills.items.length > 0) {
          this.repo!.delete(skills.items[0].id)
        }
      },
      teardown: async () => {
        await this.teardown()
      },
    })

    // Upsert benchmark (mix of insert and update)
    runner.add({
      name: 'upsert_skill',
      setup: async () => {
        await this.setup()
        // Seed some initial skills
        const skills = this.generateBatchSkills(50)
        this.repo!.createBatch(skills)
        this.skillCounter = 0
      },
      fn: () => {
        const isUpdate = this.skillCounter % 2 === 0
        const repoUrl = isUpdate
          ? `https://github.com/benchmark/skill-0`
          : `https://github.com/benchmark/new-skill-${this.skillCounter}`

        this.repo!.upsert({
          name: `Upserted Skill ${this.skillCounter}`,
          description: `Description ${this.skillCounter}`,
          author: 'benchmark',
          repoUrl,
          tags: ['upsert', 'test'],
        })
        this.skillCounter++
      },
      teardown: async () => {
        await this.teardown()
      },
    })

    // Run benchmarks
    return await runner.run()
  }

  /**
   * Run throughput benchmark (measures skills per second)
   */
  async runThroughput(): Promise<ThroughputResult> {
    await this.setup()

    const batchSizes = [10, 50, 100, 500, 1000]
    const results: ThroughputResult['results'] = {}

    for (const batchSize of batchSizes) {
      // Create a fresh database for each batch size test
      await this.teardown()
      await this.setup()

      const skills = this.generateBatchSkills(batchSize)

      const start = performance.now()
      this.repo!.createBatch(skills)
      const duration = performance.now() - start

      const throughput = (batchSize / duration) * 1000 // skills per second

      results[`batch_${batchSize}`] = {
        batchSize,
        duration_ms: Math.round(duration * 100) / 100,
        throughput_per_sec: Math.round(throughput * 100) / 100,
        meetsTarget: throughput >= INDEX_TARGETS.throughput_skills_per_sec,
      }
    }

    await this.teardown()

    return {
      timestamp: new Date().toISOString(),
      results,
    }
  }

  /**
   * Run database size impact benchmark
   */
  async runSizeImpact(): Promise<SizeImpactResult> {
    const sizes = [100, 500, 1000, 5000, 10000]
    const results: SizeImpactResult['results'] = {}

    for (const size of sizes) {
      await this.setup()

      // Seed the database to target size
      const seedSkills = this.generateBatchSkills(size)
      this.repo!.createBatch(seedSkills)

      // Measure insert time at this database size
      const insertTimes: number[] = []
      for (let i = 0; i < 100; i++) {
        const start = performance.now()
        this.repo!.create({
          name: `Extra Skill ${i}`,
          description: `Description at size ${size}`,
          author: 'benchmark',
          tags: ['size-test'],
        })
        insertTimes.push(performance.now() - start)
      }

      const sortedTimes = insertTimes.sort((a, b) => a - b)

      // SMI-677: Use shared stats utilities for consistent percentile calculations
      results[`size_${size}`] = {
        databaseSize: size,
        avgInsert_ms: Math.round(mean(sortedTimes) * 1000) / 1000,
        p50Insert_ms: percentile(sortedTimes, 50),
        p95Insert_ms: percentile(sortedTimes, 95),
      }

      await this.teardown()
    }

    return {
      timestamp: new Date().toISOString(),
      results,
    }
  }

  /**
   * Setup database
   */
  private async setup(): Promise<void> {
    this.db = createDatabase(':memory:')
    this.repo = new SkillRepository(this.db)
    this.skillCounter = 0
  }

  /**
   * Cleanup database resources
   */
  private async teardown(): Promise<void> {
    if (this.db) {
      closeDatabase(this.db)
      this.db = null
      this.repo = null
    }
  }

  /**
   * Generate a batch of test skills
   */
  private generateBatchSkills(count: number): Array<{
    name: string
    description: string
    author: string
    repoUrl: string
    tags: string[]
    qualityScore: number
    trustTier: 'verified' | 'community' | 'experimental' | 'unknown'
  }> {
    const startId = this.skillCounter
    this.skillCounter += count

    return Array.from({ length: count }, (_, i) => ({
      name: `Batch Skill ${startId + i}`,
      description: `Description for batch skill ${startId + i} with some searchable content`,
      author: 'benchmark',
      repoUrl: `https://github.com/benchmark/skill-${startId + i}`,
      tags: ['batch', 'benchmark', i % 2 === 0 ? 'even' : 'odd'],
      qualityScore: 0.5 + Math.random() * 0.5,
      trustTier: (['verified', 'community', 'experimental', 'unknown'] as const)[i % 4],
    }))
  }
}

/**
 * Throughput benchmark result
 */
export interface ThroughputResult {
  timestamp: string
  results: Record<
    string,
    {
      batchSize: number
      duration_ms: number
      throughput_per_sec: number
      meetsTarget: boolean
    }
  >
}

/**
 * Size impact benchmark result
 */
export interface SizeImpactResult {
  timestamp: string
  results: Record<
    string,
    {
      databaseSize: number
      avgInsert_ms: number
      p50Insert_ms: number
      p95Insert_ms: number
    }
  >
}

/**
 * Validate indexing benchmark results against targets
 */
export function validateIndexResults(report: BenchmarkReport): IndexValidationResult {
  const failures: string[] = []
  const warnings: string[] = []

  // Check single insert
  const singleInsert = report.results['single_insert']
  if (singleInsert && singleInsert.p95_ms > INDEX_TARGETS.single_insert_max_ms) {
    failures.push(
      `single_insert: p95 (${singleInsert.p95_ms}ms) exceeds target (${INDEX_TARGETS.single_insert_max_ms}ms)`
    )
  }

  // Check batch insert
  const batchInsert = report.results['batch_insert_100']
  if (batchInsert && batchInsert.p95_ms > INDEX_TARGETS.batch_100_max_ms) {
    failures.push(
      `batch_insert_100: p95 (${batchInsert.p95_ms}ms) exceeds target (${INDEX_TARGETS.batch_100_max_ms}ms)`
    )
  }

  // Check throughput for batch of 1000
  const batch1000 = report.results['batch_insert_1000']
  if (batch1000) {
    const throughput = (1000 / batch1000.mean_ms) * 1000 // skills per second
    if (throughput < INDEX_TARGETS.throughput_skills_per_sec) {
      warnings.push(
        `batch_insert_1000: throughput (${Math.round(throughput)} skills/sec) below target (${INDEX_TARGETS.throughput_skills_per_sec} skills/sec)`
      )
    }
  }

  return {
    passed: failures.length === 0,
    failures,
    warnings,
  }
}

/**
 * Index validation result
 */
export interface IndexValidationResult {
  passed: boolean
  failures: string[]
  warnings: string[]
}
