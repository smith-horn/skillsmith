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
 *
 * `emitBaselineSignature` is mocked below (SMI-5708 Wave 1 fix): the real
 * `updateBaseline()` unconditionally calls it, and it writes to a hardcoded,
 * tracked `eval/.signatures.log` (SIGNATURES_LOG_PATH is not parameterized —
 * it ignores this suite's temp `baselinePath`) plus shells out to
 * `git rev-parse`. Before this mock, every run of this file appended real
 * lines to that committed file as a side effect of Test 5/5b's three
 * `updateBaseline()` calls.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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

vi.mock('../../eval/eval-runner-signatures.js', () => ({
  emitBaselineSignature: vi.fn(),
}))

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

  // SMI-5708 Item #3 (Codex review finding, High): a genuinely MISSING
  // baseline.json (first-ever run) must be distinguished from an EXISTING
  // one that's malformed/corrupted -- the latter must hard-fail rather than
  // silently being treated as "start fresh, this is a legitimate bootstrap".
  // Before this fix, both cases mapped to `existingCurrent === null`, which
  // would have let real corruption launder itself into `bootstrapped: true`
  // -- exactly the bypass SMI-5708 Item #3's schema validator is meant to
  // close, undermined one layer up at the writer.

  it('Test 6: genuinely missing baseline.json -- writes bootstrapped: true', () => {
    const baselinePath = join(tmpDir, 'baseline.json')
    const stateFile = writeStateFile({ 'memory://a.md': 5 })
    expect(existsSync(baselinePath)).toBe(false)

    updateBaseline(makeReport(0.5), { baselinePath, stateFile })

    const written = JSON.parse(readFileSync(baselinePath, 'utf8')) as BaselineFile
    expect(written.bootstrapped).toBe(true)
    expect(written.prior).toBeNull()
  })

  it('Test 7: an existing, valid baseline.json -- writes bootstrapped: false, promotes prior', () => {
    const baselinePath = join(tmpDir, 'baseline.json')
    const stateFile = writeStateFile({ 'memory://a.md': 5 })

    updateBaseline(makeReport(0.5), { baselinePath, stateFile }) // Run 1: genuine bootstrap
    updateBaseline(makeReport(0.6), { baselinePath, stateFile }) // Run 2: promotes Run 1's current

    const written = JSON.parse(readFileSync(baselinePath, 'utf8')) as BaselineFile
    expect(written.bootstrapped).toBe(false)
    expect(written.prior).toBe(0.5)
    expect(written.current).toBe(0.6)
  })

  it('Test 8: an EXISTING baseline.json with malformed JSON throws, does NOT silently bootstrap', () => {
    const baselinePath = join(tmpDir, 'baseline.json')
    const stateFile = writeStateFile({ 'memory://a.md': 5 })
    writeFileSync(baselinePath, '{not valid json', 'utf8')

    expect(() => updateBaseline(makeReport(0.5), { baselinePath, stateFile })).toThrow(
      /malformed JSON/
    )
  })

  it('Test 9: an EXISTING baseline.json with a non-numeric current throws, does NOT silently bootstrap', () => {
    const baselinePath = join(tmpDir, 'baseline.json')
    const stateFile = writeStateFile({ 'memory://a.md': 5 })
    // bootstrapped: true isolates this to purely a current-type failure --
    // otherwise prior: null (missing bootstrapped) would ALSO fail
    // validation, muddying which specific defect the test is proving.
    writeFileSync(
      baselinePath,
      JSON.stringify({ prior: null, bootstrapped: true, current: 'not-a-number' }),
      'utf8'
    )

    expect(() => updateBaseline(makeReport(0.5), { baselinePath, stateFile })).toThrow(
      /current must be a number/
    )
  })

  // Codex round-2 review finding (High): a bare `typeof current === 'number'`
  // check let current: 0, -1, 1.5, or NaN -- all still `typeof 'number'` --
  // pass through and get silently promoted as the new prior. updateBaseline()
  // now reuses the full schema validator (validateBaselineFile) instead,
  // closing this gap the same way the reader is closed.
  it('Test 10: an EXISTING baseline.json with current: 0 is valid (a real run can score zero recall)', () => {
    // Unlike `prior` (where exactly 0 was the original silent-skip loophole
    // and is deliberately rejected), `current`'s range is inclusive [0, 1] --
    // a genuinely terrible eval run that found zero relevant results is real
    // data, not corruption, and must not be rejected.
    const baselinePath = join(tmpDir, 'baseline.json')
    const stateFile = writeStateFile({ 'memory://a.md': 5 })
    writeFileSync(
      baselinePath,
      JSON.stringify({ prior: 0.5, current: 0, bootstrapped: false }),
      'utf8'
    )

    expect(() => updateBaseline(makeReport(0.5), { baselinePath, stateFile })).not.toThrow()
    const after = JSON.parse(readFileSync(baselinePath, 'utf8')) as BaselineFile
    expect(after.prior).toBe(0) // promoted correctly from the existing current: 0
  })

  it('Test 10b: an EXISTING baseline.json with current: -1 (genuinely out of range) throws', () => {
    const baselinePath = join(tmpDir, 'baseline.json')
    const stateFile = writeStateFile({ 'memory://a.md': 5 })
    writeFileSync(
      baselinePath,
      JSON.stringify({ prior: 0.5, current: -1, bootstrapped: false }),
      'utf8'
    )

    expect(() => updateBaseline(makeReport(0.5), { baselinePath, stateFile })).toThrow(
      /current must be in range/
    )
  })

  it('Test 11: an EXISTING baseline.json with current out of [0,1] range (1.5) throws', () => {
    const baselinePath = join(tmpDir, 'baseline.json')
    const stateFile = writeStateFile({ 'memory://a.md': 5 })
    writeFileSync(
      baselinePath,
      JSON.stringify({ prior: 0.5, current: 1.5, bootstrapped: false }),
      'utf8'
    )

    expect(() => updateBaseline(makeReport(0.5), { baselinePath, stateFile })).toThrow(
      /current must be in range/
    )
  })

  it('Test 12: an EXISTING baseline.json with current: NaN (via JSON round-trip as null) throws', () => {
    const baselinePath = join(tmpDir, 'baseline.json')
    const stateFile = writeStateFile({ 'memory://a.md': 5 })
    // JSON has no NaN literal -- a hand-edited/corrupted file expressing "no
    // real value" would write current: null, which fails the same way (never
    // legitimate for `current`, unlike `prior`).
    writeFileSync(
      baselinePath,
      JSON.stringify({ prior: 0.5, current: null, bootstrapped: false }),
      'utf8'
    )

    expect(() => updateBaseline(makeReport(0.5), { baselinePath, stateFile })).toThrow(
      /current must be a number/
    )
  })

  it('Test 13: an EXISTING baseline.json with malformed nested byCategory (missing count) throws', () => {
    const baselinePath = join(tmpDir, 'baseline.json')
    const stateFile = writeStateFile({ 'memory://a.md': 5 })
    writeFileSync(
      baselinePath,
      JSON.stringify({
        prior: 0.5,
        current: 0.6,
        bootstrapped: false,
        byCategory: { recallAt5: { 'skill-discovery': 0.5 } }, // count missing entirely
      }),
      'utf8'
    )

    expect(() => updateBaseline(makeReport(0.5), { baselinePath, stateFile })).toThrow(
      /byCategory\.count must be an object/
    )
  })

  // Codex round-3 review finding: a top-level `null` is syntactically valid
  // JSON (JSON.parse succeeds, so the malformed-JSON catch never fires), but
  // would otherwise crash with an uncaught TypeError reading `.prior` off
  // `null` instead of throwing a clean, actionable Error like every other
  // case here.
  it('Test 14: an EXISTING baseline.json containing only the JSON literal null throws a clean error', () => {
    // Guarded once, centrally, in validateBaselineFile() itself (Opus
    // round-3 review finding) -- not duplicated ad hoc at every call site --
    // so both this writer AND the CI reader (check-baseline-drift.ts) get a
    // clean, actionable error instead of an uncaught TypeError reading
    // `.prior` off `null`.
    const baselinePath = join(tmpDir, 'baseline.json')
    const stateFile = writeStateFile({ 'memory://a.md': 5 })
    writeFileSync(baselinePath, 'null', 'utf8')

    expect(() => updateBaseline(makeReport(0.5), { baselinePath, stateFile })).toThrow(
      /baseline\.json must be a JSON object, got null/
    )
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
