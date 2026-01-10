/**
 * SMI-1303: Language Router
 * SMI-1337: Added metrics integration
 * SMI-1339: Added factory pattern integration
 * SMI-1340: Added language detection for extensionless files
 *
 * Detects file language and dispatches to appropriate adapter.
 * Manages adapter registry and provides unified access to framework rules.
 *
 * @see docs/architecture/multi-language-analysis.md
 * @module analysis/router
 */

import path from 'path'
import type { LanguageAdapter } from './adapters/base.js'
import { AdapterFactory } from './adapters/factory.js'
import type { SupportedLanguage, FrameworkRule, ParseResult } from './types.js'
import { getAnalysisMetrics, type AnalysisMetrics } from './metrics.js'
import { LanguageDetector, type LanguageDetectionResult } from './language-detector.js'

/**
 * Options for LanguageRouter
 */
export interface LanguageRouterOptions {
  /** Whether to throw on unsupported files (default: false) */
  throwOnUnsupported?: boolean
  /** Custom metrics instance (uses default if not provided) */
  metrics?: AnalysisMetrics
  /** Languages to register adapters for (default: all) */
  languages?: SupportedLanguage[]
  /** Enable language detection for extensionless files (default: true) */
  enableLanguageDetection?: boolean
  /** Minimum confidence for language detection (default: 0.5) */
  detectionMinConfidence?: number
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
  private readonly metrics: AnalysisMetrics
  private readonly languageDetector: LanguageDetector | null
  private readonly enableLanguageDetection: boolean

  constructor(options: LanguageRouterOptions = {}) {
    this.throwOnUnsupported = options.throwOnUnsupported ?? false
    this.metrics = options.metrics ?? getAnalysisMetrics()
    this.enableLanguageDetection = options.enableLanguageDetection ?? true

    // Initialize language detector if enabled
    if (this.enableLanguageDetection) {
      this.languageDetector = new LanguageDetector({
        minConfidence: options.detectionMinConfidence ?? 0.5,
      })
    } else {
      this.languageDetector = null
    }
  }

  /**
   * Create a LanguageRouter with all adapters pre-registered
   *
   * Uses AdapterFactory to create adapters for all supported languages.
   *
   * @param options - Router options
   * @returns Configured LanguageRouter
   *
   * @example
   * ```typescript
   * // Create router with all language adapters
   * const router = LanguageRouter.createWithAllAdapters()
   *
   * // Create router with specific languages only
   * const router2 = LanguageRouter.createWithAllAdapters({
   *   languages: ['typescript', 'python']
   * })
   * ```
   */
  static createWithAllAdapters(options: LanguageRouterOptions = {}): LanguageRouter {
    const router = new LanguageRouter(options)

    // Determine which languages to register
    const languages = options.languages ?? AdapterFactory.getSupportedLanguages()

    // Create and register adapters using factory
    const adapters = AdapterFactory.createAdapters(languages)
    for (const adapter of adapters.values()) {
      router.registerAdapter(adapter)
    }

    return router
  }

  /**
   * Create a LanguageRouter using cached adapters from factory
   *
   * Reuses adapter instances from the factory cache for efficiency.
   *
   * @param options - Router options
   * @returns Configured LanguageRouter
   */
  static createWithCachedAdapters(options: LanguageRouterOptions = {}): LanguageRouter {
    const router = new LanguageRouter(options)

    // Determine which languages to register
    const languages = options.languages ?? AdapterFactory.getSupportedLanguages()

    // Use cached adapters from factory
    for (const language of languages) {
      const adapter = AdapterFactory.createCachedAdapter(language)
      router.registerAdapter(adapter)
    }

    return router
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
   * SMI-1340: For extensionless files, attempts language detection
   * from content if provided and detection is enabled.
   *
   * @param filePath - Path to the file
   * @param content - Optional file content for language detection
   * @returns Adapter or null if not supported
   *
   * @example
   * ```typescript
   * // With extension - uses extension mapping
   * const adapter = router.tryGetAdapter('main.py')
   *
   * // Without extension - attempts content detection
   * const adapter2 = router.tryGetAdapter('Makefile', 'package main\n...')
   * ```
   */
  tryGetAdapter(filePath: string, content?: string): LanguageAdapter | null {
    const ext = path.extname(filePath).toLowerCase()

    // Try extension-based lookup first
    const adapter = this.extensionMap.get(ext)
    if (adapter) {
      return adapter
    }

    // For extensionless files, try language detection if content provided
    if (!ext && content && this.languageDetector) {
      const detection = this.detectLanguageFromContent(content)
      if (detection.language) {
        return this.adapters.get(detection.language) ?? null
      }
    }

    return null
  }

  /**
   * Detect language from file content
   *
   * Uses heuristics to determine the language of a file:
   * - Shebang analysis (#!/usr/bin/python, etc.)
   * - Content patterns (import statements, syntax markers)
   * - Statistical keyword analysis
   *
   * @param content - File content to analyze
   * @returns Detection result with language and confidence
   *
   * @example
   * ```typescript
   * const result = router.detectLanguageFromContent('#!/usr/bin/env python3\nprint("hello")')
   * // { language: 'python', confidence: 1.0, method: 'shebang', evidence: [...] }
   * ```
   */
  detectLanguageFromContent(content: string): LanguageDetectionResult {
    if (!this.languageDetector) {
      return {
        language: null,
        confidence: 0,
        method: 'none',
        evidence: ['Language detection disabled'],
      }
    }

    return this.languageDetector.detect(content)
  }

  /**
   * Try to get adapter using content detection
   *
   * Specifically for extensionless files where content-based
   * detection is required.
   *
   * @param content - File content to analyze
   * @returns Object with adapter and detection result
   */
  tryGetAdapterFromContent(content: string): {
    adapter: LanguageAdapter | null
    detection: LanguageDetectionResult
  } {
    const detection = this.detectLanguageFromContent(content)

    if (detection.language) {
      const adapter = this.adapters.get(detection.language) ?? null
      return { adapter, detection }
    }

    return { adapter: null, detection }
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
   * SMI-1337: Records metrics for file parsing.
   *
   * @param content - File content
   * @param filePath - Path to the file
   * @returns Parse result
   * @throws Error if no adapter for file type
   */
  parseFile(content: string, filePath: string): ParseResult {
    const adapter = this.getAdapter(filePath)
    const language = adapter.language
    const start = performance.now()

    try {
      const result = adapter.parseFile(content, filePath)
      this.metrics.recordFileParsed(language)
      return result
    } catch (error) {
      this.metrics.recordError('parse_error', language)
      throw error
    } finally {
      const duration = performance.now() - start
      this.metrics.recordParseDuration(language, duration)
    }
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
