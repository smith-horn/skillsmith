/**
 * SMI-632: SearchBenchmark - Search query latency benchmarks
 *
 * Features:
 * - Various query types (simple, complex, phrase, boolean)
 * - Different result set sizes
 * - Cold vs warm cache comparison
 * - BM25 ranking performance
 */

import type { Database as DatabaseType } from 'better-sqlite3'
import { createDatabase, closeDatabase } from '../db/schema.js'
import { SkillRepository } from '../repositories/SkillRepository.js'
import { SearchService } from '../services/SearchService.js'
import { BenchmarkRunner, type BenchmarkReport, type BenchmarkConfig } from './BenchmarkRunner.js'

/**
 * Search benchmark configuration
 */
export interface SearchBenchmarkConfig extends BenchmarkConfig {
  /** Number of skills to seed in database */
  skillCount?: number
  /** Clear cache between iterations */
  coldCache?: boolean
}

const DEFAULT_CONFIG: Required<SearchBenchmarkConfig> = {
  warmupIterations: 5,
  iterations: 1000,
  measureMemory: true,
  suiteName: 'search',
  skillCount: 1000,
  coldCache: false,
  // SMI-689: Memory profiling defaults
  enableMemoryProfiler: false,
  memoryRegressionThreshold: 10,
  memoryBaselines: {},
}

/**
 * Performance targets for search operations
 */
export const SEARCH_TARGETS = {
  p50_ms: 100,
  p95_ms: 300,
  p99_ms: 500,
  memoryPeak_mb: 50,
}

/**
 * Search query benchmark suite
 */
export class SearchBenchmark {
  private config: Required<SearchBenchmarkConfig>
  private db: DatabaseType | null = null
  private repo: SkillRepository | null = null
  private search: SearchService | null = null

  constructor(config: SearchBenchmarkConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Run all search benchmarks
   */
  async run(): Promise<BenchmarkReport> {
    const runner = new BenchmarkRunner({
      warmupIterations: this.config.warmupIterations,
      iterations: this.config.iterations,
      measureMemory: this.config.measureMemory,
      suiteName: this.config.suiteName,
    })

    // Setup database and seed data
    await this.setup()

    // Simple query benchmarks
    runner.add({
      name: 'simple_query',
      fn: () => {
        if (this.config.coldCache) {
          this.search!.clearCache()
        }
        this.search!.search({ query: 'typescript' })
      },
    })

    runner.add({
      name: 'simple_query_common_term',
      fn: () => {
        if (this.config.coldCache) {
          this.search!.clearCache()
        }
        this.search!.search({ query: 'skill' })
      },
    })

    runner.add({
      name: 'simple_query_rare_term',
      fn: () => {
        if (this.config.coldCache) {
          this.search!.clearCache()
        }
        this.search!.search({ query: 'xyzzy123' })
      },
    })

    // Complex query benchmarks
    runner.add({
      name: 'multi_term_query',
      fn: () => {
        if (this.config.coldCache) {
          this.search!.clearCache()
        }
        this.search!.search({ query: 'typescript formatting code' })
      },
    })

    runner.add({
      name: 'phrase_query',
      fn: () => {
        if (this.config.coldCache) {
          this.search!.clearCache()
        }
        this.search!.searchPhrase('TypeScript code')
      },
    })

    runner.add({
      name: 'boolean_query_and',
      fn: () => {
        if (this.config.coldCache) {
          this.search!.clearCache()
        }
        this.search!.searchBoolean({ must: ['typescript', 'formatting'] })
      },
    })

    runner.add({
      name: 'boolean_query_or',
      fn: () => {
        if (this.config.coldCache) {
          this.search!.clearCache()
        }
        this.search!.searchBoolean({ should: ['typescript', 'javascript', 'python'] })
      },
    })

    // Filtered query benchmarks
    runner.add({
      name: 'filtered_by_trust_tier',
      fn: () => {
        if (this.config.coldCache) {
          this.search!.clearCache()
        }
        this.search!.search({ query: 'skill', trustTier: 'verified' })
      },
    })

    runner.add({
      name: 'filtered_by_quality_score',
      fn: () => {
        if (this.config.coldCache) {
          this.search!.clearCache()
        }
        this.search!.search({ query: 'skill', minQualityScore: 0.8 })
      },
    })

    runner.add({
      name: 'combined_filters',
      fn: () => {
        if (this.config.coldCache) {
          this.search!.clearCache()
        }
        this.search!.search({
          query: 'skill',
          trustTier: 'verified',
          minQualityScore: 0.7,
        })
      },
    })

    // Pagination benchmarks
    runner.add({
      name: 'paginated_first_page',
      fn: () => {
        if (this.config.coldCache) {
          this.search!.clearCache()
        }
        this.search!.search({ query: 'skill', limit: 20, offset: 0 })
      },
    })

    runner.add({
      name: 'paginated_deep_page',
      fn: () => {
        if (this.config.coldCache) {
          this.search!.clearCache()
        }
        this.search!.search({ query: 'skill', limit: 20, offset: 500 })
      },
    })

    // Suggestions benchmark
    runner.add({
      name: 'suggestions',
      fn: () => {
        this.search!.suggest('Type', 10)
      },
    })

    // Similar skills benchmark - cache skill ID to avoid overhead
    let similarSkillId: string | null = null
    runner.add({
      name: 'find_similar',
      setup: () => {
        const skills = this.repo!.findAll(1, 0)
        similarSkillId = skills.items.length > 0 ? skills.items[0].id : null
      },
      fn: () => {
        if (similarSkillId) {
          this.search!.findSimilar(similarSkillId, 5)
        }
      },
    })

    // Popular skills benchmark
    runner.add({
      name: 'get_popular',
      fn: () => {
        this.search!.getPopular(undefined, 10)
      },
    })

    runner.add({
      name: 'get_popular_filtered',
      fn: () => {
        this.search!.getPopular('verified', 10)
      },
    })

    // Empty result benchmarks
    runner.add({
      name: 'empty_results',
      fn: () => {
        if (this.config.coldCache) {
          this.search!.clearCache()
        }
        this.search!.search({ query: 'nonexistentterm12345' })
      },
    })

    // Run benchmarks
    const report = await runner.run()

    // Cleanup
    await this.teardown()

    return report
  }

  /**
   * Run cold cache benchmarks (separate from main suite)
   */
  async runColdCache(): Promise<BenchmarkReport> {
    const coldConfig = { ...this.config, coldCache: true, suiteName: 'search_cold' }
    const coldBenchmark = new SearchBenchmark(coldConfig)
    return coldBenchmark.run()
  }

  /**
   * Setup database and seed test data
   */
  private async setup(): Promise<void> {
    this.db = createDatabase(':memory:')
    this.repo = new SkillRepository(this.db)
    this.search = new SearchService(this.db, { cacheTtl: 60 })

    // Seed test data
    const skills = this.generateTestSkills(this.config.skillCount)
    this.repo.createBatch(skills)
  }

  /**
   * Cleanup database resources
   */
  private async teardown(): Promise<void> {
    if (this.db) {
      closeDatabase(this.db)
      this.db = null
      this.repo = null
      this.search = null
    }
  }

  /**
   * Generate test skills with realistic distribution
   */
  private generateTestSkills(count: number): Array<{
    name: string
    description: string
    author: string
    tags: string[]
    qualityScore: number
    trustTier: 'verified' | 'community' | 'experimental' | 'unknown'
  }> {
    const languages = ['TypeScript', 'JavaScript', 'Python', 'Go', 'Rust', 'Java', 'CPlusPlus']
    const categories = [
      'formatting',
      'linting',
      'testing',
      'deployment',
      'documentation',
      'security',
    ]
    const trustTiers: Array<'verified' | 'community' | 'experimental' | 'unknown'> = [
      'verified',
      'community',
      'experimental',
      'unknown',
    ]
    const authors = ['developer-one', 'developer-two', 'developer-three', 'org-alpha', 'org-beta']

    return Array.from({ length: count }, (_, i) => {
      const lang = languages[i % languages.length]
      const category = categories[i % categories.length]
      const tier = trustTiers[i % trustTiers.length]
      // Use words instead of numbers to avoid FTS5 column parsing issues
      const suffix = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'][i % 5]

      return {
        name: `${lang} ${category} skill ${suffix}`,
        description: `A comprehensive ${category} skill for ${lang} code with advanced features and best practices support.`,
        author: authors[i % authors.length],
        tags: [lang.toLowerCase(), category, 'skill', i % 2 === 0 ? 'popular' : 'niche'],
        qualityScore: 0.5 + Math.random() * 0.5, // 0.5 to 1.0
        trustTier: tier,
      }
    })
  }
}

/**
 * Validate search benchmark results against targets
 */
export function validateSearchResults(report: BenchmarkReport): ValidationResult {
  const failures: string[] = []
  const warnings: string[] = []

  for (const [name, stats] of Object.entries(report.results)) {
    // Check p50 target
    if (stats.p50_ms > SEARCH_TARGETS.p50_ms) {
      failures.push(`${name}: p50 (${stats.p50_ms}ms) exceeds target (${SEARCH_TARGETS.p50_ms}ms)`)
    }

    // Check p95 target
    if (stats.p95_ms > SEARCH_TARGETS.p95_ms) {
      failures.push(`${name}: p95 (${stats.p95_ms}ms) exceeds target (${SEARCH_TARGETS.p95_ms}ms)`)
    }

    // Check p99 target
    if (stats.p99_ms > SEARCH_TARGETS.p99_ms) {
      failures.push(`${name}: p99 (${stats.p99_ms}ms) exceeds target (${SEARCH_TARGETS.p99_ms}ms)`)
    }

    // Check memory target
    if (stats.memoryPeak_mb && stats.memoryPeak_mb > SEARCH_TARGETS.memoryPeak_mb) {
      warnings.push(
        `${name}: memory peak (${stats.memoryPeak_mb}MB) exceeds target (${SEARCH_TARGETS.memoryPeak_mb}MB)`
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
 * Validation result
 */
export interface ValidationResult {
  passed: boolean
  failures: string[]
  warnings: string[]
}
