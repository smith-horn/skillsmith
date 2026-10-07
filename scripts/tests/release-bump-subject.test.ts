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

  it('keeps arm 2, the literal prefix the drift checker asserts', () => {
    expect(isReleaseBumpSubject('chore: bump version to 1.2.3')).toBe(true)
  })

  it('rejects every free-text subject the deleted arm 3 used to accept', () => {
    // Arm 3 was /^chore:.*bump.*\d+\.\d+\.\d+/ — any bare `chore:` carrying
    // "bump" and something version-shaped. Two review rounds found six wrong
    // verdicts in it, so it was deleted rather than narrowed a third time.
    // Each of these was accepted as a release boundary and is not a release.
    // The caller takes the FIRST match scanning newest-first, so any one of
    // them landing after a real release would have replaced it.
    expect(isReleaseBumpSubject('chore: bump npm from 10.9.4 to 11.9.0')).toBe(false) // 8ac96f7a4, real
    expect(isReleaseBumpSubject('chore: bump minimum Node version to 20.1.0')).toBe(false)
    expect(isReleaseBumpSubject('chore: bump API docs for 1.2.3')).toBe(false)
    expect(isReleaseBumpSubject('chore: bump lockfile format to 3.0.0')).toBe(false)
    expect(isReleaseBumpSubject('chore: bump docs for 1.2.3beta')).toBe(false)
  })

  it('also stops recognising the pre-0.5.x bare-chore release forms, deliberately', () => {
    // These three are real release subjects from this history (09ed1c6c6,
    // fbf9a4c7f, adac919ae) and are no longer matched. That is the measured
    // cost of deleting arm 3, asserted here so it stays a decision rather than
    // becoming a surprise: the nearest sits 2,356 commits from HEAD while
    // BOUNDARY_SEARCH_DEPTH is 50, so this function cannot reach any of them.
    // An unrecognised subject makes the caller refuse, which is the correct
    // outcome — it never guesses a boundary.
    expect(
      isReleaseBumpSubject('chore: bump core 0.4.16, mcp-server 0.4.4, fix core dep pin')
    ).toBe(false)
    expect(isReleaseBumpSubject('chore: bump core 0.4.10, mcp-server 0.3.20, cli 0.3.8')).toBe(
      false
    )
    expect(isReleaseBumpSubject('chore: bump mcp-server and cli to v0.2.2')).toBe(false)
  })

  it('has no free-text arm at all — the matcher is two exact forms', () => {
    // The property that makes arm 3's whole defect class unreachable, asserted
    // directly rather than through examples: a bare `chore:` subject matches
    // only via arm 2's literal prefix, never by merely resembling a bump.
    expect(isReleaseBumpSubject('chore: anything at all 1.2.3 bump')).toBe(false)
    expect(isReleaseBumpSubject('chore: bump')).toBe(false)
    // The lookahead that introduced a false negative went with the arm, so the
    // word "from" is no longer special anywhere in the matcher.
    expect(isReleaseBumpSubject('chore(release): bump core 0.5.0 from the cadence run')).toBe(true)
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

  /**
   * Line number of the sole line matching `re`, 1-based.
   *
   * Asserts UNIQUENESS, not just presence. A cross-family review argued the
   * ordering assertions could be satisfied by a second, earlier occurrence of
   * the pattern — the function's own signature rather than its call site. That
   * was measured false for this pattern (it matches exactly one line, 292), but
   * the objection is sound in general: `findIndex` silently takes the first hit,
   * so a future edit introducing a second match would redirect every ordering
   * assertion below without failing anything. Requiring exactly one match makes
   * that a test failure instead of a silent change of subject.
   */
  const lineOf = (re: RegExp): number => {
    const hits = src.map((l, i) => (re.test(l) ? i + 1 : 0)).filter((n) => n > 0)
    expect(hits, `expected exactly one line matching ${re} in prepare-release.ts`).toHaveLength(1)
    return hits[0]
  }

  /** The call site in main(), spelled out so it cannot collide with the definition. */
  const BOUNDARY_CALL = /^\s*const changelogSince = resolveChangelogBoundary\(noChangelog\)$/

  it('resolves the boundary before the version-file writes, README sync, dep ranges and snapshot', () => {
    const boundary = lineOf(BOUNDARY_CALL)
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

  it('resolves the boundary before the --dry-run exit, so the preview sees the refusal', () => {
    // A dry run exists to report what the real run will do. With the resolution
    // below the early exit, --dry-run passed clean and the operator met the
    // refusal for the first time on the real invocation. Step 3.5's npm
    // collision guard already documents this convention for itself.
    const boundary = lineOf(BOUNDARY_CALL)
    expect(boundary, 'boundary must resolve before the --dry-run early exit').toBeLessThan(
      lineOf(/^\s*if \(dryRun\) \{$/)
    )
  })

  it('leaves --check exiting above the boundary resolution', () => {
    // Deliberate, and the inverse of the assertion above: --check is a version
    // audit that never reaches changelog generation, so a boundary it would not
    // use must not be able to fail it.
    const boundary = lineOf(BOUNDARY_CALL)
    expect(lineOf(/^\s*if \(check\) \{$/), '--check exits before the boundary').toBeLessThan(
      boundary
    )
  })

  it('consumes the retained hash at changelog generation instead of re-resolving', () => {
    // Re-resolving would reintroduce a second, unguarded lookup — one that runs
    // after the writes, which is the arrangement this change exists to remove.
    const generation = src.slice(lineOf(/Step 7-8: Generate and prepend changelogs/) - 1)
    expect(generation.join('\n')).toContain('changelogSince')
  })

  it('calls the boundary resolver exactly once in the whole file', () => {
    // The scoped-window version of this assertion looked only 20 lines past the
    // Step 7-8 comment, so a second lookup placed further down — or reached
    // through an alias — survived it. A cross-family review named that mutation.
    // Counting over the entire file closes it: there is one resolver call and
    // one underlying lookup, and both are the ones the ordering tests pin.
    const body = src.filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n')
    expect(body.match(/resolveChangelogBoundary\(/g) ?? []).toHaveLength(2) // definition + 1 call site
    expect(body.match(/findLastVersionBumpCommit\(\)/g) ?? []).toHaveLength(1) // once, inside the resolver
  })
})
