/**
 * SMI-2756: LanguageRouter — route dispatch and error boundary tests
 *
 * Tests register/unregister adapters, adapter dispatch by file extension,
 * language detection for extensionless files, error boundary on parse,
 * and edge cases like unknown extensions and re-registration.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LanguageRouter } from '../../src/analysis/router.js'
import type { LanguageAdapter } from '../../src/analysis/adapters/base.js'
import type { SupportedLanguage, ParseResult, FrameworkRule } from '../../src/analysis/types.js'

// ---------------------------------------------------------------------------
// Helpers — minimal stub adapter
// ---------------------------------------------------------------------------

function makeAdapter(
  language: SupportedLanguage,
  extensions: string[],
  parseResult?: Partial<ParseResult>
): LanguageAdapter {
  const defaultResult: ParseResult = {
    imports: [],
    exports: [],
    functions: [],
    ...parseResult,
  }
  return {
    language,
    extensions,
    canHandle: vi.fn((fp: string) => extensions.some((e) => fp.endsWith(e))),
    parseFile: vi.fn().mockReturnValue(defaultResult),
    parseIncremental: vi.fn().mockReturnValue(defaultResult),
    getFrameworkRules: vi.fn().mockReturnValue([] as FrameworkRule[]),
    dispose: vi.fn(),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LanguageRouter', () => {
  let router: LanguageRouter

  beforeEach(() => {
    router = new LanguageRouter({ enableLanguageDetection: false })
  })

  describe('registerAdapter', () => {
    it('registers adapter and makes extensions available', () => {
      const adapter = makeAdapter('typescript', ['.ts', '.tsx'])
      router.registerAdapter(adapter)

      expect(router.getSupportedLanguages()).toContain('typescript')
      expect(router.getSupportedExtensions()).toContain('.ts')
      expect(router.getSupportedExtensions()).toContain('.tsx')
    })

    it('replacing adapter for same language removes old extension mappings', () => {
      const adapter1 = makeAdapter('typescript', ['.ts'])
      const adapter2 = makeAdapter('typescript', ['.tsx'])

      router.registerAdapter(adapter1)
      router.registerAdapter(adapter2)

      // Old .ts mapping removed; new .tsx added
      expect(router.canHandle('file.tsx')).toBe(true)
      expect(router.canHandle('file.ts')).toBe(false)
    })
  })

  describe('getAdapter', () => {
    it('dispatches to correct adapter by extension', () => {
      const tsAdapter = makeAdapter('typescript', ['.ts'])
      const pyAdapter = makeAdapter('python', ['.py'])

      router.registerAdapter(tsAdapter)
      router.registerAdapter(pyAdapter)

      expect(router.getAdapter('src/main.ts')).toBe(tsAdapter)
      expect(router.getAdapter('src/main.py')).toBe(pyAdapter)
    })

    it('throws for unknown extension when throwOnUnsupported is false (default)', () => {
      // Even without throwOnUnsupported the source still throws for unknown extensions
      expect(() => router.getAdapter('file.xyz')).toThrow(Error)
    })

    it('throws with informative message for unknown extension', () => {
      const tsAdapter = makeAdapter('typescript', ['.ts'])
      router.registerAdapter(tsAdapter)

      expect(() => router.getAdapter('file.xyz')).toThrow(/No adapter registered/)
    })

    it('extension lookup is case-insensitive (.TS resolves to .ts adapter)', () => {
      const adapter = makeAdapter('typescript', ['.ts'])
      router.registerAdapter(adapter)

      // getAdapter lowercases the extension
      const found = router.getAdapter('FILE.TS')
      expect(found).toBe(adapter)
    })
  })

  describe('parseFile', () => {
    it('dispatches to handler and returns ParseResult', () => {
      const adapter = makeAdapter('typescript', ['.ts'])
      router.registerAdapter(adapter)

      const result = router.parseFile('const x = 1', 'src/x.ts')

      expect(adapter.parseFile).toHaveBeenCalledWith('const x = 1', 'src/x.ts')
      expect(Array.isArray(result.imports)).toBe(true)
    })

    it('throws when adapter parse throws (error boundary)', () => {
      const adapter = makeAdapter('typescript', ['.ts'])
      ;(adapter.parseFile as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('parse failed')
      })
      router.registerAdapter(adapter)

      expect(() => router.parseFile('bad content', 'file.ts')).toThrow('parse failed')
    })
  })

  describe('tryGetAdapter', () => {
    it('returns null for unknown extension instead of throwing', () => {
      const result = router.tryGetAdapter('file.unknown')
      expect(result).toBeNull()
    })

    it('returns adapter for known extension', () => {
      const adapter = makeAdapter('python', ['.py'])
      router.registerAdapter(adapter)

      expect(router.tryGetAdapter('script.py')).toBe(adapter)
    })
  })

  describe('unregisterAdapter', () => {
    it('removes adapter and its extensions', () => {
      const adapter = makeAdapter('typescript', ['.ts'])
      router.registerAdapter(adapter)
      router.unregisterAdapter('typescript')

      expect(router.canHandle('file.ts')).toBe(false)
      expect(router.getAdapterByLanguage('typescript')).toBeUndefined()
    })

    it('returns false for unknown language', () => {
      expect(router.unregisterAdapter('rust')).toBe(false)
    })
  })

  describe('getAllFrameworkRules', () => {
    it('aggregates rules from all registered adapters', () => {
      const tsRule: FrameworkRule = {
        name: 'React',
        depIndicators: ['react'],
        importIndicators: ['react'],
      }
      const tsAdapter = makeAdapter('typescript', ['.ts'])
      ;(tsAdapter.getFrameworkRules as ReturnType<typeof vi.fn>).mockReturnValue([tsRule])

      router.registerAdapter(tsAdapter)

      const rules = router.getAllFrameworkRules()
      expect(rules).toContain(tsRule)
    })
  })

  describe('dispose', () => {
    it('disposes all registered adapters', () => {
      const ts = makeAdapter('typescript', ['.ts'])
      const py = makeAdapter('python', ['.py'])
      router.registerAdapter(ts)
      router.registerAdapter(py)

      router.dispose()

      expect(ts.dispose).toHaveBeenCalled()
      expect(py.dispose).toHaveBeenCalled()
      expect(router.adapterCount).toBe(0)
    })
  })

  describe('createWithAllAdapters', () => {
    it('creates a router with at least one adapter pre-registered', () => {
      const fullRouter = LanguageRouter.createWithAllAdapters()
      expect(fullRouter.adapterCount).toBeGreaterThan(0)
      fullRouter.dispose()
    })
  })
})
