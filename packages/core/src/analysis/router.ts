/**
 * SMI-1303: Language Router
 *
 * Detects file language and dispatches to appropriate adapter.
 * Manages adapter registry and provides unified access to framework rules.
 *
 * @see docs/architecture/multi-language-analysis.md
 * @module analysis/router
 */

import path from 'path'
import type { LanguageAdapter } from './adapters/base.js'
import type { SupportedLanguage, FrameworkRule, ParseResult } from './types.js'

/**
 * Options for LanguageRouter
 */
export interface LanguageRouterOptions {
  /** Whether to throw on unsupported files (default: false) */
  throwOnUnsupported?: boolean
}

/**
 * Routes files to appropriate language adapters
 *
 * Manages a registry of language adapters and provides:
 * - File extension to adapter mapping
 * - Aggregated framework detection rules
 * - Unified parsing interface
 *
 * @example
 * ```typescript
 * const router = new LanguageRouter()
 *
 * // Register adapters
 * router.registerAdapter(new TypeScriptAdapter())
 * router.registerAdapter(new PythonAdapter())
 *
 * // Route files to appropriate adapter
 * const adapter = router.getAdapter('src/main.py')
 * const result = adapter.parseFile(content, 'src/main.py')
 * ```
 */
export class LanguageRouter {
  private adapters: Map<SupportedLanguage, LanguageAdapter> = new Map()
  private extensionMap: Map<string, LanguageAdapter> = new Map()
  private readonly throwOnUnsupported: boolean

  constructor(options: LanguageRouterOptions = {}) {
    this.throwOnUnsupported = options.throwOnUnsupported ?? false
  }

  /**
   * Register a language adapter
   *
   * The adapter's extensions are mapped for fast lookup.
   * If an adapter for the same language exists, it is replaced.
   *
   * @param adapter - Adapter to register
   *
   * @example
   * ```typescript
   * router.registerAdapter(new PythonAdapter())
   * // Now handles .py, .pyi, .pyw files
   * ```
   */
  registerAdapter(adapter: LanguageAdapter): void {
    // Store by language
    const existing = this.adapters.get(adapter.language)
    if (existing) {
      // Remove old extension mappings
      for (const ext of existing.extensions) {
        this.extensionMap.delete(ext.toLowerCase())
      }
    }

    this.adapters.set(adapter.language, adapter)

    // Map extensions to adapter
    for (const ext of adapter.extensions) {
      this.extensionMap.set(ext.toLowerCase(), adapter)
    }
  }

  /**
   * Unregister a language adapter
   *
   * @param language - Language to unregister
   * @returns True if adapter was found and removed
   */
  unregisterAdapter(language: SupportedLanguage): boolean {
    const adapter = this.adapters.get(language)
    if (!adapter) return false

    // Remove extension mappings
    for (const ext of adapter.extensions) {
      this.extensionMap.delete(ext.toLowerCase())
    }

    this.adapters.delete(language)
    return true
  }

  /**
   * Get adapter for a file path
   *
   * @param filePath - Path to the file
   * @returns Adapter that can handle the file
   * @throws Error if no adapter found and throwOnUnsupported is true
   *
   * @example
   * ```typescript
   * const adapter = router.getAdapter('src/main.py')
   * // Returns PythonAdapter
   *
   * const adapter2 = router.getAdapter('unknown.xyz')
   * // Throws if throwOnUnsupported, otherwise returns null
   * ```
   */
  getAdapter(filePath: string): LanguageAdapter {
    const ext = path.extname(filePath).toLowerCase()
    const adapter = this.extensionMap.get(ext)

    if (!adapter) {
      if (this.throwOnUnsupported) {
        throw new Error(
          `No adapter registered for extension: ${ext}. ` +
            `Supported extensions: ${this.getSupportedExtensions().join(', ')}`
        )
      }
      // Return a no-op adapter for unsupported files
      throw new Error(`No adapter registered for extension: ${ext}`)
    }

    return adapter
  }

  /**
   * Try to get adapter for a file path (returns null instead of throwing)
   *
   * @param filePath - Path to the file
   * @returns Adapter or null if not supported
   */
  tryGetAdapter(filePath: string): LanguageAdapter | null {
    const ext = path.extname(filePath).toLowerCase()
    return this.extensionMap.get(ext) ?? null
  }

  /**
   * Check if a file can be handled
   *
   * @param filePath - Path to check
   * @returns True if an adapter is registered for this file type
   *
   * @example
   * ```typescript
   * router.canHandle('main.py')   // true (if Python adapter registered)
   * router.canHandle('main.xyz')  // false
   * ```
   */
  canHandle(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase()
    return this.extensionMap.has(ext)
  }

  /**
   * Get language for a file path
   *
   * @param filePath - Path to check
   * @returns Language or null if not supported
   */
  getLanguage(filePath: string): SupportedLanguage | null {
    const adapter = this.tryGetAdapter(filePath)
    return adapter?.language ?? null
  }

  /**
   * Parse a file using the appropriate adapter
   *
   * Convenience method that combines getAdapter and parseFile.
   *
   * @param content - File content
   * @param filePath - Path to the file
   * @returns Parse result
   * @throws Error if no adapter for file type
   */
  parseFile(content: string, filePath: string): ParseResult {
    const adapter = this.getAdapter(filePath)
    return adapter.parseFile(content, filePath)
  }

  /**
   * Get list of supported languages
   *
   * @returns Array of registered languages
   */
  getSupportedLanguages(): SupportedLanguage[] {
    return Array.from(this.adapters.keys())
  }

  /**
   * Get list of supported file extensions
   *
   * @returns Array of extensions (with dot)
   */
  getSupportedExtensions(): string[] {
    return Array.from(this.extensionMap.keys())
  }

  /**
   * Get adapter for a specific language
   *
   * @param language - Language to get adapter for
   * @returns Adapter or undefined if not registered
   */
  getAdapterByLanguage(language: SupportedLanguage): LanguageAdapter | undefined {
    return this.adapters.get(language)
  }

  /**
   * Get all framework detection rules from all adapters
   *
   * Aggregates rules from all registered adapters for
   * comprehensive framework detection.
   *
   * @returns Combined array of framework rules
   *
   * @example
   * ```typescript
   * const rules = router.getAllFrameworkRules()
   * // Includes rules for React, Django, Gin, Actix, etc.
   * ```
   */
  getAllFrameworkRules(): FrameworkRule[] {
    const rules: FrameworkRule[] = []

    for (const adapter of this.adapters.values()) {
      rules.push(...adapter.getFrameworkRules())
    }

    return rules
  }

  /**
   * Get framework rules for a specific language
   *
   * @param language - Language to get rules for
   * @returns Framework rules or empty array
   */
  getFrameworkRules(language: SupportedLanguage): FrameworkRule[] {
    const adapter = this.adapters.get(language)
    return adapter?.getFrameworkRules() ?? []
  }

  /**
   * Get number of registered adapters
   */
  get adapterCount(): number {
    return this.adapters.size
  }

  /**
   * Clean up all adapters
   *
   * Disposes all registered adapters and clears the registry.
   */
  dispose(): void {
    for (const adapter of this.adapters.values()) {
      try {
        adapter.dispose()
      } catch {
        // Ignore errors during cleanup
      }
    }
    this.adapters.clear()
    this.extensionMap.clear()
  }
}
