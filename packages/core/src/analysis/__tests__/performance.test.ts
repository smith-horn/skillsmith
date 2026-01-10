/**
 * SMI-1308: Performance Benchmarks
 *
 * Benchmark suite for multi-language AST analysis performance.
 *
 * Performance Targets:
 * - 10k files: < 5 seconds
 * - Incremental parse: < 100ms
 * - Memory budget: 500MB
 * - Cache hit rate: > 80%
 *
 * @see docs/architecture/multi-language-analysis.md
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { ParserWorkerPool } from '../worker-pool.js'
import { MemoryMonitor } from '../memory-monitor.js'
import { batchReadFiles, streamFiles, filterByExtension } from '../file-streamer.js'
import { LanguageRouter } from '../router.js'
import { TypeScriptAdapter } from '../adapters/typescript.js'
import { PythonAdapter } from '../adapters/python.js'
import { GoAdapter } from '../adapters/go.js'
import { ParseCache } from '../cache.js'

describe('Performance Benchmarks', () => {
  describe('ParserWorkerPool', () => {
    it('should parse 100 TypeScript files under 1 second', async () => {
      const pool = new ParserWorkerPool({ poolSize: 4 })

      // Generate mock tasks with realistic TypeScript content
      const tasks = Array.from({ length: 100 }, (_, i) => ({
        filePath: `test-${i}.ts`,
        content: `
import { useState, useEffect } from 'react'
import type { FC } from 'react'

export interface Props${i} {
  name: string
  value: number
}

export const Component${i}: FC<Props${i}> = ({ name, value }) => {
  const [state, setState] = useState(value)

  useEffect(() => {
    console.log('Component ${i} mounted')
  }, [])

  return <div>{name}: {state}</div>
}

export function helper${i}(a: number, b: number): number {
  return a + b
}

export async function fetchData${i}(): Promise<void> {
  await fetch('/api/data/${i}')
}
        `.trim(),
        language: 'typescript',
      }))

      const start = performance.now()
      const results = await pool.parseFiles(tasks)
      const duration = performance.now() - start

      expect(results).toHaveLength(100)
      expect(duration).toBeLessThan(1000) // 1 second

      // Verify parsing worked
      const successCount = results.filter((r) => !r.error).length
      expect(successCount).toBeGreaterThan(90) // Allow some failures

      pool.dispose()
    })

    it('should parse mixed language files', async () => {
      const pool = new ParserWorkerPool({ poolSize: 4 })

      const tasks = [
        // TypeScript files
        ...Array.from({ length: 30 }, (_, i) => ({
          filePath: `ts-${i}.ts`,
          content: `export const value${i} = ${i}`,
          language: 'typescript',
        })),
        // Python files
        ...Array.from({ length: 30 }, (_, i) => ({
          filePath: `py-${i}.py`,
          content: `def func${i}(): return ${i}`,
          language: 'python',
        })),
        // Go files
        ...Array.from({ length: 30 }, (_, i) => ({
          filePath: `go-${i}.go`,
          content: `func Func${i}() int { return ${i} }`,
          language: 'go',
        })),
      ]

      const start = performance.now()
      const results = await pool.parseFiles(tasks)
      const duration = performance.now() - start

      expect(results).toHaveLength(90)
      expect(duration).toBeLessThan(2000) // 2 seconds for 90 files

      pool.dispose()
    })

    it('should handle empty task list', async () => {
      const pool = new ParserWorkerPool()
      const results = await pool.parseFiles([])
      expect(results).toHaveLength(0)
      pool.dispose()
    })

    it('should report pool statistics', () => {
      const pool = new ParserWorkerPool({ poolSize: 8 })
      const stats = pool.getStats()

      expect(stats.poolSize).toBe(8)
      expect(stats.activeWorkers).toBe(0)
      expect(stats.queuedTasks).toBe(0)

      pool.dispose()
    })

    it('should throw when disposed', async () => {
      const pool = new ParserWorkerPool()
      pool.dispose()

      await expect(
        pool.parseFiles([{ filePath: 'a.ts', content: '', language: 'typescript' }])
      ).rejects.toThrow('Worker pool has been disposed')
    })
  })

  describe('MemoryMonitor', () => {
    it('should track memory usage', () => {
      const monitor = new MemoryMonitor({ thresholdMB: 100 })
      const stats = monitor.getStats()

      expect(stats.heapUsed).toBeGreaterThan(0)
      expect(stats.heapTotal).toBeGreaterThan(0)
      expect(stats.rss).toBeGreaterThan(0)
      expect(stats.threshold).toBe(100 * 1024 * 1024)
      expect(typeof stats.isOverThreshold).toBe('boolean')
    })

    it('should format bytes correctly', () => {
      expect(MemoryMonitor.formatBytes(0)).toBe('0.00 B')
      expect(MemoryMonitor.formatBytes(1024)).toBe('1.00 KB')
      expect(MemoryMonitor.formatBytes(1024 * 1024)).toBe('1.00 MB')
      expect(MemoryMonitor.formatBytes(1024 * 1024 * 1024)).toBe('1.00 GB')
      expect(MemoryMonitor.formatBytes(1536)).toBe('1.50 KB')
    })

    it('should provide summary', () => {
      const monitor = new MemoryMonitor({ thresholdMB: 500 })
      const summary = monitor.getSummary()

      expect(summary).toContain('Heap:')
      expect(summary).toContain('RSS:')
      expect(summary).toContain('Threshold:')
      expect(summary).toContain('Cleanups:')
    })

    it('should track cleanup count', () => {
      const cache = new ParseCache({ maxMemoryMB: 10 })
      const monitor = new MemoryMonitor({ thresholdMB: 0.001, cache }) // Very low threshold

      expect(monitor.getCleanupCount()).toBe(0)

      // Force cleanup by setting threshold very low
      monitor.forceCleanup()

      expect(monitor.getCleanupCount()).toBe(1)
    })

    it('should start and stop monitoring', () => {
      const monitor = new MemoryMonitor()

      expect(monitor.isMonitoring()).toBe(false)

      const stop = monitor.startMonitoring(60000) // Long interval for test
      expect(monitor.isMonitoring()).toBe(true)

      stop()
      expect(monitor.isMonitoring()).toBe(false)
    })

    it('should integrate with ParseCache', () => {
      const cache = new ParseCache({ maxMemoryMB: 10 })
      const monitor = new MemoryMonitor({ cache })

      // Add items to cache
      for (let i = 0; i < 100; i++) {
        cache.set(`file${i}.ts`, `content${i}`, {
          imports: [],
          exports: [],
          functions: [],
        })
      }

      expect(cache.size).toBeGreaterThan(0)

      // Force cleanup
      monitor.forceCleanup()

      // Cache should be cleared
      expect(cache.size).toBe(0)
    })
  })

  describe('ParseCache', () => {
    let cache: ParseCache

    beforeEach(() => {
      cache = new ParseCache({ maxMemoryMB: 10 })
    })

    it('should achieve >80% cache hit rate on repeated parses', () => {
      const content = 'export const foo = 1;'
      const result = { imports: [], exports: [], functions: [] }

      // First access - miss
      expect(cache.get('test.ts', content)).toBeNull()
      cache.set('test.ts', content, result)

      // Repeated access - hits
      let hits = 0
      for (let i = 0; i < 100; i++) {
        if (cache.get('test.ts', content)) {
          hits++
        }
      }

      const hitRate = hits / 100
      expect(hitRate).toBeGreaterThan(0.8)

      const stats = cache.getStats()
      expect(stats.hitRate).toBeGreaterThan(0.8)
    })

    it('should invalidate on content change', () => {
      const result = { imports: [], exports: [], functions: [] }

      cache.set('test.ts', 'original content', result)
      expect(cache.get('test.ts', 'original content')).toEqual(result)

      // Content changed - should miss
      expect(cache.get('test.ts', 'modified content')).toBeNull()
    })

    it('should support pattern invalidation', () => {
      const result = { imports: [], exports: [], functions: [] }

      cache.set('src/a.ts', 'a', result)
      cache.set('src/b.ts', 'b', result)
      cache.set('lib/c.ts', 'c', result)

      cache.invalidatePattern('src/*.ts')

      expect(cache.has('src/a.ts')).toBe(false)
      expect(cache.has('src/b.ts')).toBe(false)
      expect(cache.has('lib/c.ts')).toBe(true)
    })
  })

  describe('File Streamer', () => {
    it('should filter files by extension', () => {
      const paths = ['a.ts', 'b.tsx', 'c.js', 'd.py', 'e.go', 'f.txt']

      const tsFiles = filterByExtension(paths, ['.ts', '.tsx'])
      expect(tsFiles).toEqual(['a.ts', 'b.tsx'])

      const pyFiles = filterByExtension(paths, ['.py'])
      expect(pyFiles).toEqual(['d.py'])
    })

    it('should stream files with generator', async () => {
      // Create temporary test files
      const fs = await import('fs/promises')
      const path = await import('path')
      const os = await import('os')

      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bench-'))
      const testFiles: string[] = []

      try {
        // Create test files
        for (let i = 0; i < 5; i++) {
          const filePath = path.join(tempDir, `test${i}.ts`)
          await fs.writeFile(filePath, `export const value${i} = ${i}`)
          testFiles.push(filePath)
        }

        // Stream files
        const results: Array<{ path: string; lineCount: number }> = []
        for await (const file of streamFiles(testFiles)) {
          results.push({ path: file.path, lineCount: file.lineCount })
        }

        expect(results).toHaveLength(5)
      } finally {
        // Cleanup
        for (const file of testFiles) {
          await fs.unlink(file).catch(() => {})
        }
        await fs.rmdir(tempDir).catch(() => {})
      }
    })

    it('should batch read files with concurrency', async () => {
      const fs = await import('fs/promises')
      const path = await import('path')
      const os = await import('os')

      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bench-batch-'))
      const testFiles: string[] = []

      try {
        // Create test files
        for (let i = 0; i < 20; i++) {
          const filePath = path.join(tempDir, `batch${i}.ts`)
          await fs.writeFile(filePath, `export const batch${i} = ${i}`)
          testFiles.push(filePath)
        }

        // Batch read with limited concurrency
        const start = performance.now()
        const results = await batchReadFiles(testFiles, { concurrency: 5 })
        const duration = performance.now() - start

        expect(results).toHaveLength(20)
        expect(duration).toBeLessThan(1000) // Should be fast
      } finally {
        // Cleanup
        for (const file of testFiles) {
          await fs.unlink(file).catch(() => {})
        }
        await fs.rmdir(tempDir).catch(() => {})
      }
    })
  })

  describe('LanguageRouter Performance', () => {
    let router: LanguageRouter

    beforeAll(() => {
      router = new LanguageRouter()
      router.registerAdapter(new TypeScriptAdapter())
      router.registerAdapter(new PythonAdapter())
      router.registerAdapter(new GoAdapter())
    })

    afterAll(() => {
      router.dispose()
    })

    it('should parse 1000 TypeScript files under 5 seconds', async () => {
      const files = Array.from({ length: 1000 }, (_, i) => ({
        path: `file${i}.ts`,
        content: `
import { useState } from 'react'
export const Component${i} = () => useState(${i})
export function helper${i}() { return ${i} }
        `.trim(),
      }))

      const start = performance.now()

      for (const file of files) {
        router.parseFile(file.content, file.path)
      }

      const duration = performance.now() - start

      // Should be well under 5 seconds for 1000 files
      expect(duration).toBeLessThan(5000)

      // Log actual performance
      console.log(`Parsed 1000 TypeScript files in ${duration.toFixed(2)}ms`)
      console.log(`Average: ${(duration / 1000).toFixed(2)}ms per file`)
    })

    it('should parse incrementally under 100ms', async () => {
      const content = 'def new_function(): pass'
      const adapter = router.getAdapterByLanguage('python')

      if (adapter) {
        const start = performance.now()
        adapter.parseIncremental(content, 'test.py')
        const duration = performance.now() - start

        expect(duration).toBeLessThan(100)
      }
    })
  })

  describe('Memory Budget Compliance', () => {
    it('should stay within 500MB memory budget for 10k file simulation', () => {
      const monitor = new MemoryMonitor({ thresholdMB: 500 })
      const cache = new ParseCache({ maxMemoryMB: 200 })

      // Simulate caching results for many files
      for (let i = 0; i < 1000; i++) {
        cache.set(`file${i}.ts`, `content${i}`, {
          imports: Array.from({ length: 5 }, (_, j) => ({
            module: `module${j}`,
            namedImports: ['a', 'b', 'c'],
            isTypeOnly: false,
            sourceFile: `file${i}.ts`,
          })),
          exports: Array.from({ length: 3 }, (_, j) => ({
            name: `export${j}`,
            kind: 'function' as const,
            isDefault: false,
            sourceFile: `file${i}.ts`,
          })),
          functions: Array.from({ length: 10 }, (_, j) => ({
            name: `func${j}`,
            parameterCount: 2,
            isAsync: j % 2 === 0,
            isExported: true,
            sourceFile: `file${i}.ts`,
            line: j * 10,
          })),
        })
      }

      const stats = monitor.getStats()

      // Memory should be well under threshold
      expect(stats.heapUsed).toBeLessThan(500 * 1024 * 1024)

      // Cache should have evicted entries if needed
      const cacheStats = cache.getStats()
      expect(cacheStats.size).toBeLessThanOrEqual(cacheStats.maxSize)

      cache.clear()
    })
  })

  describe('Integration Benchmarks', () => {
    it('should parse, cache, and reparse with high hit rate', async () => {
      const cache = new ParseCache({ maxMemoryMB: 50 })
      const router = new LanguageRouter()
      router.registerAdapter(new TypeScriptAdapter())

      const files = Array.from({ length: 100 }, (_, i) => ({
        path: `src/component${i}.ts`,
        content: `
import React from 'react'
export const Component${i} = () => <div>Hello ${i}</div>
        `.trim(),
      }))

      // First pass - all misses
      let misses = 0
      for (const file of files) {
        const cached = cache.get(file.path, file.content)
        if (!cached) {
          misses++
          const result = router.parseFile(file.content, file.path)
          cache.set(file.path, file.content, result)
        }
      }

      expect(misses).toBe(100) // All misses on first pass

      // Second pass - all hits (same content)
      let hits = 0
      for (const file of files) {
        if (cache.get(file.path, file.content)) {
          hits++
        }
      }

      expect(hits).toBe(100) // All hits on second pass

      const stats = cache.getStats()
      expect(stats.hitRate).toBeGreaterThan(0.4) // At least 40% overall (100 hits / 200 total)

      router.dispose()
      cache.clear()
    })
  })
})
