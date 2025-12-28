/**
 * SMI-630: CacheService - Unified caching with TTL management
 *
 * Combines:
 * - L1: In-memory LRU cache (hot queries)
 * - L2: SQLite persistent cache (warm data)
 * - TTLManager: Per-type TTL configuration
 */

import { L1Cache, type SearchResult, type CacheStats } from './lru.js'
import { L2Cache, type L2CacheOptions } from './sqlite.js'
import { TTLManager, CacheType, type TTLConfig } from './TTLManager.js'

export interface CacheServiceOptions {
  /** Maximum entries in L1 cache */
  l1MaxSize?: number
  /** L2 SQLite options (if omitted, L2 is disabled) */
  l2Options?: L2CacheOptions
  /** TTL configuration overrides */
  ttlOverrides?: Partial<Record<CacheType, Partial<TTLConfig>>>
}

export interface CacheEntry<T = unknown> {
  value: T
  createdAt: number
  expiresAt: number
  cacheType: CacheType
}

export interface CacheServiceStats {
  l1: CacheStats
  l2: (CacheStats & { expiredCount: number }) | null
  ttlConfigs: Record<CacheType, TTLConfig>
}

/**
 * Unified cache service with L1/L2 tiering and TTL management
 */
export class CacheService {
  private l1: L1Cache
  private l2: L2Cache | null = null
  private ttlManager: TTLManager
  private metadataCache: Map<string, { cacheType: CacheType; createdAt: number }>

  constructor(options: CacheServiceOptions = {}) {
    this.l1 = new L1Cache(options.l1MaxSize ?? 100)
    this.ttlManager = new TTLManager(options.ttlOverrides)
    this.metadataCache = new Map()

    if (options.l2Options) {
      this.l2 = new L2Cache(options.l2Options)
    }
  }

  /**
   * Get cached search results
   */
  getSearchResults(
    query: string,
    filters?: Record<string, unknown>
  ): { results: SearchResult[]; totalCount: number } | undefined {
    const key = this.buildSearchKey(query, filters)
    return this.get(key, CacheType.SEARCH_RESULTS)
  }

  /**
   * Set cached search results
   */
  setSearchResults(
    query: string,
    filters: Record<string, unknown> | undefined,
    results: SearchResult[],
    totalCount: number
  ): void {
    const key = this.buildSearchKey(query, filters)
    this.set(key, { results, totalCount }, CacheType.SEARCH_RESULTS)
  }

  /**
   * Get cached skill details
   */
  getSkillDetails<T>(skillId: string): T | undefined {
    const key = `skill:${skillId}`
    const entry = this.get(key, CacheType.SKILL_DETAILS)
    return entry as T | undefined
  }

  /**
   * Set cached skill details
   */
  setSkillDetails<T>(skillId: string, details: T): void {
    const key = `skill:${skillId}`
    this.set(key, details, CacheType.SKILL_DETAILS)
  }

  /**
   * Get cached popular queries
   */
  getPopularQueries(): string[] | undefined {
    const key = 'popular:queries'
    return this.get(key, CacheType.POPULAR_QUERIES)
  }

  /**
   * Set cached popular queries
   */
  setPopularQueries(queries: string[]): void {
    const key = 'popular:queries'
    this.set(key, queries, CacheType.POPULAR_QUERIES)
  }

  /**
   * Generic get with cache type
   */
  get<T>(key: string, cacheType: CacheType = CacheType.CUSTOM): T | undefined {
    // Check metadata for expiration
    const metadata = this.metadataCache.get(key)
    if (metadata && this.ttlManager.isExpired(metadata.cacheType, metadata.createdAt)) {
      this.delete(key)
      return undefined
    }

    // Check L1 first
    const l1Entry = this.l1.get(key)
    if (l1Entry) {
      return l1Entry as unknown as T
    }

    // Check L2 if available
    if (this.l2 && this.ttlManager.shouldPersistToL2(cacheType)) {
      const l2Entry = this.l2.get(key)
      if (l2Entry) {
        // Promote to L1
        this.l1.set(key, l2Entry.results, l2Entry.totalCount)
        return l2Entry as unknown as T
      }
    }

    return undefined
  }

  /**
   * Generic set with cache type
   */
  set<T>(key: string, value: T, cacheType: CacheType = CacheType.CUSTOM): void {
    const now = Date.now()

    // Store metadata
    this.metadataCache.set(key, { cacheType, createdAt: now })

    // Handle search result format
    if (this.isSearchResultFormat(value)) {
      const { results, totalCount } = value as { results: SearchResult[]; totalCount: number }
      this.l1.set(key, results, totalCount)

      if (this.l2 && this.ttlManager.shouldPersistToL2(cacheType)) {
        this.l2.set(key, results, totalCount)
      }
    } else {
      // Store as single-item array for non-search data
      const wrapped = [value as unknown as SearchResult]
      this.l1.set(key, wrapped, 1)

      if (this.l2 && this.ttlManager.shouldPersistToL2(cacheType)) {
        this.l2.set(key, wrapped, 1)
      }
    }
  }

  /**
   * Check if key exists and is not expired
   */
  has(key: string): boolean {
    const metadata = this.metadataCache.get(key)
    if (metadata && this.ttlManager.isExpired(metadata.cacheType, metadata.createdAt)) {
      this.delete(key)
      return false
    }

    return this.l1.has(key) || (this.l2?.has(key) ?? false)
  }

  /**
   * Delete a cache entry
   */
  delete(key: string): boolean {
    this.metadataCache.delete(key)
    const l1Deleted = this.l1.delete(key)
    const l2Deleted = this.l2?.delete(key) ?? false
    return l1Deleted || l2Deleted
  }

  /**
   * Invalidate all cache entries
   */
  invalidateAll(): void {
    this.metadataCache.clear()
    this.l1.invalidateAll()
    this.l2?.invalidateAll()
  }

  /**
   * Invalidate entries by type
   */
  invalidateByType(cacheType: CacheType): void {
    const keysToDelete: string[] = []

    for (const [key, metadata] of this.metadataCache) {
      if (metadata.cacheType === cacheType) {
        keysToDelete.push(key)
      }
    }

    for (const key of keysToDelete) {
      this.delete(key)
    }
  }

  /**
   * Prune expired entries
   */
  prune(): number {
    let pruned = 0

    // Prune based on metadata
    for (const [key, metadata] of this.metadataCache) {
      if (this.ttlManager.isExpired(metadata.cacheType, metadata.createdAt)) {
        this.delete(key)
        pruned++
      }
    }

    // Also prune L1 and L2 internal expiration
    this.l1.prune()
    pruned += this.l2?.prune() ?? 0

    return pruned
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheServiceStats {
    return {
      l1: this.l1.getStats(),
      l2: this.l2?.getStats() ?? null,
      ttlConfigs: this.ttlManager.getAllConfigs(),
    }
  }

  /**
   * Get TTL manager for configuration
   */
  getTTLManager(): TTLManager {
    return this.ttlManager
  }

  /**
   * Close L2 database connection
   */
  close(): void {
    this.l2?.close()
  }

  /**
   * Build cache key for search
   */
  private buildSearchKey(query: string, filters?: Record<string, unknown>): string {
    return L1Cache.generateKey(query, filters)
  }

  /**
   * Check if value is in search result format
   */
  private isSearchResultFormat(value: unknown): boolean {
    return (
      typeof value === 'object' &&
      value !== null &&
      'results' in value &&
      'totalCount' in value &&
      Array.isArray((value as { results: unknown }).results)
    )
  }
}

export default CacheService
