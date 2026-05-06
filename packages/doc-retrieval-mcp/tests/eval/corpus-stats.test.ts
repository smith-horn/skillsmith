/**
 * SMI-4763 — Unit tests for corpus-stats helpers in eval-runner.ts.
 *
 * Two latent bugs surfaced during the SMI-4762 baseline bootstrap:
 *
 *   Bug 1: `updateBaseline()` carried `existingCorpus` forward unchanged from
 *          the previous baseline.json. If the index grew (e.g. 1325 → 1500
 *          files), baseline.json kept claiming the stale count forever.
 *
 *   Bug 2: The GAP 1 startup check resolved `.index-state.json` against the
 *          package directory (`packages/doc-retrieval-mcp/.ruvector/...`)
 *          instead of `$REPO_ROOT/.ruvector/...`. The file never existed at
 *          the wrong path, so the check silently passed.
 *
 * Test 5 is the regression guard for Bug 1: it verifies that `updateBaseline`
 * always reflects the live index state, never the previous baseline.json.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  readCorpusStatsFromIndex,
  resolveIndexStateFile,
  updateBaseline,
  type BaselineFile,
} from '../../eval/eval-runner.js'
import type { MetricsReport } from '../../eval/metrics.js'

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'smi-4763-corpus-stats-'))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function writeStateFile(chunkCountByFile: Record<string, number>): string {
  const path = join(tmpDir, '.index-state.json')
  writeFileSync(path, JSON.stringify({ chunkCountByFile }, null, 2), 'utf8')
  return path
}

function makeReport(recallAt5: number): MetricsReport {
  return {
    overall: { count: 10, recallAt5, recallAt10: recallAt5 + 0.05, mrr: 0.7, ndcgAt10: 0.75 },
    byCategory: {},
    byDifficulty: {},
  }
}

// ---------------------------------------------------------------------------
// readCorpusStatsFromIndex — Tests 1-4
// ---------------------------------------------------------------------------

describe('readCorpusStatsFromIndex', () => {
  it('Test 1: returns correct counts for a 3-file / 10-chunk fixture', () => {
    const stateFile = writeStateFile({
      'memory://feedback_a.md': 4,
      'memory://feedback_b.md': 3,
      'docs/internal/architecture/standards.md': 3,
    })
    const stats = readCorpusStatsFromIndex(stateFile)
    expect(stats.filesScanned).toBe(3)
    expect(stats.chunksUpserted).toBe(10)
  })

  it('Test 2: missing file returns 0/0 without throwing', () => {
    const missing = join(tmpDir, 'does-not-exist.json')
    expect(() => readCorpusStatsFromIndex(missing)).not.toThrow()
    const stats = readCorpusStatsFromIndex(missing)
    expect(stats).toEqual({ filesScanned: 0, chunksUpserted: 0 })
  })

  it('Test 3: malformed JSON returns 0/0 without throwing', () => {
    const path = join(tmpDir, '.index-state.json')
    writeFileSync(path, '{not valid json', 'utf8')
    expect(() => readCorpusStatsFromIndex(path)).not.toThrow()
    const stats = readCorpusStatsFromIndex(path)
    expect(stats).toEqual({ filesScanned: 0, chunksUpserted: 0 })
  })

  it('Test 4: empty chunkCountByFile returns 0/0', () => {
    const stateFile = writeStateFile({})
    const stats = readCorpusStatsFromIndex(stateFile)
    expect(stats).toEqual({ filesScanned: 0, chunksUpserted: 0 })
  })
})

// ---------------------------------------------------------------------------
// updateBaseline regression — Test 5 (Bug 1 guard)
// ---------------------------------------------------------------------------

describe('updateBaseline (SMI-4763 regression guard)', () => {
  it('Test 5: writes corpus stats from the live index, NOT the prior baseline.json', () => {
    const baselinePath = join(tmpDir, 'baseline.json')

    // Run 1: index has 1325 files / 28432 chunks
    const stateRun1 = writeStateFile({
      ...Object.fromEntries(
        Array.from({ length: 1325 }, (_, i) => [`memory://file_${i}.md`, 21] as const)
      ),
    })
    // 1325 * 21 = 27825 — not 28432 — but Test 5 only requires the post-update
    // value reflects the live index. Use clean math:
    // 1325 files with 21 chunks each = 27825 chunks.
    updateBaseline(makeReport(0.5), { baselinePath, stateFile: stateRun1 })
    const after1 = JSON.parse(readFileSync(baselinePath, 'utf8')) as BaselineFile
    expect(after1.corpus.filesScanned).toBe(1325)
    expect(after1.corpus.chunksUpserted).toBe(27825)

    // Run 2: index grew to 1500 files / 31500 chunks (1500 * 21).
    // Critical: baseline.json from Run 1 still says 1325/27825. The bug being
    // guarded against is the carry-forward of those stale stats.
    const stateRun2 = writeStateFile({
      ...Object.fromEntries(
        Array.from({ length: 1500 }, (_, i) => [`memory://file_${i}.md`, 21] as const)
      ),
    })
    updateBaseline(makeReport(0.6), { baselinePath, stateFile: stateRun2 })
    const after2 = JSON.parse(readFileSync(baselinePath, 'utf8')) as BaselineFile

    // The load-bearing assertion: stats reflect the LIVE index (1500/31500),
    // not the previous baseline.json's stats (1325/27825).
    expect(after2.corpus.filesScanned).toBe(1500)
    expect(after2.corpus.chunksUpserted).toBe(31500)

    // Sanity: prior promotion still works correctly.
    expect(after2.prior).toBe(0.5)
    expect(after2.current).toBe(0.6)
  })

  it('Test 5b: degraded baseline (missing state file) writes 0/0 not throws', () => {
    const baselinePath = join(tmpDir, 'baseline.json')
    const missingState = join(tmpDir, 'never-existed.json')
    expect(() =>
      updateBaseline(makeReport(0.5), { baselinePath, stateFile: missingState })
    ).not.toThrow()
    expect(existsSync(baselinePath)).toBe(true)
    const written = JSON.parse(readFileSync(baselinePath, 'utf8')) as BaselineFile
    expect(written.corpus).toEqual({ filesScanned: 0, chunksUpserted: 0 })
  })
})

// ---------------------------------------------------------------------------
// resolveIndexStateFile — Tests 6-8 (Bug 2 guard)
// ---------------------------------------------------------------------------

describe('resolveIndexStateFile', () => {
  let originalRepoRoot: string | undefined

  beforeEach(() => {
    originalRepoRoot = process.env.SKILLSMITH_REPO_ROOT
  })

  afterEach(() => {
    if (originalRepoRoot === undefined) {
      delete process.env.SKILLSMITH_REPO_ROOT
    } else {
      process.env.SKILLSMITH_REPO_ROOT = originalRepoRoot
    }
  })

  it('Test 6: respects SKILLSMITH_REPO_ROOT env when set', () => {
    process.env.SKILLSMITH_REPO_ROOT = '/tmp/synthetic-repo-root'
    const resolved = resolveIndexStateFile()
    expect(resolved).toBe('/tmp/synthetic-repo-root/.ruvector/.index-state.json')
  })

  it('Test 7: falls back to process.cwd() when SKILLSMITH_REPO_ROOT is unset', () => {
    delete process.env.SKILLSMITH_REPO_ROOT
    const resolved = resolveIndexStateFile()
    expect(resolved).toBe(join(process.cwd(), '.ruvector', '.index-state.json'))
  })

  it('Test 8: produces an absolute path', () => {
    process.env.SKILLSMITH_REPO_ROOT = '/tmp/abs-check'
    const resolved = resolveIndexStateFile()
    expect(resolved.startsWith('/')).toBe(true)
  })
})
