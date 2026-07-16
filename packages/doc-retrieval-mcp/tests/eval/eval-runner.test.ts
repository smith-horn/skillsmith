/**
 * SMI-5708 Task #1 — Regression tests for `maybeUpdateBaseline()` in
 * eval-runner.ts.
 *
 * Bug: `main()` used to call `updateBaseline(report)` unconditionally in
 * real mode, even when `opts.category !== null` (i.e. `--category X` was
 * passed). A `--category`-filtered real-mode run only computes metrics over
 * that one category, so an unconditional `updateBaseline()` call silently
 * replaced the canonical, all-category `baseline.json` — the file
 * `check-baseline-drift.ts`'s CI gate depends on — with single-category
 * numbers.
 *
 * Fix: `main()` now routes through `maybeUpdateBaseline(report, opts)`,
 * which refuses to write when `opts.category !== null` and prints an
 * explicit eval-only notice instead. This suite proves both halves of that
 * contract:
 *   - a category-filtered call does NOT invoke the baseline writer and
 *     leaves an existing baseline.json byte-for-byte unchanged;
 *   - an unfiltered call still invokes the writer and does update it.
 *
 * No supported partial-category baseline-update path is added here
 * (plan-review finding M3, docs/internal/implementation/
 * smi-5708-retrieval-eval-harness-hardening.md §1) — refreshing a single
 * category's snapshot is out of scope; the documented path is an
 * unfiltered real-mode run.
 *
 * `emitBaselineSignature` is mocked below: the real `updateBaseline()`
 * unconditionally calls it, and it writes to a hardcoded, tracked
 * `eval/.signatures.log` (not the test's temp `baselinePath`) plus shells
 * out to `git rev-parse`. Exercising the real `updateBaseline()` in the
 * "end-to-end" tests below (to prove actual baseline.json file behavior,
 * not just a mock call count) must not have that side effect on repo state.
 *
 * SMI-5708 Item #4 — the mock factory now uses `importOriginal` to keep
 * `writeFileAtomicSync` real (only `emitBaselineSignature` is replaced):
 * `updateBaseline()` now imports BOTH from `eval-runner-signatures.js`, and a
 * bare `{ emitBaselineSignature: vi.fn() }` replacement would leave
 * `writeFileAtomicSync` `undefined`, breaking every real `updateBaseline()`
 * call below. `writeFileAtomicSync` only ever touches this suite's own temp
 * `baselinePath`, never the committed `.signatures.log`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  maybeUpdateBaseline,
  updateBaseline,
  buildBaselineSignatureWarning,
  type BaselineFile,
  type UpdateBaselineResult,
} from '../../eval/eval-runner.js'
import { emitBaselineSignature } from '../../eval/eval-runner-signatures.js'
import type { MetricsReport } from '../../eval/metrics.js'

vi.mock('../../eval/eval-runner-signatures.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../eval/eval-runner-signatures.js')>()
  return {
    ...actual,
    emitBaselineSignature: vi.fn(),
  }
})

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'smi-5708-eval-runner-'))
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
    byCategory: {
      'general-docs': {
        count: 10,
        recallAt5,
        recallAt10: recallAt5 + 0.05,
        mrr: 0.7,
        ndcgAt10: 0.75,
      },
    },
    byDifficulty: {},
  }
}

describe('maybeUpdateBaseline (SMI-5708 Task #1 regression guard)', () => {
  it('a category-filtered call does NOT invoke the injected baseline writer', () => {
    const updateBaselineFn = vi.fn()
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const wrote = maybeUpdateBaseline(
      makeReport(0.5),
      { category: 'general-docs' },
      {},
      updateBaselineFn
    )

    expect(wrote).toBe(false)
    expect(updateBaselineFn).not.toHaveBeenCalled()
    // Explicit eval-only notice, per the plan's requirement.
    const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(written).toContain('Filtered real-mode run (--category general-docs)')
    expect(written).toContain('NOT updated')

    stderrSpy.mockRestore()
  })

  it('an unfiltered call DOES invoke the injected baseline writer', () => {
    const updateBaselineFn = vi.fn()
    const report = makeReport(0.6)
    const updateBaselineOpts = { baselinePath: join(tmpDir, 'baseline.json') }

    const wrote = maybeUpdateBaseline(
      report,
      { category: null },
      updateBaselineOpts,
      updateBaselineFn
    )

    expect(wrote).toBe(true)
    expect(updateBaselineFn).toHaveBeenCalledTimes(1)
    expect(updateBaselineFn).toHaveBeenCalledWith(report, updateBaselineOpts)
  })

  it('end-to-end (real updateBaseline, no injection): --category filter leaves baseline.json byte-for-byte unchanged', () => {
    const baselinePath = join(tmpDir, 'baseline.json')
    const stateFile = writeStateFile({ 'memory://a.md': 5 })

    // Seed a canonical, all-category baseline as if an unfiltered real-mode
    // run had already produced it.
    updateBaseline(makeReport(0.5), { baselinePath, stateFile })
    const before = readFileSync(baselinePath, 'utf8')

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    // Simulate `RETRIEVAL_EVAL_REAL=1 npm run eval:retrieval -- --category general-docs`:
    // a real-mode run whose report was computed over only one category.
    const wrote = maybeUpdateBaseline(
      makeReport(0.9), // deliberately different metrics — would be an obvious corruption if written
      { category: 'general-docs' },
      { baselinePath, stateFile }
    )
    stderrSpy.mockRestore()

    const after = readFileSync(baselinePath, 'utf8')
    expect(wrote).toBe(false)
    expect(after).toBe(before)
    const parsed = JSON.parse(after) as BaselineFile
    expect(parsed.current).toBe(0.5) // unchanged — NOT the filtered run's 0.9
  })

  it('end-to-end (real updateBaseline, no injection): an unfiltered real-mode run still updates baseline.json', () => {
    const baselinePath = join(tmpDir, 'baseline.json')
    const stateFile = writeStateFile({ 'memory://a.md': 5 })

    updateBaseline(makeReport(0.5), { baselinePath, stateFile })
    const before = JSON.parse(readFileSync(baselinePath, 'utf8')) as BaselineFile
    expect(before.current).toBe(0.5)

    const wrote = maybeUpdateBaseline(
      makeReport(0.65),
      { category: null },
      { baselinePath, stateFile }
    )

    const after = JSON.parse(readFileSync(baselinePath, 'utf8')) as BaselineFile
    expect(wrote).toBe(true)
    expect(after.current).toBe(0.65)
    expect(after.prior).toBe(0.5) // promoted from the previous run, confirming the write happened
  })
})

// ---------------------------------------------------------------------------
// SMI-5708 Item #4 — outcome out-param plumbing + summary-warning helper
// ---------------------------------------------------------------------------

describe('maybeUpdateBaseline outcome out-param (SMI-5708 Item #4)', () => {
  it('omitting the outcome param is byte-for-byte identical to before this change (existing boolean contract untouched)', () => {
    // All pre-existing call sites (this file's earlier tests, corpus-stats
    // tests) call with 3 or 4 args and never pass a 5th `outcome` arg. This
    // proves that shape still works and still returns a plain boolean.
    const updateBaselineFn = vi.fn().mockReturnValue({ signatureEmitted: true })
    const wrote = maybeUpdateBaseline(makeReport(0.6), { category: null }, {}, updateBaselineFn)
    expect(wrote).toBe(true)
  })

  it('populates outcome.signatureEmitted from the injected updateBaselineFn result when a write is attempted', () => {
    const updateBaselineFn = vi.fn().mockReturnValue({ signatureEmitted: false })
    const outcome: UpdateBaselineResult = { signatureEmitted: true } // starts true, must flip to false

    const wrote = maybeUpdateBaseline(
      makeReport(0.6),
      { category: null },
      {},
      updateBaselineFn,
      outcome
    )

    expect(wrote).toBe(true)
    expect(outcome.signatureEmitted).toBe(false)
  })

  it('leaves outcome untouched when the write is skipped (category-filtered run)', () => {
    const updateBaselineFn = vi.fn().mockReturnValue({ signatureEmitted: false })
    const outcome: UpdateBaselineResult = { signatureEmitted: true }
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const wrote = maybeUpdateBaseline(
      makeReport(0.6),
      { category: 'general-docs' },
      {},
      updateBaselineFn,
      outcome
    )
    stderrSpy.mockRestore()

    expect(wrote).toBe(false)
    expect(updateBaselineFn).not.toHaveBeenCalled()
    // Never touched: still whatever the caller initialized it to.
    expect(outcome.signatureEmitted).toBe(true)
  })

  it('a truthy-but-not-exactly-false signatureEmitted value is not mistaken for a failure (typeof check, not truthiness)', () => {
    // Regression guard: an earlier draft of this plumbing used a truthy
    // check (`if (result?.signatureEmitted)`) which would have silently
    // treated `signatureEmitted: false` as "nothing to report" -- exactly
    // backwards. This test pins the correct behavior from the other
    // direction: a genuinely-`true` result must set outcome to `true`.
    const updateBaselineFn = vi.fn().mockReturnValue({ signatureEmitted: true })
    const outcome: UpdateBaselineResult = { signatureEmitted: false }

    maybeUpdateBaseline(makeReport(0.6), { category: null }, {}, updateBaselineFn, outcome)

    expect(outcome.signatureEmitted).toBe(true)
  })

  it('end-to-end (real updateBaseline, mocked emitBaselineSignature): outcome reflects a real signature-emission failure', () => {
    const baselinePath = join(tmpDir, 'baseline.json')
    const stateFile = writeStateFile({ 'memory://a.md': 5 })
    vi.mocked(emitBaselineSignature).mockReturnValueOnce(false)

    const outcome: UpdateBaselineResult = { signatureEmitted: true }
    const wrote = maybeUpdateBaseline(
      makeReport(0.5),
      { category: null },
      { baselinePath, stateFile },
      updateBaseline,
      outcome
    )

    expect(wrote).toBe(true)
    expect(outcome.signatureEmitted).toBe(false)
    // The baseline write itself must have succeeded regardless.
    const written = JSON.parse(readFileSync(baselinePath, 'utf8')) as BaselineFile
    expect(written.current).toBe(0.5)
  })
})

describe('buildBaselineSignatureWarning (SMI-5708 Item #4)', () => {
  it('returns null when no write was attempted, regardless of the stale outcome value', () => {
    expect(buildBaselineSignatureWarning(false, { signatureEmitted: false })).toBeNull()
    expect(buildBaselineSignatureWarning(false, { signatureEmitted: true })).toBeNull()
  })

  it('returns null when a write was attempted and signature emission succeeded', () => {
    expect(buildBaselineSignatureWarning(true, { signatureEmitted: true })).toBeNull()
  })

  it('returns a non-null warning mentioning the signature log and the pre-push validator when a write was attempted and signature emission failed', () => {
    const warning = buildBaselineSignatureWarning(true, { signatureEmitted: false })
    expect(warning).not.toBeNull()
    expect(warning).toContain('.signatures.log')
    expect(warning).toContain('eval-baseline-validator.mjs')
    expect(warning).toContain('WARNING')
  })
})
