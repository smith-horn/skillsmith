/**
 * SMI-1339: Adapter Factory Pattern
 *
 * Factory class for creating language adapters with lazy instantiation.
 * Avoids unnecessary adapter creation and provides centralized adapter management.
 *
 * @see docs/architecture/multi-language-analysis.md
 * @module analysis/adapters/factory
 */

import type { LanguageAdapter } from './base.js'
import type { SupportedLanguage } from '../types.js'
import { TypeScriptAdapter } from './typescript.js'
import { PythonAdapter } from './python.js'
import { GoAdapter } from './go.js'
import { RustAdapter } from './rust.js'
import { JavaAdapter } from './java.js'

/**
 * Factory function type for creating adapters
 */
type AdapterFactoryFn = () => LanguageAdapter

/**
 * Registry of adapter factory functions by language
 */
const ADAPTER_FACTORIES: Record<SupportedLanguage, AdapterFactoryFn> = {
  typescript: () => new TypeScriptAdapter(),
  javascript: () => new TypeScriptAdapter(), // TypeScript adapter handles JS
  python: () => new PythonAdapter(),
  go: () => new GoAdapter(),
  rust: () => new RustAdapter(),
  java: () => new JavaAdapter(),
}

/**
 * Factory class for creating language adapters
 *
 * Provides lazy instantiation of adapters to avoid creating
 * unused adapter instances and reduce startup overhead.
 *
 * @example
 * ```typescript
 * // Create a single adapter
 * const pythonAdapter = AdapterFactory.createAdapter('python')
 *
 * // Create all adapters
 * const allAdapters = AdapterFactory.createAll()
 *
 * // Create specific adapters
 * const adapters = AdapterFactory.createAdapters(['typescript', 'python'])
 * ```
 */
export class AdapterFactory {
  /** Cache of created adapters for reuse */
  private static adapterCache: Map<SupportedLanguage, LanguageAdapter> = new Map()

  /**
   * Create an adapter for a specific language
   *
   * Creates a new adapter instance for the given language.
   * Use createCachedAdapter() if you want to reuse adapter instances.
   *
   * @param language - Language to create adapter for
   * @returns New adapter instance
   * @throws Error if language is not supported
   *
   * @example
   * ```typescript
   * const adapter = AdapterFactory.createAdapter('python')
   * const result = adapter.parseFile(content, 'main.py')
   * adapter.dispose()
   * ```
   */
  static createAdapter(language: SupportedLanguage): LanguageAdapter {
    const factory = ADAPTER_FACTORIES[language]

    if (!factory) {
      const supported = AdapterFactory.getSupportedLanguages()
      throw new Error(
        `Unsupported language: ${language}. ` + `Supported languages: ${supported.join(', ')}`
      )
    }

    return factory()
  }

  /**
   * Get or create a cached adapter for a specific language
   *
   * Returns an existing adapter if one was previously created,
   * otherwise creates and caches a new adapter instance.
   *
   * @param language - Language to get adapter for
   * @returns Cached or new adapter instance
   * @throws Error if language is not supported
   *
   * @example
   * ```typescript
   * // Reuses same instance
   * const adapter1 = AdapterFactory.createCachedAdapter('typescript')
   * const adapter2 = AdapterFactory.createCachedAdapter('typescript')
   * console.log(adapter1 === adapter2) // true
   * ```
   */
  static createCachedAdapter(language: SupportedLanguage): LanguageAdapter {
    const cached = this.adapterCache.get(language)
    if (cached) {
      return cached
    }

    const adapter = this.createAdapter(language)
    this.adapterCache.set(language, adapter)
    return adapter
  }

  /**
   * Create adapters for all supported languages
   *
   * Returns a Map of language to adapter for all supported languages.
   * Each adapter is created lazily (new instance per call).
   *
   * @returns Map of language to adapter
   *
   * @example
   * ```typescript
   * const adapters = AdapterFactory.createAll()
   * for (const [lang, adapter] of adapters) {
   *   console.log(`${lang}: ${adapter.extensions.join(', ')}`)
   * }
   * ```
   */
  static createAll(): Map<SupportedLanguage, LanguageAdapter> {
    const adapters = new Map<SupportedLanguage, LanguageAdapter>()

    for (const language of AdapterFactory.getSupportedLanguages()) {
      adapters.set(language, this.createAdapter(language))
    }

    return adapters
  }

  /**
   * Create adapters for specific languages
   *
   * @param languages - Array of languages to create adapters for
   * @returns Map of language to adapter
   * @throws Error if any language is not supported
   *
   * @example
   * ```typescript
   * const adapters = AdapterFactory.createAdapters(['typescript', 'python'])
   * ```
   */
  static createAdapters(languages: SupportedLanguage[]): Map<SupportedLanguage, LanguageAdapter> {
    const adapters = new Map<SupportedLanguage, LanguageAdapter>()

    for (const language of languages) {
      adapters.set(language, this.createAdapter(language))
    }

    return adapters
  }

  /**
   * Get list of supported languages
   *
   * @returns Array of supported language identifiers
   */
  static getSupportedLanguages(): SupportedLanguage[] {
    return Object.keys(ADAPTER_FACTORIES) as SupportedLanguage[]
  }

  /**
   * Check if a language is supported
   *
   * @param language - Language to check
   * @returns True if language is supported
   */
  static isSupported(language: string): language is SupportedLanguage {
    return language in ADAPTER_FACTORIES
  }

  /**
   * Get file extensions for a language
   *
   * Returns the file extensions handled by the adapter for a given language,
   * without needing to instantiate the adapter.
   *
   * @param language - Language to get extensions for
   * @returns Array of file extensions (with dot prefix)
   */
  static getExtensions(language: SupportedLanguage): string[] {
    // Use cached adapter if available, otherwise create temporary one
    const cached = this.adapterCache.get(language)
    if (cached) {
      return [...cached.extensions]
    }

    // Create temporary adapter to get extensions
    const adapter = this.createAdapter(language)
    const extensions = [...adapter.extensions]
    adapter.dispose()
    return extensions
  }

  /**
   * Get all file extensions from all adapters
   *
   * Returns a map of file extension to language.
   * Note: TypeScript-specific extensions (.ts, .tsx) map to 'typescript',
   * while JavaScript-specific extensions (.js, .jsx, etc.) map to 'javascript'.
   *
   * @returns Map of extension to language
   */
  static getAllExtensions(): Map<string, SupportedLanguage> {
    const extensionMap = new Map<string, SupportedLanguage>()

    // Define canonical mappings - TypeScript-specific extensions should map to typescript
    const canonicalMappings: Record<string, SupportedLanguage> = {
      '.ts': 'typescript',
      '.tsx': 'typescript',
      '.mts': 'typescript',
      '.cts': 'typescript',
      '.js': 'javascript',
      '.jsx': 'javascript',
      '.mjs': 'javascript',
      '.cjs': 'javascript',
    }

    for (const language of this.getSupportedLanguages()) {
      const extensions = this.getExtensions(language)
      for (const ext of extensions) {
        const normalizedExt = ext.toLowerCase()
        // Use canonical mapping if available, otherwise use the adapter's language
        const mappedLanguage = canonicalMappings[normalizedExt] ?? language
        // Only set if not already defined (first definition wins for non-canonical)
        if (!extensionMap.has(normalizedExt)) {
          extensionMap.set(normalizedExt, mappedLanguage)
        }
      }
    }

    return extensionMap
  }

  /**
   * Clear the adapter cache
   *
   * Disposes all cached adapters and clears the cache.
   * Call this when you want to free resources or reset state.
   */
  static clearCache(): void {
    for (const adapter of this.adapterCache.values()) {
      try {
        adapter.dispose()
      } catch {
        // Ignore errors during cleanup
      }
    }
    this.adapterCache.clear()
  }

  /**
   * Get cache statistics
   *
   * @returns Object with cache stats
   */
  static getCacheStats(): { size: number; languages: SupportedLanguage[] } {
    return {
      size: this.adapterCache.size,
      languages: Array.from(this.adapterCache.keys()),
    }
  }
}
