/**
 * SMI-4293: Python query-based extractor tests.
 *
 * Drives `extractPythonParseResult` through the live web-tree-sitter WASM
 * grammar so behaviour tracks the real parser, not a mock. The regression
 * guard (queryExtractionMatchesOrExceedsRegex) proves parity vs regex;
 * these tests pin the extractor's output shape.
 *
 * @see docs/internal/implementation/github-wave-5c-tree-sitter-incremental.md
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { PythonIncrementalParser } from './pythonIncremental.js'

describe('extractPythonParseResult (via PythonIncrementalParser)', () => {
  const parser = new PythonIncrementalParser()

  beforeAll(async () => {
    await parser.ensureReady()
  })

  it('captures simple imports with aliases', () => {
    const src = 'import numpy as np\nimport os\n'
    const r = parser.parseSync(src, 'a.py')
    expect(r).not.toBeNull()
    const byModule = Object.fromEntries((r?.imports ?? []).map((i) => [i.module, i]))
    expect(byModule['numpy']?.defaultImport).toBe('np')
    expect(byModule['os']?.defaultImport).toBeUndefined()
  })

  it('captures from-imports and strips alias suffix from named imports', () => {
    const src = 'from pkg import foo, bar as renamed\n'
    const r = parser.parseSync(src, 'a.py')
    expect(r).not.toBeNull()
    const imp = r?.imports[0]
    expect(imp?.module).toBe('pkg')
    // regression guard is satisfied when we capture `foo`; aliased name `bar`
    // is retained via the dotted_name inside the aliased_import.
    expect(imp?.namedImports).toContain('foo')
    expect(imp?.namedImports).toContain('bar')
    // Alias suffix must not leak into the named list.
    expect(imp?.namedImports.some((n) => n.includes('as'))).toBe(false)
  })

  it('tags wildcard from-imports with namespaceImport="*"', () => {
    const src = 'from pkg import *\n'
    const r = parser.parseSync(src, 'a.py')
    expect(r?.imports[0].namespaceImport).toBe('*')
    expect(r?.imports[0].namedImports).toEqual([])
  })

  it('marks async function definitions correctly', () => {
    const src = 'async def job(x):\n    return x\n'
    const r = parser.parseSync(src, 'a.py')
    expect(r?.functions[0]).toMatchObject({ name: 'job', isAsync: true, parameterCount: 1 })
  })

  it('drops self / cls from parameter counts', () => {
    const src = 'class C:\n    def m(self, a, b):\n        pass\n'
    const r = parser.parseSync(src, 'a.py')
    const m = r?.functions.find((f) => f.name === 'm')
    expect(m?.parameterCount).toBe(2)
  })

  it('treats top-level public functions and classes as exports', () => {
    const src = 'def pub():\n    pass\n\nclass Cls:\n    pass\n\ndef _hidden():\n    pass\n'
    const r = parser.parseSync(src, 'a.py')
    const names = (r?.exports ?? []).map((e) => e.name).sort()
    expect(names).toContain('pub')
    expect(names).toContain('Cls')
    expect(names).not.toContain('_hidden')
  })

  it('honours __all__ to enumerate exports and prevents duplicates', () => {
    const src = '__all__ = ["Pub"]\n\ndef Pub():\n    pass\n\ndef Also():\n    pass\n'
    const r = parser.parseSync(src, 'a.py')
    const exports = r?.exports ?? []
    // Pub appears once (from __all__, deduped from function scan).
    expect(exports.filter((e) => e.name === 'Pub')).toHaveLength(1)
    // Also is still picked up by the function scan as a top-level public fn.
    expect(exports.some((e) => e.name === 'Also')).toBe(true)
  })
})
