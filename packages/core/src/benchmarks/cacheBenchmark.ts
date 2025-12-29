/**
 * SMI-738: Cache Operation Benchmarks
 *
 * Measures performance of cache operations:
 * - L1 (LRU) cache get/set operations
 * - L2 (SQLite) cache persistence
 * - Tiered cache hit/miss patterns
 * - Cache invalidation performance
 * - TTL tier calculations
 */

import { BenchmarkRunner, type BenchmarkReport, type BenchmarkConfig } from './BenchmarkRunner.js'
import { CacheManager, type SearchOptions } from '../cache/CacheManager.js'
import { EnhancedTieredCache, type TieredCacheConfig } from '../cache/TieredCache.js'
import type { SearchResult } from '../cache/lru.js'

/**
 * Cache benchmark configuration
 */
export interface CacheBenchmarkConfig extends BenchmarkConfig {
  /** Number of entries to pre-populate cache (default: 1000) */
  cacheSize?: number
  /** L1 cache max size (default: 500) */
  l1MaxSize?: number
  /** Simulate cache misses ratio (0-1, default: 0.2) */
  missRatio?: number
}

const DEFAULT_CONFIG: Required<CacheBenchmarkConfig> = {
  warmupIterations: 10,
  iterations: 1000,
  measureMemory: true,
  suiteName: 'cache',
  cacheSize: 1000,
  l1MaxSize: 500,
  missRatio: 0.2,
  enableMemoryProfiler: false,
  memoryRegressionThreshold: 10,
  memoryBaselines: {},
}

/**
 * Performance targets for cache operations
 */
export const CACHE_TARGETS = {
  l1_get_p50_ms: 0.1,
  l1_get_p95_ms: 0.5,
  l2_get_p50_ms: 1,
  l2_get_p95_ms: 5,
  set_p50_ms: 0.5,
  set_p95_ms: 2,
  invalidate_p50_ms: 5,
  invalidate_p95_ms: 20,
}

/**
 * Cache operation benchmark suite
 */
export class CacheBenchmark {
  private config: Required<CacheBenchmarkConfig>
  private tieredCache: EnhancedTieredCache | null = null
  private cacheManager: CacheManager | null = null
  private testKeys: string[] = []
  private testResults: Map<string, { results: SearchResult[]; totalCount: number }> = new Map()

  constructor(config: CacheBenchmarkConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Run all cache benchmarks
   */
  async run(): Promise<BenchmarkReport> {
    const runner = new BenchmarkRunner({
      warmupIterations: this.config.warmupIterations,
      iterations: this.config.iterations,
      measureMemory: this.config.measureMemory,
      suiteName: this.config.suiteName,
      enableMemoryProfiler: this.config.enableMemoryProfiler,
      memoryRegressionThreshold: this.config.memoryRegressionThreshold,
      memoryBaselines: this.config.memoryBaselines,
    })

    // Setup caches
    await this.setup()

    // L1 Cache Get (should be fastest - pure memory)
    let l1GetIndex = 0
    runner.add({
      name: 'l1_cache_get_hit',
      fn: () => {
        const key = this.testKeys[l1GetIndex % this.testKeys.length]
        l1GetIndex++
        this.tieredCache!.get(key)
      },
    })

    // L2 Cache Get (SQLite read)
    let l2GetIndex = 0
    runner.add({
      name: 'l2_cache_get',
      setup: () => {
        // Evict from L1 to force L2 lookup
        for (let i = 0; i < this.config.l1MaxSize; i++) {
          const evictKey = `evict_${i}`
          this.tieredCache!.set(evictKey, [], 0)
        }
      },
      fn: () => {
        // Access keys that were evicted from L1
        const key = this.testKeys[l2GetIndex % Math.min(100, this.testKeys.length)]
        l2GetIndex++
        this.tieredCache!.get(key)
      },
    })

    // Cache Set operations
    let setIndex = 0
    runner.add({
      name: 'cache_set',
      fn: () => {
        const key = `bench_set_${setIndex++}`
        const results = this.generateMockResults(10)
        this.tieredCache!.set(key, results, results.length)
      },
    })

    // Cache Miss scenario
    let missIndex = 0
    runner.add({
      name: 'cache_miss',
      fn: () => {
        const key = `nonexistent_${missIndex++}`
        this.tieredCache!.get(key)
      },
    })

    // Cache Has check
    let hasIndex = 0
    runner.add({
      name: 'cache_has_check',
      fn: () => {
        const key = this.testKeys[hasIndex % this.testKeys.length]
        hasIndex++
        this.tieredCache!.has(key)
      },
    })

    // CacheManager key generation
    let keyGenIndex = 0
    runner.add({
      name: 'key_generation',
      fn: () => {
        CacheManager.generateKey({
          query: `test query ${keyGenIndex++}`,
          filters: { trustTier: 'verified', minQualityScore: 0.8 },
          limit: 20,
          offset: 0,
        })
      },
    })

    // CacheManager get with popularity tracking
    let managerGetIndex = 0
    runner.add({
      name: 'manager_get_with_tracking',
      fn: () => {
        const options: SearchOptions = {
          query: `query ${managerGetIndex % 100}`,
          limit: 20,
          offset: 0,
        }
        managerGetIndex++
        this.cacheManager!.get(options)
      },
    })

    // CacheManager set with TTL tier calculation
    let managerSetIndex = 0
    runner.add({
      name: 'manager_set_with_ttl',
      fn: () => {
        const options: SearchOptions = {
          query: `set query ${managerSetIndex++}`,
          limit: 20,
          offset: 0,
        }
        const results = this.generateMockResults(10)
        this.cacheManager!.set(options, results, results.length)
      },
    })

    // Cache prune operation
    runner.add({
      name: 'cache_prune',
      fn: () => {
        this.tieredCache!.prune()
      },
    })

    // Cache invalidation (single run, not per iteration)
    runner.add({
      name: 'cache_invalidate_all',
      fn: () => {
        // Re-populate for next iteration
        for (let i = 0; i < 10; i++) {
          const key = `invalidate_test_${i}`
          this.tieredCache!.set(key, [], 0)
        }
        this.tieredCache!.invalidateAll()
      },
    })

    // Cache stats collection
    runner.add({
      name: 'cache_stats',
      fn: () => {
        this.tieredCache!.getStats()
      },
    })

    // Mixed workload (realistic pattern)
    let mixedIndex = 0
    runner.add({
      name: 'mixed_workload',
      fn: () => {
        const rand = Math.random()
        const idx = mixedIndex++

        if (rand < 0.7) {
          // 70% reads
          const key = this.testKeys[idx % this.testKeys.length]
          this.tieredCache!.get(key)
        } else if (rand < 0.9) {
          // 20% writes
          const key = `mixed_write_${idx}`
          this.tieredCache!.set(key, [], 0)
        } else {
          // 10% has checks
          const key = this.testKeys[idx % this.testKeys.length]
          this.tieredCache!.has(key)
        }
      },
    })

    // Run benchmarks
    const report = await runner.run()

    // Cleanup
    await this.teardown()

    return report
  }

  /**
   * Setup caches with test data
   */
  private async setup(): Promise<void> {
    const cacheConfig: TieredCacheConfig = {
      l1: {
        maxEntries: this.config.l1MaxSize,
      },
      l2: {
        dbPath: ':memory:',
      },
    }

    this.tieredCache = new EnhancedTieredCache(cacheConfig)
    this.cacheManager = new CacheManager({
      ...cacheConfig,
      enableBackgroundRefresh: false, // Disable for benchmarking
    })

    // Pre-populate cache
    this.testKeys = []
    this.testResults = new Map()

    for (let i = 0; i < this.config.cacheSize; i++) {
      const key = `benchmark_key_${i}`
      const results = this.generateMockResults(Math.floor(Math.random() * 20) + 1)
      this.testKeys.push(key)
      this.testResults.set(key, { results, totalCount: results.length })
      this.tieredCache.set(key, results, results.length)
    }

    // Pre-populate CacheManager
    for (let i = 0; i < 100; i++) {
      const options: SearchOptions = {
        query: `query ${i}`,
        limit: 20,
        offset: 0,
      }
      const results = this.generateMockResults(10)
      this.cacheManager.set(options, results, results.length)
    }
  }

  /**
   * Cleanup resources
   */
  private async teardown(): Promise<void> {
    if (this.tieredCache) {
      this.tieredCache.close()
      this.tieredCache = null
    }
    if (this.cacheManager) {
      this.cacheManager.close()
      this.cacheManager = null
    }
    this.testKeys = []
    this.testResults.clear()
  }

  /**
   * Generate mock search results
   */
  private generateMockResults(count: number): SearchResult[] {
    return Array.from({ length: count }, (_, i) => ({
      id: `skill_${i}`,
      name: `Test Skill ${i}`,
      description: `Description for test skill ${i} with some content`,
      score: Math.random(),
      source: `github:test-author/test-skill-${i}`,
    }))
  }
}

/**
 * Validate cache benchmark results against targets
 */
export function validateCacheResults(report: BenchmarkReport): CacheValidationResult {
  const failures: string[] = []
  const warnings: string[] = []

  const checkTarget = (name: string, metric: 'p50_ms' | 'p95_ms', target: number) => {
    const stats = report.results[name]
    if (!stats) return

    const value = stats[metric]
    if (value > target) {
      failures.push(`${name}: ${metric} (${value}ms) exceeds target (${target}ms)`)
    }
  }

  // Check L1 cache performance
  checkTarget('l1_cache_get_hit', 'p50_ms', CACHE_TARGETS.l1_get_p50_ms)
  checkTarget('l1_cache_get_hit', 'p95_ms', CACHE_TARGETS.l1_get_p95_ms)

  // Check L2 cache performance
  checkTarget('l2_cache_get', 'p50_ms', CACHE_TARGETS.l2_get_p50_ms)
  checkTarget('l2_cache_get', 'p95_ms', CACHE_TARGETS.l2_get_p95_ms)

  // Check set performance
  checkTarget('cache_set', 'p50_ms', CACHE_TARGETS.set_p50_ms)
  checkTarget('cache_set', 'p95_ms', CACHE_TARGETS.set_p95_ms)

  // Check invalidation performance
  checkTarget('cache_invalidate_all', 'p50_ms', CACHE_TARGETS.invalidate_p50_ms)
  checkTarget('cache_invalidate_all', 'p95_ms', CACHE_TARGETS.invalidate_p95_ms)

  // Memory warnings
  for (const [name, stats] of Object.entries(report.results)) {
    if (stats.memoryPeak_mb && stats.memoryPeak_mb > 100) {
      warnings.push(`${name}: high memory usage (${stats.memoryPeak_mb}MB)`)
    }
  }

  return {
    passed: failures.length === 0,
    failures,
    warnings,
  }
}

/**
 * Cache validation result
 */
export interface CacheValidationResult {
  passed: boolean
  failures: string[]
  warnings: string[]
}
