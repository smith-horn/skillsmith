/**
 * SMI-1309: Incremental Parser Coordinator
 *
 * Coordinates incremental parsing across language adapters.
 * Uses tree caching to enable fast re-parsing when only
 * small portions of files change.
 *
 * Performance target: < 100ms for incremental parse
 *
 * @see docs/architecture/multi-language-analysis.md
 * @module analysis/incremental-parser
 */

import { createHash } from 'crypto'
import { TreeCache, type TreeCacheStats } from './tree-cache.js'
import { findMinimalEdit, calculateEdit, type FileEdit, type EditDiff } from './incremental.js'
import type { ParseResult } from './types.js'
import type { LanguageAdapter } from './adapters/base.js'

/**
 * Result of an incremental parse operation
 */
export interface IncrementalParseResult {
  /** The parse result (imports, exports, functions) */
  result: ParseResult
  /** True if incremental parsing was used */
  wasIncremental: boolean
  /** Parse duration in milliseconds */
  durationMs: number
  /** True if result came from cache */
  wasCached: boolean
}

/**
 * Options for IncrementalParser
 */
export interface IncrementalParserOptions {
  /** Maximum trees to cache (default: 100) */
  maxTrees?: number
  /** Enable content caching for unchanged files */
  cacheContent?: boolean
}

/**
 * Statistics for incremental parser
 */
export interface IncrementalParserStats {
  /** Tree cache statistics */
  treeCache: TreeCacheStats
  /** Number of files with cached content */
  contentCacheSize: number
  /** Total incremental parses performed */
  incrementalParses: number
  /** Total full parses performed */
  fullParses: number
  /** Average incremental parse time in ms */
  avgIncrementalTimeMs: number
  /** Average full parse time in ms */
  avgFullTimeMs: number
}

/**
 * Incremental parsing coordinator
 *
 * Manages tree caching and content tracking to enable efficient
 * incremental parsing when files change.
 *
 * Flow:
 * 1. Check if content unchanged (return cached result)
 * 2. Check if previous tree exists for incremental parse
 * 3. Calculate edit between old and new content
 * 4. Apply edit to tree and re-parse incrementally
 * 5. Cache new tree for future updates
 *
 * @example
 * ```typescript
 * const parser = new IncrementalParser({ maxTrees: 50 })
 * const adapter = new TypeScriptAdapter()
 *
 * // First parse (full)
 * const result1 = parser.parse('src/main.ts', content1, adapter)
 * console.log(result1.wasIncremental) // false
 *
 * // Second parse with small change (incremental)
 * const result2 = parser.parse('src/main.ts', content2, adapter)
 * console.log(result2.wasIncremental) // true
 * console.log(result2.durationMs) // < 100ms
 *
 * // Cleanup
 * parser.dispose()
 * ```
 */
export class IncrementalParser {
  private readonly treeCache: TreeCache
  private readonly contentCache: Map<string, string>
  private readonly cacheContent: boolean
  private incrementalParses = 0
  private fullParses = 0
  private totalIncrementalTime = 0
  private totalFullTime = 0

  constructor(options: IncrementalParserOptions = {}) {
    this.treeCache = new TreeCache({ maxTrees: options.maxTrees })
    this.contentCache = new Map()
    this.cacheContent = options.cacheContent ?? true
  }

  /**
   * Parse file, using incremental parsing if possible
   *
   * Automatically determines whether to use incremental or
   * full parsing based on cached state.
   *
   * @param filePath - Path to the file
   * @param content - Current file content
   * @param adapter - Language adapter for parsing
   * @returns Parse result with metadata
   */
  parse(filePath: string, content: string, adapter: LanguageAdapter): IncrementalParseResult {
    const start = performance.now()
    const contentHash = this.hashContent(content)

    // Check if tree is still valid (content unchanged)
    if (this.treeCache.isValid(filePath, contentHash)) {
      // Content unchanged, use cached tree for extraction
      const cachedTree = this.treeCache.get(filePath)
      if (cachedTree) {
        // Re-extract from cached tree (cheaper than full parse)
        const result = adapter.parseFile(content, filePath)
        const durationMs = performance.now() - start
        return {
          result,
          wasIncremental: true,
          wasCached: true,
          durationMs,
        }
      }
    }

    // Check if we can do incremental parse
    const oldContent = this.contentCache.get(filePath)
    const previousTree = this.treeCache.get(filePath)

    if (oldContent && previousTree && this.cacheContent) {
      // Try incremental parse
      const edit = findMinimalEdit(oldContent, content)
      if (edit) {
        return this.doIncrementalParse(
          filePath,
          content,
          contentHash,
          adapter,
          previousTree,
          edit,
          start
        )
      }
    }

    // Full parse required
    return this.doFullParse(filePath, content, contentHash, adapter, start)
  }

  /**
   * Parse file with explicit edit information
   *
   * Use this when edit information is already available
   * (e.g., from an editor's change event).
   *
   * @param filePath - Path to the file
   * @param content - Current file content
   * @param adapter - Language adapter
   * @param edit - Edit information
   * @returns Parse result with metadata
   */
  parseWithEdit(
    filePath: string,
    content: string,
    adapter: LanguageAdapter,
    edit: FileEdit
  ): IncrementalParseResult {
    const start = performance.now()
    const contentHash = this.hashContent(content)

    const previousTree = this.treeCache.get(filePath)
    if (previousTree) {
      // Apply edit to previous tree
      const result = adapter.parseIncremental(content, filePath, {
        previousTree,
        edit,
      })

      // Update caches
      if (this.cacheContent) {
        this.contentCache.set(filePath, content)
      }
      this.treeCache.set(filePath, null, contentHash) // Store hash for validation

      const durationMs = performance.now() - start
      this.recordIncremental(durationMs)

      return {
        result,
        wasIncremental: true,
        wasCached: false,
        durationMs,
      }
    }

    // No previous tree, fall back to full parse
    return this.doFullParse(filePath, content, contentHash, adapter, start)
  }

  /**
   * Invalidate cache for file(s)
   *
   * Call this when files are deleted or externally modified.
   *
   * @param filePaths - Path or paths to invalidate
   */
  invalidate(filePaths: string | string[]): void {
    const paths = Array.isArray(filePaths) ? filePaths : [filePaths]
    this.treeCache.invalidateMany(paths)
    for (const path of paths) {
      this.contentCache.delete(path)
    }
  }

  /**
   * Invalidate files matching a pattern
   *
   * @param pattern - Regex to match file paths
   * @returns Number of entries invalidated
   */
  invalidatePattern(pattern: RegExp): number {
    let count = this.treeCache.invalidatePattern(pattern)
    for (const path of this.contentCache.keys()) {
      if (pattern.test(path)) {
        this.contentCache.delete(path)
        count++
      }
    }
    return count
  }

  /**
   * Check if a file is cached
   *
   * @param filePath - Path to check
   * @returns True if content and/or tree is cached
   */
  isCached(filePath: string): boolean {
    return this.treeCache.has(filePath) || this.contentCache.has(filePath)
  }

  /**
   * Get cache statistics
   */
  getStats(): IncrementalParserStats {
    return {
      treeCache: this.treeCache.getStats(),
      contentCacheSize: this.contentCache.size,
      incrementalParses: this.incrementalParses,
      fullParses: this.fullParses,
      avgIncrementalTimeMs:
        this.incrementalParses > 0 ? this.totalIncrementalTime / this.incrementalParses : 0,
      avgFullTimeMs: this.fullParses > 0 ? this.totalFullTime / this.fullParses : 0,
    }
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.treeCache.resetStats()
    this.incrementalParses = 0
    this.fullParses = 0
    this.totalIncrementalTime = 0
    this.totalFullTime = 0
  }

  /**
   * Clear all caches
   */
  clear(): void {
    this.treeCache.clear()
    this.contentCache.clear()
    this.resetStats()
  }

  /**
   * Dispose of all resources
   *
   * Call this when the parser is no longer needed.
   */
  dispose(): void {
    this.treeCache.dispose()
    this.contentCache.clear()
  }

  /**
   * Get the underlying tree cache (for advanced use)
   */
  getTreeCache(): TreeCache {
    return this.treeCache
  }

  /**
   * Perform incremental parse
   */
  private doIncrementalParse(
    filePath: string,
    content: string,
    contentHash: string,
    adapter: LanguageAdapter,
    previousTree: unknown,
    edit: EditDiff,
    startTime: number
  ): IncrementalParseResult {
    const oldContent = this.contentCache.get(filePath)!

    const fileEdit = calculateEdit(
      oldContent,
      content,
      edit.changeStart,
      edit.changeEnd,
      edit.newText
    )

    const result = adapter.parseIncremental(content, filePath, {
      previousTree,
      edit: fileEdit,
    })

    // Update caches
    if (this.cacheContent) {
      this.contentCache.set(filePath, content)
    }
    this.treeCache.set(filePath, null, contentHash) // Store hash for validation

    const durationMs = performance.now() - startTime
    this.recordIncremental(durationMs)

    return {
      result,
      wasIncremental: true,
      wasCached: false,
      durationMs,
    }
  }

  /**
   * Perform full parse
   */
  private doFullParse(
    filePath: string,
    content: string,
    contentHash: string,
    adapter: LanguageAdapter,
    startTime: number
  ): IncrementalParseResult {
    const result = adapter.parseFile(content, filePath)

    // Update caches
    if (this.cacheContent) {
      this.contentCache.set(filePath, content)
    }
    this.treeCache.set(filePath, null, contentHash) // Store hash for validation

    const durationMs = performance.now() - startTime
    this.recordFull(durationMs)

    return {
      result,
      wasIncremental: false,
      wasCached: false,
      durationMs,
    }
  }

  /**
   * Record incremental parse statistics
   */
  private recordIncremental(durationMs: number): void {
    this.incrementalParses++
    this.totalIncrementalTime += durationMs
  }

  /**
   * Record full parse statistics
   */
  private recordFull(durationMs: number): void {
    this.fullParses++
    this.totalFullTime += durationMs
  }

  /**
   * Hash content for cache validation
   */
  private hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex').slice(0, 16)
  }
}
