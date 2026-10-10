/**
 * SMI-6973 cross-family review findings H1/H2, run the way Husky runs them:
 * `sh -e <script>` (errexit ON). Each test injects a failure with a `git` shim
 * on PATH, because the defect class is "a fallible command inside the held
 * interval aborts the shell before the explicit release".
 *
 * H3 (a signal landing between mkdir and the flag) has no deterministic
 * trigger from outside the shell; its fix is structural (INT/TERM ignored
 * across that window) and is NOT covered by a deterministic test. The existing
 * signal tests deliver their signal during `sleep`, after acquisition.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const PRE_COMMIT_SRC = readFileSync(resolve(__dirname, '..', '..', '.husky', 'pre-commit'), 'utf8')
const LOCK_LIB = resolve(__dirname, '..', 'lib', 'git-crypt-lock.sh')
const REAL_SH = execFileSync('sh', ['-c', 'command -v sh'], { encoding: 'utf8' }).trim()
const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()

function extractSpan(name: string): string {
  const begin = `# SMI-5983-TEST:BEGIN ${name}`
  const end = `# SMI-5983-TEST:END ${name}`
  const startIdx = PRE_COMMIT_SRC.indexOf(begin)
  const endIdx = PRE_COMMIT_SRC.indexOf(end)
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(`test span "${name}" not found in .husky/pre-commit`)
  }
  // Same guard as git-crypt-pre-commit-disable.test.ts: with no line ending
  // before END, indexOf returns -1 and the slice would start at the top of
  // the hook instead of failing.
  const lineEnd = PRE_COMMIT_SRC.indexOf('\n', startIdx)
  if (lineEnd === -1 || lineEnd > endIdx) {
    throw new Error(
      `test span "${name}": BEGIN sentinel has no line ending before its END sentinel`
    )
  }
  return PRE_COMMIT_SRC.slice(lineEnd + 1, endIdx)
}

const PRELUDE = `EXPECTED_BRANCH=main\nRED=''\nNC=''\nYELLOW=''\nGREEN=''\n. ${JSON.stringify(LOCK_LIB)}\n`
const FULL_CYCLE = [
  PRELUDE,
  extractSpan('clear-marker'),
  extractSpan('disabled-precheck'),
  extractSpan('restore-definition'),
].join('\n')

/**
 * Runs `script` under `sh -e` with a `git` shim first on PATH. The shim runs
 * `shimBody` (sh, with $OBS and $SHIM_DIR available) before delegating to the
 * real git, so a test can observe or fail any individual git invocation.
 */
function runWithGitShim(
  dir: string,
  script: string,
  shimBody: string,
  extraEnv: Record<string, string> = {}
) {
  const shimDir = join(dir, '.shim-bin')
  mkdirSync(shimDir, { recursive: true })
  const obs = join(dir, '.shim-obs')
  writeFileSync(
    join(shimDir, 'git'),
    ['#!/bin/sh', shimBody, `exec ${JSON.stringify(REAL_GIT)} "$@"`].join('\n')
  )
  chmodSync(join(shimDir, 'git'), 0o755)
  const result = spawnSync(REAL_SH, ['-ec', script], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...GIT_ENV,
      PATH: `${shimDir}:${GIT_ENV.PATH ?? process.env.PATH ?? ''}`,
      OBS: obs,
      SHIM_DIR: shimDir,
      ...extraEnv,
    },
  })
  const out = (result.stdout ?? '') + (result.stderr ?? '')
  return { status: result.status, out, obs: existsSync(obs) ? readFileSync(obs, 'utf8') : '' }
}

const lockDirOf = (dir: string) => join(dir, '.git', 'skillsmith-git-crypt-filter.lock')

function repoWithRealFilters(): string {
  const dir = makeRepo()
  setConfig(dir, 'filter.git-crypt.smudge', 'git-crypt smudge')
  setConfig(dir, 'filter.git-crypt.clean', 'git-crypt clean')
  return dir
}

describe('SMI-6973 H1: every exit path from the held interval releases the lock (sh -e)', () => {
  // Fails exactly the post-acquisition `git config ... smudge cat` write, which
  // sits inside an `if` BODY in the hook, where errexit is not suppressed.
  const FAIL_DISABLE = [
    'if [ -n "$INJECT" ] && [ "$*" = "config --local filter.git-crypt.smudge cat" ]; then',
    '  echo INJECTED >> "$OBS"; exit 1',
    'fi',
  ].join('\n')

  it('control: the same script with no injection completes and the shim never fires', () => {
    const dir = repoWithRealFilters()
    const r = runWithGitShim(dir, `${FULL_CYCLE}\necho REACHED_END\n`, FAIL_DISABLE)
    expect(r.out).toContain('REACHED_END')
    expect(r.status).toBe(0)
    expect(r.obs).not.toContain('INJECTED')
  })

  it('a failing git config after acquisition aborts the hook but never leaks the lock', () => {
    const dir = repoWithRealFilters()
    const r = runWithGitShim(dir, `${FULL_CYCLE}\necho REACHED_END\n`, FAIL_DISABLE, {
      INJECT: '1',
    })
    // Presence proof: the abort happened where we aimed (the shim fired); the
    // control above runs the identical script with INJECT unset and completes.
    expect(r.obs).toContain('INJECTED')
    expect(r.status).not.toBe(0)
    expect(r.out).not.toContain('REACHED_END')
    expect(existsSync(lockDirOf(dir)), 'lock directory leaked after errexit abort').toBe(false)
  })

  it('a failure inside _restore_smudge_filter releases the lock AND re-runs the restoration (outer cleanup is not lost)', () => {
    const dir = repoWithRealFilters()
    // Fail the FIRST restore write of the smudge value only.
    const shim = [
      'if [ "$*" = "config --local filter.git-crypt.smudge git-crypt smudge" ] && [ ! -e "$SHIM_DIR/once" ]; then',
      '  : > "$SHIM_DIR/once"; echo INJECTED >> "$OBS"; exit 1',
      'fi',
    ].join('\n')
    const r = runWithGitShim(dir, `${FULL_CYCLE}\n_restore_smudge_filter\necho REACHED_END\n`, shim)
    expect(r.obs, 'injection did not fire').toContain('INJECTED')
    expect(r.out).not.toContain('REACHED_END')
    expect(existsSync(lockDirOf(dir)), 'lock directory leaked').toBe(false)
    // The chained restoration ran to completion on the second attempt.
    expect(getConfig(dir, 'filter.git-crypt.smudge')).toBe('git-crypt smudge')
    expect(getConfig(dir, 'filter.git-crypt.clean')).toBe('git-crypt clean')
    expect(getConfig(dir, 'skillsmith.git-crypt-disabled-marker')).toBe('')
  })
})

describe('SMI-6973 H1 (round 3): _restore_smudge_filter run FROM the EXIT trap never leaks the lock', () => {
  // The hook's final trap IS _restore_smudge_filter. Re-arming a trap inside a
  // running EXIT handler never fires, so errexit must not be able to abort the
  // restore between acquire and release.
  const FAIL_RESTORE_SMUDGE = [
    'if [ "$*" = "config --local filter.git-crypt.smudge git-crypt smudge" ]; then',
    '  echo INJECTED >> "$OBS"; exit 1',
    'fi',
  ].join('\n')

  it('a failing restore write reached via the EXIT trap still releases the lock and reports the failure', () => {
    const dir = repoWithRealFilters()
    const r = runWithGitShim(dir, `${FULL_CYCLE}\nexit 0\n`, FAIL_RESTORE_SMUDGE)
    expect(r.obs, 'injection did not fire').toContain('INJECTED')
    expect(existsSync(lockDirOf(dir)), 'lock directory leaked from the EXIT-trap restore').toBe(
      false
    )
    expect(r.out).toMatch(/failed to restore git-crypt filter config/i)
    // Best effort continues past the failing write: the other filter is back.
    expect(getConfig(dir, 'filter.git-crypt.clean')).toBe('git-crypt clean')
    expect(getConfig(dir, 'skillsmith.git-crypt-disabled-marker')).toBe('')
  })

  it('control: the same script with no failing write restores everything and prints no failure', () => {
    const dir = repoWithRealFilters()
    const r = runWithGitShim(dir, `${FULL_CYCLE}\nexit 0\n`, ':')
    expect(existsSync(lockDirOf(dir))).toBe(false)
    expect(getConfig(dir, 'filter.git-crypt.smudge')).toBe('git-crypt smudge')
    expect(getConfig(dir, 'filter.git-crypt.clean')).toBe('git-crypt clean')
    expect(r.out).not.toMatch(/failed to restore/i)
  })
})

describe('SMI-6973 F1: an abort in the disable window releases the lock AND restores the filters', () => {
  // The window runs from the first `cat` write until the hook's own restore
  // trap is armed. Each case fails exactly one step in it and asserts the
  // pair (lock released, filters back to their pre-hook values).
  const failOn = (match: string) =>
    [
      `if [ -n "$INJECT" ] && [ "$*" = ${JSON.stringify(match)} ]; then`,
      '  echo INJECTED >> "$OBS"; exit 1',
      'fi',
    ].join('\n')
  const expectRestored = (dir: string) => {
    expect(existsSync(lockDirOf(dir)), 'lock directory leaked').toBe(false)
    expect(getConfig(dir, 'filter.git-crypt.smudge')).toBe('git-crypt smudge')
    expect(getConfig(dir, 'filter.git-crypt.clean')).toBe('git-crypt clean')
    // R3-M: restoring the filters while leaving a stale marker is a distinct
    // failure (the auto-heal keys on the marker), so pin the marker too.
    expect(getConfig(dir, 'skillsmith.git-crypt-disabled-marker')).toBe('')
  }

  it('failing the CLEAN "cat" write (smudge already disabled) restores both filters', () => {
    const dir = repoWithRealFilters()
    const r = runWithGitShim(
      dir,
      `${FULL_CYCLE}\necho REACHED_END\n`,
      failOn('config --local filter.git-crypt.clean cat'),
      { INJECT: '1' }
    )
    expect(r.obs, 'injection did not fire').toContain('INJECTED')
    expect(r.out).not.toContain('REACHED_END')
    expectRestored(dir)
  })

  it('failing the _worktree_b64 step (both filters disabled, no marker yet) restores both filters', () => {
    const dir = repoWithRealFilters()
    // The substitution is `printf | base64 | tr`: a pipeline's status is its
    // LAST command's, so failing base64 aborts nothing (measured: that variant
    // reached REACHED_END). Fail `tr`, the command whose status decides.
    const shimDir = join(dir, '.shim-bin')
    mkdirSync(shimDir, { recursive: true })
    writeFileSync(join(shimDir, 'tr'), '#!/bin/sh\necho INJECTED >> "$OBS"\nexit 1\n')
    chmodSync(join(shimDir, 'tr'), 0o755)
    const r = runWithGitShim(dir, `${FULL_CYCLE}\necho REACHED_END\n`, ':')
    expect(r.obs, 'injection did not fire').toContain('INJECTED')
    expect(r.out).not.toContain('REACHED_END')
    expectRestored(dir)
  })

  it('failing the marker write (both filters disabled) restores both filters', () => {
    const dir = repoWithRealFilters()
    const r = runWithGitShim(
      dir,
      `${FULL_CYCLE}\necho REACHED_END\n`,
      [
        'case "$*" in',
        '  "config --local skillsmith.git-crypt-disabled-marker "*)',
        '    if [ -n "$INJECT" ]; then echo INJECTED >> "$OBS"; exit 1; fi ;;',
        'esac',
      ].join('\n'),
      { INJECT: '1' }
    )
    expect(r.obs, 'injection did not fire').toContain('INJECTED')
    expect(r.out).not.toContain('REACHED_END')
    expectRestored(dir)
  })
})

describe('SMI-6973 F6: a failed lock removal keeps the flag so the EXIT trap retries', () => {
  it('a failing rm leaves GIT_CRYPT_LOCK_HELD set, and a later successful release clears it', () => {
    const dir = makeRepo()
    const stubDir = join(dir, 'stub-bin')
    mkdirSync(stubDir, { recursive: true })
    writeFileSync(
      join(stubDir, 'rm'),
      '#!/bin/sh\nif [ -n "$FAIL_RM" ]; then echo RM_FAILED >> "$OBS"; exit 1; fi\nexec /bin/rm "$@"\n'
    )
    chmodSync(join(stubDir, 'rm'), 0o755)
    const script = [
      PRELUDE,
      '_acquire_git_crypt_lock',
      'FAIL_RM=1; export FAIL_RM',
      // R4: a failed removal is NON-zero (and would abort under -e).
      '_release_git_crypt_lock || echo "RELEASE_RC=$?"',
      'echo "HELD_AFTER_FAILED_RM=[$GIT_CRYPT_LOCK_HELD] SELF=[$$]"',
      '[ -d "$GIT_CRYPT_LOCK_DIR" ] && echo DIR_PRESENT || echo DIR_GONE',
      'unset FAIL_RM',
      '_release_git_crypt_lock',
      'echo "HELD_AFTER_RETRY=[$GIT_CRYPT_LOCK_HELD]"',
      '[ -d "$GIT_CRYPT_LOCK_DIR" ] && echo DIR_PRESENT_2 || echo DIR_GONE_2',
    ].join('\n')
    const r = runWithGitShim(dir, script, ':', { PATH: `${stubDir}:${GIT_ENV.PATH ?? ''}` })
    expect(r.obs, 'rm stub did not fire').toContain('RM_FAILED')
    expect(r.out).toContain('RELEASE_RC=1')
    // Round 4: HELD names the acquiring shell, so "still held" means "equals $$".
    const held = r.out.match(/HELD_AFTER_FAILED_RM=\[(\d*)\] SELF=\[(\d+)\]/)
    expect(held, `output: ${r.out}`).not.toBeNull()
    expect(held?.[1], `output: ${r.out}`).toBe(held?.[2])
    expect(r.out).toContain('DIR_PRESENT\n')
    expect(r.out).toContain('HELD_AFTER_RETRY=[]')
    expect(r.out).toContain('DIR_GONE_2')
    expect(r.status).toBe(0)
  })
})

describe('SMI-6973 H2 (round 3): the EXIT trap retries a failed lock removal', () => {
  it('rm fails once, then works: the exit handler removes the lock directory', () => {
    const dir = makeRepo()
    const stubDir = join(dir, 'stub-bin')
    mkdirSync(stubDir, { recursive: true })
    // Fails the FIRST rm only, so the retry has something to succeed at.
    writeFileSync(
      join(stubDir, 'rm'),
      [
        '#!/bin/sh',
        'if [ ! -e "$STUB_DIR/rm-failed-once" ]; then',
        '  : > "$STUB_DIR/rm-failed-once"; echo RM_FAILED >> "$OBS"; exit 1',
        'fi',
        'exec /bin/rm "$@"',
      ].join('\n')
    )
    chmodSync(join(stubDir, 'rm'), 0o755)
    const r = runWithGitShim(dir, `${PRELUDE}_acquire_git_crypt_lock\nexit 0\n`, ':', {
      PATH: `${stubDir}:${GIT_ENV.PATH ?? ''}`,
      STUB_DIR: stubDir,
    })
    expect(r.obs, 'rm stub did not fire').toContain('RM_FAILED')
    expect(r.out).toContain('could not remove the git-crypt filter lock')
    expect(existsSync(lockDirOf(dir)), 'EXIT trap did not retry the removal').toBe(false)
  })
})

describe('SMI-6973 F3 (round 3): a TERM during the marker write restores promptly', () => {
  it('a TERM landing during the marker write restores the filters, releases the lock and exits 143 within 5s', () => {
    const dir = repoWithRealFilters()
    const shim = [
      'case "$*" in',
      '  "config --local skillsmith.git-crypt-disabled-marker "*)',
      '    echo SIGNALLED >> "$OBS"; kill -TERM $PPID ;;',
      'esac',
    ].join('\n')
    const started = Date.now()
    const r = runWithGitShim(dir, `${FULL_CYCLE}\necho REACHED_END\n`, shim)
    expect(r.obs, 'signal was not sent').toContain('SIGNALLED')
    // This once also pinned the hook's release-before-trap ORDER: with the
    // trap armed while the lock was held, the restore spun ~10s on its own
    // lock. Since SMI-6973 round 4 acquire reuses a lock this shell holds, so
    // both orders pass (measured, SMI-7059). It now pins the outcome only.
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(r.out).not.toContain('REACHED_END')
    expect(r.status).toBe(143)
    expect(existsSync(lockDirOf(dir))).toBe(false)
    expect(getConfig(dir, 'filter.git-crypt.smudge')).toBe('git-crypt smudge')
    expect(getConfig(dir, 'filter.git-crypt.clean')).toBe('git-crypt clean')
    expect(getConfig(dir, 'skillsmith.git-crypt-disabled-marker')).toBe('')
  })
})

describe('SMI-6973 H1: the marker is written while the lock is held', () => {
  it('observes the lock directory present at the instant the marker is written', () => {
    const dir = repoWithRealFilters()
    const shim = [
      'case "$*" in',
      `  "config --local skillsmith.git-crypt-disabled-marker "*)`,
      `    if [ -d "$(${JSON.stringify(REAL_GIT)} rev-parse --git-common-dir)/skillsmith-git-crypt-filter.lock" ]; then echo MARKER_UNDER_LOCK >> "$OBS"; else echo MARKER_UNLOCKED >> "$OBS"; fi ;;`,
      'esac',
    ].join('\n')
    const r = runWithGitShim(dir, `${FULL_CYCLE}\necho REACHED_END\n`, shim)
    expect(r.out).toContain('REACHED_END')
    // Presence proof (the marker write really happened and was observed), then
    // the property: it was observed under the lock, never outside it.
    expect(r.obs).toContain('MARKER_UNDER_LOCK')
    expect(r.obs).not.toContain('MARKER_UNLOCKED')
  })
})

describe('SMI-6973 H2: release is errexit-safe when the pid file is missing', () => {
  const ACQ = `${PRELUDE}_acquire_git_crypt_lock\n`

  it('empty-owner path runs: the lock is released and the script continues', () => {
    const dir = makeRepo()
    const script = `${ACQ}rm -f "$GIT_CRYPT_LOCK_DIR/pid"\n_release_git_crypt_lock\necho AFTER_RELEASE\n[ -d "$GIT_CRYPT_LOCK_DIR" ] && echo STILL_THERE || echo GONE\n`
    const r = runWithGitShim(dir, script, ':')
    // Presence proof that release ran to completion under -e.
    expect(r.out).toContain('AFTER_RELEASE')
    expect(r.out).toContain('GONE')
    expect(r.out).not.toContain('STILL_THERE')
    expect(r.status).toBe(0)
  })

  it('known-negative: a pid file naming ANOTHER process is still refused', () => {
    const dir = makeRepo()
    const script = `${ACQ}echo 999999 > "$GIT_CRYPT_LOCK_DIR/pid"\n_release_git_crypt_lock\necho AFTER_RELEASE\n[ -d "$GIT_CRYPT_LOCK_DIR" ] && echo STILL_THERE || echo GONE\n`
    const r = runWithGitShim(dir, script, ':')
    expect(r.out).toContain('AFTER_RELEASE')
    expect(r.out).toContain('STILL_THERE')
    rmSync(lockDirOf(dir), { recursive: true, force: true })
  })

  it('busy diagnostic with an unreadable holder pid file still prints and exits 1', () => {
    const dir = makeRepo()
    mkdirSync(lockDirOf(dir)) // held by "someone", no pid file at all
    const r = runWithGitShim(dir, `${PRELUDE}_acquire_git_crypt_lock\necho UNREACHABLE\n`, ':')
    expect(r.out).toMatch(/busy after 10s \(holder PID: unknown\)/)
    expect(r.out).not.toContain('UNREACHABLE')
    expect(r.status).toBe(1)
    expect(existsSync(lockDirOf(dir))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// R4 (final round): no cleanup step's failure is reported as success, and the
// lock-releasing traps stay armed until release is CONFIRMED.
// ---------------------------------------------------------------------------
const EXPLICIT = extractSpan('explicit-restore')

/** `rm` stub: fails every call while $SHIM_DIR/failrm exists (persistent), or just the next one if failrm-once exists. */
function rmStubPath(dir: string): Record<string, string> {
  const stubDir = join(dir, 'stub-bin')
  mkdirSync(stubDir, { recursive: true })
  writeFileSync(
    join(stubDir, 'rm'),
    [
      '#!/bin/sh',
      'if [ -e "$SHIM_DIR/failrm" ]; then echo RM_FAILED >> "$OBS"; exit 1; fi',
      'if [ -e "$SHIM_DIR/failrm-once" ]; then',
      '  /bin/rm -f "$SHIM_DIR/failrm-once"; echo RM_FAILED >> "$OBS"; exit 1',
      'fi',
      'exec /bin/rm "$@"',
    ].join('\n')
  )
  chmodSync(join(stubDir, 'rm'), 0o755)
  return { PATH: `${stubDir}:${GIT_ENV.PATH ?? ''}` }
}
const MANUAL_REMEDY = /rmdir "[^"]*skillsmith-git-crypt-filter\.lock"/
const count = (hay: string, needle: string) => hay.split(needle).length - 1
const PERSIST = ': > "$SHIM_DIR/failrm"'
const ONCE = ': > "$SHIM_DIR/failrm-once"'

describe('R4 H-a: a failed marker clear is a failed restore', () => {
  const FAIL_UNSET = [
    'if [ "$*" = "config --local --unset skillsmith.git-crypt-disabled-marker" ]; then',
    '  echo UNSET_FAILED >> "$OBS"; exit 4',
    'fi',
  ].join('\n')

  it('exit 4 from the marker unset makes restore return non-zero, print the remedy, and still release the lock', () => {
    const dir = repoWithRealFilters()
    const r = runWithGitShim(
      dir,
      `${FULL_CYCLE}\n_restore_smudge_filter || echo "RESTORE_RC=$?"\nexit 0\n`,
      FAIL_UNSET
    )
    expect(r.obs, 'injection did not fire').toContain('UNSET_FAILED')
    expect(r.out).toContain('RESTORE_RC=1')
    expect(r.out).toMatch(
      /failed to restore git-crypt filter config; run: \.\/scripts\/worktree-crypt\.sh fix/i
    )
    expect(existsSync(lockDirOf(dir)), 'lock leaked').toBe(false)
    expect(getConfig(dir, 'skillsmith.git-crypt-disabled-marker')).not.toBe('')
    expect(r.status).not.toBe(0)
  })

  it('known-negative: an ABSENT marker (git exit 5) is success, not failure', () => {
    const dir = repoWithRealFilters()
    const r = runWithGitShim(
      dir,
      `${FULL_CYCLE}\n_restore_smudge_filter\n_clear_git_crypt_marker\necho "CLEAR_RC=$?"\n`,
      ':'
    )
    expect(r.out).toContain('CLEAR_RC=0')
    expect(r.out).not.toMatch(/failed to restore/i)
    expect(r.status).toBe(0)
  })
})

describe('R4 H-b: a failed lock removal is never reported as success', () => {
  it('explicit call: restore fails, the traps stay armed, and the hook still ends non-zero with the remedy', () => {
    const dir = repoWithRealFilters()
    const script = [
      FULL_CYCLE,
      PERSIST,
      'RESTORE_EXIT=0',
      EXPLICIT,
      'echo "RESTORE_EXIT=$RESTORE_EXIT"',
      'trap',
      'echo REACHED_END',
    ].join('\n')
    const started = Date.now()
    const r = runWithGitShim(dir, script, ':', rmStubPath(dir))
    expect(r.obs, 'rm stub did not fire').toContain('RM_FAILED')
    expect(r.out).toContain('RESTORE_EXIT=1')
    expect(r.out).toMatch(MANUAL_REMEDY)
    // The traps were NOT dropped: the lock library's EXIT handler is still armed...
    expect(r.out).toMatch(/trap -- '_git_crypt_lock_on_exit' EXIT/)
    // ...and at exit it retried (more attempts than the explicit call alone made).
    expect(count(r.obs, 'RM_FAILED')).toBeGreaterThan(2)
    expect(r.status).not.toBe(0)
    expect(Date.now() - started).toBeLessThan(8_000)
  })

  it('removal failing ONCE: the call honestly reports failure, the kept traps retry at exit and recover (status 0, lock gone)', () => {
    const dir = repoWithRealFilters()
    const script = [
      FULL_CYCLE,
      ONCE,
      'RESTORE_EXIT=0',
      EXPLICIT,
      'echo "RESTORE_EXIT=$RESTORE_EXIT"',
      'trap',
      'echo REACHED_END',
    ].join('\n')
    const r = runWithGitShim(dir, script, ':', rmStubPath(dir))
    expect(r.obs, 'rm stub did not fire').toContain('RM_FAILED')
    expect(r.out).toContain('REACHED_END')
    expect(r.out).toContain('RESTORE_EXIT=1')
    expect(r.out).toMatch(/trap -- '_git_crypt_lock_on_exit' EXIT/)
    expect(r.status).toBe(0)
    expect(existsSync(lockDirOf(dir))).toBe(false)
    expect(getConfig(dir, 'filter.git-crypt.smudge')).toBe('git-crypt smudge')
  })

  it('final EXIT trap: persistent removal failure ends non-zero with the remedy (never a silent 0)', () => {
    const dir = repoWithRealFilters()
    const started = Date.now()
    const r = runWithGitShim(dir, `${FULL_CYCLE}\n${PERSIST}\nexit 0\n`, ':', rmStubPath(dir))
    expect(r.obs, 'rm stub did not fire').toContain('RM_FAILED')
    expect(r.out).toMatch(MANUAL_REMEDY)
    expect(r.status).not.toBe(0)
    expect(Date.now() - started).toBeLessThan(8_000)
  })

  it('final EXIT trap: removal failing ONCE still ends 0 with the lock gone', () => {
    const dir = repoWithRealFilters()
    const r = runWithGitShim(dir, `${FULL_CYCLE}\n${ONCE}\nexit 0\n`, ':', rmStubPath(dir))
    expect(r.obs, 'rm stub did not fire').toContain('RM_FAILED')
    expect(r.status).toBe(0)
    expect(existsSync(lockDirOf(dir))).toBe(false)
  })

  // The lock library's own handler: acquire, name the hook's restore as the
  // outer cleanup, then deliver the signal while removal is failing.
  const signalScript = (sig: string, failure: string) =>
    [
      FULL_CYCLE,
      failure,
      '_acquire_git_crypt_lock',
      'GIT_CRYPT_LOCK_OUTER_TRAP=_restore_smudge_filter',
      `kill -${sig} $$`,
      'echo AFTER_SIGNAL',
    ].join('\n')

  it.each([
    ['INT', 130],
    ['TERM', 143],
  ])('signal %s: persistent removal failure exits %i promptly with the remedy', (sig, code) => {
    const dir = repoWithRealFilters()
    const started = Date.now()
    const r = runWithGitShim(dir, signalScript(sig, PERSIST), ':', rmStubPath(dir))
    expect(r.obs, 'rm stub did not fire').toContain('RM_FAILED')
    expect(r.out).toMatch(MANUAL_REMEDY)
    expect(r.out).not.toContain('AFTER_SIGNAL')
    expect(r.status).toBe(code)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('signal (M): removal failing ONCE — the chained restore reuses the held lock instead of spinning, exits 143 within 5s, lock gone', () => {
    const dir = repoWithRealFilters()
    const started = Date.now()
    const r = runWithGitShim(dir, signalScript('TERM', ONCE), ':', rmStubPath(dir))
    expect(r.obs, 'rm stub did not fire').toContain('RM_FAILED')
    expect(r.out).not.toContain('AFTER_SIGNAL')
    expect(r.status).toBe(143)
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(existsSync(lockDirOf(dir))).toBe(false)
    expect(getConfig(dir, 'filter.git-crypt.smudge')).toBe('git-crypt smudge')
    expect(getConfig(dir, 'skillsmith.git-crypt-disabled-marker')).toBe('')
  })
})

describe('SMI-6973 F7: INT/TERM after the hook arms its restore trap ends the hook (never swallowed)', () => {
  // Stand-in for the hook's checkout + explicit-restore + success message,
  // with the signal delivered from the git shim DURING `git checkout`.
  const hookTail = [
    'RESTORE_EXIT=0',
    'git checkout main || RESTORE_EXIT=$?',
    EXPLICIT,
    'echo SUCCESS_MESSAGE',
  ].join('\n')
  const shim = (sig: string) =>
    'if [ "$1" = checkout ]; then echo SIGNALLED >> "$OBS"; kill -' + sig + ' $PPID; fi'

  it.each([
    ['INT', 130],
    ['TERM', 143],
  ])(
    'signal %s during checkout: restores filters, releases the lock, exits %i, no success message',
    (sig, code) => {
      const dir = repoWithRealFilters()
      const r = runWithGitShim(dir, `${FULL_CYCLE}\n${hookTail}\n`, shim(sig))
      expect(r.obs, 'signal was not sent').toContain('SIGNALLED')
      expect(r.out).not.toContain('SUCCESS_MESSAGE')
      expect(r.status).toBe(code)
      expect(existsSync(lockDirOf(dir)), 'lock directory leaked').toBe(false)
      expect(getConfig(dir, 'filter.git-crypt.smudge')).toBe('git-crypt smudge')
      expect(getConfig(dir, 'filter.git-crypt.clean')).toBe('git-crypt clean')
      expect(getConfig(dir, 'skillsmith.git-crypt-disabled-marker')).toBe('')
    }
  )

  it('control: no signal reaches the success message with status 0', () => {
    const dir = repoWithRealFilters()
    const r = runWithGitShim(dir, `${FULL_CYCLE}\n${hookTail}\n`, ':')
    expect(r.out).toContain('SUCCESS_MESSAGE')
    expect(r.status).toBe(0)
  })
})

describe("SMI-6973 F8: a failed lock removal in the hook's disable sequence does not abort it before the restore trap is armed", () => {
  it('rm failing at the post-disable release: the hook proceeds (REACHED_END) with the restore trap armed, and still ends non-zero with the remedy', () => {
    const dir = repoWithRealFilters()
    const r = runWithGitShim(
      dir,
      `${PERSIST}\n${FULL_CYCLE}\necho REACHED_END\n`,
      ':',
      rmStubPath(dir)
    )
    expect(r.obs, 'rm stub did not fire').toContain('RM_FAILED')
    expect(r.out).toContain('REACHED_END')
    expect(r.out).toMatch(MANUAL_REMEDY)
    expect(r.status).not.toBe(0)
  })
})

describe('SMI-6973 F8: a failed lock removal on the config-read-error path still prints the explanation', () => {
  const failRead = [
    'if [ "$*" = "config --local filter.git-crypt.smudge" ]; then',
    '  echo READ_FAILED >> "$OBS"; exit 128',
    'fi',
  ].join('\n')

  it('rm failing while _read_git_crypt_cfg refuses: the "cannot read" explanation is printed and the hook exits 1', () => {
    const dir = repoWithRealFilters()
    const script = `${PRELUDE}_acquire_git_crypt_lock\n${PERSIST}\n_read_git_crypt_cfg SMUDGE_CMD filter.git-crypt.smudge\necho REACHED_END\n`
    // rmStubPath replaces PATH, so re-prepend the git shim dir ahead of it.
    const rm = rmStubPath(dir)
    const r = runWithGitShim(dir, script, failRead, {
      PATH: `${join(dir, '.shim-bin')}:${rm.PATH}`,
    })
    expect(r.obs, 'read injection did not fire').toContain('READ_FAILED')
    expect(r.obs, 'rm stub did not fire').toContain('RM_FAILED')
    expect(r.out).toContain('cannot read filter.git-crypt.smudge (git config exit 128)')
    expect(r.out).not.toContain('REACHED_END')
    expect(r.status).toBe(1)
  })
})

describe('SMI-6973 round 4 (high): HELD proves ownership only when it names this shell', () => {
  // A foreign holder caught in its own mkdir-to-pid-write window: the lock
  // directory exists and no pid file has been written yet.
  const foreignEmptyLock = (dir: string) => mkdirSync(lockDirOf(dir))

  it('an inherited HELD does not let release remove a foreign lock with an empty pid file', () => {
    const dir = makeRepo()
    foreignEmptyLock(dir)
    const script = [
      PRELUDE,
      'echo "HELD_AFTER_SOURCE=[$GIT_CRYPT_LOCK_HELD]"',
      '_release_git_crypt_lock',
      '[ -d "$GIT_CRYPT_LOCK_DIR" ] && echo FOREIGN_SURVIVES || echo FOREIGN_REMOVED',
    ].join('\n')
    const r = runWithGitShim(dir, script, ':', { GIT_CRYPT_LOCK_HELD: '1' })
    expect(r.out, `output: ${r.out}`).toContain('HELD_AFTER_SOURCE=[]')
    expect(r.out, `output: ${r.out}`).toContain('FOREIGN_SURVIVES')
    expect(r.status).toBe(0)
  })

  it('an inherited HELD does not let acquire adopt a foreign lock: it contends, then takes the lock with its own mkdir', () => {
    const dir = makeRepo()
    foreignEmptyLock(dir)
    // The foreign holder lets go after ~1s; a real acquire must wait for that.
    const script = [
      PRELUDE,
      // The holder marks its release BEFORE rmdir, so an acquire that really
      // waited for it always sees the marker; one that took the lock any other
      // way (adopted it, or removed the foreign directory) does not.
      `( sleep 1; : > ${JSON.stringify(join(dir, '.holder-released'))}; rmdir ${JSON.stringify(lockDirOf(dir))} ) &`,
      '_acquire_git_crypt_lock',
      `[ -e ${JSON.stringify(join(dir, '.holder-released'))} ] && echo ACQUIRED_AFTER_HOLDER || echo ACQUIRED_BEFORE_HOLDER`,
      'echo "PID_FILE=[$(cat "$GIT_CRYPT_LOCK_DIR/pid" 2>/dev/null)] SELF=[$$]"',
      'wait',
      '_release_git_crypt_lock',
    ].join('\n')
    const r = runWithGitShim(dir, script, ':', { GIT_CRYPT_LOCK_HELD: '1' })
    expect(r.out, `output: ${r.out}`).toContain('ACQUIRED_AFTER_HOLDER')
    const m = r.out.match(/PID_FILE=\[(\d*)\] SELF=\[(\d+)\]/)
    expect(m, `output: ${r.out}`).not.toBeNull()
    expect(m?.[1], `output: ${r.out}`).toBe(m?.[2])
    expect(r.status, `output: ${r.out}`).toBe(0)
    expect(existsSync(lockDirOf(dir))).toBe(false)
  })

  it('control: sourcing the library twice in the same shell keeps live ownership', () => {
    const dir = makeRepo()
    const script = [
      PRELUDE,
      '_acquire_git_crypt_lock',
      `. ${JSON.stringify(LOCK_LIB)}`,
      '[ -n "$GIT_CRYPT_LOCK_HELD" ] && echo STILL_HELD || echo LOST',
      '_release_git_crypt_lock',
      '[ -d "$GIT_CRYPT_LOCK_DIR" ] && echo DIR_PRESENT || echo DIR_GONE',
    ].join('\n')
    const r = runWithGitShim(dir, script, ':')
    expect(r.out, `output: ${r.out}`).toContain('STILL_HELD')
    expect(r.out, `output: ${r.out}`).toContain('DIR_GONE')
    expect(r.status).toBe(0)
  })
})

describe('SMI-6973 round 5 (high): an EXPORTED HELD is never trusted, even when it equals $$', () => {
  // `exec` keeps the pid, so a parent can export HELD=<the pid the hook will
  // run as> and hand it over. That value equals $$ in the hook shell without
  // that shell ever running mkdir.
  function execForged(dir: string, childBody: string[]) {
    const child = join(dir, '.child.sh')
    writeFileSync(child, [PRELUDE, ...childBody].join('\n'))
    return runWithGitShim(
      dir,
      [
        'GIT_CRYPT_LOCK_HELD=$$',
        'export GIT_CRYPT_LOCK_HELD',
        `exec ${JSON.stringify(REAL_SH)} -e ${JSON.stringify(child)}`,
      ].join('\n'),
      ':'
    )
  }

  it('exec-forged HELD=$$: release leaves a foreign empty-pid lock alone', () => {
    const dir = makeRepo()
    mkdirSync(lockDirOf(dir))
    const r = execForged(dir, [
      'echo "HELD_AFTER_SOURCE=[$GIT_CRYPT_LOCK_HELD]"',
      '_release_git_crypt_lock',
      '[ -d "$GIT_CRYPT_LOCK_DIR" ] && echo FOREIGN_SURVIVES || echo FOREIGN_REMOVED',
    ])
    expect(r.out, `output: ${r.out}`).toContain('HELD_AFTER_SOURCE=[]')
    expect(r.out, `output: ${r.out}`).toContain('FOREIGN_SURVIVES')
    expect(r.status).toBe(0)
  })

  it('exec-forged HELD=$$: acquire contends for a foreign empty-pid lock, then takes it with its own mkdir', () => {
    const dir = makeRepo()
    mkdirSync(lockDirOf(dir))
    const r = execForged(dir, [
      `( sleep 1; : > ${JSON.stringify(join(dir, '.holder-released'))}; rmdir ${JSON.stringify(lockDirOf(dir))} ) &`,
      '_acquire_git_crypt_lock',
      `[ -e ${JSON.stringify(join(dir, '.holder-released'))} ] && echo ACQUIRED_AFTER_HOLDER || echo ACQUIRED_BEFORE_HOLDER`,
      'echo "PID_FILE=[$(cat "$GIT_CRYPT_LOCK_DIR/pid" 2>/dev/null)] SELF=[$$]"',
      'wait',
      '_release_git_crypt_lock',
    ])
    expect(r.out, `output: ${r.out}`).toContain('ACQUIRED_AFTER_HOLDER')
    const m = r.out.match(/PID_FILE=\[(\d*)\] SELF=\[(\d+)\]/)
    expect(m, `output: ${r.out}`).not.toBeNull()
    expect(m?.[1], `output: ${r.out}`).toBe(m?.[2])
    expect(r.status, `output: ${r.out}`).toBe(0)
    expect(existsSync(lockDirOf(dir))).toBe(false)
  })

  it('an inherited exported HELD loses its export attribute, so our own HELD=$$ stays local: re-sourcing keeps ownership and release removes the lock', () => {
    const dir = makeRepo()
    const script = [
      PRELUDE,
      '_acquire_git_crypt_lock',
      "export -p | grep -Eq '^(export|declare -x) GIT_CRYPT_LOCK_HELD(=|$)' && echo HELD_EXPORTED || echo HELD_LOCAL",
      `. ${JSON.stringify(LOCK_LIB)}`,
      '_release_git_crypt_lock',
      '[ -d "$GIT_CRYPT_LOCK_DIR" ] && echo DIR_PRESENT || echo DIR_GONE',
    ].join('\n')
    // Inherited exported HELD from the environment: the case that must not
    // leave the export attribute behind for our own value to ride on.
    const r = runWithGitShim(dir, script, ':', { GIT_CRYPT_LOCK_HELD: '1' })
    expect(r.out, `output: ${r.out}`).toContain('HELD_LOCAL')
    expect(r.out, `output: ${r.out}`).toContain('DIR_GONE')
    expect(r.status).toBe(0)
  })
})

describe('SMI-6973 round 7: acquisition is EXCLUSIVE, not merely "after the holder left"', () => {
  // A wait-for-absence followed by a non-exclusive `mkdir -p` passes every
  // test that only checks WHEN acquire returned. The difference shows only in
  // the race between seeing the directory absent and creating it, so this
  // stub forces that race: on its FIRST call for the lock path it plays a
  // rival that creates the directory at that exact instant (and lets go ~1s
  // later, marking its release BEFORE rmdir), then hands off to the real
  // mkdir. An exclusive mkdir now fails and must wait for the rival; `-p`
  // succeeds and takes over the rival's lock.
  function rivalMkdirStub(dir: string): Record<string, string> {
    const stubDir = join(dir, 'stub-bin')
    mkdirSync(stubDir, { recursive: true })
    const realMkdir = execFileSync('sh', ['-c', 'command -v mkdir'], { encoding: 'utf8' }).trim()
    writeFileSync(
      join(stubDir, 'mkdir'),
      [
        '#!/bin/sh',
        'for a in "$@"; do last="$a"; done',
        // The library's path comes from `git rev-parse --git-common-dir`,
        // which is relative (.git/...), so match the lock by its name.
        'case "$last" in *skillsmith-git-crypt-filter.lock)',
        '  if [ ! -e "$SHIM_DIR/rival-done" ]; then',
        '    : > "$SHIM_DIR/rival-done"',
        `    ${JSON.stringify(realMkdir)} "$last" && echo RIVAL_IN >> "$OBS"`,
        '    ( sleep 1; : > "$SHIM_DIR/rival-released"; rmdir "$last" ) >/dev/null 2>&1 &',
        '  fi ;;',
        'esac',
        `exec ${JSON.stringify(realMkdir)} "$@"`,
      ].join('\n')
    )
    chmodSync(join(stubDir, 'mkdir'), 0o755)
    return { PATH: `${stubDir}:${GIT_ENV.PATH ?? ''}` }
  }

  it('a rival that creates the lock directory at the instant of our mkdir makes acquire wait for it', () => {
    const dir = makeRepo()
    const env = rivalMkdirStub(dir)
    const released = JSON.stringify(join(dir, '.shim-bin', 'rival-released'))
    const script = [
      PRELUDE,
      '_acquire_git_crypt_lock',
      `[ -e ${released} ] && echo ACQUIRED_AFTER_RIVAL || echo ACQUIRED_BEFORE_RIVAL`,
      'echo "PID_FILE=[$(cat "$GIT_CRYPT_LOCK_DIR/pid" 2>/dev/null)] SELF=[$$]"',
      '_release_git_crypt_lock',
    ].join('\n')
    const r = runWithGitShim(dir, script, ':', env)
    // Presence: the stub really injected the rival, so the race happened.
    expect(r.obs, `output: ${r.out}`).toContain('RIVAL_IN')
    expect(r.out, `output: ${r.out}`).toContain('ACQUIRED_AFTER_RIVAL')
    const m = r.out.match(/PID_FILE=\[(\d*)\] SELF=\[(\d+)\]/)
    expect(m?.[1], `output: ${r.out}`).toBe(m?.[2])
    expect(r.status, `output: ${r.out}`).toBe(0)
    expect(existsSync(lockDirOf(dir))).toBe(false)
  })
})
