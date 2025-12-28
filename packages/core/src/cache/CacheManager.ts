/**
 * SMI-644: Unified Cache Manager
 * Provides high-level cache operations with:
 * - Popular query detection (dynamic TTL)
 * - Background refresh for hot entries
 * - Cache invalidation coordination
 * - Statistics and monitoring
 */

import type { SearchResult } from './lru.js'
import { TTLTier, POPULARITY_THRESHOLDS, calculateTTLTier, getTTLTierName } from './CacheEntry.js'
import {
  EnhancedTieredCache,
  type TieredCacheConfig,
  type TieredCacheStats,
} from './TieredCache.js'

/**
 * Search options for cache key generation
 */
export interface SearchOptions {
  query: string
  filters?: Record<string, unknown>
  limit?: number
  offset?: number
}

/**
 * Refresh callback type
 */
export type RefreshCallback = (
  options: SearchOptions
) => Promise<{ results: SearchResult[]; totalCount: number }>

/**
 * Cache manager configuration
 */
export interface CacheManagerConfig extends TieredCacheConfig {
  /** Enable background refresh for hot entries (default: true) */
  enableBackgroundRefresh?: boolean
  /** Background refresh interval in ms (default: 30 seconds) */
  refreshIntervalMs?: number
  /** Maximum concurrent refreshes (default: 3) */
  maxConcurrentRefreshes?: number
  /** Callback to refresh cache entries */
  refreshCallback?: RefreshCallback
}

/**
 * Query frequency tracker for popularity detection
 */
interface QueryFrequency {
  hits: number
  firstSeen: number
  lastSeen: number
}

/**
 * Resolved manager configuration
 */
interface ResolvedManagerConfig {
  enableBackgroundRefresh: boolean
  refreshIntervalMs: number
  maxConcurrentRefreshes: number
}

/**
 * Unified Cache Manager
 * Coordinates L1/L2 caching with intelligent TTL management
 */
export class CacheManager {
  private cache: EnhancedTieredCache
  private readonly config: ResolvedManagerConfig
  private queryFrequencies: Map<string, QueryFrequency> = new Map()
  private refreshTimer: ReturnType<typeof setInterval> | null = null
  /** SMI-683: Use Map<key, Promise> for proper deduplication of concurrent refreshes */
  private activeRefreshes = new Map<string, Promise<void>>()
  private refreshCallback: RefreshCallback | null = null

  // Track invalidation for coordination
  private lastInvalidation = 0
  private invalidationCallbacks: Array<() => void> = []

  constructor(config: CacheManagerConfig = {}) {
    this.cache = new EnhancedTieredCache(config)

    this.config = {
      enableBackgroundRefresh: config.enableBackgroundRefresh ?? true,
      refreshIntervalMs: config.refreshIntervalMs ?? 30 * 1000,
      maxConcurrentRefreshes: config.maxConcurrentRefreshes ?? 3,
    }

    this.refreshCallback = config.refreshCallback ?? null

    // Start background refresh if enabled
    if (this.config.enableBackgroundRefresh && this.refreshCallback) {
      this.startBackgroundRefresh()
    }
  }

  /**
   * Generate cache key from search options
   */
  static generateKey(options: SearchOptions): string {
    // Normalize query: lowercase, trim, collapse whitespace
    const normalizedQuery = options.query.toLowerCase().trim().replace(/\s+/g, ' ')

    // Sort and stringify filters for consistent keys
    const sortedFilters = options.filters
      ? JSON.stringify(
          Object.keys(options.filters)
            .sort()
            .reduce(
              (acc, key) => {
                acc[key] = options.filters![key]
                return acc
              },
              {} as Record<string, unknown>
            )
        )
      : ''

    // Include pagination in key
    const pagination = `${options.limit ?? 20}:${options.offset ?? 0}`

    return `search:${normalizedQuery}:${sortedFilters}:${pagination}`
  }

  /**
   * Parse search options from cache key
   * SMI-683: Fixed regex to handle empty filters (was: .+? requires at least 1 char)
   */
  static parseKey(key: string): SearchOptions | null {
    // Allow empty filters section with (.*?) instead of (.+?)
    const match = key.match(/^search:(.+?):(.*?):(\d+):(\d+)$/)
    if (!match) return null

    const [, query, filtersJson, limit, offset] = match

    let filters: Record<string, unknown> | undefined
    try {
      filters = filtersJson ? JSON.parse(filtersJson) : undefined
    } catch {
      filters = undefined
    }

    return {
      query,
      filters,
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10),
    }
  }

  /**
   * Get cached results for search options
   */
  get(options: SearchOptions): { results: SearchResult[]; totalCount: number } | undefined {
    const key = CacheManager.generateKey(options)
    const result = this.cache.get(key)

    if (result) {
      // Track query frequency for popularity detection
      this.recordQueryHit(key)
    }

    return result
  }

  /**
   * Get or compute cached results
   * @param options Search options
   * @param compute Function to compute results if not cached
   */
  async getOrCompute(
    options: SearchOptions,
    compute: () => Promise<{ results: SearchResult[]; totalCount: number }>
  ): Promise<{ results: SearchResult[]; totalCount: number }> {
    const cached = this.get(options)
    if (cached) {
      return cached
    }

    const result = await compute()
    this.set(options, result.results, result.totalCount)
    return result
  }

  /**
   * Store results in cache with automatic TTL detection
   */
  set(options: SearchOptions, results: SearchResult[], totalCount: number): void {
    const key = CacheManager.generateKey(options)

    // Determine TTL tier based on query frequency
    const ttlTier = this.determineTTLTier(key)

    this.cache.set(key, results, totalCount, ttlTier)
  }

  /**
   * Check if results are cached
   */
  has(options: SearchOptions): boolean {
    const key = CacheManager.generateKey(options)
    return this.cache.has(key)
  }

  /**
   * Delete specific cached result
   */
  delete(options: SearchOptions): boolean {
    const key = CacheManager.generateKey(options)
    this.queryFrequencies.delete(key)
    return this.cache.delete(key)
  }

  /**
   * Invalidate all cached results
   * Should be called when the skill index is updated
   */
  invalidateAll(): void {
    this.cache.invalidateAll()
    this.queryFrequencies.clear()
    this.lastInvalidation = Date.now()

    // Notify listeners
    for (const callback of this.invalidationCallbacks) {
      try {
        callback()
      } catch {
        // Ignore callback errors
      }
    }
  }

  /**
   * Register callback for invalidation events
   */
  onInvalidate(callback: () => void): () => void {
    this.invalidationCallbacks.push(callback)
    return () => {
      const index = this.invalidationCallbacks.indexOf(callback)
      if (index >= 0) {
        this.invalidationCallbacks.splice(index, 1)
      }
    }
  }

  /**
   * Get time since last invalidation
   */
  getTimeSinceInvalidation(): number {
    return this.lastInvalidation > 0 ? Date.now() - this.lastInvalidation : -1
  }

  /**
   * Prune expired entries
   */
  prune(): number {
    this.pruneQueryFrequencies()
    return this.cache.prune()
  }

  /**
   * Get comprehensive cache statistics
   */
  getStats(): TieredCacheStats & {
    queryFrequencies: { popular: number; standard: number; rare: number }
    backgroundRefresh: { active: number; lastRun: number }
  } {
    const cacheStats = this.cache.getStats()

    // Count queries by frequency tier
    const now = Date.now()
    let popular = 0
    let standard = 0
    let rare = 0

    for (const [, freq] of this.queryFrequencies) {
      const tier = calculateTTLTier(freq.firstSeen, freq.hits, now)
      if (tier === TTLTier.POPULAR) popular++
      else if (tier === TTLTier.RARE) rare++
      else standard++
    }

    return {
      ...cacheStats,
      queryFrequencies: { popular, standard, rare },
      backgroundRefresh: {
        active: this.activeRefreshes.size, // Map.size works the same as Set.size
        lastRun: this.refreshTimer ? Date.now() : 0,
      },
    }
  }

  /**
   * Get detailed hit rate by TTL tier
   */
  getHitRateByTier(): Record<string, number> {
    const stats = this.cache.getStats()
    const total = stats.totalHits + stats.totalMisses

    return {
      overall: total > 0 ? stats.totalHits / total : 0,
      l1: stats.l1Hits + stats.l1Misses > 0 ? stats.l1Hits / (stats.l1Hits + stats.l1Misses) : 0,
      l2: stats.l2Hits + stats.l2Misses > 0 ? stats.l2Hits / (stats.l2Hits + stats.l2Misses) : 0,
    }
  }

  /**
   * Set the refresh callback for background refresh
   */
  setRefreshCallback(callback: RefreshCallback): void {
    this.refreshCallback = callback

    // Start background refresh if not already running
    if (this.config.enableBackgroundRefresh && !this.refreshTimer) {
      this.startBackgroundRefresh()
    }
  }

  /**
   * Close cache manager and cleanup resources
   */
  close(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }
    this.cache.close()
    this.queryFrequencies.clear()
    this.invalidationCallbacks = []
  }

  // Private methods

  /**
   * Record a hit for query frequency tracking
   */
  private recordQueryHit(key: string): void {
    const now = Date.now()
    const existing = this.queryFrequencies.get(key)

    if (existing) {
      existing.hits++
      existing.lastSeen = now
    } else {
      this.queryFrequencies.set(key, {
        hits: 1,
        firstSeen: now,
        lastSeen: now,
      })
    }
  }

  /**
   * Determine TTL tier based on query frequency
   */
  private determineTTLTier(key: string): TTLTier {
    const freq = this.queryFrequencies.get(key)
    if (!freq) {
      return TTLTier.STANDARD
    }

    return calculateTTLTier(freq.firstSeen, freq.hits)
  }

  /**
   * Prune old query frequency entries
   */
  private pruneQueryFrequencies(): void {
    const now = Date.now()
    const maxAge = 24 * 60 * 60 * 1000 // 24 hours

    for (const [key, freq] of this.queryFrequencies) {
      if (now - freq.lastSeen > maxAge) {
        this.queryFrequencies.delete(key)
      }
    }
  }

  /**
   * Start background refresh loop
   */
  private startBackgroundRefresh(): void {
    if (this.refreshTimer) return

    this.refreshTimer = setInterval(() => {
      this.performBackgroundRefresh().catch(() => {
        // Ignore refresh errors - background task should not crash
      })
    }, this.config.refreshIntervalMs)
    // Unref timer to not block process exit
    this.refreshTimer.unref()
  }

  /**
   * Perform background refresh for entries approaching expiration
   */
  private async performBackgroundRefresh(): Promise<void> {
    if (!this.refreshCallback) return

    const keysToRefresh = this.cache.getEntriesNeedingRefresh()

    // Limit concurrent refreshes
    const available = this.config.maxConcurrentRefreshes - this.activeRefreshes.size
    if (available <= 0) return

    const toProcess = keysToRefresh
      .filter((key) => !this.activeRefreshes.has(key))
      .slice(0, available)

    for (const key of toProcess) {
      this.refreshEntry(key).catch(() => {
        // Ignore individual refresh errors
      })
    }
  }

  /**
   * Refresh a single cache entry
   * SMI-683: Fixed race condition by using Map<string, Promise<void>> for proper deduplication.
   * Concurrent calls for the same key now return the same promise instance.
   */
  private refreshEntry(key: string): Promise<void> {
    if (!this.refreshCallback) return Promise.resolve()

    // SMI-683: Check if already refreshing - return existing promise
    const existing = this.activeRefreshes.get(key)
    if (existing) {
      return existing
    }

    // Create new refresh promise
    const refreshPromise = (async () => {
      try {
        const options = CacheManager.parseKey(key)
        if (!options) return
        const result = await this.refreshCallback!(options)
        this.set(options, result.results, result.totalCount)
      } finally {
        // SMI-683: Always cleanup on completion or error
        this.activeRefreshes.delete(key)
      }
    })()

    // Store promise for deduplication
    this.activeRefreshes.set(key, refreshPromise)
    return refreshPromise
  }
}

// Re-export types and utilities
export { TTLTier, getTTLTierName, POPULARITY_THRESHOLDS }
