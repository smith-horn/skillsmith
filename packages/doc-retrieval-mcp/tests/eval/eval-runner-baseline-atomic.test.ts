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
})
