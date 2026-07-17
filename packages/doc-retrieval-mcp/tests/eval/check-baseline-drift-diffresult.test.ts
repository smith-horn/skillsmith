/**
 * SMI-5708 Item #2 -- Unit tests for check-baseline-drift.ts's git-diff
 * resolution and fail-closed wiring (getChangedFiles, evaluateDriftWithDiffResult,
 * and the real main() CLI entry point).
 *
 * Split out of check-baseline-drift.test.ts to stay under the 500-line gate
 * (audit:standards / scripts/check-file-length.mjs). Duplicates the mock
 * setup and baseline factories that file also uses -- see its own header
 * comment for the rationale on avoiding subprocess/filesystem access.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  evaluateDriftWithDiffResult,
  getChangedFiles,
  main,
} from '../../eval/check-baseline-drift.js'
import type { BaselineFile } from '../../eval/check-baseline-drift.js'

// SMI-5708 Item #2 -- mock the git subprocess so getChangedFiles() can be
// forced into its failure path without a real repo/git invocation.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) }
})

// SMI-5708 Item #3 (Codex review finding, Medium): validateBaselineFile now
// runs unconditionally in evaluateDrift, so every fixture passed to it must
// itself be schema-valid -- current can never be null in a real baseline.json
// (updateBaseline() always writes a real computed number), and a null prior
// requires the bootstrapped marker. This factory represents a genuine
// first-ever run (no prior data), which is exactly what bootstrapped: true
// exists to mark -- current: 0 is a valid placeholder (in-range), not a
// magic sentinel.
const nullBaseline = (): BaselineFile => ({
  prior: null,
  current: 0,
  bootstrapped: true,
  generated: '2026-05-05',
  corpus: { filesScanned: 0, chunksUpserted: 0 },
  knobs: { boost: 1.5, dampen: 0.85, floor: 0.35, bm25: false },
  metrics: { recallAt5: null },
})

const populatedBaseline = (prior: number | null, current: number | null): BaselineFile => ({
  prior,
  current,
  generated: '2026-05-05',
  corpus: { filesScanned: 1080, chunksUpserted: 26089 },
  knobs: { boost: 1.5, dampen: 0.85, floor: 0.35, bm25: false },
  metrics: { recallAt5: current },
})

// ---------------------------------------------------------------------------
// SMI-5708 Item #2 -- drift gate must fail closed when git-diff resolution
// fails, instead of silently treating it as "nothing changed" (pass: true).
// ---------------------------------------------------------------------------

describe('getChangedFiles', () => {
  const originalBaseRef = process.env['GITHUB_BASE_REF']
  const originalHeadRef = process.env['GITHUB_HEAD_REF']

  beforeEach(() => {
    vi.mocked(execFileSync).mockReset()
  })
  afterEach(() => {
    vi.mocked(execFileSync).mockReset()
    if (originalBaseRef === undefined) delete process.env['GITHUB_BASE_REF']
    else process.env['GITHUB_BASE_REF'] = originalBaseRef
    if (originalHeadRef === undefined) delete process.env['GITHUB_HEAD_REF']
    else process.env['GITHUB_HEAD_REF'] = originalHeadRef
  })

  // SMI-5708 CI repro: actions/checkout never creates a local branch named
  // after GITHUB_BASE_REF (only the origin/ remote-tracking ref exists, even
  // with fetch-depth: 0) -- an unprefixed range fails with "unknown
  // revision", which the fail-closed handling above now surfaces as a hard
  // CI failure instead of the pre-fix silent pass:true.
  it('prefixes the base ref with origin/ when GITHUB_BASE_REF/GITHUB_HEAD_REF are set', () => {
    // A non-"main" base ref, so this test can only pass via the actual
    // origin/${baseRef} interpolation -- "main" would coincidentally match
    // the origin/main...HEAD fallback branch too and mask a dropped
    // interpolation regression.
    process.env['GITHUB_BASE_REF'] = 'release/1.2'
    process.env['GITHUB_HEAD_REF'] = 'some-feature-branch'
    vi.mocked(execFileSync).mockReturnValueOnce('')
    getChangedFiles()
    const [, args] = vi.mocked(execFileSync).mock.calls[0] ?? []
    expect(args).toContain('origin/release/1.2...HEAD')
  })

  it('falls back to origin/main...HEAD when GITHUB_BASE_REF/GITHUB_HEAD_REF are unset', () => {
    delete process.env['GITHUB_BASE_REF']
    delete process.env['GITHUB_HEAD_REF']
    vi.mocked(execFileSync).mockReturnValueOnce('')
    getChangedFiles()
    const [, args] = vi.mocked(execFileSync).mock.calls[0] ?? []
    expect(args).toContain('origin/main...HEAD')
  })

  it('returns { ok: true, files } on a successful git diff', () => {
    vi.mocked(execFileSync).mockReturnValueOnce(
      'packages/doc-retrieval-mcp/src/rerank.ts\npackages/doc-retrieval-mcp/eval/baseline.json\n'
    )
    const result = getChangedFiles()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.files).toEqual([
        'packages/doc-retrieval-mcp/src/rerank.ts',
        'packages/doc-retrieval-mcp/eval/baseline.json',
      ])
    }
  })

  it('returns { ok: false, error } -- NOT an empty file list -- when git diff throws', () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw new Error("fatal: bad revision 'main...HEAD'")
    })
    const result = getChangedFiles()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain("bad revision 'main...HEAD'")
    }
  })
})

describe('evaluateDriftWithDiffResult', () => {
  it('fails closed (pass: false) when diff resolution failed, regardless of baseline content', () => {
    const result = evaluateDriftWithDiffResult(
      { ok: false, error: "fatal: bad revision 'main...HEAD'" },
      nullBaseline()
    )
    expect(result.pass).toBe(false)
    expect(result.message).toContain('::error::')
    expect(result.message).toContain("fatal: bad revision 'main...HEAD'")
  })

  it('a forced git-diff failure does NOT fall through to the old silent pass:true default', () => {
    // Before this fix, a git-diff failure was indistinguishable from "no
    // files changed", and evaluateDrift([], baseline) hits the final
    // fallback branch: pass: true, "nothing to check". This proves the
    // fail-closed path is reached instead, even against a baseline/changed-
    // files combination that would otherwise cleanly pass.
    const result = evaluateDriftWithDiffResult(
      { ok: false, error: 'shallow clone: base ref unreachable' },
      populatedBaseline(0.8, 0.81) // would pass cleanly if [] were used
    )
    expect(result.pass).toBe(false)
    expect(result.message).not.toContain('nothing to check')
  })

  it('delegates to evaluateDrift unchanged when diff resolution succeeded', () => {
    const result = evaluateDriftWithDiffResult(
      { ok: true, files: ['packages/doc-retrieval-mcp/src/rerank.ts'] },
      nullBaseline()
    )
    expect(result.pass).toBe(false)
    expect(result.message).toContain('baseline.json was not updated')
  })

  it('passes through evaluateDrift-normal pass:true cases when diff resolution succeeded with no changes', () => {
    const result = evaluateDriftWithDiffResult({ ok: true, files: [] }, nullBaseline())
    expect(result.pass).toBe(true)
    expect(result.message).toContain('nothing to check')
  })
})

// SMI-5708 Item #2 -- end-to-end CLI wiring test (independent Opus + Codex
// review, both requested this): proves the REAL, unexported-in-spirit
// `main()` wired to a REAL forced `git diff` failure actually reaches
// `process.exit(1)`, not just its parts in isolation. Deliberately still
// avoids spawning a subprocess (per this file's header comment) by mocking
// `process.exit`/`process.stderr.write` instead -- `main()`'s own
// `loadBaseline()` call reads the real, committed baseline.json (harmless,
// read-only), so nothing besides the git subprocess needs mocking.
describe('main (CLI wiring, end-to-end)', () => {
  it('a real forced git-diff failure propagates through the real main() to exit(1)', () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw new Error("fatal: bad revision 'main...HEAD'")
    })
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    main()

    expect(exitSpy).toHaveBeenCalledWith(1)
    const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(written).toContain('::error::')
    expect(written).toContain("fatal: bad revision 'main...HEAD'")

    exitSpy.mockRestore()
    stderrSpy.mockRestore()
  })
})
