import { describe, it, expect, vi, beforeEach } from 'vitest'

import { LanguageRouter } from './router.js'
import type { LanguageAdapter } from './adapters/base.js'
import type { SupportedLanguage, ParseResult, FrameworkRule } from './types.js'
import type { AnalysisMetrics } from './metrics.js'

// ---------------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------------

const EMPTY_PARSE_RESULT: ParseResult = { imports: [], exports: [], functions: [] }

function makeAdapter(
  language: SupportedLanguage,
  extensions: string[],
  overrides: Partial<LanguageAdapter> = {}
): LanguageAdapter {
  return {
    language,
    extensions,
    canHandle: vi.fn().mockImplementation((fp: string) => {
      const ext = fp.slice(fp.lastIndexOf('.')).toLowerCase()
      return extensions.includes(ext)
    }),
    parseFile: vi.fn().mockReturnValue(EMPTY_PARSE_RESULT),
    getFrameworkRules: vi.fn().mockReturnValue([]),
    dispose: vi.fn(),
    ...overrides,
  } as unknown as LanguageAdapter
}

function makeMockMetrics(): AnalysisMetrics {
  return {
    recordFileParsed: vi.fn(),
    recordParseDuration: vi.fn(),
    recordError: vi.fn(),
    getSnapshot: vi.fn().mockReturnValue({}),
    reset: vi.fn(),
  } as unknown as AnalysisMetrics
}

// ---------------------------------------------------------------------------
// registerAdapter / unregisterAdapter
// ---------------------------------------------------------------------------

describe('LanguageRouter.registerAdapter', () => {
  it('makes the adapter retrievable by its extensions', () => {
    const router = new LanguageRouter({ enableLanguageDetection: false })
    router.registerAdapter(makeAdapter('python', ['.py', '.pyi']))
    expect(router.tryGetAdapter('main.py')).not.toBeNull()
    expect(router.tryGetAdapter('stubs.pyi')).not.toBeNull()
  })

  it('replacing an adapter removes old extension mappings', () => {
    const router = new LanguageRouter({ enableLanguageDetection: false })
    const first = makeAdapter('python', ['.py', '.pyi'])
    const replacement = makeAdapter('python', ['.py'])
    router.registerAdapter(first)
    router.registerAdapter(replacement)
    expect(router.tryGetAdapter('stubs.pyi')).toBeNull()
    expect(router.tryGetAdapter('main.py')).not.toBeNull()
  })

  it('increments adapterCount', () => {
    const router = new LanguageRouter({ enableLanguageDetection: false })
    expect(router.adapterCount).toBe(0)
    router.registerAdapter(makeAdapter('python', ['.py']))
    expect(router.adapterCount).toBe(1)
    router.registerAdapter(makeAdapter('go', ['.go']))
    expect(router.adapterCount).toBe(2)
  })
})

describe('LanguageRouter.unregisterAdapter', () => {
  it('returns true and removes adapter and its extensions', () => {
    const router = new LanguageRouter({ enableLanguageDetection: false })
    router.registerAdapter(makeAdapter('python', ['.py', '.pyi']))
    expect(router.unregisterAdapter('python')).toBe(true)
    expect(router.tryGetAdapter('main.py')).toBeNull()
    expect(router.adapterCount).toBe(0)
  })

  it('returns false for a language that was never registered', () => {
    const router = new LanguageRouter({ enableLanguageDetection: false })
    expect(router.unregisterAdapter('rust')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// getAdapter
// ---------------------------------------------------------------------------

describe('LanguageRouter.getAdapter', () => {
  it('returns the correct adapter for a registered extension', () => {
    const router = new LanguageRouter({ enableLanguageDetection: false })
    const adapter = makeAdapter('python', ['.py'])
    router.registerAdapter(adapter)
    expect(router.getAdapter('src/main.py')).toBe(adapter)
  })

  it('is case-insensitive for extension matching', () => {
    const router = new LanguageRouter({ enableLanguageDetection: false })
    const adapter = makeAdapter('python', ['.py'])
    router.registerAdapter(adapter)
    expect(router.getAdapter('src/MAIN.PY')).toBe(adapter)
  })

  it('throws for an unknown extension', () => {
    const router = new LanguageRouter({ enableLanguageDetection: false })
    expect(() => router.getAdapter('file.xyz')).toThrow(/No adapter registered for extension/)
  })

  it('includes supported extensions in the error when throwOnUnsupported is true', () => {
    const router = new LanguageRouter({
      throwOnUnsupported: true,
      enableLanguageDetection: false,
    })
    router.registerAdapter(makeAdapter('python', ['.py']))
    expect(() => router.getAdapter('file.xyz')).toThrow(/Supported extensions/)
  })
})

// ---------------------------------------------------------------------------
// tryGetAdapter
// ---------------------------------------------------------------------------

describe('LanguageRouter.tryGetAdapter', () => {
  it('returns the adapter for a known extension', () => {
    const router = new LanguageRouter({ enableLanguageDetection: false })
    const adapter = makeAdapter('go', ['.go'])
    router.registerAdapter(adapter)
    expect(router.tryGetAdapter('cmd/main.go')).toBe(adapter)
  })

  it('returns null for an unknown extension', () => {
    const router = new LanguageRouter({ enableLanguageDetection: false })
    expect(router.tryGetAdapter('file.xyz')).toBeNull()
  })

  it('returns null for an extensionless file when no content is provided', () => {
    const router = new LanguageRouter({ enableLanguageDetection: true })
    router.registerAdapter(makeAdapter('python', ['.py']))
    expect(router.tryGetAdapter('Makefile')).toBeNull()
  })

  it('returns null for an extensionless file when language detection is disabled', () => {
    const router = new LanguageRouter({ enableLanguageDetection: false })
    router.registerAdapter(makeAdapter('python', ['.py']))
    expect(router.tryGetAdapter('Makefile', 'print("hello")')).toBeNull()
  })

  it('returns an adapter via content detection for an extensionless file', () => {
    const router = new LanguageRouter({
      enableLanguageDetection: true,
      detectionMinConfidence: 0.5,
    })
    const adapter = makeAdapter('python', ['.py'])
    router.registerAdapter(adapter)
    // Python shebang gives confidence 1.0
    const result = router.tryGetAdapter('run', '#!/usr/bin/env python3\nprint("hello")')
    expect(result).toBe(adapter)
  })
})

// ---------------------------------------------------------------------------
// detectLanguageFromContent
// ---------------------------------------------------------------------------

describe('LanguageRouter.detectLanguageFromContent', () => {
  it('returns language=null with method=none when detection is disabled', () => {
    const router = new LanguageRouter({ enableLanguageDetection: false })
    const result = router.detectLanguageFromContent('print("hello")')
    expect(result.language).toBeNull()
    expect(result.method).toBe('none')
  })

  it('detects Python from a shebang line', () => {
    const router = new LanguageRouter({ enableLanguageDetection: true })
    const result = router.detectLanguageFromContent('#!/usr/bin/env python3\nprint("hello")')
    expect(result.language).toBe('python')
    expect(result.confidence).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// tryGetAdapterFromContent
// ---------------------------------------------------------------------------

describe('LanguageRouter.tryGetAdapterFromContent', () => {
  it('returns the adapter when a language is detected', () => {
    const router = new LanguageRouter({ enableLanguageDetection: true })
    const adapter = makeAdapter('python', ['.py'])
    router.registerAdapter(adapter)
    const { adapter: found, detection } = router.tryGetAdapterFromContent(
      '#!/usr/bin/env python3\nprint("hello")'
    )
    expect(found).toBe(adapter)
    expect(detection.language).toBe('python')
  })

  it('returns null adapter when language cannot be detected', () => {
    const router = new LanguageRouter({ enableLanguageDetection: true })
    const { adapter, detection } = router.tryGetAdapterFromContent('hello world')
    expect(adapter).toBeNull()
    expect(detection.language).toBeNull()
  })

  it('returns null adapter when the detected language has no registered adapter', () => {
    const router = new LanguageRouter({ enableLanguageDetection: true })
    // No adapters registered — detected language will have no adapter
    const { adapter } = router.tryGetAdapterFromContent('#!/usr/bin/env python3\nprint("hi")')
    expect(adapter).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// canHandle / getLanguage
// ---------------------------------------------------------------------------

describe('LanguageRouter.canHandle', () => {
  it('returns true for a registered extension', () => {
    const router = new LanguageRouter({ enableLanguageDetection: false })
    router.registerAdapter(makeAdapter('go', ['.go']))
    expect(router.canHandle('main.go')).toBe(true)
  })

  it('returns false for an unregistered extension', () => {
    const router = new LanguageRouter({ enableLanguageDetection: false })
    expect(router.canHandle('main.xyz')).toBe(false)
  })
})

describe('LanguageRouter.getLanguage', () => {
  it('returns the language for a registered file extension', () => {
    const router = new LanguageRouter({ enableLanguageDetection: false })
    router.registerAdapter(makeAdapter('go', ['.go']))
    expect(router.getLanguage('cmd/main.go')).toBe('go')
  })

  it('returns null for an unregistered file extension', () => {
    const router = new LanguageRouter({ enableLanguageDetection: false })
    expect(router.getLanguage('file.xyz')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// parseFile
// ---------------------------------------------------------------------------

describe('LanguageRouter.parseFile', () => {
  let metrics: AnalysisMetrics
  let router: LanguageRouter

  beforeEach(() => {
    metrics = makeMockMetrics()
    router = new LanguageRouter({ metrics, enableLanguageDetection: false })
  })

  it('delegates to the adapter and returns its result', () => {
    const parseResult: ParseResult = {
      imports: [{ module: 'os', namedImports: [], isTypeOnly: false, sourceFile: 'src/main.py' }],
      exports: [],
      functions: [],
    }
    const adapter = makeAdapter('python', ['.py'], {
      parseFile: vi.fn().mockReturnValue(parseResult),
    })
    router.registerAdapter(adapter)
    const result = router.parseFile('import os', 'src/main.py')
    expect(result).toBe(parseResult)
  })

  it('calls recordFileParsed and recordParseDuration on success', () => {
    router.registerAdapter(makeAdapter('python', ['.py']))
    router.parseFile('import os', 'main.py')
    expect(metrics.recordFileParsed).toHaveBeenCalledWith('python')
    expect(metrics.recordParseDuration).toHaveBeenCalledWith('python', expect.any(Number))
  })

  it('calls recordError and re-throws when the adapter throws', () => {
    const adapter = makeAdapter('python', ['.py'], {
      parseFile: vi.fn().mockImplementation(() => {
        throw new Error('parse failure')
      }),
    })
    router.registerAdapter(adapter)
    expect(() => router.parseFile('bad code', 'main.py')).toThrow('parse failure')
    expect(metrics.recordError).toHaveBeenCalledWith('parse_error', 'python')
  })

  it('still records parse duration even when the adapter throws', () => {
    const adapter = makeAdapter('python', ['.py'], {
      parseFile: vi.fn().mockImplementation(() => {
        throw new Error('boom')
      }),
    })
    router.registerAdapter(adapter)
    expect(() => router.parseFile('', 'main.py')).toThrow()
    expect(metrics.recordParseDuration).toHaveBeenCalledWith('python', expect.any(Number))
  })

  it('throws for a file with no registered adapter', () => {
    expect(() => router.parseFile('content', 'file.xyz')).toThrow(
      /No adapter registered for extension/
    )
  })
})

// ---------------------------------------------------------------------------
// getSupportedLanguages / getSupportedExtensions / getAdapterByLanguage
// ---------------------------------------------------------------------------

describe('LanguageRouter.getSupportedLanguages', () => {
  it('returns only registered languages', () => {
    const router = new LanguageRouter({ enableLanguageDetection: false })
    router.registerAdapter(makeAdapter('python', ['.py']))
    router.registerAdapter(makeAdapter('go', ['.go']))
    const langs = router.getSupportedLanguages()
    expect(langs).toContain('python')
    expect(langs).toContain('go')
    expect(langs).toHaveLength(2)
  })

  it('returns an empty array when no adapters are registered', () => {
    const router = new LanguageRouter({ enableLanguageDetection: false })
    expect(router.getSupportedLanguages()).toEqual([])
  })
})

describe('LanguageRouter.getSupportedExtensions', () => {
  it('returns all extensions from all registered adapters', () => {
    const router = new LanguageRouter({ enableLanguageDetection: false })
    router.registerAdapter(makeAdapter('python', ['.py', '.pyi']))
    router.registerAdapter(makeAdapter('go', ['.go']))
    const exts = router.getSupportedExtensions()
    expect(exts).toContain('.py')
    expect(exts).toContain('.pyi')
    expect(exts).toContain('.go')
  })
})

describe('LanguageRouter.getAdapterByLanguage', () => {
  it('returns the adapter for a registered language', () => {
    const router = new LanguageRouter({ enableLanguageDetection: false })
    const adapter = makeAdapter('python', ['.py'])
    router.registerAdapter(adapter)
    expect(router.getAdapterByLanguage('python')).toBe(adapter)
  })

  it('returns undefined for an unregistered language', () => {
    const router = new LanguageRouter({ enableLanguageDetection: false })
    expect(router.getAdapterByLanguage('rust')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// getAllFrameworkRules / getFrameworkRules
// ---------------------------------------------------------------------------

describe('LanguageRouter.getAllFrameworkRules', () => {
  it('aggregates rules from all registered adapters', () => {
    const router = new LanguageRouter({ enableLanguageDetection: false })
    const rule1: FrameworkRule = { name: 'django', depIndicators: ['django'], importIndicators: [] }
    const rule2: FrameworkRule = { name: 'gin', depIndicators: ['gin'], importIndicators: [] }
    router.registerAdapter(
      makeAdapter('python', ['.py'], { getFrameworkRules: vi.fn().mockReturnValue([rule1]) })
    )
    router.registerAdapter(
      makeAdapter('go', ['.go'], { getFrameworkRules: vi.fn().mockReturnValue([rule2]) })
    )
    const rules = router.getAllFrameworkRules()
    expect(rules).toContain(rule1)
    expect(rules).toContain(rule2)
  })

  it('returns an empty array when no adapters are registered', () => {
    const router = new LanguageRouter({ enableLanguageDetection: false })
    expect(router.getAllFrameworkRules()).toEqual([])
  })
})

describe('LanguageRouter.getFrameworkRules', () => {
  it('returns rules for a specific registered language', () => {
    const router = new LanguageRouter({ enableLanguageDetection: false })
    const rule: FrameworkRule = { name: 'django', depIndicators: ['django'], importIndicators: [] }
    router.registerAdapter(
      makeAdapter('python', ['.py'], { getFrameworkRules: vi.fn().mockReturnValue([rule]) })
    )
    expect(router.getFrameworkRules('python')).toContain(rule)
  })

  it('returns an empty array for an unregistered language', () => {
    const router = new LanguageRouter({ enableLanguageDetection: false })
    expect(router.getFrameworkRules('rust')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// dispose
// ---------------------------------------------------------------------------

describe('LanguageRouter.dispose', () => {
  it('calls dispose on every registered adapter', () => {
    const router = new LanguageRouter({ enableLanguageDetection: false })
    const pyAdapter = makeAdapter('python', ['.py'])
    const goAdapter = makeAdapter('go', ['.go'])
    router.registerAdapter(pyAdapter)
    router.registerAdapter(goAdapter)
    router.dispose()
    expect(pyAdapter.dispose).toHaveBeenCalled()
    expect(goAdapter.dispose).toHaveBeenCalled()
  })

  it('clears the adapter registry after disposal', () => {
    const router = new LanguageRouter({ enableLanguageDetection: false })
    router.registerAdapter(makeAdapter('python', ['.py']))
    router.dispose()
    expect(router.adapterCount).toBe(0)
    expect(router.tryGetAdapter('main.py')).toBeNull()
  })

  it('does not throw if an adapter dispose method throws', () => {
    const router = new LanguageRouter({ enableLanguageDetection: false })
    router.registerAdapter(
      makeAdapter('python', ['.py'], {
        dispose: vi.fn().mockImplementation(() => {
          throw new Error('cleanup error')
        }),
      })
    )
    expect(() => router.dispose()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// createWithAllAdapters (factory integration)
// ---------------------------------------------------------------------------

describe('LanguageRouter.createWithAllAdapters', () => {
  it('registers adapters for all supported languages by default', () => {
    const router = LanguageRouter.createWithAllAdapters({ enableLanguageDetection: false })
    const langs = router.getSupportedLanguages()
    expect(langs).toContain('typescript')
    expect(langs).toContain('python')
    expect(langs).toContain('go')
    expect(router.adapterCount).toBeGreaterThan(0)
  })

  it('registers only the specified languages when the languages option is set', () => {
    const router = LanguageRouter.createWithAllAdapters({
      languages: ['python', 'go'],
      enableLanguageDetection: false,
    })
    expect(router.getSupportedLanguages()).toContain('python')
    expect(router.getSupportedLanguages()).toContain('go')
    expect(router.getSupportedLanguages()).not.toContain('typescript')
  })

  it('handles TypeScript files after creation', () => {
    const router = LanguageRouter.createWithAllAdapters({ enableLanguageDetection: false })
    expect(router.canHandle('app.ts')).toBe(true)
    expect(router.canHandle('component.tsx')).toBe(true)
  })

  it('handles Python files after creation', () => {
    const router = LanguageRouter.createWithAllAdapters({ enableLanguageDetection: false })
    expect(router.canHandle('main.py')).toBe(true)
  })

  it('handles Go files after creation', () => {
    const router = LanguageRouter.createWithAllAdapters({ enableLanguageDetection: false })
    expect(router.canHandle('main.go')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// createWithCachedAdapters (factory integration)
// ---------------------------------------------------------------------------

describe('LanguageRouter.createWithCachedAdapters', () => {
  it('creates a fully functional router', () => {
    const router = LanguageRouter.createWithCachedAdapters({ enableLanguageDetection: false })
    expect(router.adapterCount).toBeGreaterThan(0)
    expect(router.canHandle('main.py')).toBe(true)
  })

  it('with languages option, only registers specified languages', () => {
    const router = LanguageRouter.createWithCachedAdapters({
      languages: ['go'],
      enableLanguageDetection: false,
    })
    expect(router.getSupportedLanguages()).toEqual(['go'])
  })
})
