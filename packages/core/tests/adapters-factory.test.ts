/**
 * SMI-1339: Adapter Factory Tests
 *
 * Tests for the AdapterFactory class, verifying:
 * - Adapter creation for all supported languages
 * - Lazy instantiation
 * - Caching behavior
 * - Extension mapping
 *
 * @see docs/architecture/multi-language-analysis.md
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AdapterFactory } from '../src/analysis/adapters/factory.js'
import { TypeScriptAdapter } from '../src/analysis/adapters/typescript.js'
import { PythonAdapter } from '../src/analysis/adapters/python.js'
import { GoAdapter } from '../src/analysis/adapters/go.js'
import { RustAdapter } from '../src/analysis/adapters/rust.js'
import { JavaAdapter } from '../src/analysis/adapters/java.js'

describe('AdapterFactory', () => {
  beforeEach(() => {
    // Clear cache before each test
    AdapterFactory.clearCache()
  })

  afterEach(() => {
    // Clean up after tests
    AdapterFactory.clearCache()
  })

  describe('createAdapter', () => {
    it('creates TypeScript adapter', () => {
      const adapter = AdapterFactory.createAdapter('typescript')
      expect(adapter).toBeInstanceOf(TypeScriptAdapter)
      expect(adapter.language).toBe('typescript')
      adapter.dispose()
    })

    it('creates JavaScript adapter (via TypeScript adapter)', () => {
      const adapter = AdapterFactory.createAdapter('javascript')
      expect(adapter).toBeInstanceOf(TypeScriptAdapter)
      // JavaScript uses TypeScript adapter under the hood
      adapter.dispose()
    })

    it('creates Python adapter', () => {
      const adapter = AdapterFactory.createAdapter('python')
      expect(adapter).toBeInstanceOf(PythonAdapter)
      expect(adapter.language).toBe('python')
      adapter.dispose()
    })

    it('creates Go adapter', () => {
      const adapter = AdapterFactory.createAdapter('go')
      expect(adapter).toBeInstanceOf(GoAdapter)
      expect(adapter.language).toBe('go')
      adapter.dispose()
    })

    it('creates Rust adapter', () => {
      const adapter = AdapterFactory.createAdapter('rust')
      expect(adapter).toBeInstanceOf(RustAdapter)
      expect(adapter.language).toBe('rust')
      adapter.dispose()
    })

    it('creates Java adapter', () => {
      const adapter = AdapterFactory.createAdapter('java')
      expect(adapter).toBeInstanceOf(JavaAdapter)
      expect(adapter.language).toBe('java')
      adapter.dispose()
    })

    it('creates new instance each time', () => {
      const adapter1 = AdapterFactory.createAdapter('python')
      const adapter2 = AdapterFactory.createAdapter('python')

      expect(adapter1).not.toBe(adapter2)

      adapter1.dispose()
      adapter2.dispose()
    })

    it('throws for unsupported language', () => {
      expect(() => {
        // @ts-expect-error - testing invalid input
        AdapterFactory.createAdapter('cobol')
      }).toThrow('Unsupported language: cobol')
    })
  })

  describe('createCachedAdapter', () => {
    it('returns same instance for same language', () => {
      const adapter1 = AdapterFactory.createCachedAdapter('python')
      const adapter2 = AdapterFactory.createCachedAdapter('python')

      expect(adapter1).toBe(adapter2)
    })

    it('returns different instances for different languages', () => {
      const pythonAdapter = AdapterFactory.createCachedAdapter('python')
      const goAdapter = AdapterFactory.createCachedAdapter('go')

      expect(pythonAdapter).not.toBe(goAdapter)
      expect(pythonAdapter.language).toBe('python')
      expect(goAdapter.language).toBe('go')
    })

    it('caches adapter after first creation', () => {
      const stats1 = AdapterFactory.getCacheStats()
      expect(stats1.size).toBe(0)

      AdapterFactory.createCachedAdapter('typescript')
      const stats2 = AdapterFactory.getCacheStats()
      expect(stats2.size).toBe(1)
      expect(stats2.languages).toContain('typescript')

      AdapterFactory.createCachedAdapter('python')
      const stats3 = AdapterFactory.getCacheStats()
      expect(stats3.size).toBe(2)
      expect(stats3.languages).toContain('python')
    })
  })

  describe('createAll', () => {
    it('creates adapters for all supported languages', () => {
      const adapters = AdapterFactory.createAll()

      expect(adapters.size).toBe(6)
      expect(adapters.has('typescript')).toBe(true)
      expect(adapters.has('javascript')).toBe(true)
      expect(adapters.has('python')).toBe(true)
      expect(adapters.has('go')).toBe(true)
      expect(adapters.has('rust')).toBe(true)
      expect(adapters.has('java')).toBe(true)

      // Clean up
      for (const adapter of adapters.values()) {
        adapter.dispose()
      }
    })

    it('creates new instances each call', () => {
      const adapters1 = AdapterFactory.createAll()
      const adapters2 = AdapterFactory.createAll()

      expect(adapters1.get('python')).not.toBe(adapters2.get('python'))

      // Clean up
      for (const adapter of adapters1.values()) {
        adapter.dispose()
      }
      for (const adapter of adapters2.values()) {
        adapter.dispose()
      }
    })
  })

  describe('createAdapters', () => {
    it('creates adapters for specified languages only', () => {
      const adapters = AdapterFactory.createAdapters(['typescript', 'python'])

      expect(adapters.size).toBe(2)
      expect(adapters.has('typescript')).toBe(true)
      expect(adapters.has('python')).toBe(true)
      expect(adapters.has('go')).toBe(false)

      // Clean up
      for (const adapter of adapters.values()) {
        adapter.dispose()
      }
    })

    it('handles empty array', () => {
      const adapters = AdapterFactory.createAdapters([])
      expect(adapters.size).toBe(0)
    })

    it('throws for unsupported language in array', () => {
      expect(() => {
        // @ts-expect-error - testing invalid input
        AdapterFactory.createAdapters(['python', 'fortran'])
      }).toThrow('Unsupported language: fortran')
    })
  })

  describe('getSupportedLanguages', () => {
    it('returns all supported languages', () => {
      const languages = AdapterFactory.getSupportedLanguages()

      expect(languages).toContain('typescript')
      expect(languages).toContain('javascript')
      expect(languages).toContain('python')
      expect(languages).toContain('go')
      expect(languages).toContain('rust')
      expect(languages).toContain('java')
      expect(languages).toHaveLength(6)
    })
  })

  describe('isSupported', () => {
    it('returns true for supported languages', () => {
      expect(AdapterFactory.isSupported('typescript')).toBe(true)
      expect(AdapterFactory.isSupported('python')).toBe(true)
      expect(AdapterFactory.isSupported('go')).toBe(true)
      expect(AdapterFactory.isSupported('rust')).toBe(true)
      expect(AdapterFactory.isSupported('java')).toBe(true)
    })

    it('returns false for unsupported languages', () => {
      expect(AdapterFactory.isSupported('cobol')).toBe(false)
      expect(AdapterFactory.isSupported('fortran')).toBe(false)
      expect(AdapterFactory.isSupported('')).toBe(false)
    })
  })

  describe('getExtensions', () => {
    it('returns extensions for TypeScript', () => {
      const extensions = AdapterFactory.getExtensions('typescript')

      expect(extensions).toContain('.ts')
      expect(extensions).toContain('.tsx')
      expect(extensions).toContain('.js')
      expect(extensions).toContain('.jsx')
    })

    it('returns extensions for Python', () => {
      const extensions = AdapterFactory.getExtensions('python')

      expect(extensions).toContain('.py')
      expect(extensions).toContain('.pyi')
    })

    it('returns extensions for Go', () => {
      const extensions = AdapterFactory.getExtensions('go')

      expect(extensions).toContain('.go')
    })

    it('returns extensions for Rust', () => {
      const extensions = AdapterFactory.getExtensions('rust')

      expect(extensions).toContain('.rs')
    })

    it('returns extensions for Java', () => {
      const extensions = AdapterFactory.getExtensions('java')

      expect(extensions).toContain('.java')
    })

    it('uses cached adapter if available', () => {
      // Pre-cache an adapter
      AdapterFactory.createCachedAdapter('python')

      const stats = AdapterFactory.getCacheStats()
      expect(stats.size).toBe(1)

      // Getting extensions should use cached adapter
      const extensions = AdapterFactory.getExtensions('python')
      expect(extensions).toContain('.py')

      // Cache size should not increase
      const statsAfter = AdapterFactory.getCacheStats()
      expect(statsAfter.size).toBe(1)
    })
  })

  describe('getAllExtensions', () => {
    it('returns map of all extensions to languages', () => {
      const extensionMap = AdapterFactory.getAllExtensions()

      expect(extensionMap.get('.ts')).toBe('typescript')
      expect(extensionMap.get('.tsx')).toBe('typescript')
      expect(extensionMap.get('.py')).toBe('python')
      expect(extensionMap.get('.go')).toBe('go')
      expect(extensionMap.get('.rs')).toBe('rust')
      expect(extensionMap.get('.java')).toBe('java')
    })

    it('handles case-insensitive extensions', () => {
      const extensionMap = AdapterFactory.getAllExtensions()

      // All extensions should be lowercase
      for (const ext of extensionMap.keys()) {
        expect(ext).toBe(ext.toLowerCase())
      }
    })
  })

  describe('clearCache', () => {
    it('clears all cached adapters', () => {
      AdapterFactory.createCachedAdapter('typescript')
      AdapterFactory.createCachedAdapter('python')

      expect(AdapterFactory.getCacheStats().size).toBe(2)

      AdapterFactory.clearCache()

      expect(AdapterFactory.getCacheStats().size).toBe(0)
    })

    it('disposes adapters when clearing', () => {
      const _adapter = AdapterFactory.createCachedAdapter('typescript')

      // Should not throw
      expect(() => AdapterFactory.clearCache()).not.toThrow()
    })

    it('can be called multiple times', () => {
      AdapterFactory.clearCache()
      AdapterFactory.clearCache()
      expect(AdapterFactory.getCacheStats().size).toBe(0)
    })
  })

  describe('getCacheStats', () => {
    it('returns empty stats initially', () => {
      const stats = AdapterFactory.getCacheStats()

      expect(stats.size).toBe(0)
      expect(stats.languages).toEqual([])
    })

    it('tracks cached adapters', () => {
      AdapterFactory.createCachedAdapter('typescript')
      AdapterFactory.createCachedAdapter('python')
      AdapterFactory.createCachedAdapter('go')

      const stats = AdapterFactory.getCacheStats()

      expect(stats.size).toBe(3)
      expect(stats.languages).toContain('typescript')
      expect(stats.languages).toContain('python')
      expect(stats.languages).toContain('go')
    })
  })

  describe('integration', () => {
    it('created adapters can parse files', () => {
      const adapter = AdapterFactory.createAdapter('typescript')

      const result = adapter.parseFile(
        `
        import { useState } from 'react'
        export function Counter() {
          const [count, setCount] = useState(0)
          return count
        }
        `,
        'Counter.tsx'
      )

      expect(result.imports).toHaveLength(1)
      expect(result.imports[0].module).toBe('react')
      expect(result.functions).toHaveLength(1)
      expect(result.functions[0].name).toBe('Counter')

      adapter.dispose()
    })

    it('factory works with LanguageRouter pattern', () => {
      // Simulate how LanguageRouter would use the factory
      const adapters = AdapterFactory.createAdapters(['typescript', 'python'])

      // Test TypeScript
      const tsAdapter = adapters.get('typescript')!
      expect(tsAdapter.canHandle('app.ts')).toBe(true)
      expect(tsAdapter.canHandle('app.py')).toBe(false)

      // Test Python
      const pyAdapter = adapters.get('python')!
      expect(pyAdapter.canHandle('app.py')).toBe(true)
      expect(pyAdapter.canHandle('app.ts')).toBe(false)

      // Clean up
      for (const adapter of adapters.values()) {
        adapter.dispose()
      }
    })
  })
})
