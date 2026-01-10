/**
 * SMI-1309: Tree Cache for Incremental Parsing
 *
 * LRU cache for parsed AST trees to enable fast incremental updates.
 * Manages tree lifecycle independently from parse result caching.
 *
 * Tree-sitter trees hold native resources and must be explicitly
 * deleted to free memory. This cache handles that lifecycle.
 *
 * @see docs/architecture/multi-language-analysis.md
 * @module analysis/tree-cache
 */

import { createHash } from 'crypto'

/**
 * Cached tree entry with metadata
 */
export interface CachedTree {
  /** Tree-sitter Tree object (typed as unknown for flexibility) */
  tree: unknown
  /** Version number for LRU tracking */
  version: number
  /** SHA-256 hash prefix of content (for validation) */
  contentHash: string
  /** Timestamp when entry was created */
  createdAt: number
}

/**
 * Cache statistics for monitoring
 */
export interface TreeCacheStats {
  /** Current number of cached trees */
  size: number
  /** Maximum trees allowed */
  maxSize: number
  /** Hit rate (0-1) since last reset */
  hitRate: number
  /** Oldest tree version in cache */
  oldestVersion: number
  /** Newest tree version in cache */
  newestVersion: number
}

/**
 * Options for TreeCache
 */
export interface TreeCacheOptions {
  /** Maximum number of trees to cache (default: 100) */
  maxTrees?: number
}

/**
 * LRU cache for parsed AST trees
 *
 * Manages tree-sitter tree instances with proper lifecycle handling.
 * Trees require explicit deletion to free native memory.
 *
 * Separate from ParseCache because:
 * 1. Trees have native resources requiring explicit cleanup
 * 2. Tree reuse enables incremental parsing
 * 3. Different eviction strategies may be optimal
 *
 * @example
 * ```typescript
 * const cache = new TreeCache({ maxTrees: 50 })
 *
 * // Store tree after initial parse
 * const tree = parser.parse(content)
 * cache.set('src/main.ts', tree, hashContent(content))
 *
 * // Later, check if tree is valid for incremental parse
 * if (cache.isValid('src/main.ts', hashContent(newContent))) {
 *   // Use cached tree as base
 *   const oldTree = cache.get('src/main.ts')
 *   oldTree.edit(editInfo)
 *   const newTree = parser.parse(newContent, oldTree)
 * }
 *
 * // Cleanup
 * cache.dispose()
 * ```
 */
export class TreeCache {
  private trees: Map<string, CachedTree> = new Map()
  private readonly maxTrees: number
  private version = 0
  private hits = 0
  private misses = 0

  constructor(options: TreeCacheOptions = {}) {
    this.maxTrees = options.maxTrees ?? 100
  }

  /**
   * Get cached tree for a file
   *
   * Returns null if no tree is cached for the path.
   * Updates hit/miss statistics.
   *
   * @param filePath - Path to look up
   * @returns Cached tree or null
   */
  get(filePath: string): unknown | null {
    const entry = this.trees.get(filePath)
    if (entry) {
      this.hits++
      return entry.tree
    }
    this.misses++
    return null
  }

  /**
   * Get full cache entry with metadata
   *
   * @param filePath - Path to look up
   * @returns Full cache entry or undefined
   */
  getEntry(filePath: string): CachedTree | undefined {
    return this.trees.get(filePath)
  }

  /**
   * Check if cached tree is valid for content
   *
   * Compares content hash to detect if the cached tree
   * can be used as a base for incremental parsing.
   *
   * @param filePath - Path to check
   * @param contentHash - Hash of current content
   * @returns True if tree matches content
   */
  isValid(filePath: string, contentHash: string): boolean {
    const entry = this.trees.get(filePath)
    return entry?.contentHash === contentHash
  }

  /**
   * Get version number for a cached tree
   *
   * @param filePath - Path to look up
   * @returns Version number or null if not cached
   */
  getVersion(filePath: string): number | null {
    return this.trees.get(filePath)?.version ?? null
  }

  /**
   * Store a tree in cache
   *
   * Evicts oldest entry if at capacity.
   * Properly deletes existing tree before replacement.
   *
   * @param filePath - File path as cache key
   * @param tree - Tree-sitter tree to cache
   * @param contentHash - Hash of content tree was parsed from
   */
  set(filePath: string, tree: unknown, contentHash: string): void {
    // Evict oldest if at capacity and this is a new entry
    if (this.trees.size >= this.maxTrees && !this.trees.has(filePath)) {
      this.evictOldest()
    }

    // Delete existing tree to free native memory
    const existing = this.trees.get(filePath)
    if (existing) {
      this.deleteTree(existing.tree)
    }

    this.version++
    this.trees.set(filePath, {
      tree,
      version: this.version,
      contentHash,
      createdAt: Date.now(),
    })
  }

  /**
   * Invalidate cached tree for a file
   *
   * Deletes tree to free native memory.
   *
   * @param filePath - Path to invalidate
   */
  invalidate(filePath: string): void {
    const entry = this.trees.get(filePath)
    if (entry) {
      this.deleteTree(entry.tree)
      this.trees.delete(filePath)
    }
  }

  /**
   * Invalidate multiple files
   *
   * @param filePaths - Paths to invalidate
   */
  invalidateMany(filePaths: string[]): void {
    for (const filePath of filePaths) {
      this.invalidate(filePath)
    }
  }

  /**
   * Invalidate files matching a pattern
   *
   * @param pattern - Regex pattern to match file paths
   * @returns Number of entries invalidated
   */
  invalidatePattern(pattern: RegExp): number {
    let count = 0
    for (const filePath of this.trees.keys()) {
      if (pattern.test(filePath)) {
        this.invalidate(filePath)
        count++
      }
    }
    return count
  }

  /**
   * Check if a file has a cached tree
   *
   * @param filePath - Path to check
   * @returns True if tree is cached
   */
  has(filePath: string): boolean {
    return this.trees.has(filePath)
  }

  /**
   * Get current cache size
   */
  get size(): number {
    return this.trees.size
  }

  /**
   * Get cache statistics
   *
   * @returns Current cache statistics
   */
  getStats(): TreeCacheStats {
    let oldestVersion = Infinity
    let newestVersion = 0

    for (const entry of this.trees.values()) {
      if (entry.version < oldestVersion) oldestVersion = entry.version
      if (entry.version > newestVersion) newestVersion = entry.version
    }

    const total = this.hits + this.misses
    return {
      size: this.trees.size,
      maxSize: this.maxTrees,
      hitRate: total > 0 ? this.hits / total : 0,
      oldestVersion: oldestVersion === Infinity ? 0 : oldestVersion,
      newestVersion,
    }
  }

  /**
   * Reset hit/miss counters
   */
  resetStats(): void {
    this.hits = 0
    this.misses = 0
  }

  /**
   * Clear all cached trees
   *
   * Properly deletes all trees to free native resources.
   */
  clear(): void {
    for (const entry of this.trees.values()) {
      this.deleteTree(entry.tree)
    }
    this.trees.clear()
    this.hits = 0
    this.misses = 0
  }

  /**
   * Dispose of cache and free all resources
   *
   * Call this when the cache is no longer needed.
   */
  dispose(): void {
    this.clear()
  }

  /**
   * Get list of all cached file paths
   */
  keys(): string[] {
    return Array.from(this.trees.keys())
  }

  /**
   * Hash content for cache validation
   *
   * @param content - Content to hash
   * @returns SHA-256 hash prefix (16 chars)
   */
  static hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex').slice(0, 16)
  }

  /**
   * Evict the oldest entry from cache
   */
  private evictOldest(): void {
    let oldestPath: string | null = null
    let oldestVersion = Infinity

    for (const [path, entry] of this.trees) {
      if (entry.version < oldestVersion) {
        oldestVersion = entry.version
        oldestPath = path
      }
    }

    if (oldestPath) {
      this.invalidate(oldestPath)
    }
  }

  /**
   * Safely delete a tree object
   *
   * Handles trees that may or may not have a delete method.
   */
  private deleteTree(tree: unknown): void {
    if (tree && typeof tree === 'object') {
      const maybeTree = tree as { delete?: () => void }
      if (typeof maybeTree.delete === 'function') {
        try {
          maybeTree.delete()
        } catch {
          // Ignore errors during cleanup
        }
      }
    }
  }
}
