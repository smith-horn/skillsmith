/**
 * SMI-4293: PythonIncrementalParser unit tests.
 *
 * Covers the six cases called out in the plan:
 *   1. First parse caches the tree.
 *   2. Unchanged content re-parse hits the cache (no re-parse).
 *   3. Incremental edits re-use the previous tree via tree.edit().
 *   4. LRU eviction at the configured max.
 *   5. Corrupted cached tree falls back gracefully (returns null, adapter
 *      then falls back to regex).
 *   6. Unsupported / unavailable grammar surfaces `isReady === false` and
 *      `parseSync` returns null.
 *
 * @see docs/internal/implementation/github-wave-5c-tree-sitter-incremental.md
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

// Silence warn output from the SMI-4316 hardening paths; behavioural
// assertions live in pythonIncremental.hardening.test.ts.
vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    auditLog: vi.fn(),
    securityLog: vi.fn(),
  }),
}))

import { PythonIncrementalParser, type WebTreeSitterLoader } from './pythonIncremental.js'

describe('PythonIncrementalParser', () => {
  const parsers: PythonIncrementalParser[] = []

  beforeAll(() => {
    // No-op — each test creates its own parser so disposal is explicit.
  })

  function trackedParser(
    options: ConstructorParameters<typeof PythonIncrementalParser>[0] = {},
    loader?: WebTreeSitterLoader
  ) {
    const p = loader
      ? new PythonIncrementalParser(options, loader)
      : new PythonIncrementalParser(options)
    parsers.push(p)
    return p
  }

  afterAll(() => {
    for (const p of parsers) p.dispose()
  })

  // ------------------------------------------------------------------
  // 1. First parse caches the tree
  // ------------------------------------------------------------------

  it('caches a tree after the first parse', async () => {
    const parser = trackedParser()
    const result = await parser.parse('def foo():\n    pass\n', 'first.py')
    expect(result).not.toBeNull()
    expect(parser.cacheSize).toBe(1)
    expect(result?.functions.map((f) => f.name)).toContain('foo')
  })

  // ------------------------------------------------------------------
  // 2. Unchanged content hits the cache and still returns results
  // ------------------------------------------------------------------

  it('reuses the cached tree when content is unchanged', async () => {
    const parser = trackedParser()
    const src = 'def foo():\n    return 42\n'
    const r1 = await parser.parse(src, 'unchanged.py')
    const r2 = await parser.parse(src, 'unchanged.py')
    expect(r1).toEqual(r2)
    // Still only one entry; parse didn't create a duplicate.
    expect(parser.cacheSize).toBe(1)
  })

  // ------------------------------------------------------------------
  // 3. Incremental edit re-parses using the previous tree
  // ------------------------------------------------------------------

  it('applies incremental edits and observes the change', async () => {
    const parser = trackedParser()
    const filePath = 'edit.py'
    const v1 = 'def foo():\n    return 1\n'
    const v2 = 'def foo():\n    return 2\n'
    await parser.parse(v1, filePath)
    const r2 = await parser.parse(v2, filePath)
    expect(r2).not.toBeNull()
    expect(r2?.functions).toHaveLength(1)
    expect(r2?.functions[0].name).toBe('foo')
  })

  it('detects newly added functions across an edit', async () => {
    const parser = trackedParser()
    const filePath = 'add.py'
    await parser.parse('def a():\n    pass\n', filePath)
    const r = await parser.parse('def a():\n    pass\n\ndef b():\n    pass\n', filePath)
    expect(r).not.toBeNull()
    const names = r?.functions.map((f) => f.name).sort()
    expect(names).toEqual(['a', 'b'])
  })

  // ------------------------------------------------------------------
  // 4. LRU eviction at max
  // ------------------------------------------------------------------

  it('evicts the least-recently-used tree when the cache is full', async () => {
    const parser = trackedParser({ maxTrees: 3 })
    await parser.parse('def a(): pass\n', 'a.py')
    await parser.parse('def b(): pass\n', 'b.py')
    await parser.parse('def c(): pass\n', 'c.py')
    expect(parser.cacheSize).toBe(3)
    // Touch a.py and b.py so c.py becomes LRU.
    await parser.parse('def a(): pass\n', 'a.py')
    await parser.parse('def b(): pass\n', 'b.py')
    // Adding a new file should evict c.py.
    await parser.parse('def d(): pass\n', 'd.py')
    expect(parser.cacheSize).toBe(3)
  })

  // ------------------------------------------------------------------
  // 5. Corrupted cached tree falls back gracefully
  //    (simulated by forcing the cached tree's .edit to throw)
  // ------------------------------------------------------------------

  it('invalidates and returns null when the cached tree is corrupted', async () => {
    const parser = trackedParser()
    const filePath = 'corrupt.py'
    await parser.parse('def ok(): pass\n', filePath)
    // Reach into the private cache to sabotage the tree.
    const cache = (parser as unknown as { cache: Map<string, { tree: { edit: () => void } }> })
      .cache
    const entry = cache.get(filePath)
    if (!entry) throw new Error('expected cache entry')
    entry.tree.edit = () => {
      throw new Error('simulated corruption')
    }
    const r = await parser.parse('def ok(): return 1\n', filePath)
    expect(r).toBeNull()
    expect(parser.cacheSize).toBe(0)
  })

  // ------------------------------------------------------------------
  // 6. Grammar unavailable (loader rejects) → isReady stays false
  // ------------------------------------------------------------------

  it('flags init failure when the WASM loader rejects', async () => {
    const failingLoader: WebTreeSitterLoader = async () => {
      throw new Error('module not found')
    }
    const parser = trackedParser({}, failingLoader)
    const result = await parser.parse('def x(): pass\n', 'fail.py')
    expect(result).toBeNull()
    expect(parser.isReady).toBe(false)
    expect(parser.hasFailedInit).toBe(true)
  })
})
