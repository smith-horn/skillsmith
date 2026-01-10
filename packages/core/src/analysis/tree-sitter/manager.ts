/**
 * SMI-1303: Tree-sitter Parser Manager
 *
 * Manages tree-sitter parser instances with lazy loading.
 * Uses web-tree-sitter (WASM) to avoid native module conflicts.
 *
 * @see docs/architecture/multi-language-analysis.md
 * @see ADR-002: Docker glibc Requirement
 * @module analysis/tree-sitter/manager
 */

import type { SupportedLanguage } from '../types.js'

/**
 * Parser interface (matches web-tree-sitter API)
 */
export interface TreeSitterParser {
  parse(input: string, previousTree?: TreeSitterTree): TreeSitterTree
  setLanguage(language: TreeSitterLanguage): void
  delete(): void
}

/**
 * Tree interface (matches web-tree-sitter API)
 */
export interface TreeSitterTree {
  rootNode: TreeSitterNode
  delete(): void
}

/**
 * Node interface (matches web-tree-sitter API)
 */
export interface TreeSitterNode {
  type: string
  text: string
  startPosition: { row: number; column: number }
  endPosition: { row: number; column: number }
  children: TreeSitterNode[]
  namedChildren: TreeSitterNode[]
  childCount: number
  namedChildCount: number
  child(index: number): TreeSitterNode | null
  namedChild(index: number): TreeSitterNode | null
  childForFieldName(fieldName: string): TreeSitterNode | null
  descendantsOfType(types: string | string[]): TreeSitterNode[]
}

/**
 * Language module interface
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface TreeSitterLanguage {
  // Opaque language type - intentionally empty, represents native tree-sitter module
}

/**
 * Options for TreeSitterManager
 */
export interface TreeSitterManagerOptions {
  /** Maximum parsers to cache (default: 6, one per language) */
  maxParsers?: number
}

/**
 * Manages tree-sitter parser instances with lazy loading
 *
 * Parsers are loaded on-demand and cached for reuse.
 * Uses WASM-based web-tree-sitter to avoid native module issues.
 *
 * @example
 * ```typescript
 * const manager = new TreeSitterManager()
 * const parser = await manager.getParser('python')
 * const tree = parser.parse('def main(): pass')
 * manager.dispose()
 * ```
 */
export class TreeSitterManager {
  private parsers: Map<SupportedLanguage, TreeSitterParser> = new Map()
  private loading: Map<SupportedLanguage, Promise<TreeSitterParser>> = new Map()
  private readonly maxParsers: number
  private initialized = false
  private initPromise: Promise<void> | null = null
  private ParserClass: (new () => TreeSitterParser) | null = null
  // SMI-1333: Track access order for proper LRU eviction
  private accessOrder: SupportedLanguage[] = []

  constructor(options: TreeSitterManagerOptions = {}) {
    this.maxParsers = options.maxParsers ?? 6
  }

  /**
   * SMI-1333: Update access order for LRU tracking
   * Moves the accessed language to the end (most recently used)
   */
  private updateAccessOrder(language: SupportedLanguage): void {
    const index = this.accessOrder.indexOf(language)
    if (index > -1) {
      this.accessOrder.splice(index, 1)
    }
    this.accessOrder.push(language)
  }

  /**
   * Initialize web-tree-sitter (must be called before first use)
   *
   * This initializes the WASM runtime. Called automatically by getParser().
   */
  async initialize(): Promise<void> {
    if (this.initialized) return

    if (this.initPromise) {
      await this.initPromise
      return
    }

    this.initPromise = this.doInitialize()
    await this.initPromise
  }

  private async doInitialize(): Promise<void> {
    try {
      // Dynamic import for web-tree-sitter (WASM-based)
      // @ts-expect-error - Optional dependency, may not have type declarations
      const TreeSitter = await import('web-tree-sitter')
      await TreeSitter.default.init()
      this.ParserClass = TreeSitter.default as unknown as new () => TreeSitterParser
      this.initialized = true
    } catch {
      // Fallback: try native tree-sitter if WASM unavailable
      try {
        // @ts-expect-error - Optional dependency, may not have type declarations
        const TreeSitterNative = await import('tree-sitter')
        this.ParserClass = TreeSitterNative.default as unknown as new () => TreeSitterParser
        this.initialized = true
      } catch {
        throw new Error(
          'tree-sitter is not available. Install web-tree-sitter or tree-sitter to enable multi-language analysis.'
        )
      }
    }
  }

  /**
   * Get parser for a language, loading if necessary
   *
   * Parsers are cached for reuse. If the maximum number of
   * parsers is reached, the least recently used is evicted.
   *
   * @param language - Language to get parser for
   * @returns Configured parser instance
   * @throws Error if language is not supported or tree-sitter unavailable
   *
   * @example
   * ```typescript
   * const parser = await manager.getParser('python')
   * const tree = parser.parse(pythonCode)
   * ```
   */
  async getParser(language: SupportedLanguage): Promise<TreeSitterParser> {
    // Ensure initialized
    await this.initialize()

    // Return cached parser
    const cached = this.parsers.get(language)
    if (cached) {
      // SMI-1333: Update access order on cache hit
      this.updateAccessOrder(language)
      return cached
    }

    // Return in-progress load
    const loading = this.loading.get(language)
    if (loading) {
      return loading
    }

    // Start new load
    const loadPromise = this.loadParser(language)
    this.loading.set(language, loadPromise)

    try {
      const parser = await loadPromise

      // SMI-1333: Evict LRU (first in accessOrder) if at capacity
      if (this.parsers.size >= this.maxParsers) {
        const lru = this.accessOrder.shift()
        if (lru) {
          const oldParser = this.parsers.get(lru)
          oldParser?.delete()
          this.parsers.delete(lru)
        }
      }

      this.parsers.set(language, parser)
      // SMI-1333: Track new parser in access order
      this.updateAccessOrder(language)
      return parser
    } finally {
      this.loading.delete(language)
    }
  }

  /**
   * Load a parser for a specific language
   */
  private async loadParser(language: SupportedLanguage): Promise<TreeSitterParser> {
    if (!this.ParserClass) {
      throw new Error('TreeSitterManager not initialized. Call initialize() first.')
    }

    const parser = new this.ParserClass()
    const languageModule = await this.loadLanguageModule(language)
    parser.setLanguage(languageModule)

    return parser
  }

  /**
   * Load the language module for tree-sitter
   */
  private async loadLanguageModule(language: SupportedLanguage): Promise<TreeSitterLanguage> {
    try {
      switch (language) {
        case 'typescript':
        case 'javascript': {
          // @ts-expect-error - Optional dependency, may not have type declarations
          const mod = await import('tree-sitter-typescript')
          // tree-sitter-typescript exports { typescript, tsx }
          return (mod as { typescript: TreeSitterLanguage }).typescript
        }
        case 'python': {
          // @ts-expect-error - Optional dependency, may not have type declarations
          const mod = await import('tree-sitter-python')
          return mod.default as TreeSitterLanguage
        }
        case 'go': {
          // @ts-expect-error - Optional dependency, may not have type declarations
          const mod = await import('tree-sitter-go')
          return mod.default as TreeSitterLanguage
        }
        case 'rust': {
          // @ts-expect-error - Optional dependency, may not have type declarations
          const mod = await import('tree-sitter-rust')
          return mod.default as TreeSitterLanguage
        }
        case 'java': {
          // @ts-expect-error - Optional dependency, may not have type declarations
          const mod = await import('tree-sitter-java')
          return mod.default as TreeSitterLanguage
        }
        default:
          throw new Error(`Unsupported language: ${language}`)
      }
    } catch (error) {
      const err = error as Error
      throw new Error(
        `Failed to load tree-sitter language module for ${language}: ${err.message}. ` +
          `Make sure tree-sitter-${language} is installed.`
      )
    }
  }

  /**
   * Check if a language is available
   *
   * @param language - Language to check
   * @returns True if the language can be loaded
   */
  async isLanguageAvailable(language: SupportedLanguage): Promise<boolean> {
    try {
      await this.loadLanguageModule(language)
      return true
    } catch {
      return false
    }
  }

  /**
   * Get list of currently loaded languages
   */
  getLoadedLanguages(): SupportedLanguage[] {
    return Array.from(this.parsers.keys())
  }

  /**
   * Clean up all parser resources
   *
   * Call this when the manager is no longer needed
   * to free memory and WASM resources.
   */
  dispose(): void {
    for (const parser of this.parsers.values()) {
      try {
        parser.delete()
      } catch {
        // Ignore errors during cleanup
      }
    }
    this.parsers.clear()
    this.loading.clear()
    // SMI-1333: Clear access order
    this.accessOrder = []
    this.initialized = false
    this.initPromise = null
    this.ParserClass = null
  }
}
