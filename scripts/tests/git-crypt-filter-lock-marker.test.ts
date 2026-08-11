/**
 * SMI-5983: git-crypt filter lock + DISABLED-state marker tests.
 *
 * Companion to git-crypt-filter-registration.test.ts (SMI-5702, unchanged
 * by this work) and to git-crypt-filter-lock-trap-composition.test.ts
 * (split out of THIS file once the two together exceeded vitest-file scale
 * conventions for this area -- trap-clobbering/composition tests live
 * there). Same harness shape: source the real scripts/_lib.sh via
 * `source`, exercise real functions against plain `git init` temp-dir
 * fixtures.
 *
 * Covers: acquire_git_crypt_filter_lock()/release_git_crypt_filter_lock()
 * (fail-closed on contention, ownership-aware release, unknown-owner
 * diagnostic -- no reclaim exists to test, per the round-4 NEEDLE review
 * finding that rejected automatic reclaim as ABA-unsafe); the marker
 * write/read/clear helpers, including malformed-marker fail-closed
 * behavior; has_active_rebase_state()'s tri-state result; the DISABLED
 * heal decision's four (PID-liveness x rebase-state) quadrants via
 * ensure_git_crypt_filter_registered(); and the real Step 7 wrapper,
 * disable_git_crypt_filters_or_fail().
 */

// SMI-4693-EXEMPT: this file's own execFileSync('git', ...) calls pass
// `env: GIT_ENV`, imported from ./_lib/git-crypt-lock-marker-helpers.js --
// that module itself imports makeFixtureEnv from _lib/git-fixture-env and
// builds GIT_ENV from it (same sanitization SMI-4693 requires), so the
// protection genuinely applies here too. audit:standards Check 40's
// import-path regex can't see through the re-export indirection to detect
// this, hence the explicit exemption rather than a false-positive failure.

import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  makeRepo,
  setConfig,
  getConfig,
  sourceAndRun,
  sourceDisableAndRun,
  deadPid,
  cleanupTrackedTempDirs,
  GIT_ENV,
} from './_lib/git-crypt-lock-marker-helpers.js'

afterEach(() => cleanupTrackedTempDirs())

describe('SMI-5983: acquire/release_git_crypt_filter_lock()', () => {
  it('acquires and releases cleanly; the lock directory is gone after release', () => {
    const dir = makeRepo()
    const result = sourceAndRun(
      `acquire_git_crypt_filter_lock ${JSON.stringify(dir)}; ls "$GIT_CRYPT_FILTER_LOCK_DIR" >/dev/null 2>&1 && echo HELD; release_git_crypt_filter_lock; ls "$GIT_CRYPT_FILTER_LOCK_DIR" >/dev/null 2>&1 && echo STILL_HELD || echo RELEASED`
    )
    expect(result.stdout).toContain('HELD')
    expect(result.stdout).toContain('RELEASED')
    expect(result.stdout).not.toContain('STILL_HELD')
  })

  it('fails closed (no reclaim) when the lock is held by a live PID, naming it', () => {
    const dir = makeRepo()
    // Simulate an externally-held lock: mkdir it ourselves with this test
    // process's own (very much alive) PID recorded inside.
    const lockDir = join(dir, '.git', 'skillsmith-git-crypt-filter.lock')
    mkdirSync(lockDir)
    writeFileSync(join(lockDir, 'pid'), String(process.pid))

    // SMI-5983 (governance follow-up): GIT_CRYPT_FILTER_LOCK_WAIT is resolved
    // from SKILLSMITH_GIT_CRYPT_FILTER_LOCK_WAIT ONCE at _lib.sh source time
    // (scripts/_lib.sh's top-level GIT_CRYPT_FILTER_LOCK_WAIT="${SKILLSMITH_
    // GIT_CRYPT_FILTER_LOCK_WAIT:-10}") -- setting the env var as an inline
    // prefix to the function call AFTER `source` has already run (the
    // original form of this test) is a no-op; the wait always fell back to
    // the full 10s default regardless, which is why this test (and the two
    // below it) measured ~10s despite the apparent 1s override. Passing it
    // via extraEnv sets it in the spawned process's environment BEFORE the
    // script (and therefore the `source` line) runs, so the override
    // actually takes effect -- also the first real exercise of this env var
    // actually working, not just its default.
    const result = sourceAndRun(`acquire_git_crypt_filter_lock ${JSON.stringify(dir)}`, {
      SKILLSMITH_GIT_CRYPT_FILTER_LOCK_WAIT: '1',
    })
    expect(result.status).not.toBe(0)
    expect(result.combined).toContain(String(process.pid))
    expect(result.combined).toMatch(/live/i)
    expect(result.combined).not.toMatch(/rmdir/) // never suggests removing a live holder's lock
  })

  it('fails closed with an "unknown owner" diagnostic when the lock dir has no readable PID file', () => {
    const dir = makeRepo()
    const lockDir = join(dir, '.git', 'skillsmith-git-crypt-filter.lock')
    mkdirSync(lockDir) // no pid file written -- simulates a crash between mkdir and the PID write

    // SMI-5983 (governance follow-up): env var passed via extraEnv, not as
    // an inline call-prefix -- see the sibling test above for why the
    // prefix form is a no-op.
    const result = sourceAndRun(`acquire_git_crypt_filter_lock ${JSON.stringify(dir)}`, {
      SKILLSMITH_GIT_CRYPT_FILTER_LOCK_WAIT: '1',
    })
    expect(result.status).not.toBe(0)
    expect(result.combined).toMatch(/unrecorded|unknown/i)
    expect(result.combined).toContain('rmdir')
  })

  it('fails closed with a manual rmdir remediation when held by a confirmed-dead PID (no automatic reclaim)', () => {
    const dir = makeRepo()
    const lockDir = join(dir, '.git', 'skillsmith-git-crypt-filter.lock')
    mkdirSync(lockDir)
    writeFileSync(join(lockDir, 'pid'), String(deadPid()))

    // SMI-5983 (governance follow-up): env var passed via extraEnv, not as
    // an inline call-prefix -- see the first test in this describe block for
    // why the prefix form is a no-op.
    const result = sourceAndRun(`acquire_git_crypt_filter_lock ${JSON.stringify(dir)}`, {
      SKILLSMITH_GIT_CRYPT_FILTER_LOCK_WAIT: '1',
    })
    expect(result.status).not.toBe(0)
    expect(result.combined).toContain('rmdir')
    expect(result.combined).toMatch(/not running/i)
    // The lock directory must still exist -- this call never reclaims it.
    expect(existsSync(lockDir)).toBe(true)
  })

  it('release is ownership-aware: a process that is not the recorded owner cannot release the lock', () => {
    const dir = makeRepo()
    const lockDir = join(dir, '.git', 'skillsmith-git-crypt-filter.lock')
    mkdirSync(lockDir)
    writeFileSync(join(lockDir, 'pid'), '999999999') // not this test process's PID

    // Directly exercise release_git_crypt_filter_lock() as if this process
    // believed it held the lock (GIT_CRYPT_FILTER_LOCK_MODE=held) -- it must
    // refuse to remove a directory owned by a different PID.
    const result = sourceAndRun(
      `GIT_CRYPT_FILTER_LOCK_MODE=held GIT_CRYPT_FILTER_LOCK_DIR=${JSON.stringify(lockDir)} release_git_crypt_filter_lock; ls ${JSON.stringify(lockDir)} >/dev/null 2>&1 && echo STILL_THERE`
    )
    expect(result.stdout).toContain('STILL_THERE')
  })
})

describe('SMI-5983: write/read/clear_git_crypt_disabled_marker()', () => {
  it('round-trips PID, timestamp, and a base64-encoded worktree path', () => {
    const dir = makeRepo()
    const worktree = '/some/path with spaces/and:colons'
    const result = sourceAndRun(
      `write_git_crypt_disabled_marker ${JSON.stringify(dir)} ${JSON.stringify(worktree)}
       read_git_crypt_disabled_marker ${JSON.stringify(dir)}
       echo "VALID:$GIT_CRYPT_MARKER_VALID PID:$GIT_CRYPT_MARKER_PID WT:$GIT_CRYPT_MARKER_WORKTREE"`
    )
    expect(result.stdout).toContain('VALID:true')
    expect(result.stdout).toContain(`WT:${worktree}`)
  })

  it('clear removes the marker; a subsequent read reports it absent (VALID=false)', () => {
    const dir = makeRepo()
    const result = sourceAndRun(
      `write_git_crypt_disabled_marker ${JSON.stringify(dir)} /some/worktree
       clear_git_crypt_disabled_marker ${JSON.stringify(dir)}
       read_git_crypt_disabled_marker ${JSON.stringify(dir)}
       echo "VALID:$GIT_CRYPT_MARKER_VALID"`
    )
    expect(result.stdout).toContain('VALID:false')
  })

  it('clear is safe to call when no marker is present', () => {
    const dir = makeRepo()
    const result = sourceAndRun(`clear_git_crypt_disabled_marker ${JSON.stringify(dir)}; echo OK`)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('OK')
  })

  const malformedCases: Array<{ label: string; raw: string }> = [
    { label: 'non-numeric PID', raw: 'notapid 1234567890 d29ya3RyZWU=' },
    { label: 'non-numeric timestamp', raw: '123 not-a-timestamp d29ya3RyZWU=' },
    { label: 'invalid base64 worktree field', raw: '123 1234567890 !!!not-base64!!!' },
    { label: 'empty decoded worktree path', raw: '123 1234567890 ' }, // base64 of "" decodes to ""
    { label: 'missing field (only two)', raw: '123 1234567890' },
    { label: 'extra trailing field (four, not three)', raw: '123 1234567890 d29ya3RyZWU= extra' },
  ]
  for (const { label, raw } of malformedCases) {
    it(`marks a malformed marker (${label}) as VALID=false -- must fail closed like an absent marker`, () => {
      const dir = makeRepo()
      setConfig(dir, 'skillsmith.git-crypt-disabled-marker', raw)
      const result = sourceAndRun(
        `read_git_crypt_disabled_marker ${JSON.stringify(dir)}; echo "VALID:$GIT_CRYPT_MARKER_VALID"`
      )
      expect(result.stdout).toContain('VALID:false')
    })
  }
})

describe('SMI-5983: has_active_rebase_state() tri-state', () => {
  it('inactive: a normal worktree with no rebase-merge/rebase-apply directory', () => {
    const dir = makeRepo()
    const result = sourceAndRun(
      `has_active_rebase_state ${JSON.stringify(dir)}; echo "STATE:$GIT_CRYPT_REBASE_STATE"`
    )
    expect(result.stdout).toContain('STATE:inactive')
  })

  it('active: a rebase-merge directory exists at the git-path', () => {
    const dir = makeRepo()
    const gitPath = execFileSync(
      'git',
      ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-path', 'rebase-merge'],
      {
        encoding: 'utf8',
        env: GIT_ENV,
      }
    ).trim()
    mkdirSync(gitPath, { recursive: true })
    const result = sourceAndRun(
      `has_active_rebase_state ${JSON.stringify(dir)}; echo "STATE:$GIT_CRYPT_REBASE_STATE"`
    )
    expect(result.stdout).toContain('STATE:active')
  })

  it('unknown: a nonexistent/inaccessible worktree path -- NOT treated as inactive', () => {
    const result = sourceAndRun(
      `has_active_rebase_state /does/not/exist/anywhere-12345; echo "STATE:$GIT_CRYPT_REBASE_STATE"`
    )
    expect(result.stdout).toContain('STATE:unknown')
  })
})

describe('SMI-5983: DISABLED heal decision (ensure_git_crypt_filter_registered) -- all four quadrants', () => {
  it('dead PID + inactive rebase state -> heals to canonical, clears the marker', () => {
    const dir = makeRepo()
    setConfig(dir, 'filter.git-crypt.smudge', 'cat')
    setConfig(dir, 'filter.git-crypt.clean', 'cat')
    const pid = deadPid()

    const result = sourceAndRun(
      `write_git_crypt_disabled_marker ${JSON.stringify(dir)} ${JSON.stringify(dir)}
       git -C ${JSON.stringify(dir)} config --local skillsmith.git-crypt-disabled-marker "${pid} 1 $(printf '%s' ${JSON.stringify(dir)} | base64 | tr -d '\\n')"
       ensure_git_crypt_filter_registered ${JSON.stringify(dir)}`
    )
    expect(result.status).toBe(0)
    expect(result.combined).toMatch(/auto-healed/i)
    expect(getConfig(dir, 'filter.git-crypt.smudge')).toBe('git-crypt smudge')
    expect(getConfig(dir, 'filter.git-crypt.clean')).toBe('git-crypt clean')
    expect(getConfig(dir, 'skillsmith.git-crypt-disabled-marker')).toBe('')
  })

  it('dead PID + active rebase state -> declines (the round-1 regression this design closes)', () => {
    const dir = makeRepo()
    setConfig(dir, 'filter.git-crypt.smudge', 'cat')
    setConfig(dir, 'filter.git-crypt.clean', 'cat')
    const pid = deadPid()
    const gitPath = execFileSync(
      'git',
      ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-path', 'rebase-merge'],
      {
        encoding: 'utf8',
        env: GIT_ENV,
      }
    ).trim()
    mkdirSync(gitPath, { recursive: true })

    const result = sourceAndRun(
      `git -C ${JSON.stringify(dir)} config --local skillsmith.git-crypt-disabled-marker "${pid} 1 $(printf '%s' ${JSON.stringify(dir)} | base64 | tr -d '\\n')"
       ensure_git_crypt_filter_registered ${JSON.stringify(dir)}`
    )
    expect(result.status).toBe(0)
    expect(result.combined).toMatch(/not healing/i)
    expect(getConfig(dir, 'filter.git-crypt.smudge')).toBe('cat')
    expect(getConfig(dir, 'filter.git-crypt.clean')).toBe('cat')
  })

  it('live PID + inactive rebase state -> declines', () => {
    const dir = makeRepo()
    setConfig(dir, 'filter.git-crypt.smudge', 'cat')
    setConfig(dir, 'filter.git-crypt.clean', 'cat')

    const result = sourceAndRun(
      `git -C ${JSON.stringify(dir)} config --local skillsmith.git-crypt-disabled-marker "$$ 1 $(printf '%s' ${JSON.stringify(dir)} | base64 | tr -d '\\n')"
       ensure_git_crypt_filter_registered ${JSON.stringify(dir)}`
    )
    expect(result.status).toBe(0)
    expect(result.combined).toMatch(/not healing/i)
    expect(getConfig(dir, 'filter.git-crypt.smudge')).toBe('cat')
    expect(getConfig(dir, 'filter.git-crypt.clean')).toBe('cat')
  })

  it('live PID + active rebase state -> declines (the fourth quadrant)', () => {
    const dir = makeRepo()
    setConfig(dir, 'filter.git-crypt.smudge', 'cat')
    setConfig(dir, 'filter.git-crypt.clean', 'cat')
    const gitPath = execFileSync(
      'git',
      ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-path', 'rebase-merge'],
      { encoding: 'utf8', env: GIT_ENV }
    ).trim()
    mkdirSync(gitPath, { recursive: true })

    const result = sourceAndRun(
      `git -C ${JSON.stringify(dir)} config --local skillsmith.git-crypt-disabled-marker "$$ 1 $(printf '%s' ${JSON.stringify(dir)} | base64 | tr -d '\\n')"
       ensure_git_crypt_filter_registered ${JSON.stringify(dir)}`
    )
    expect(result.status).toBe(0)
    expect(result.combined).toMatch(/not healing/i)
    expect(getConfig(dir, 'filter.git-crypt.smudge')).toBe('cat')
    expect(getConfig(dir, 'filter.git-crypt.clean')).toBe('cat')
  })

  it('a malformed marker never heals, regardless of the underlying PID/rebase state', () => {
    const dir = makeRepo()
    setConfig(dir, 'filter.git-crypt.smudge', 'cat')
    setConfig(dir, 'filter.git-crypt.clean', 'cat')
    setConfig(dir, 'skillsmith.git-crypt-disabled-marker', 'not-a-pid 1 !!!')

    const result = sourceAndRun(`ensure_git_crypt_filter_registered ${JSON.stringify(dir)}`)
    expect(result.status).toBe(0)
    expect(result.combined).toMatch(/not healing/i)
    expect(getConfig(dir, 'filter.git-crypt.smudge')).toBe('cat')
  })
})

describe('SMI-5983: disable_git_crypt_filters_or_fail() -- the real Step 7 wrapper', () => {
  it('hard-fails (never captures cat/cat as the original) when filters are already DISABLED with a valid marker', () => {
    const dir = makeRepo()
    setConfig(dir, 'filter.git-crypt.smudge', 'cat')
    setConfig(dir, 'filter.git-crypt.clean', 'cat')
    const pid = deadPid()
    setConfig(
      dir,
      'skillsmith.git-crypt-disabled-marker',
      `${pid} 1 ${Buffer.from(dir).toString('base64')}`
    )

    const result = sourceDisableAndRun(dir)
    expect(result.status).not.toBe(0)
    expect(result.combined).toMatch(/already disabled/i)
    expect(result.combined).toContain(String(pid))
    // Never captured -- filters stay untouched at "cat"/"cat", not silently
    // "restored" to that bogus value later by some other step.
    expect(getConfig(dir, 'filter.git-crypt.smudge')).toBe('cat')
    expect(getConfig(dir, 'filter.git-crypt.clean')).toBe('cat')
  })

  it('happy path: disables real canonical filters and writes the marker last', () => {
    const dir = makeRepo()
    setConfig(dir, 'filter.git-crypt.smudge', 'git-crypt smudge')
    setConfig(dir, 'filter.git-crypt.clean', 'git-crypt clean')

    const result = sourceDisableAndRun(dir)
    expect(result.combined).toContain('RC:0')
    expect(getConfig(dir, 'filter.git-crypt.smudge')).toBe('cat')
    expect(getConfig(dir, 'filter.git-crypt.clean')).toBe('cat')
    expect(getConfig(dir, 'skillsmith.git-crypt-disabled-marker')).not.toBe('')
  })

  it('--dry-run disables nothing and writes no marker', () => {
    const dir = makeRepo()
    setConfig(dir, 'filter.git-crypt.smudge', 'git-crypt smudge')
    setConfig(dir, 'filter.git-crypt.clean', 'git-crypt clean')

    sourceDisableAndRun(dir, true)
    expect(getConfig(dir, 'filter.git-crypt.smudge')).toBe('git-crypt smudge')
    expect(getConfig(dir, 'filter.git-crypt.clean')).toBe('git-crypt clean')
    expect(getConfig(dir, 'skillsmith.git-crypt-disabled-marker')).toBe('')
  })
})
