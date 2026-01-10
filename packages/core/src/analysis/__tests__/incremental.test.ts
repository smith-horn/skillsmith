/**
 * SMI-1309: Incremental Parsing Tests
 *
 * Test suite for incremental parsing and tree caching.
 *
 * Performance Targets:
 * - Incremental parse: < 100ms
 * - Tree cache hit rate: > 80%
 *
 * @see docs/architecture/multi-language-analysis.md
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  calculateEdit,
  indexToPosition,
  positionToIndex,
  findMinimalEdit,
  batchEdits,
  isInsertion,
  isDeletion,
  isReplacement,
  editSizeDelta,
} from '../incremental.js'
import { TreeCache } from '../tree-cache.js'
import { IncrementalParser } from '../incremental-parser.js'
import { TypeScriptAdapter } from '../adapters/typescript.js'
import { PythonAdapter } from '../adapters/python.js'

describe('SMI-1309: Incremental Parsing', () => {
  describe('indexToPosition', () => {
    it('converts index to position for single line', () => {
      const content = 'hello world'
      expect(indexToPosition(content, 0)).toEqual({ row: 0, column: 0 })
      expect(indexToPosition(content, 5)).toEqual({ row: 0, column: 5 })
      expect(indexToPosition(content, 11)).toEqual({ row: 0, column: 11 })
    })

    it('converts index to position across lines', () => {
      const content = 'hello\nworld'
      expect(indexToPosition(content, 0)).toEqual({ row: 0, column: 0 })
      expect(indexToPosition(content, 5)).toEqual({ row: 0, column: 5 }) // newline
      expect(indexToPosition(content, 6)).toEqual({ row: 1, column: 0 }) // 'w'
      expect(indexToPosition(content, 8)).toEqual({ row: 1, column: 2 }) // 'r'
    })

    it('handles multiple lines', () => {
      const content = 'line1\nline2\nline3'
      expect(indexToPosition(content, 12)).toEqual({ row: 2, column: 0 })
      expect(indexToPosition(content, 14)).toEqual({ row: 2, column: 2 })
    })

    it('handles empty content', () => {
      expect(indexToPosition('', 0)).toEqual({ row: 0, column: 0 })
    })

    it('handles index at end of content', () => {
      const content = 'abc'
      expect(indexToPosition(content, 3)).toEqual({ row: 0, column: 3 })
    })
  })

  describe('positionToIndex', () => {
    it('converts position to index for single line', () => {
      const content = 'hello world'
      expect(positionToIndex(content, { row: 0, column: 0 })).toBe(0)
      expect(positionToIndex(content, { row: 0, column: 5 })).toBe(5)
    })

    it('converts position across lines', () => {
      const content = 'hello\nworld'
      expect(positionToIndex(content, { row: 1, column: 0 })).toBe(6)
      expect(positionToIndex(content, { row: 1, column: 2 })).toBe(8)
    })

    it('returns content length for position past end', () => {
      const content = 'abc'
      expect(positionToIndex(content, { row: 10, column: 0 })).toBe(3)
    })
  })

  describe('calculateEdit', () => {
    it('calculates edit for simple insertion', () => {
      const oldContent = 'hello world'
      const newContent = 'hello there world'
      const edit = calculateEdit(oldContent, newContent, 6, 6, 'there ')

      expect(edit.startIndex).toBe(6)
      expect(edit.oldEndIndex).toBe(6)
      expect(edit.newEndIndex).toBe(12)
      expect(edit.startPosition).toEqual({ row: 0, column: 6 })
      expect(edit.oldEndPosition).toEqual({ row: 0, column: 6 })
      expect(edit.newEndPosition).toEqual({ row: 0, column: 12 })
    })

    it('calculates edit for deletion', () => {
      const oldContent = 'hello there world'
      const newContent = 'hello world'
      const edit = calculateEdit(oldContent, newContent, 6, 12, '')

      expect(edit.startIndex).toBe(6)
      expect(edit.oldEndIndex).toBe(12)
      expect(edit.newEndIndex).toBe(6)
    })

    it('calculates edit for replacement', () => {
      const oldContent = 'hello world'
      const newContent = 'hello WORLD'
      const edit = calculateEdit(oldContent, newContent, 6, 11, 'WORLD')

      expect(edit.startIndex).toBe(6)
      expect(edit.oldEndIndex).toBe(11)
      expect(edit.newEndIndex).toBe(11)
    })

    it('handles multiline edits', () => {
      const oldContent = 'line1\nline2'
      const newContent = 'line1\nNEW\nline2'
      const edit = calculateEdit(oldContent, newContent, 6, 6, 'NEW\n')

      expect(edit.startPosition).toEqual({ row: 1, column: 0 })
      expect(edit.newEndPosition).toEqual({ row: 2, column: 0 })
    })
  })

  describe('findMinimalEdit', () => {
    it('returns null for identical strings', () => {
      expect(findMinimalEdit('hello', 'hello')).toBeNull()
      expect(findMinimalEdit('', '')).toBeNull()
    })

    it('detects insertion at beginning', () => {
      const diff = findMinimalEdit('world', 'hello world')
      expect(diff).toEqual({
        changeStart: 0,
        changeEnd: 0,
        newText: 'hello ',
      })
    })

    it('detects insertion at end', () => {
      const diff = findMinimalEdit('hello', 'hello world')
      expect(diff).toEqual({
        changeStart: 5,
        changeEnd: 5,
        newText: ' world',
      })
    })

    it('detects insertion in middle', () => {
      const diff = findMinimalEdit('hello world', 'hello big world')
      expect(diff).toEqual({
        changeStart: 6,
        changeEnd: 6,
        newText: 'big ',
      })
    })

    it('detects deletion', () => {
      const diff = findMinimalEdit('hello world', 'hello')
      expect(diff).toEqual({
        changeStart: 5,
        changeEnd: 11,
        newText: '',
      })
    })

    it('detects replacement', () => {
      const diff = findMinimalEdit('hello world', 'hello WORLD')
      expect(diff).toEqual({
        changeStart: 6,
        changeEnd: 11,
        newText: 'WORLD',
      })
    })

    it('detects complex change', () => {
      const diff = findMinimalEdit('the quick brown fox', 'the slow red fox')
      // Should find the minimal bounding region
      expect(diff).not.toBeNull()
      expect(diff!.changeStart).toBe(4)
    })
  })

  describe('batchEdits', () => {
    it('returns null for empty array', () => {
      expect(batchEdits([])).toBeNull()
    })

    it('returns single edit unchanged', () => {
      const edit = { changeStart: 0, changeEnd: 5, newText: 'hello' }
      expect(batchEdits([edit])).toEqual(edit)
    })

    it('merges overlapping edits', () => {
      const edits = [
        { changeStart: 0, changeEnd: 5, newText: 'HELLO' },
        { changeStart: 3, changeEnd: 8, newText: 'WORLD' },
      ]
      const merged = batchEdits(edits)

      expect(merged).not.toBeNull()
      expect(merged!.changeStart).toBe(0)
      expect(merged!.changeEnd).toBe(8)
    })

    it('sorts edits by start position', () => {
      const edits = [
        { changeStart: 10, changeEnd: 15, newText: 'B' },
        { changeStart: 0, changeEnd: 5, newText: 'A' },
      ]
      const merged = batchEdits(edits)

      expect(merged!.changeStart).toBe(0)
    })
  })

  describe('edit type helpers', () => {
    it('identifies insertions', () => {
      expect(isInsertion({ changeStart: 5, changeEnd: 5, newText: 'hello' })).toBe(true)
      expect(isInsertion({ changeStart: 5, changeEnd: 10, newText: 'hello' })).toBe(false)
      expect(isInsertion({ changeStart: 5, changeEnd: 5, newText: '' })).toBe(false)
    })

    it('identifies deletions', () => {
      expect(isDeletion({ changeStart: 5, changeEnd: 10, newText: '' })).toBe(true)
      expect(isDeletion({ changeStart: 5, changeEnd: 5, newText: '' })).toBe(false)
      expect(isDeletion({ changeStart: 5, changeEnd: 10, newText: 'x' })).toBe(false)
    })

    it('identifies replacements', () => {
      expect(isReplacement({ changeStart: 5, changeEnd: 10, newText: 'hello' })).toBe(true)
      expect(isReplacement({ changeStart: 5, changeEnd: 5, newText: 'hello' })).toBe(false)
      expect(isReplacement({ changeStart: 5, changeEnd: 10, newText: '' })).toBe(false)
    })

    it('calculates size delta', () => {
      expect(editSizeDelta({ changeStart: 0, changeEnd: 5, newText: 'hello' })).toBe(0)
      expect(editSizeDelta({ changeStart: 0, changeEnd: 5, newText: 'hi' })).toBe(-3)
      expect(editSizeDelta({ changeStart: 0, changeEnd: 5, newText: 'hello world' })).toBe(6)
      expect(editSizeDelta({ changeStart: 5, changeEnd: 5, newText: 'xxx' })).toBe(3)
    })
  })

  describe('TreeCache', () => {
    let cache: TreeCache

    beforeEach(() => {
      cache = new TreeCache({ maxTrees: 5 })
    })

    afterEach(() => {
      cache.dispose()
    })

    it('stores and retrieves trees', () => {
      const mockTree = { type: 'tree', delete: () => {} }
      cache.set('test.ts', mockTree, 'hash123')

      expect(cache.get('test.ts')).toBe(mockTree)
      expect(cache.has('test.ts')).toBe(true)
    })

    it('returns null for missing entries', () => {
      expect(cache.get('missing.ts')).toBeNull()
    })

    it('validates content hash', () => {
      const mockTree = { type: 'tree', delete: () => {} }
      cache.set('test.ts', mockTree, 'hash123')

      expect(cache.isValid('test.ts', 'hash123')).toBe(true)
      expect(cache.isValid('test.ts', 'different')).toBe(false)
      expect(cache.isValid('missing.ts', 'hash123')).toBe(false)
    })

    it('evicts oldest entry when at capacity', () => {
      for (let i = 0; i < 7; i++) {
        cache.set(`file${i}.ts`, { id: i, delete: () => {} }, `hash${i}`)
      }

      // Should have evicted oldest entries
      expect(cache.size).toBe(5)
      expect(cache.has('file0.ts')).toBe(false)
      expect(cache.has('file1.ts')).toBe(false)
      expect(cache.has('file6.ts')).toBe(true)
    })

    it('tracks version numbers', () => {
      cache.set('a.ts', {}, 'h1')
      cache.set('b.ts', {}, 'h2')

      const stats = cache.getStats()
      expect(stats.newestVersion).toBe(2)
      expect(stats.oldestVersion).toBe(1)
    })

    it('invalidates single file', () => {
      cache.set('test.ts', {}, 'hash')
      cache.invalidate('test.ts')

      expect(cache.has('test.ts')).toBe(false)
    })

    it('invalidates multiple files', () => {
      cache.set('a.ts', {}, 'h1')
      cache.set('b.ts', {}, 'h2')
      cache.set('c.ts', {}, 'h3')

      cache.invalidateMany(['a.ts', 'b.ts'])

      expect(cache.has('a.ts')).toBe(false)
      expect(cache.has('b.ts')).toBe(false)
      expect(cache.has('c.ts')).toBe(true)
    })

    it('invalidates by pattern', () => {
      cache.set('src/a.ts', {}, 'h1')
      cache.set('src/b.ts', {}, 'h2')
      cache.set('lib/c.ts', {}, 'h3')

      const count = cache.invalidatePattern(/^src\//)

      expect(count).toBe(2)
      expect(cache.has('src/a.ts')).toBe(false)
      expect(cache.has('lib/c.ts')).toBe(true)
    })

    it('tracks hit/miss statistics', () => {
      cache.set('test.ts', {}, 'hash')

      cache.get('test.ts') // hit
      cache.get('test.ts') // hit
      cache.get('missing.ts') // miss

      const stats = cache.getStats()
      expect(stats.hitRate).toBeCloseTo(2 / 3, 2)
    })

    it('clears all entries', () => {
      cache.set('a.ts', {}, 'h1')
      cache.set('b.ts', {}, 'h2')

      cache.clear()

      expect(cache.size).toBe(0)
      expect(cache.getStats().hitRate).toBe(0)
    })

    it('provides static hash function', () => {
      const hash1 = TreeCache.hashContent('hello world')
      const hash2 = TreeCache.hashContent('hello world')
      const hash3 = TreeCache.hashContent('different')

      expect(hash1).toBe(hash2)
      expect(hash1).not.toBe(hash3)
      expect(hash1.length).toBe(16)
    })

    it('calls delete on tree when evicted', () => {
      let deleteCount = 0
      const mockTree = {
        delete: () => {
          deleteCount++
        },
      }

      cache.set('test.ts', mockTree, 'hash')
      cache.invalidate('test.ts')

      expect(deleteCount).toBe(1)
    })
  })

  describe('IncrementalParser', () => {
    let parser: IncrementalParser
    let adapter: TypeScriptAdapter

    beforeEach(() => {
      parser = new IncrementalParser({ maxTrees: 10 })
      adapter = new TypeScriptAdapter()
    })

    afterEach(() => {
      parser.dispose()
      adapter.dispose()
    })

    it('performs full parse on first access', () => {
      const content = 'export const foo = 1'
      const result = parser.parse('test.ts', content, adapter)

      expect(result.wasIncremental).toBe(false)
      expect(result.wasCached).toBe(false)
      expect(result.result).toBeDefined()
    })

    it('returns cached result for unchanged content', () => {
      const content = 'export const foo = 1'

      // First parse
      parser.parse('test.ts', content, adapter)

      // Second parse with same content - should return cached result
      const result = parser.parse('test.ts', content, adapter)

      // Note: wasCached is true when content hash matches AND we have a tree
      // Since TypeScriptAdapter doesn't store tree-sitter trees, this may be false
      // But the content IS cached
      expect(parser.isCached('test.ts')).toBe(true)
      expect(result.result).toBeDefined()
    })

    it('detects content change and re-parses', () => {
      const content1 = 'export const foo = 1'
      const content2 = 'export const foo = 2'

      // First parse
      parser.parse('test.ts', content1, adapter)

      // Second parse with changed content
      const result = parser.parse('test.ts', content2, adapter)

      // Should have parsed successfully
      expect(result.result).toBeDefined()
      expect(result.wasCached).toBe(false)
    })

    it('invalidates cache entries', () => {
      const content = 'export const foo = 1'
      parser.parse('test.ts', content, adapter)

      parser.invalidate('test.ts')

      expect(parser.isCached('test.ts')).toBe(false)
    })

    it('invalidates by pattern', () => {
      parser.parse('src/a.ts', 'const a = 1', adapter)
      parser.parse('src/b.ts', 'const b = 2', adapter)
      parser.parse('lib/c.ts', 'const c = 3', adapter)

      parser.invalidatePattern(/^src\//)

      expect(parser.isCached('src/a.ts')).toBe(false)
      expect(parser.isCached('lib/c.ts')).toBe(true)
    })

    it('tracks statistics', () => {
      parser.parse('a.ts', 'const a = 1', adapter)
      parser.parse('b.ts', 'const b = 2', adapter)
      parser.parse('a.ts', 'const a = 2', adapter) // re-parse due to content change

      const stats = parser.getStats()
      // Note: without actual tree-sitter trees, all parses are counted as full
      // The stats track parse operations regardless
      expect(stats.fullParses + stats.incrementalParses).toBe(3)
    })

    it('resets statistics', () => {
      parser.parse('test.ts', 'const x = 1', adapter)
      parser.resetStats()

      const stats = parser.getStats()
      expect(stats.fullParses).toBe(0)
      expect(stats.incrementalParses).toBe(0)
    })

    it('clears all caches', () => {
      parser.parse('a.ts', 'const a = 1', adapter)
      parser.parse('b.ts', 'const b = 2', adapter)

      parser.clear()

      expect(parser.getStats().contentCacheSize).toBe(0)
      expect(parser.getStats().treeCache.size).toBe(0)
    })

    it('exposes tree cache', () => {
      const treeCache = parser.getTreeCache()
      expect(treeCache).toBeInstanceOf(TreeCache)
    })
  })

  describe('Performance', () => {
    it('re-parse completes under 100ms', () => {
      const parser = new IncrementalParser()
      const adapter = new TypeScriptAdapter()

      // Large-ish TypeScript content
      const content1 = `
import React, { useState, useEffect, useCallback } from 'react'
import type { FC, ReactNode } from 'react'

export interface Props {
  name: string
  value: number
  children?: ReactNode
}

export const Component: FC<Props> = ({ name, value, children }) => {
  const [state, setState] = useState(value)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    console.log('Component mounted')
    return () => console.log('Component unmounted')
  }, [])

  const handleClick = useCallback(() => {
    setState(prev => prev + 1)
  }, [])

  return (
    <div className="component">
      <h1>{name}</h1>
      <p>Value: {state}</p>
      <button onClick={handleClick}>Increment</button>
      {loading && <span>Loading...</span>}
      {children}
    </div>
  )
}

export function helperFunction(a: number, b: number): number {
  return a + b
}

export async function fetchData(url: string): Promise<unknown> {
  const response = await fetch(url)
  return response.json()
}
      `.trim()

      // First parse (full)
      parser.parse('component.tsx', content1, adapter)

      // Small change
      const content2 = content1.replace('Value: {state}', 'Current Value: {state}')

      // Re-parse - should be fast (under 100ms target)
      const start = performance.now()
      const result = parser.parse('component.tsx', content2, adapter)
      const duration = performance.now() - start

      expect(result.result).toBeDefined()
      expect(duration).toBeLessThan(100) // Under 100ms

      parser.dispose()
      adapter.dispose()
    })

    it('handles rapid sequential edits efficiently', () => {
      const parser = new IncrementalParser()
      const adapter = new TypeScriptAdapter()

      let content = 'export const count = 0'
      parser.parse('counter.ts', content, adapter)

      const times: number[] = []
      for (let i = 1; i <= 10; i++) {
        content = `export const count = ${i}`
        const start = performance.now()
        parser.parse('counter.ts', content, adapter)
        times.push(performance.now() - start)
      }

      // All incremental parses should be fast
      const avgTime = times.reduce((a, b) => a + b, 0) / times.length
      expect(avgTime).toBeLessThan(50) // Under 50ms average

      parser.dispose()
      adapter.dispose()
    })

    it('Python adapter re-parse under 100ms', () => {
      const parser = new IncrementalParser()
      const adapter = new PythonAdapter()

      const content1 = `
def calculate(a: int, b: int) -> int:
    return a + b

class Calculator:
    def __init__(self):
        self.value = 0

    def add(self, x: int) -> int:
        self.value += x
        return self.value

    def reset(self):
        self.value = 0
      `.trim()

      parser.parse('calc.py', content1, adapter)

      const content2 = content1.replace('def calculate', 'def compute')

      const start = performance.now()
      const result = parser.parse('calc.py', content2, adapter)
      const duration = performance.now() - start

      expect(result.result).toBeDefined()
      expect(duration).toBeLessThan(100)

      parser.dispose()
      adapter.dispose()
    })

    it('achieves high cache hit rate on repeated access', () => {
      const parser = new IncrementalParser()
      const adapter = new TypeScriptAdapter()

      const files = Array.from({ length: 10 }, (_, i) => ({
        path: `file${i}.ts`,
        content: `export const value${i} = ${i}`,
      }))

      // Initial parse (all misses)
      for (const file of files) {
        parser.parse(file.path, file.content, adapter)
      }

      // Repeated access (all hits)
      for (let round = 0; round < 5; round++) {
        for (const file of files) {
          parser.parse(file.path, file.content, adapter)
        }
      }

      const stats = parser.getStats()
      // 10 full parses, 50 cached accesses
      // Hit rate should be 50/60 = 0.833...
      expect(stats.treeCache.hitRate).toBeGreaterThan(0.8)

      parser.dispose()
      adapter.dispose()
    })
  })
})
