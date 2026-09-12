/**
 * SMI-6514: tests for the P-7 State-Flip Assertion Audit scanner
 * (`.claude/skills/plan-review-skill/scripts/scan-state-flip.sh`).
 *
 * The scanner lives in the private strategy submodule beside the skill it
 * serves (SMI-6514 section 4, matching the concurrency-auditor precedent),
 * so every test here skips cleanly when that submodule is absent: external
 * contributors, and CI runners with no PAT access to
 * smith-horn/skillsmith-strategy.
 *
 * SMI-6549 split: a worktree container's `.git` is a gitdir-pointer file
 * holding an absolute HOST path (e.g.
 * `/Users/<dev>/.../skillsmith/.git/worktrees/<name>`), which does not exist
 * inside the container filesystem. Every git command against this repo's
 * real history therefore fails in-container with "fatal: not a git
 * repository" -- not just a lookup of one specific historical SHA. Confirmed
 * live: `git -C /app rev-parse --verify dfe3a485a^` exits 128 with that exact
 * message inside this worktree's own container.
 *
 * "Does the scanner work" and "does it match this repo's real history" are
 * two different claims, so they are two different test groups:
 *   - Group A (below) builds its own throwaway git repo per test, so it
 *     proves the scanner's counting logic without depending on any
 *     particular checkout's git plumbing. Runs identically on host and
 *     in-container.
 *   - Group B locks in the real historical *invariant* from SMI-6514's own
 *     Fixture 1 (git-crypt, SMI-6491) against THIS repo's actual commits --
 *     that is inherently host-only, so it detects the broken case live and
 *     skips with a reason naming the ref, rather than asserting a false
 *     "0 denominator" result. The scanner's own denominator guard is what
 *     turned the in-container case into a loud test failure instead of a
 *     silent pass asserting nothing -- do not weaken that guard to make this
 *     split unnecessary.
 *
 *     SMI-6514 finding 4 (adversarial pre-merge review, 2026-09-11): an
 *     earlier version of Group B froze the exact pre-fix integers (577 / 29
 *     / 5) as `toContain` assertions and used the abbreviated ref
 *     `dfe3a485a^`. Both were wrong per the plan's own text: the
 *     Verification checklist ("Re-measure, don't assert") and D-12 say
 *     divergence from those integers is EXPECTED as the tree evolves and
 *     the acceptance gate is reproduction plus a ratio, not the integers
 *     matching -- a frozen-integer gate would fail on the first legitimate
 *     scanner-vocabulary or pathspec improvement. And an abbreviated SHA can
 *     become unresolvable through a collision, history rewrite, shallow
 *     checkout, or GC, silently turning this regression lock into a skip.
 *     Fixed below: the ref is now the full 40-character SHA, and the
 *     assertions are the invariant the plan states, not the integers.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { makeFixtureEnv, makeFixtureTempDir } from './_lib/git-fixture-env.js'

// Every synthetic repo created by setupSyntheticStateFlipRepo() this file,
// drained and removed in afterEach (SMI-4693 fixture convention: retried
// rmSync, since a just-spawned git process can still hold the directory
// open for a moment on some filesystems).
const createdRepoDirs: string[] = []

afterEach(() => {
  for (const dir of createdRepoDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

// __dirname here is <repo-root>/scripts/tests, so two levels up is repo root
// regardless of vitest's own invocation cwd (matches the convention in
// audit-standards.test.ts and audit-workflow-sha-pin.test.ts).
const REPO_ROOT = join(__dirname, '..', '..')
const SCANNER_PATH = join(REPO_ROOT, '.claude/skills/plan-review-skill/scripts/scan-state-flip.sh')
const SCANNER_PRESENT = existsSync(SCANNER_PATH)

const GIT_ENV = makeFixtureEnv()

/** True when the `shellcheck` binary resolves on PATH in this environment. */
function shellcheckAvailable(): boolean {
  try {
    execFileSync('shellcheck', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    // Not on PATH (ENOENT), or some other spawn failure. Either way there
    // is no shellcheck binary this test can safely invoke.
    return false
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' })
}

/**
 * Build a small, self-contained, hermetic git repo (SMI-4693 fixture-env
 * convention) with two commits: a "pre-flip" commit whose `scripts/fixture.ts`
 * carries a known STEP1/2/3 hit shape for the noun `widget-tool`, and a
 * "post-flip" HEAD commit where the stale lines are fixed. Neither commit
 * touches this repo's own history, so `git grep` against either resolves
 * identically on host and inside a worktree container.
 *
 * Pre-flip line shape (mirrors SMI-6514 Fixture 1's real casualty mix):
 *   1. "not installed"      -- matches STEP2 (absence-vocab) AND STEP3 (triage)
 *   2. "absent" + "by design" -- matches STEP2 AND STEP3
 *   3. "absent" only         -- matches STEP2 ONLY, same shape as the real T9
 *      casualty STEP3 is measured to miss (SMI-6514 D-11)
 *   4. no absence-vocab       -- STEP1 only
 * -> STEP1=4, STEP2=3, STEP3=2.
 *
 * Post-flip (HEAD): only line 4 remains, unchanged -> STEP1=1, STEP2=0, STEP3=0.
 */
function setupSyntheticStateFlipRepo(): { repoDir: string; preFlipSha: string } {
  const repoDir = makeFixtureTempDir('state-flip-scan-fixture')
  createdRepoDirs.push(repoDir)
  git(repoDir, ['init', '-q', '-b', 'main'])
  // One level under scripts/, not directly inside it: measured live (not
  // assumed) that git's `**` pathspec glob requires at least one
  // intermediate directory -- `scripts/**/*.ts` matches `scripts/tests/
  // fixture.ts` but NOT `scripts/fixture.ts`. A first draft of this fixture
  // used the zero-intermediate-directory path and every count below came
  // back 0, the exact vacuous-success shape the scanner's own guard is
  // built to catch turned against the test itself.
  const fixtureDir = join(repoDir, 'scripts', 'tests')
  mkdirSync(fixtureDir, { recursive: true })
  const fixturePath = join(fixtureDir, 'fixture.ts')

  writeFileSync(
    fixturePath,
    [
      '// widget-tool not installed here',
      '// widget-tool absent by design',
      '// widget-tool is absent from PATH',
      '// widget-tool version check only',
      '',
    ].join('\n')
  )
  git(repoDir, ['add', '.'])
  git(repoDir, ['commit', '-q', '-m', 'pre-flip: widget-tool assertions'])
  const preFlipSha = git(repoDir, ['rev-parse', 'HEAD']).trim()

  writeFileSync(fixturePath, ['// widget-tool version check only', ''].join('\n'))
  git(repoDir, ['add', '.'])
  git(repoDir, ['commit', '-q', '-m', 'post-flip: fixed the stale assertions'])

  return { repoDir, preFlipSha }
}

/**
 * Whether `ref` resolves against this checkout's real git history in this
 * environment, and why not when it doesn't. Used only by Group B to decide
 * whether to skip, and to put the reason in the skip note (SMI-6549).
 */
function resolveRefStatus(ref: string): { resolvable: boolean; reason: string } {
  try {
    execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', '--verify', ref], {
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    return { resolvable: true, reason: '' }
  } catch (err) {
    const stderr = (err as { stderr?: Buffer | string }).stderr
    const reason = (
      typeof stderr === 'string' ? stderr : (stderr?.toString() ?? String(err))
    ).trim()
    return { resolvable: false, reason }
  }
}

describe('scan-state-flip.sh (SMI-6514 P-7 scanner) -- Group A: portable', () => {
  it.skipIf(!SCANNER_PRESENT)('parses cleanly under `bash -n`', () => {
    expect(() => execFileSync('bash', ['-n', SCANNER_PATH], { encoding: 'utf8' })).not.toThrow()
  })

  it.skipIf(!SCANNER_PRESENT)('is shellcheck-clean, when shellcheck is available', () => {
    if (!shellcheckAvailable()) {
      // Not installed in this environment (the Docker dev container does
      // not carry it; the repo's actual shellcheck enforcement surface for
      // scripts/ is the dedicated host-runner steps in
      // .github/workflows/validate-hooks.yml and friends). Nothing to
      // assert when the binary itself is absent.
      return
    }
    expect(() => execFileSync('shellcheck', [SCANNER_PATH], { encoding: 'utf8' })).not.toThrow()
  })

  it.skipIf(!SCANNER_PRESENT)('usage error (no noun given) exits with code 2', () => {
    let threw = false
    try {
      execFileSync('bash', [SCANNER_PATH], { cwd: REPO_ROOT, encoding: 'utf8' })
    } catch (err) {
      threw = true
      expect((err as { status: number }).status).toBe(2)
    }
    expect(threw).toBe(true)
  })

  it.skipIf(!SCANNER_PRESENT)(
    'correctly counts a synthetic pre-flip tree via --ref (STEP1=4, STEP2=3, STEP3=2)',
    () => {
      const { repoDir, preFlipSha } = setupSyntheticStateFlipRepo()
      const out = execFileSync('bash', [SCANNER_PATH, 'widget-tool', '--ref', preFlipSha], {
        cwd: repoDir,
        encoding: 'utf8',
      })
      expect(out).toContain('STEP 1 (denominator): 4')
      expect(out).toContain('STEP 2: noun x absence-vocabulary (3 hit(s))')
      expect(out).toContain('STEP 3: high-yield triage subset (2 hit(s))')
    }
  )

  it.skipIf(!SCANNER_PRESENT)(
    'correctly counts the post-flip working tree with no --ref (STEP1=1, STEP2=0, STEP3=0)',
    () => {
      const { repoDir } = setupSyntheticStateFlipRepo()
      const out = execFileSync('bash', [SCANNER_PATH, 'widget-tool'], {
        cwd: repoDir,
        encoding: 'utf8',
      })
      expect(out).toContain('STEP 1 (denominator): 1')
      expect(out).toContain('STEP 2: noun x absence-vocabulary (0 hit(s))')
      expect(out).toContain('STEP 3: high-yield triage subset (0 hit(s))')
    }
  )

  it.skipIf(!SCANNER_PRESENT)(
    'exits non-zero on a zero STEP-1 denominator against a real, working repo (the vacuous-success guard)',
    () => {
      const { repoDir } = setupSyntheticStateFlipRepo()
      expect(() =>
        execFileSync('bash', [SCANNER_PATH, 'zzz-totally-absent-noun-smi-6514', '--ref', 'HEAD'], {
          cwd: repoDir,
          encoding: 'utf8',
        })
      ).toThrow()
    }
  )
})

// dfe3a485a^ pinned to its full 40-character SHA (SMI-6514 finding 4): an
// abbreviated ref can become unresolvable through an abbreviated-SHA
// collision, a history rewrite, a shallow checkout, or GC, which would
// silently convert this regression lock into a legitimate-looking skip.
// dfe3a485a is SMI-6491's own git-crypt-install commit (fixed, permanent
// SHA; PR #2792); this is its parent -- the pre-fix tree the plan's own
// D-11 counterfactual measured. Verify independently with
// `git rev-parse --verify dfe3a485a^` (resolved to this exact SHA when this
// test was written) or `git log -1 --format=%H dfe3a485a^`.
const HISTORICAL_REF = 'be71efb24382b28a06e7ad07327a46c418fe186a' // dfe3a485a^
const historicalRefStatus = SCANNER_PRESENT
  ? resolveRefStatus(HISTORICAL_REF)
  : { resolvable: false, reason: 'scanner not present (submodule absent)' }

/** Pulls the three STEP counts back out of the scanner's own stdout. */
function parseScannerCounts(output: string): { step1: number; step2: number; step3: number } {
  const step1 = Number(output.match(/STEP 1 \(denominator\): (\d+)/)?.[1])
  const step2 = Number(output.match(/STEP 2: noun x absence-vocabulary \((\d+) hit/)?.[1])
  const step3 = Number(output.match(/STEP 3: high-yield triage subset \((\d+) hit/)?.[1])
  return { step1, step2, step3 }
}

/**
 * The UNSCOPED "vocabulary-only, no noun" grep from SMI-6514 section 2.1 --
 * the naive one-step baseline the plan's D-3 measured noun-scope-first
 * against (2,627 hits at plan-writing time, an 88x reduction down to the
 * ~29-30 hit STEP-2 output). Same VOCAB regex and pathspec set as section
 * 2.1's own command, reproduced here (not the scanner's own broader
 * ABSENCE_VOCAB, which additionally ORs in noun-dependent terms that don't
 * make sense unscoped) and run against the SAME historical ref the scanner
 * itself is invoked against below, so the ratio in the test is
 * apples-to-apples rather than mixing a plan-writing-time snapshot with a
 * live re-run.
 */
function countUnscopedAbsenceVocab(ref: string): number {
  const vocab =
    "not installed|not present|not available|not on path|absent|does not exist|unavailable|by design|isn't|is NOT"
  try {
    const out = execFileSync(
      'git',
      [
        'grep',
        '-niE',
        vocab,
        ref,
        '--',
        'scripts/**/*.ts',
        'scripts/**/*.sh',
        'scripts/*.mjs',
        'packages/*/src/**',
        '.github/**',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' }
    )
    return out.split('\n').filter((line) => line.length > 0).length
  } catch (err) {
    // `git grep` exits 1 (not an error condition here) when it finds no
    // matches at all; anything else (bad ref, etc.) is a real failure and
    // should still surface.
    const status = (err as { status?: number }).status
    if (status === 1) return 0
    throw err
  }
}

describe(
  `scan-state-flip.sh -- Group B: historical regression lock ` +
    `(ref '${HISTORICAL_REF}' resolvable: ${historicalRefStatus.resolvable})`,
  () => {
    // SMI-6514 finding 4: this asserts the invariant the plan's own
    // Verification checklist ("Re-measure, don't assert") and D-12 state --
    // the command reproduces, and the two-step (noun-scope-first) collapse
    // still clears >=50x -- not the specific integers recorded in the plan
    // at write time (577 / 29 / 5), which the plan explicitly says will
    // drift as the scanner's own vocabulary or pathspecs are tuned.
    //
    // Measured discrepancy, reported rather than silently resolved: D-12's
    // literal text is "the STEP-1 -> STEP-2 ratio still collapses by
    // >=50x", but STEP-1/STEP-2 against this exact ref is ~19.9x (577/29)
    // pre-fix and ~19.7x (592/30) post-fix -- neither clears 50x, so that
    // literal reading is unsatisfiable by the plan's own recorded numbers.
    // The reading that IS satisfiable, and matches the plan's headline
    // claim (section 2.1 / D-3: "noun-scope-first cuts 2,627 -> 30, an 88x
    // reduction"), is the ratio between the UNSCOPED vocabulary-only count
    // and STEP-2 -- confirmed live at ~90x for this ref. That is what this
    // test asserts.
    it(`reproduces against ${HISTORICAL_REF} and the noun-scope-first collapse still clears >=50x`, (ctx) => {
      if (!SCANNER_PRESENT) {
        ctx.skip('scanner not present (submodule absent)')
      }
      if (!historicalRefStatus.resolvable) {
        // SMI-6549: this is expected and correct inside any worktree
        // container (see the file-header comment) and is a legitimate,
        // visible skip -- not a silent pass. The portable Group A tests
        // above already cover "does the scanner work" in this environment;
        // this test alone locks in a regression against THIS repo's real
        // history, which only a real, working checkout of it can do.
        ctx.skip(
          `ref '${HISTORICAL_REF}' does not resolve in this environment, cannot run the ` +
            `historical regression lock. Reason: ${historicalRefStatus.reason}`
        )
      }

      const out = execFileSync('bash', [SCANNER_PATH, 'git-crypt', '--ref', HISTORICAL_REF], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      })
      const { step1, step2, step3 } = parseScannerCounts(out)

      // "The command reproduces": ran to completion with real, parseable,
      // non-vacuous counts -- not that the integers match a frozen value.
      expect(Number.isNaN(step1), `could not parse STEP 1 out of:\n${out}`).toBe(false)
      expect(Number.isNaN(step2), `could not parse STEP 2 out of:\n${out}`).toBe(false)
      expect(Number.isNaN(step3), `could not parse STEP 3 out of:\n${out}`).toBe(false)
      expect(step1, 'STEP 1 denominator must be > 0 -- a real historical flip').toBeGreaterThan(0)
      expect(step2, 'STEP 2 must find real casualties for a known real flip').toBeGreaterThan(0)

      const unscopedCount = countUnscopedAbsenceVocab(HISTORICAL_REF)
      const ratio = unscopedCount / step2

      expect(
        ratio,
        `noun-scope-first collapse for '${HISTORICAL_REF}': unscoped vocabulary-only count ` +
          `${unscopedCount} -> STEP 2 (noun-scoped) count ${step2} is only ${ratio.toFixed(1)}x, ` +
          `below the plan's stated >=50x acceptance gate (SMI-6514 D-12 / Verification). ` +
          `STEP 1=${step1}, STEP 3=${step3} for reference.`
      ).toBeGreaterThanOrEqual(50)
    })
  }
)
