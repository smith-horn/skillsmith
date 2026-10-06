/**
 * SMI-7012: the release-boundary matcher, its consolidation, and the ordering
 * that keeps a refusal from landing after writes.
 *
 * Its own file rather than an extension of release-changelog.test.ts, which is
 * already 426 lines against the 500-line pre-commit gate.
 *
 * The defect: `startsWith('chore(release):')` cannot match `chore(release)!:`,
 * so core 0.13.0's own release commit was invisible to the function whose only
 * job is finding it. Two byte-identical copies of the matcher existed, so the
 * fix consolidates rather than patching both.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// ESM-safe module mock, declared before importing the SUT. Matches the pattern
// in prepare-release-reserved-range.test.ts.
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process')
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) }
})

import { execFileSync } from 'child_process'

import { isReleaseBumpSubject } from '../lib/release-bump-subject.mjs'
import { isReleaseBumpSubject as fromDriftChecker } from '../check-source-version-drift.mjs'
import { findLastVersionBumpCommit, BOUNDARY_SEARCH_DEPTH } from '../lib/release-changelog'
import { resolveChangelogBoundary } from '../prepare-release'
import { ROOT_DIR } from '../lib/version-utils'

const mockedExecFileSync = vi.mocked(execFileSync)

/** The real subject that exposed this defect, verbatim from `main`. */
const REAL_BANGED_SUBJECT =
  'chore(release)!: SMI-6983 -- core 0.13.0 ships the breaking export removal as a MINOR, not the patch the cadence would have published (#3017)'

describe('isReleaseBumpSubject — the bang (SMI-7012)', () => {
  it('matches the real banged release subject that broke this', () => {
    expect(isReleaseBumpSubject(REAL_BANGED_SUBJECT)).toBe(true)
  })

  it('still matches the unbanged form — control, so the bang is proven to be the discriminator', () => {
    expect(isReleaseBumpSubject('chore(release): bump core 0.13.0, cli 0.8.13')).toBe(true)
  })

  it('does NOT match a bare `chore!:` with no scope', () => {
    expect(isReleaseBumpSubject('chore!: something breaking')).toBe(false)
  })

  it('does NOT match an unrelated scope carrying a bang', () => {
    expect(isReleaseBumpSubject('chore(deps)!: bump a dependency')).toBe(false)
  })

  it('does NOT match a subject that merely mentions a release', () => {
    expect(isReleaseBumpSubject('fix(core): correct the chore(release) matcher')).toBe(false)
  })

  it('keeps both legacy arms, which match commits that exist in this history', () => {
    expect(isReleaseBumpSubject('chore: bump version to 1.2.3')).toBe(true)
    expect(isReleaseBumpSubject('chore: weekly bump 0.11.4')).toBe(true)
  })

  it('returns false for a non-string rather than throwing', () => {
    expect(isReleaseBumpSubject(undefined)).toBe(false)
    expect(isReleaseBumpSubject(null)).toBe(false)
    expect(isReleaseBumpSubject(42)).toBe(false)
  })
})

describe('isReleaseBumpSubject — consolidation (SMI-7012)', () => {
  it('the drift checker re-exports the SAME function object, so the two cannot drift again', () => {
    // Identity, not behavioural equivalence. Equal behaviour across a handful of
    // inputs is what the two byte-identical copies already had; only shared
    // identity makes a future divergence impossible.
    expect(fromDriftChecker).toBe(isReleaseBumpSubject)
  })

  it('and therefore the drift checker also sees the banged subject', () => {
    expect(fromDriftChecker(REAL_BANGED_SUBJECT)).toBe(true)
  })
})

describe('findLastVersionBumpCommit — discriminated result (SMI-7012)', () => {
  beforeEach(() => {
    mockedExecFileSync.mockReset()
  })

  it('returns ok with the hash when a release commit is in the window', () => {
    mockedExecFileSync.mockReturnValue(
      ['deadbeefdeadbeef feat(core): something', `cafebabecafebabe ${REAL_BANGED_SUBJECT}`].join(
        '\n'
      ) as unknown as Buffer
    )
    const r = findLastVersionBumpCommit()
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.hash).toBe('cafebabecafebabe')
  })

  it('reports no-match-in-window rather than guessing a range', () => {
    mockedExecFileSync.mockReturnValue(
      'deadbeefdeadbeef feat(core): nothing releasey here' as unknown as Buffer
    )
    const r = findLastVersionBumpCommit()
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('no-match-in-window')
      expect(r.detail).toContain(String(BOUNDARY_SEARCH_DEPTH))
    }
  })

  it('reports git-failed when git itself fails, distinctly from finding nothing', () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error('not a git repository')
    })
    const r = findLastVersionBumpCommit()
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('git-failed')
      expect(r.detail).toContain('not a git repository')
    }
  })

  it('never returns the literal HEAD~20 on any path', () => {
    // The defect this replaces: both the not-found path and the catch returned
    // 'HEAD~20', so "could not inspect" was indistinguishable from a real
    // boundary twenty commits back (ADR-177 section 5).
    mockedExecFileSync.mockReturnValue('deadbeefdeadbeef feat: nothing' as unknown as Buffer)
    const miss = findLastVersionBumpCommit()
    mockedExecFileSync.mockImplementation(() => {
      throw new Error('boom')
    })
    const failed = findLastVersionBumpCommit()
    for (const r of [miss, failed]) {
      expect(JSON.stringify(r)).not.toContain('HEAD~20')
    }
  })
})

describe('resolveChangelogBoundary — refuses before any write (SMI-7012)', () => {
  beforeEach(() => {
    mockedExecFileSync.mockReset()
  })

  it('throws a remedy-bearing error when the boundary cannot be established', () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error('not a git repository')
    })
    expect(() => resolveChangelogBoundary(false)).toThrow(/Could not establish/)
    expect(() => resolveChangelogBoundary(false)).toThrow(/--no-changelog/)
  })

  it('returns the hash on success', () => {
    mockedExecFileSync.mockReturnValue(
      `cafebabecafebabe ${REAL_BANGED_SUBJECT}` as unknown as Buffer
    )
    expect(resolveChangelogBoundary(false)).toBe('cafebabecafebabe')
  })

  it('with --no-changelog returns undefined AND never consults git', () => {
    // The paired presence proof: the absence assertion below ("did not throw")
    // would pass if the function were a no-op for every input, so the call count
    // is what proves the flag is what suppressed the lookup.
    mockedExecFileSync.mockImplementation(() => {
      throw new Error('git should not have been called')
    })
    expect(resolveChangelogBoundary(true)).toBeUndefined()
    expect(mockedExecFileSync).not.toHaveBeenCalled()

    // Known-positive control from the same execution: with the flag off, the
    // same mock IS reached — so the zero above is the flag's doing, not an
    // artifact of the mock never being wired up.
    expect(() => resolveChangelogBoundary(false)).toThrow()
    expect(mockedExecFileSync).toHaveBeenCalled()
  })
})

describe('ordering: the boundary resolves before any writer runs (SMI-7012)', () => {
  // A source-order assertion, and its limits are worth stating. The resolution
  // lives inside main(), which is neither exported nor module-guarded, so a
  // true in-process "no writer was invoked" observation is not reachable without
  // widening this module's surface. What this pins instead is the property that
  // actually regressed: the call sitting after the write steps. Move it back and
  // this fails, which is the guard the reviewer asked for.
  const src = readFileSync(join(ROOT_DIR, 'scripts/prepare-release.ts'), 'utf-8').split('\n')
  const lineOf = (re: RegExp): number => {
    const i = src.findIndex((l) => re.test(l))
    expect(i, `expected to find ${re} in prepare-release.ts`).toBeGreaterThanOrEqual(0)
    return i + 1
  }

  it('resolves the boundary before the version-file writes, README sync, dep ranges and snapshot', () => {
    const boundary = lineOf(/resolveChangelogBoundary\(noChangelog\)/)
    const writers: Array<[string, RegExp]> = [
      ['version files', /updatePackageJson\(plan\.spec\.packageJsonPath/],
      ['README sync', /syncReadmeWhatsNew\(plans\)/],
      ['workspace dep ranges', /updateWorkspaceDependencies\(/],
      ['typosquat snapshot', /ensureTyposquatSnapshot\(/],
    ]
    for (const [name, re] of writers) {
      expect(boundary, `boundary must resolve before ${name}`).toBeLessThan(lineOf(re))
    }
  })

  it('consumes the retained hash at changelog generation instead of re-resolving', () => {
    // Re-resolving there would reintroduce a second, unguarded lookup.
    const generation = src.slice(lineOf(/Step 7-8: Generate and prepend changelogs/) - 1)
    const untilLoopEnd = generation.slice(0, 20).join('\n')
    expect(untilLoopEnd).toContain('changelogSince')
    expect(untilLoopEnd).not.toMatch(/findLastVersionBumpCommit\(\)/)
  })
})
