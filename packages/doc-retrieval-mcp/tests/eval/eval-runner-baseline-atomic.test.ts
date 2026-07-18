/**
 * SMI-5708 Item #4 — atomic baseline.json write + signature-emission-outcome
 * plumbing, split out of corpus-stats.test.ts to keep that file under the
 * 500-line standard (same rationale as this plan's two source-file splits,
 * eval-runner-baseline.ts / eval-runner-signatures.ts).
 *
 * `updateBaseline()` used to write baseline.json via a direct `writeFileSync`
 * (no temp-file+rename): an interrupted run (Ctrl-C, OOM, crash) mid-write
 * could leave a truncated/corrupted file on disk. It now writes via
 * `writeFileAtomicSync` (temp file in the same directory, then
 * `fs.renameSync`), and its return value carries whether the accompanying
 * `.signatures.log` write (`emitBaselineSignature()`) succeeded, so a
 * failure there — still non-fatal to the run — can be surfaced further up in
 * `main()`'s own output instead of only a stderr warning that scrolls past.
 *
 * `emitBaselineSignature` is mocked below (same reason as corpus-stats.test.ts):
 * the real function writes to a hardcoded, tracked `eval/.signatures.log`
 * (not parameterized by this suite's temp `baselinePath`) and shells out to
 * `git rev-parse`. The mock factory uses `importOriginal` so
 * `writeFileAtomicSync` — imported from the SAME module by
 * `eval-runner-baseline.ts` — stays real; only `emitBaselineSignature` itself
 * is replaced.
 *
 * `node:fs`'s `writeFileSync`/`renameSync` are also wrapped (not replaced)
 * via `importOriginal` so every fixture write and the real
 * `writeFileAtomicSync` path keep working unmodified; only the two
 * interrupted-write tests below arm a one-shot throw via
 * `mockImplementationOnce`, which reverts to the real implementation for the
 * very next call automatically.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  renameSync,
  readFileSync,
  readdirSync,
  existsSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { updateBaseline, type BaselineFile } from '../../eval/eval-runner.js'
import { renderBaselineMarkdown } from '../../eval/eval-runner-baseline.js'
import { emitBaselineSignature } from '../../eval/eval-runner-signatures.js'
import type { MetricsReport } from '../../eval/metrics.js'

vi.mock('../../eval/eval-runner-signatures.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../eval/eval-runner-signatures.js')>()
  return {
    ...actual,
    emitBaselineSignature: vi.fn(),
  }
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    writeFileSync: vi.fn(actual.writeFileSync),
    renameSync: vi.fn(actual.renameSync),
  }
})

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'smi-5708-baseline-atomic-'))
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

describe('updateBaseline atomic write + signature-emission outcome (SMI-5708 Item #4)', () => {
  it('return value carries signatureEmitted: true when emitBaselineSignature succeeds', () => {
    const baselinePath = join(tmpDir, 'baseline.json')
    const stateFile = writeStateFile({ 'memory://a.md': 5 })
    vi.mocked(emitBaselineSignature).mockReturnValueOnce(true)

    const result = updateBaseline(makeReport(0.5), { baselinePath, stateFile })

    expect(result).toEqual({ signatureEmitted: true })
  })

  it('return value carries signatureEmitted: false when emitBaselineSignature fails, but updateBaseline does NOT throw (non-fatal)', () => {
    const baselinePath = join(tmpDir, 'baseline.json')
    const stateFile = writeStateFile({ 'memory://a.md': 5 })
    vi.mocked(emitBaselineSignature).mockReturnValueOnce(false)

    let result: { signatureEmitted: boolean } | undefined
    expect(() => {
      result = updateBaseline(makeReport(0.5), { baselinePath, stateFile })
    }).not.toThrow()

    expect(result).toEqual({ signatureEmitted: false })
    // The baseline write itself must still have succeeded -- signature
    // emission failure must never block or roll back the baseline write.
    expect(existsSync(baselinePath)).toBe(true)
    const written = JSON.parse(readFileSync(baselinePath, 'utf8')) as BaselineFile
    expect(written.current).toBe(0.5)
  })

  it('a failed write to the temp file leaves an existing baseline.json byte-for-byte unchanged and no stray temp file behind', () => {
    const baselinePath = join(tmpDir, 'baseline.json')
    const stateFile = writeStateFile({ 'memory://a.md': 5 })

    // Seed an existing, valid baseline as if a prior real-mode run had
    // already produced it.
    updateBaseline(makeReport(0.4), { baselinePath, stateFile })
    const before = readFileSync(baselinePath, 'utf8')

    // Arm ONE forced failure on the temp-file write -- simulates a crash
    // (Ctrl-C, OOM, disk full) during the write itself. Reverts to the real
    // implementation for any subsequent call.
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw new Error('simulated disk full')
    })

    expect(() => updateBaseline(makeReport(0.9), { baselinePath, stateFile })).toThrow(
      /simulated disk full/
    )

    // The original file must be untouched -- the temp write never reached
    // renameSync, so the target path was never overwritten.
    const after = readFileSync(baselinePath, 'utf8')
    expect(after).toBe(before)

    // No stray `.<pid>.<random>.tmp` file left behind in the directory.
    const strayTempFiles = readdirSync(tmpDir).filter(
      (f) => f.startsWith('baseline.json.') && f.endsWith('.tmp')
    )
    expect(strayTempFiles).toEqual([])
  })

  it('a failed rename leaves an existing baseline.json byte-for-byte unchanged and cleans up the temp file', () => {
    const baselinePath = join(tmpDir, 'baseline.json')
    const stateFile = writeStateFile({ 'memory://a.md': 5 })

    updateBaseline(makeReport(0.4), { baselinePath, stateFile })
    const before = readFileSync(baselinePath, 'utf8')

    // This time the temp file write itself succeeds (real writeFileSync),
    // but the rename step fails -- simulates a crash/interruption after the
    // temp file is fully written but before it replaces the target.
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw new Error('simulated rename failure')
    })

    expect(() => updateBaseline(makeReport(0.9), { baselinePath, stateFile })).toThrow(
      /simulated rename failure/
    )

    const after = readFileSync(baselinePath, 'utf8')
    expect(after).toBe(before)

    // writeFileAtomicSync's catch branch must have unlinked the temp file
    // it just wrote -- nothing orphaned should remain.
    const strayTempFiles = readdirSync(tmpDir).filter(
      (f) => f.startsWith('baseline.json.') && f.endsWith('.tmp')
    )
    expect(strayTempFiles).toEqual([])
  })

  it('a successful write still produces the exact same correct final content as before (no happy-path regression), with no stray temp file', () => {
    const baselinePath = join(tmpDir, 'baseline.json')
    const stateFile = writeStateFile({ 'memory://a.md': 5 })

    updateBaseline(makeReport(0.5), { baselinePath, stateFile })
    const written = JSON.parse(readFileSync(baselinePath, 'utf8')) as BaselineFile

    expect(written.current).toBe(0.5)
    expect(written.bootstrapped).toBe(true)
    expect(written.prior).toBeNull()
    // The file itself is well-formed, newline-terminated JSON (the exact
    // shape `updateBaseline` has always produced).
    expect(readFileSync(baselinePath, 'utf8').endsWith('\n')).toBe(true)

    const filesInDir = readdirSync(tmpDir)
    expect(filesInDir.filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  // Opus + Codex review finding (SMI-5708 Item #10): the two tests above only
  // arm ONE forced writeFileSync failure, which -- since updateBaseline()
  // writes baseline.json THEN baseline.md, each via its own writeFileSync
  // call -- is consumed by the FIRST call (the JSON write). Neither test
  // ever exercises the SECOND call (the markdown write) failing, so a future
  // refactor that silently swallowed a baseline.md write failure (e.g.
  // wrapping it in a try/catch "to be safe") would reintroduce the exact
  // stale-baseline.md bug Item #10 exists to close, and this suite would
  // stay green. This test targets that second call specifically.
  it('a failed baseline.md write throws (does not silently swallow), even though baseline.json was already written successfully', async () => {
    const baselinePath = join(tmpDir, 'baseline.json')
    const stateFile = writeStateFile({ 'memory://a.md': 5 })
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')

    // Call #1 (baseline.json's temp file) succeeds via the real
    // implementation; call #2 (baseline.md's temp file) throws.
    vi.mocked(writeFileSync)
      .mockImplementationOnce(actualFs.writeFileSync)
      .mockImplementationOnce(() => {
        throw new Error('simulated disk full (markdown)')
      })

    expect(() => updateBaseline(makeReport(0.5), { baselinePath, stateFile })).toThrow(
      /simulated disk full \(markdown\)/
    )

    // baseline.json itself was written successfully before the failure --
    // Opus's review confirmed this is benign (a deterministic re-run is
    // monotonic, not corrupting), so this test pins the actual behavior
    // rather than asserting a rollback that doesn't exist.
    expect(existsSync(baselinePath)).toBe(true)
    const written = JSON.parse(readFileSync(baselinePath, 'utf8')) as BaselineFile
    expect(written.current).toBe(0.5)

    // No stray temp file from the failed markdown write.
    const strayTempFiles = readdirSync(tmpDir).filter(
      (f) => f.startsWith('baseline.md.') && f.endsWith('.tmp')
    )
    expect(strayTempFiles).toEqual([])
  })
})

describe('renderBaselineMarkdown (SMI-5708 Item #10)', () => {
  function makeBaseline(overrides: Partial<BaselineFile> = {}): BaselineFile {
    return {
      prior: 0.4364,
      current: 0.6364,
      generated: '2026-06-24',
      corpus: { filesScanned: 1995, chunksUpserted: 37829 },
      knobs: { boost: 1.5, dampen: 0.85, floor: 0.35, bm25: false },
      metrics: { recallAt5: 0.6364, recallAt10: 0.7273, mrr: 0.4566, ndcgAt10: 0.5219 },
      byCategory: {
        recallAt5: { 'adr-lookup': 0.8333, 'zzz-cat': 0.1 },
        recallAt5Prior: { 'adr-lookup': 0.6667 },
        count: { 'adr-lookup': 6, 'zzz-cat': 2 },
      },
      ...overrides,
    }
  }

  it('renders generated date, corpus, and knobs exactly from the baseline', () => {
    const md = renderBaselineMarkdown(makeBaseline())
    expect(md).toContain('Generated: 2026-06-24')
    expect(md).toContain('Corpus: 1995 files, 37829 chunks')
    expect(md).toContain('Knobs: boost=1.5, dampen=0.85, floor=0.35, BM25=off')
  })

  it('formats BM25=on when knobs.bm25 is true', () => {
    const md = renderBaselineMarkdown(
      makeBaseline({ knobs: { boost: 1.5, dampen: 0.85, floor: 0.35, bm25: true } })
    )
    expect(md).toContain('BM25=on')
  })

  it('renders the overall metrics table with recall@5 prior, "--" for metrics with no persisted prior', () => {
    const md = renderBaselineMarkdown(makeBaseline())
    expect(md).toContain('| recall@5   | 0.6364 | 0.4364 |')
    expect(md).toContain('| recall@10  | 0.7273 | -- |')
    expect(md).toContain('| MRR        | 0.4566 | -- |')
    expect(md).toContain('| nDCG@10    | 0.5219 | -- |')
  })

  it('renders "--" for a null prior (bootstrap run)', () => {
    const md = renderBaselineMarkdown(makeBaseline({ prior: null }))
    expect(md).toContain('| recall@5   | 0.6364 | -- |')
  })

  it('sorts by-category rows alphabetically, independent of object key insertion order', () => {
    const md = renderBaselineMarkdown(makeBaseline())
    expect(md.indexOf('zzz-cat')).toBeGreaterThan(md.indexOf('adr-lookup'))
  })

  it('renders "--" for a category with no prior entry (first run to populate byCategory)', () => {
    const md = renderBaselineMarkdown(makeBaseline())
    expect(md).toContain('| zzz-cat | 2 | 0.1000 | -- |')
  })

  it('omits the By Category section entirely when byCategory is absent (pre-Wave-1 baseline)', () => {
    const baseline = makeBaseline()
    delete baseline.byCategory
    const md = renderBaselineMarkdown(baseline)
    expect(md).not.toContain('### By Category')
  })

  it('documents itself as generated, not a manual regeneration step for the developer', () => {
    const md = renderBaselineMarkdown(makeBaseline())
    expect(md).toContain('Do not hand-edit')
    expect(md).not.toContain('developer who ran the eval')
  })
})

describe('updateBaseline also regenerates baseline.md atomically (SMI-5708 Item #10)', () => {
  it('writes baseline.md alongside baseline.json, with content matching renderBaselineMarkdown', () => {
    const baselinePath = join(tmpDir, 'baseline.json')
    const markdownPath = join(tmpDir, 'baseline.md')
    const stateFile = writeStateFile({ 'memory://a.md': 5 })

    updateBaseline(makeReport(0.5), { baselinePath, stateFile })

    expect(existsSync(markdownPath)).toBe(true)
    const writtenJson = JSON.parse(readFileSync(baselinePath, 'utf8')) as BaselineFile
    expect(readFileSync(markdownPath, 'utf8')).toBe(renderBaselineMarkdown(writtenJson))
  })

  it('leaves no stray baseline.md.*.tmp file behind on a successful write', () => {
    const baselinePath = join(tmpDir, 'baseline.json')
    const stateFile = writeStateFile({ 'memory://a.md': 5 })

    updateBaseline(makeReport(0.5), { baselinePath, stateFile })

    const strayTempFiles = readdirSync(tmpDir).filter(
      (f) => f.startsWith('baseline.md.') && f.endsWith('.tmp')
    )
    expect(strayTempFiles).toEqual([])
  })
})
