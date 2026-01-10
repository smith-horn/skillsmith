/**
 * SMI-1303: Parse Result Cache
 *
 * LRU cache for parse results with content hash validation.
 * Provides memory-based eviction to prevent memory exhaustion.
 *
 * @see docs/architecture/multi-language-analysis.md
 * @module analysis/cache
 */

import { createHash } from 'crypto'
import { LRUCache } from 'lru-cache'
import type { ParseResult, CacheStats } from './types.js'

/**
 * Internal cache entry structure
 */
interface CacheEntry {
  /** Parsed result */
  result: ParseResult
  /** SHA-256 hash of content (first 16 chars) */
  contentHash: string
  /** Timestamp when entry was created */
  timestamp: number
  /** Estimated size in bytes */
  size: number
}

/**
 * Options for ParseCache
 */
export interface ParseCacheOptions {
  /** Maximum memory in MB (default: 200) */
  maxMemoryMB?: number
  /** TTL in milliseconds (default: no TTL) */
  ttlMs?: number
}

/**
 * LRU cache for parse results with memory-based eviction
 *
 * Caches parse results keyed by file path. Uses content hashing
 * to detect when cached results are stale.
 *
 * @example
 * ```typescript
 * const cache = new ParseCache({ maxMemoryMB: 100 })
 *
 * // Check cache first
 * const cached = cache.get('src/main.py', fileContent)
 * if (cached) {
 *   return cached
 * }
 *
 * // Parse and cache
 * const result = adapter.parseFile(fileContent, 'src/main.py')
 * cache.set('src/main.py', fileContent, result)
 * ```
 */
export class ParseCache {
  private cache: LRUCache<string, CacheEntry>
  private readonly maxMemory: number
  private hits = 0
  private misses = 0

  constructor(options: ParseCacheOptions = {}) {
    this.maxMemory = (options.maxMemoryMB ?? 200) * 1024 * 1024

    this.cache = new LRUCache({
      maxSize: this.maxMemory,
      sizeCalculation: (entry: CacheEntry) => entry.size,
      ttl: options.ttlMs,
      updateAgeOnGet: true,
      updateAgeOnHas: false,
    })
  }

  /**
   * Get cached result if content unchanged
   *
   * Returns null if:
   * - No entry exists for the path
   * - Content hash doesn't match (file was modified)
   * - Entry was evicted due to memory pressure
   *
   * @param filePath - Path to the file
   * @param content - Current file content for hash comparison
   * @returns Cached parse result or null
   *
   * @example
   * ```typescript
   * const cached = cache.get('src/main.py', fileContent)
   * if (cached) {
   *   console.log('Cache hit!')
   *   return cached
   * }
   * ```
   */
  get(filePath: string, content: string): ParseResult | null {
    const entry = this.cache.get(filePath)
    if (!entry) {
      this.misses++
      return null
    }

    // Validate content hash
    const contentHash = this.hashContent(content)
    if (entry.contentHash !== contentHash) {
      // Content changed, invalidate
      this.cache.delete(filePath)
      this.misses++
      return null
    }

    this.hits++
    return entry.result
  }

  /**
   * Store parse result in cache
   *
   * The result is stored with a content hash for future validation.
   * If the cache is at capacity, least recently used entries
   * are evicted to make room.
   *
   * @param filePath - Path to the file
   * @param content - File content (used for hash)
   * @param result - Parse result to cache
   *
   * @example
   * ```typescript
   * const result = adapter.parseFile(content, 'src/main.py')
   * cache.set('src/main.py', content, result)
   * ```
   */
  set(filePath: string, content: string, result: ParseResult): void {
    const contentHash = this.hashContent(content)
    const size = this.estimateSize(result)

    this.cache.set(filePath, {
      result,
      contentHash,
      timestamp: Date.now(),
      size,
    })
  }

  /**
   * Check if a file is cached (without counting as hit/miss)
   *
   * @param filePath - Path to check
   * @returns True if entry exists (may be stale)
   */
  has(filePath: string): boolean {
    return this.cache.has(filePath)
  }

  /**
   * Invalidate cache entries for changed files
   *
   * Call this when files are known to have changed
   * to prevent stale cache hits.
   *
   * @param filePaths - Paths to invalidate
   *
   * @example
   * ```typescript
   * // On file system change event
   * cache.invalidate(['src/modified.py', 'src/deleted.py'])
   * ```
   */
  invalidate(filePaths: string[]): void {
    for (const path of filePaths) {
      this.cache.delete(path)
    }
  }

  /**
   * Invalidate entries matching a pattern
   *
   * @param pattern - Glob-like pattern to match
   *
   * @example
   * ```typescript
   * // Invalidate all Python files
   * cache.invalidatePattern('*.py')
   * ```
   */
  invalidatePattern(pattern: string): void {
    const regex = this.patternToRegex(pattern)
    for (const key of this.cache.keys()) {
      if (regex.test(key)) {
        this.cache.delete(key)
      }
    }
  }

  /**
   * Clear entire cache
   *
   * Removes all entries and resets statistics.
   */
  clear(): void {
    this.cache.clear()
    this.hits = 0
    this.misses = 0
  }

  /**
   * Get cache statistics
   *
   * @returns Current cache statistics
   *
   * @example
   * ```typescript
   * const stats = cache.getStats()
   * console.log(`Hit rate: ${(stats.hitRate * 100).toFixed(1)}%`)
   * console.log(`Size: ${(stats.size / 1024 / 1024).toFixed(1)} MB`)
   * ```
   */
  getStats(): CacheStats {
    const total = this.hits + this.misses
    return {
      size: this.cache.calculatedSize ?? 0,
      entries: this.cache.size,
      maxSize: this.maxMemory,
      hitRate: total > 0 ? this.hits / total : 0,
    }
  }

  /**
   * Get number of cached entries
   */
  get size(): number {
    return this.cache.size
  }

  /**
   * Reset hit/miss counters
   */
  resetStats(): void {
    this.hits = 0
    this.misses = 0
  }

  /**
   * Hash file content for change detection
   *
   * Uses SHA-256 truncated to 16 characters for efficiency.
   */
  private hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex').slice(0, 16)
  }

  /**
   * Estimate memory size of a parse result
   *
   * Rough estimate based on array sizes and average item sizes.
   * SMI-1335: Named constants for magic numbers
   */
  private estimateSize(result: ParseResult): number {
    // SMI-1335: Named constants for clarity and maintainability
    /** Average bytes per import/export/function entry (strings + object overhead) */
    const BYTES_PER_ITEM = 100
    /** Fixed overhead for result object structure and metadata */
    const BASE_OVERHEAD_BYTES = 1000

    return (
      result.imports.length * BYTES_PER_ITEM +
      result.exports.length * BYTES_PER_ITEM +
      result.functions.length * BYTES_PER_ITEM +
      BASE_OVERHEAD_BYTES
    )
  }

  /**
   * Convert glob pattern to regex
   */
  private patternToRegex(pattern: string): RegExp {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')

    return new RegExp(`^${escaped}$`)
  }
}
