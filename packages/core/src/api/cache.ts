/**
 * API Response Cache
 * @module api/cache
 *
 * SMI-1245: Caching layer for API responses
 *
 * Provides in-memory caching with TTL for offline support.
 * Uses a simple LRU-like eviction strategy.
 */

import type { ApiResponse, ApiSearchResult } from './client.js'

/**
 * Escape special RegExp characters in a string.
 *
 * This prevents RegExp injection when user-provided strings are
 * used to construct regular expressions.
 *
 * @param str - The string to escape
 * @returns The escaped string safe for use in RegExp constructor
 *
 * @example
 * ```typescript
 * escapeRegExp('foo.bar') // Returns 'foo\\.bar'
 * escapeRegExp('a*b+c?') // Returns 'a\\*b\\+c\\?'
 * ```
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Cache entry with metadata
 */
interface CacheEntry<T> {
  data: T
  expiresAt: number
  createdAt: number
  hitCount: number
}

/**
 * Cache configuration
 */
export interface CacheConfig {
  /** Default TTL in milliseconds (default: 1 hour) */
  defaultTtl?: number
  /** Max entries in cache (default: 1000) */
  maxEntries?: number
  /** Enable cache statistics (default: false) */
  enableStats?: boolean
}

/**
 * Cache statistics
 */
export interface CacheStats {
  hits: number
  misses: number
  entries: number
  evictions: number
  hitRate: number
}

/**
 * TTL configuration for different endpoints
 */
export const DEFAULT_TTL: Record<string, number> = {
  search: 60 * 60 * 1000, // 1 hour
  getSkill: 24 * 60 * 60 * 1000, // 24 hours
  recommend: 60 * 60 * 1000, // 1 hour
}

/**
 * API Response Cache
 *
 * @example
 * ```typescript
 * const cache = new ApiCache({ defaultTtl: 3600000 });
 *
 * // Cache a search result
 * cache.set('search:testing', results, 'search');
 *
 * // Get from cache
 * const cached = cache.get<ApiSearchResult[]>('search:testing');
 * ```
 */
export class ApiCache {
  private cache: Map<string, CacheEntry<unknown>>
  private defaultTtl: number
  private maxEntries: number
  private enableStats: boolean

  // Statistics
  private hits = 0
  private misses = 0
  private evictions = 0

  // Auto-pruning (SMI-1262)
  private operationCount = 0
  private readonly PRUNE_INTERVAL = 100

  constructor(config: CacheConfig = {}) {
    this.cache = new Map()
    this.defaultTtl = config.defaultTtl ?? DEFAULT_TTL.search
    this.maxEntries = config.maxEntries ?? 1000
    this.enableStats = config.enableStats ?? false
  }

  /**
   * Generate cache key from endpoint and parameters
   */
  static createKey(endpoint: string, params?: Record<string, unknown>): string {
    if (!params || Object.keys(params).length === 0) {
      return endpoint
    }

    const sortedParams = Object.keys(params)
      .sort()
      .map((key) => `${key}=${JSON.stringify(params[key])}`)
      .join('&')

    return `${endpoint}?${sortedParams}`
  }

  /**
   * Get item from cache
   */
  get<T>(key: string): T | undefined {
    this.maybeAutoPrune()
    const entry = this.cache.get(key) as CacheEntry<T> | undefined

    if (!entry) {
      if (this.enableStats) this.misses++
      return undefined
    }

    // Check if expired
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key)
      if (this.enableStats) this.misses++
      return undefined
    }

    // Update hit count and statistics
    entry.hitCount++
    if (this.enableStats) this.hits++

    return entry.data
  }

  /**
   * Set item in cache
   */
  set<T>(key: string, data: T, endpointType?: keyof typeof DEFAULT_TTL): void {
    this.maybeAutoPrune()

    // Evict if at capacity
    if (this.cache.size >= this.maxEntries) {
      this.evictLeastUsed()
    }

    const ttl = endpointType ? DEFAULT_TTL[endpointType] : this.defaultTtl
    const now = Date.now()

    this.cache.set(key, {
      data,
      expiresAt: now + ttl,
      createdAt: now,
      hitCount: 0,
    })
  }

  /**
   * Check if key exists and is not expired
   */
  has(key: string): boolean {
    const entry = this.cache.get(key)
    if (!entry) return false
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key)
      return false
    }
    return true
  }

  /**
   * Delete item from cache
   */
  delete(key: string): boolean {
    return this.cache.delete(key)
  }

  /**
   * Clear all cache entries
   */
  clear(): void {
    this.cache.clear()
    this.hits = 0
    this.misses = 0
    this.evictions = 0
  }

  /**
   * Clear expired entries
   */
  prune(): number {
    const now = Date.now()
    let pruned = 0

    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) {
        this.cache.delete(key)
        pruned++
      }
    }

    return pruned
  }

  /**
   * Invalidate entries matching a pattern.
   *
   * When a string is provided, it is treated as a literal string and
   * special RegExp characters are escaped to prevent RegExp injection.
   * To use regex patterns, pass a RegExp object directly.
   *
   * @param pattern - Literal string to match or RegExp for pattern matching
   * @returns Number of entries invalidated
   *
   * @example
   * ```typescript
   * // Literal string matching (special chars are escaped)
   * cache.invalidatePattern('search:user.name') // Matches exactly 'search:user.name'
   *
   * // RegExp for pattern matching
   * cache.invalidatePattern(/^search:/) // Matches all keys starting with 'search:'
   * ```
   */
  invalidatePattern(pattern: string | RegExp): number {
    const regex = typeof pattern === 'string' ? new RegExp(escapeRegExp(pattern)) : pattern
    let invalidated = 0

    for (const key of this.cache.keys()) {
      if (regex.test(key)) {
        this.cache.delete(key)
        invalidated++
      }
    }

    return invalidated
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    const total = this.hits + this.misses
    return {
      hits: this.hits,
      misses: this.misses,
      entries: this.cache.size,
      evictions: this.evictions,
      hitRate: total > 0 ? this.hits / total : 0,
    }
  }

  /**
   * Automatically prune expired entries every PRUNE_INTERVAL operations.
   * SMI-1262: Prevents expired entries from accumulating until maxEntries is reached.
   */
  private maybeAutoPrune(): void {
    if (++this.operationCount % this.PRUNE_INTERVAL === 0) {
      this.prune()
    }
  }

  /**
   * Evict least recently used entries
   */
  private evictLeastUsed(): void {
    // Find entry with lowest hit count
    let lowestKey: string | undefined
    let lowestHits = Infinity

    for (const [key, entry] of this.cache) {
      // Also check for expired while iterating
      if (Date.now() > entry.expiresAt) {
        this.cache.delete(key)
        if (this.enableStats) this.evictions++
        return
      }

      if (entry.hitCount < lowestHits) {
        lowestHits = entry.hitCount
        lowestKey = key
      }
    }

    if (lowestKey) {
      this.cache.delete(lowestKey)
      if (this.enableStats) this.evictions++
    }
  }
}

/**
 * Create a cache instance with default configuration
 */
export function createCache(config?: CacheConfig): ApiCache {
  return new ApiCache(config)
}

/**
 * Global cache instance for sharing across the application
 */
let globalCache: ApiCache | undefined

/**
 * Get or create the global cache instance
 */
export function getGlobalCache(): ApiCache {
  if (!globalCache) {
    globalCache = new ApiCache({ enableStats: true })
  }
  return globalCache
}

export default ApiCache
