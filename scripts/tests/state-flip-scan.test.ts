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
 *   - Group B locks in the real historical counts from SMI-6514's own
 *     Fixture 1 (git-crypt, SMI-6491) against THIS repo's actual commits --
 *     that is inherently host-only, so it detects the broken case live and
 *     skips with a reason naming the ref, rather than asserting a false
 *     "0 denominator" result. The scanner's own denominator guard is what
 *     turned the in-container case into a loud test failure instead of a
 *     silent pass asserting nothing -- do not weaken that guard to make this
 *     split unnecessary.
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

const HISTORICAL_REF = 'dfe3a485a^'
const historicalRefStatus = SCANNER_PRESENT
  ? resolveRefStatus(HISTORICAL_REF)
  : { resolvable: false, reason: 'scanner not present (submodule absent)' }

describe(
  `scan-state-flip.sh -- Group B: historical regression lock ` +
    `(ref '${HISTORICAL_REF}' resolvable: ${historicalRefStatus.resolvable})`,
  () => {
    it(`reproduces the Fixture 1 pre-fix counts (577 / 29 / 5) against ${HISTORICAL_REF}`, (ctx) => {
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

      // dfe3a485a is SMI-6491's own git-crypt-install commit (fixed,
      // permanent SHA; PR #2792). Its parent is the pre-fix tree the plan's
      // own D-11 counterfactual measured.
      const out = execFileSync('bash', [SCANNER_PATH, 'git-crypt', '--ref', HISTORICAL_REF], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      })
      expect(out).toContain('STEP 1 (denominator): 577')
      expect(out).toContain('STEP 2: noun x absence-vocabulary (29 hit(s))')
      expect(out).toContain('STEP 3: high-yield triage subset (5 hit(s))')
    })
  }
)
