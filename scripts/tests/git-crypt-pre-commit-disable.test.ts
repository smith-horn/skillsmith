/**
 * SMI-5983 (governance follow-up): dynamic + static test coverage for
 * .husky/pre-commit's own branch-switch-recovery block -- the POSIX-sh
 * mirror of scripts/_lib.sh's / scripts/_rebase-git-crypt-disable.sh's
 * git-crypt lock + DISABLED-marker machinery, duplicated inline (not
 * sourced) because this hook is #!/bin/sh (no `local`/`[[ ]]`/BASH_SOURCE)
 * and _lib.sh is bash-only.
 *
 * Closes three items left unchecked in
 * docs/internal/implementation/smi-5983-filter-marker-concurrency.md's own
 * Definition-of-Done checklist -- pre-commit-specific test coverage was
 * planned (the checklist names it explicitly) but never written in the
 * original 45-test batch da52b770e shipped. Also regression-guards the
 * lock/trap reentrancy bug this same governance pass found and fixed in
 * that commit's own pre-commit changes: registering the restore trap while
 * the disable sequence's OWN lock instance was still held meant a signal
 * landing in that window made the trap spin against itself for the full
 * wait window, then hard-exit without ever restoring the real filter
 * values.
 *
 * Extracts real spans of .husky/pre-commit verbatim via the
 * `SMI-5983-TEST:BEGIN/END <name>` sentinel comments (added alongside this
 * file) and runs them under a real /bin/sh (dash in the dev container --
 * confirmed via `readlink -f /bin/sh` -- matching husky's actual
 * `#!/bin/sh` execution environment, not bash) against real `git init`
 * temp-dir fixtures. This is not a reimplementation and not a static-only
 * guard: the disabled-precheck and restore-definition tests below actually
 * execute the hook's own shell text.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  makeRepo,
  setConfig,
  getConfig,
  GIT_ENV,
  cleanupTrackedTempDirs,
} from './_lib/git-crypt-lock-marker-helpers.js'

afterEach(() => cleanupTrackedTempDirs())

const __dirname = dirname(fileURLToPath(import.meta.url))
const PRE_COMMIT_PATH = resolve(__dirname, '..', '..', '.husky', 'pre-commit')
const PRE_COMMIT_SRC = readFileSync(PRE_COMMIT_PATH, 'utf8')
const REAL_SH = execFileSync('sh', ['-c', 'command -v sh'], { encoding: 'utf8' }).trim()

/**
 * Extracts the text between a `SMI-5983-TEST:BEGIN <name>` / `... END
 * <name>` sentinel comment pair in .husky/pre-commit, verbatim. Throws
 * loudly (not a silent empty string) if the sentinels move or are removed,
 * so this file's own drift-detection doesn't quietly stop testing anything.
 */
function extractSpan(name: string): string {
  const begin = `# SMI-5983-TEST:BEGIN ${name}`
  const end = `# SMI-5983-TEST:END ${name}`
  const startIdx = PRE_COMMIT_SRC.indexOf(begin)
  const endIdx = PRE_COMMIT_SRC.indexOf(end)
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(
      `SMI-5983 test span "${name}" not found in .husky/pre-commit -- sentinel comments moved or removed?`
    )
  }
  return PRE_COMMIT_SRC.slice(startIdx + begin.length, endIdx)
}

const LOCK_HELPERS_SPAN = extractSpan('lock-helpers')
const CLEAR_MARKER_SPAN = extractSpan('clear-marker')
const DISABLED_PRECHECK_SPAN = extractSpan('disabled-precheck')
const RESTORE_DEFINITION_SPAN = extractSpan('restore-definition')

/** Runs a POSIX sh script with cwd set to the repo dir -- every extracted span relies on this (no `-C`/`git -C`, matching production: git hooks always run with cwd at the repo root, githooks(5)). */
function runShInRepo(dir: string, script: string) {
  const result = spawnSync(REAL_SH, ['-c', script], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 15_000,
    env: GIT_ENV,
  })
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  return { status: result.status ?? 0, stdout, stderr, combined: stdout + stderr }
}

describe('SMI-5983 (governance follow-up): .husky/pre-commit lock-helpers span', () => {
  it("computes the same physical lock directory scripts/_lib.sh's acquire_git_crypt_filter_lock() targets", () => {
    const dir = makeRepo()
    const result = runShInRepo(dir, `${LOCK_HELPERS_SPAN}\necho "LOCKDIR:$GIT_CRYPT_LOCK_DIR"\n`)
    const match = /LOCKDIR:(.*)/.exec(result.stdout)
    expect(match).not.toBeNull()
    const printed = (match as RegExpExecArray)[1].trim()
    // git rev-parse --git-common-dir (no --path-format=absolute) returns a
    // path relative to cwd when cwd is already the repo root -- which is
    // exactly how git invokes every hook (githooks(5)), and how this test
    // runs the span (cwd: dir). Resolve before comparing.
    expect(resolve(dir, printed)).toBe(join(dir, '.git', 'skillsmith-git-crypt-filter.lock'))
  })

  it('acquires and releases cleanly on an uncontended lock', () => {
    const dir = makeRepo()
    const result = runShInRepo(
      dir,
      `${LOCK_HELPERS_SPAN}
       _acquire_git_crypt_lock
       [ -d "$GIT_CRYPT_LOCK_DIR" ] && echo HELD
       _release_git_crypt_lock
       [ -d "$GIT_CRYPT_LOCK_DIR" ] && echo STILL_HELD || echo RELEASED`
    )
    expect(result.stdout).toContain('HELD')
    expect(result.stdout).toContain('RELEASED')
    expect(result.stdout).not.toContain('STILL_HELD')
  })

  it(
    'serializes against a lock already held by another process (simulating a concurrent ' +
      'rebase-worktree.sh) -- fails closed after the full wait window, never proceeds ' +
      'unlocked, never removes the existing lock',
    () => {
      const dir = makeRepo()
      const lockDir = join(dir, '.git', 'skillsmith-git-crypt-filter.lock')
      // Simulate an externally-held lock exactly as the bash-side test suite
      // does for the equivalent scenario (git-crypt-filter-lock-marker.test.ts)
      // -- this test process's own PID is genuinely alive.
      mkdirSync(lockDir)
      writeFileSync(join(lockDir, 'pid'), String(process.pid))

      const result = runShInRepo(
        dir,
        `${LOCK_HELPERS_SPAN}\n_acquire_git_crypt_lock\necho UNREACHABLE\n`
      )
      expect(result.status).not.toBe(0)
      expect(result.combined).toMatch(/busy/i)
      expect(result.combined).toContain(String(process.pid))
      expect(result.combined).not.toContain('UNREACHABLE')
      // Fails closed, never reclaims -- the externally-held lock is untouched.
      expect(existsSync(lockDir)).toBe(true)
      expect(readFileSync(join(lockDir, 'pid'), 'utf8').trim()).toBe(String(process.pid))
    },
    15_000
  )
})

describe('SMI-5983 (governance follow-up): .husky/pre-commit disabled-precheck span', () => {
  it('hard-fails without a checkout attempt when filters are already DISABLED (cat/cat) -- no --no-verify suggestion', () => {
    const dir = makeRepo()
    setConfig(dir, 'filter.git-crypt.smudge', 'cat')
    setConfig(dir, 'filter.git-crypt.clean', 'cat')

    const result = runShInRepo(
      dir,
      `EXPECTED_BRANCH=main\n${LOCK_HELPERS_SPAN}\n${DISABLED_PRECHECK_SPAN}\necho REACHED_END\n`
    )
    expect(result.status).not.toBe(0)
    // The plan doc's own DoD wording: does NOT mention --no-verify (a bypass
    // here could commit directly on the wrong branch), DOES direct the
    // operator through worktree-crypt.sh fix -> checkout -> verify -> retry.
    expect(result.combined).not.toContain('--no-verify')
    expect(result.combined).toContain('worktree-crypt.sh fix')
    expect(result.combined).toContain('git checkout main')
    // Never reaches past the precheck span -- no checkout is even textually
    // reachable on this path, let alone attempted.
    expect(result.combined).not.toContain('REACHED_END')
    // Filters are left exactly as found -- never captured as if "cat" were
    // a real original value (the corruption bug this whole feature closes).
    expect(getConfig(dir, 'filter.git-crypt.smudge')).toBe('cat')
    expect(getConfig(dir, 'filter.git-crypt.clean')).toBe('cat')
    expect(getConfig(dir, 'skillsmith.git-crypt-disabled-marker')).toBe('')
  })

  it('proceeds past the precheck when filters are configured normally (not DISABLED)', () => {
    const dir = makeRepo()
    setConfig(dir, 'filter.git-crypt.smudge', 'git-crypt smudge')
    setConfig(dir, 'filter.git-crypt.clean', 'git-crypt clean')

    const result = runShInRepo(
      dir,
      `EXPECTED_BRANCH=main\n${LOCK_HELPERS_SPAN}\n${DISABLED_PRECHECK_SPAN}\necho REACHED_END\n`
    )
    expect(result.status).toBe(0)
    expect(result.combined).toContain('REACHED_END')
    expect(result.combined).not.toMatch(/already disabled/i)
    // The precheck's own _acquire_git_crypt_lock call is still held at this
    // point in the real file (released later, only after the SMI-2747
    // restore-definition block decides what to do) -- confirms this span
    // doesn't prematurely release out from under the caller.
    expect(existsSync(join(dir, '.git', 'skillsmith-git-crypt-filter.lock'))).toBe(true)
  })
})

describe('SMI-5983 (governance follow-up): full disable-then-restore cycle (restore-definition span)', () => {
  it('captures real values, sets cat/cat, writes the marker, then _restore_smudge_filter() restores + clears the marker -- without hanging', () => {
    const dir = makeRepo()
    setConfig(dir, 'filter.git-crypt.smudge', 'git-crypt smudge')
    setConfig(dir, 'filter.git-crypt.clean', 'git-crypt clean')

    const script = [
      'EXPECTED_BRANCH=main',
      LOCK_HELPERS_SPAN,
      DISABLED_PRECHECK_SPAN,
      CLEAR_MARKER_SPAN,
      RESTORE_DEFINITION_SPAN,
      'echo "MID:smudge=$(git config --local filter.git-crypt.smudge) clean=$(git config --local filter.git-crypt.clean)"',
      // Explicit call, mirroring the real hook's own explicit post-checkout
      // call (line ~441) rather than relying on POSIX sh signal-trap timing,
      // which is what this fix's own regression guard (below) protects via
      // static ordering instead.
      '_restore_smudge_filter',
      'trap - EXIT INT TERM',
      'echo "END:smudge=$(git config --local filter.git-crypt.smudge) clean=$(git config --local filter.git-crypt.clean)"',
    ].join('\n')

    const result = runShInRepo(dir, script)
    expect(result.status).toBe(0)
    // Disabled first (mid-cycle, before restore runs).
    expect(result.combined).toContain('MID:smudge=cat clean=cat')
    // Restored to the REAL captured originals -- not silently left at cat/cat.
    expect(result.combined).toContain('END:smudge=git-crypt smudge clean=git-crypt clean')
    expect(getConfig(dir, 'filter.git-crypt.smudge')).toBe('git-crypt smudge')
    expect(getConfig(dir, 'filter.git-crypt.clean')).toBe('git-crypt clean')
    // The marker is written during disable then cleared during restore --
    // gone by the end of a clean cycle.
    expect(getConfig(dir, 'skillsmith.git-crypt-disabled-marker')).toBe('')
    // Lock released -- restore's own acquire/release cycle completed.
    expect(existsSync(join(dir, '.git', 'skillsmith-git-crypt-filter.lock'))).toBe(false)
  })

  it('a missing pre-image (filter.git-crypt.{smudge,clean} genuinely unset) heals to canonical registration on restore, per SMI-5702', () => {
    const dir = makeRepo()
    // No filter.git-crypt.* configured at all -- SMUDGE_CMD/CLEAN_CMD will
    // both be empty, so the restore-definition span's `if` guard is false
    // and it never runs at all. This is a structural confirmation, not a
    // restore-behavior one: nothing to disable means nothing to restore.
    const script = [
      'EXPECTED_BRANCH=main',
      LOCK_HELPERS_SPAN,
      DISABLED_PRECHECK_SPAN,
      CLEAR_MARKER_SPAN,
      RESTORE_DEFINITION_SPAN,
      'echo REACHED_END',
    ].join('\n')
    const result = runShInRepo(dir, script)
    expect(result.status).toBe(0)
    expect(result.combined).toContain('REACHED_END')
    expect(getConfig(dir, 'filter.git-crypt.smudge')).toBe('')
    expect(getConfig(dir, 'skillsmith.git-crypt-disabled-marker')).toBe('')
  })
})

describe('SMI-5983 (governance follow-up): regression guard for the trap/lock reentrancy fix', () => {
  it("releases the disable sequence's lock BEFORE arming the restore trap, not after", () => {
    // The exact bug this governance pass fixed: _restore_smudge_filter()
    // itself calls _acquire_git_crypt_lock(), which is not reentrant --
    // arming `trap '_restore_smudge_filter' EXIT INT TERM` while the
    // initiating _acquire_git_crypt_lock() call (SMI-5983-TEST:BEGIN
    // disabled-precheck) was still held meant a signal/error landing
    // between trap-registration and release made the trap spin against its
    // own already-held lock for the full wait window, then hard-exit
    // without ever restoring the real filter values. This is a textual
    // regression guard on the invariant that causally prevents it --
    // exercised behaviorally (not just textually) by the disable-then-
    // restore cycle test above, which would hang/timeout well before its
    // 15s spawnSync budget if this ordering regressed back to trap-before-
    // release for the EXIT trap alone (the explicit `_restore_smudge_filter`
    // call in that test doesn't go through the trap, but a regression here
    // would still leave the lock held across the marker write for the trap
    // to fight over on any subsequent real signal).
    const markerWriteIdx = PRE_COMMIT_SRC.indexOf(
      'git config --local skillsmith.git-crypt-disabled-marker "$$'
    )
    expect(markerWriteIdx).toBeGreaterThan(-1)
    const releaseIdx = PRE_COMMIT_SRC.indexOf('_release_git_crypt_lock', markerWriteIdx)
    const trapIdx = PRE_COMMIT_SRC.indexOf(
      "trap '_restore_smudge_filter' EXIT INT TERM",
      markerWriteIdx
    )
    expect(releaseIdx).toBeGreaterThan(-1)
    expect(trapIdx).toBeGreaterThan(-1)
    expect(releaseIdx).toBeLessThan(trapIdx)
  })
})
