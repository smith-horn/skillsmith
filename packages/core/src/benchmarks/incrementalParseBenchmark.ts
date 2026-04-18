#!/usr/bin/env npx tsx
/**
 * SMI-4293: Incremental parsing benchmark.
 *
 * Runs the Python adapter's full parse vs incremental parse over a
 * synthetic module of ~500 function/class/import constructs. Targets:
 *   • Single-file re-parse < 100ms (SMI-1309 success criterion)
 *   • Unchanged re-parse ≥ 5× faster than a cold full parse
 *
 * Usage:
 *   npx tsx src/benchmarks/incrementalParseBenchmark.ts
 *   # or via npm script:
 *   npm run benchmark:incremental-parse -w @skillsmith/core
 *
 * @see docs/internal/implementation/github-wave-5c-tree-sitter-incremental.md
 */

import { performance } from 'perf_hooks'
import { PythonIncrementalParser } from '../analysis/tree-sitter/pythonIncremental.js'

function makePythonSource(functionCount: number, classCount: number): string {
  const lines: string[] = []
  lines.push('import os')
  lines.push('import sys')
  lines.push('from typing import Optional, List, Dict, Any')
  lines.push('from dataclasses import dataclass')
  lines.push('')
  for (let i = 0; i < classCount; i++) {
    lines.push(`class Model${i}:`)
    lines.push(`    """Auto-generated model ${i}."""`)
    lines.push(`    def __init__(self, a: int, b: str):`)
    lines.push(`        self.a = a`)
    lines.push(`        self.b = b`)
    lines.push('')
    lines.push(`    def describe${i}(self) -> str:`)
    lines.push(`        return f"{self.a}:{self.b}"`)
    lines.push('')
  }
  for (let i = 0; i < functionCount; i++) {
    lines.push(`def fn_${i}(x: int, y: int) -> int:`)
    lines.push(`    return x + y + ${i}`)
    lines.push('')
  }
  return lines.join('\n')
}

function applySingleCharEdit(src: string): string {
  // Replace the first occurrence of "+ 0" with "+ 1" (roughly middle of
  // the module); a minimal edit that doesn't shift line counts.
  const target = '+ 0'
  const idx = src.indexOf(target)
  if (idx === -1) return src + '\n# tail\n'
  return src.slice(0, idx + 2) + '1' + src.slice(idx + 3)
}

async function time(
  label: string,
  fn: () => Promise<void> | void,
  iterations = 1
): Promise<number> {
  // Warm-up
  await fn()
  const start = performance.now()
  for (let i = 0; i < iterations; i++) {
    await fn()
  }
  const total = performance.now() - start
  const avg = total / iterations
  console.log(`  ${label}: ${avg.toFixed(2)}ms (avg over ${iterations} iterations)`)
  return avg
}

async function main() {
  const source = makePythonSource(500, 50)
  const edited = applySingleCharEdit(source)
  console.log(`Python source: ${source.length} bytes, ${source.split('\n').length} lines`)

  const parser = new PythonIncrementalParser()
  await parser.ensureReady()
  if (!parser.isReady) {
    console.error('[benchmark] WASM parser unavailable; aborting.')
    process.exit(2)
  }

  console.log('\n=== Full (cold) parse ===')
  // Cold: dispose+reinit before each iteration so we measure a fresh parse.
  const coldParser = new PythonIncrementalParser()
  await coldParser.ensureReady()
  const coldAvg = await time(
    'cold full parse',
    () => {
      coldParser.invalidate('bench.py')
      coldParser.parseSync(source, 'bench.py')
    },
    5
  )

  console.log('\n=== Warm full parse (no cache hit: fresh file path) ===')
  let counter = 0
  const warmFullAvg = await time(
    'warm full parse',
    () => {
      parser.parseSync(source, `fresh-${counter++}.py`)
    },
    5
  )

  console.log('\n=== Unchanged re-parse (cache hit) ===')
  parser.parseSync(source, 'bench-unchanged.py') // seed
  const unchangedAvg = await time(
    'unchanged re-parse',
    () => {
      parser.parseSync(source, 'bench-unchanged.py')
    },
    20
  )

  console.log('\n=== Incremental edit (tree.edit reuse) ===')
  parser.parseSync(source, 'bench-incr.py') // seed
  const incrAvg = await time(
    'incremental edit',
    () => {
      parser.parseSync(edited, 'bench-incr.py')
      parser.parseSync(source, 'bench-incr.py') // flip back for the next iteration
    },
    10
  )

  console.log('\n=== Summary ===')
  console.log(`  Cold full parse:     ${coldAvg.toFixed(2)}ms`)
  console.log(`  Warm full parse:     ${warmFullAvg.toFixed(2)}ms`)
  console.log(`  Unchanged re-parse:  ${unchangedAvg.toFixed(2)}ms`)
  console.log(`  Incremental edit:    ${incrAvg.toFixed(2)}ms`)

  const speedup = coldAvg > 0 ? coldAvg / unchangedAvg : 0
  console.log(`  Unchanged speedup:   ${speedup.toFixed(1)}×`)

  console.log('\n=== Targets ===')
  const singleFileTarget = incrAvg < 100
  const speedupTarget = speedup >= 5
  console.log(
    `  Single-file re-parse < 100ms: ${singleFileTarget ? 'PASS' : 'FAIL'} (${incrAvg.toFixed(2)}ms)`
  )
  console.log(
    `  Unchanged ≥ 5× full parse:     ${speedupTarget ? 'PASS' : 'FAIL'} (${speedup.toFixed(1)}×)`
  )

  parser.dispose()
  coldParser.dispose()

  // Exit non-zero if any target fails so CI / humans notice.
  if (!singleFileTarget || !speedupTarget) process.exit(1)
}

main().catch((err) => {
  console.error('[benchmark] error:', err)
  process.exit(1)
})
