/**
 * SMI-6981: the orphan pruner's per-candidate critical sections under the
 * worktree lifecycle lock (lib/worktree-lifecycle.sh).
 *
 * Interleavings are driven through the docker shim's `hook__<key>` seam
 * (prune-orphaned-docker-volumes.helpers.ts), which runs a script synchronously
 * at a keyed call INSIDE the pruner's own child. Every absence assertion here is
 * paired with the hook's "ran" proof from the same execution.
 */

import { describe, it, expect, afterEach } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { join } from 'path'

import {
  setupFixture,
  imagesResponse,
  imageLabels,
  volumeListResponse,
  volumeLabels,
  runPrune,
  type FixtureRepo,
} from './prune-orphaned-docker-volumes.helpers.js'
import {
  libPrelude,
  setDockerHook,
  hookRan,
  marker,
  markerPath,
  recordAcquire,
  installGitShim,
  gitListCount,
  installPerlWrapper,
  startHolder,
  tryAcquire,
  REPLACE_GIT_DIR,
  type Holder,
} from './worktree-lifecycle.helpers.js'

const VOL = 'gone-wt_node_modules'
const VOL2 = 'gone-wt_native-seed-better-sqlite3'
const IMG = 'gone-wt-dev'
const only = (project: string, ...rest: string[]): string[] => ['--only-project', project, ...rest]
const deletesVol = (c: string, n?: string) => /(^|\s)volume rm\b/.test(c) && (!n || c.includes(n))
const deletesImg = (c: string, n?: string) => /(^|\s)rmi\b/.test(c) && (!n || c.includes(n))

const tempDirs: string[] = []
const holders: Holder[] = []

afterEach(() => {
  for (const h of holders) h.release()
  holders.length = 0
  for (const d of tempDirs) if (existsSync(d)) rmSync(d, { recursive: true, force: true })
  tempDirs.length = 0
})

function volumeFixture(name: string, vols: string[] = [VOL]): FixtureRepo {
  const f = setupFixture(name)
  tempDirs.push(f.tempRoot)
  volumeListResponse(f, vols)
  for (const v of vols) {
    const key = v.includes('native-seed') ? v.slice(v.indexOf('_') + 1) : 'node_modules'
    volumeLabels(f, v, { volume: key, project: 'gone-wt', owned: 'true' })
  }
  return f
}

function imageFixture(name: string): FixtureRepo {
  const f = setupFixture(name)
  tempDirs.push(f.tempRoot)
  imagesResponse(f, [IMG, 'repo-dev'])
  imageLabels(f, IMG, { service: 'dev', owned: 'true' })
  return f
}

/** Registration the way create-worktree.sh does it: under the lock. */
const lockedRegistration = (f: FixtureRepo, marker_: string): string =>
  [
    libPrelude(f.repoDir),
    `worktree_lifecycle_lock_acquire "${f.repoDir}" 5 hook || { echo acq-failed > "${markerPath(f, marker_)}"; exit 1; }`,
    `git -C "${f.repoDir}" worktree add --no-checkout -b feat-hook "${f.repoDir}/.worktrees/gone-wt" 7<&- >/dev/null 2>&1`,
    'rc=$?',
    'worktree_lifecycle_lock_release',
    `[ $rc -eq 0 ] && echo ok > "${markerPath(f, marker_)}"`,
  ].join('\n')

const plainAdd = (f: FixtureRepo, branch: string): string =>
  `git -C "${f.repoDir}" worktree add --no-checkout -b ${branch} "${f.repoDir}/.worktrees/gone-wt" >/dev/null 2>&1`

describe('SMI-6981: pruner delete sections under the lifecycle lock', () => {
  it('T1a. a creator is excluded while a pruner section is open, and gets in afterwards', () => {
    const f = volumeFixture('lk-t1a')
    setDockerHook(f, `volume_rm__${VOL}`, recordAcquire(f, 'contender', 1))
    const r = runPrune(f, only('gone-wt'))
    expect(r.status).toBe(0)
    expect(hookRan(f, `volume_rm__${VOL}`)).toBe(true)
    expect(marker(f, 'contender')).toBe('75')
    expect(r.dockerCalls.some((c) => deletesVol(c, VOL))).toBe(true)
    expect(tryAcquire(f.repoDir, 1, {})).toBe(0)
  })

  it('T1b. a sanctioned registration between sections is seen: LIVE NOW, nothing deleted', () => {
    const f = volumeFixture('lk-t1b')
    installGitShim(f)
    setDockerHook(f, `ps_volume__${VOL}`, lockedRegistration(f, 'reg'))
    const r = runPrune(f, only('gone-wt'))
    expect(hookRan(f, `ps_volume__${VOL}`)).toBe(true)
    expect(marker(f, 'reg')).toBe('ok')
    expect(gitListCount(f)).toBeGreaterThanOrEqual(2)
    expect(r.stdout).toContain('LIVE NOW')
    expect(r.dockerCalls.some((c) => deletesVol(c))).toBe(false)
  })

  it('T2. the pruner fails closed when the lock is busy', () => {
    const f = volumeFixture('lk-t2')
    const h = startHolder(f.repoDir, join(f.tempRoot, 'ready'))
    holders.push(h)
    const r = runPrune(f, only('gone-wt'), { SKILLSMITH_WORKTREE_LIFECYCLE_LOCK_WAIT: '1' })
    expect(r.status).toBe(1)
    // Presence: the run reached the candidate's section.
    expect(r.dockerCalls.some((c) => c.includes(`ps -aq --filter volume=${VOL}`))).toBe(true)
    expect(r.stderr).toContain('lifecycle lock is busy')
    expect(r.stderr).toContain(join(f.repoDir, '.git'))
    expect(r.dockerCalls.some((c) => deletesVol(c) || deletesImg(c))).toBe(false)
  })

  it('T4. a plain `git worktree add` before the in-lock read is caught (volumes)', () => {
    const f = volumeFixture('lk-t4', [VOL, VOL2])
    setDockerHook(f, `ps_volume__${VOL}`, plainAdd(f, 'feat-t4'))
    const r = runPrune(f, only('gone-wt'))
    expect(hookRan(f, `ps_volume__${VOL}`)).toBe(true)
    expect(r.stdout.match(/LIVE NOW/g)?.length).toBe(2)
    expect(r.dockerCalls.some((c) => deletesVol(c))).toBe(false)
  })

  it('T5. a plain `git worktree add` before the in-lock read is caught (images)', () => {
    const f = imageFixture('lk-t5')
    setDockerHook(f, `ps_ancestor__${IMG}`, plainAdd(f, 'feat-t5'))
    const r = runPrune(f, only('gone-wt'))
    expect(hookRan(f, `ps_ancestor__${IMG}`)).toBe(true)
    expect(r.stdout).toContain('LIVE NOW')
    expect(r.dockerCalls.some((c) => deletesImg(c))).toBe(false)
  })

  it('T6. a failing in-lock liveness read fails closed (control: a good read deletes)', () => {
    const control = volumeFixture('lk-t6-control')
    installGitShim(control)
    expect(runPrune(control, only('gone-wt')).dockerCalls.some((c) => deletesVol(c, VOL))).toBe(
      true
    )
    expect(gitListCount(control)).toBe(2)

    const f = volumeFixture('lk-t6')
    installGitShim(f, { failSet: [2] })
    const r = runPrune(f, only('gone-wt'))
    // Presence: the failing call (the in-lock read, #2) happened.
    expect(gitListCount(f)).toBe(2)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('liveness re-read under the worktree lifecycle lock failed')
    expect(r.dockerCalls.some((c) => deletesVol(c))).toBe(false)
  })

  it('T7a. a replaced common directory is detected before the delete', () => {
    const f = volumeFixture('lk-t7a')
    installGitShim(f, {
      hooks: { 2: [REPLACE_GIT_DIR(f.repoDir), recordAcquire(f, 'newcomer', 0)].join('\n') },
    })
    const r = runPrune(f, only('gone-wt'))
    // Presence + why the check exists: a newcomer on the replacement got in.
    expect(marker(f, 'newcomer')).toBe('0')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('identity could not be confirmed (code 72')
    expect(r.dockerCalls.some((c) => deletesVol(c))).toBe(false)
  })

  it('T7c. the identity check is the last operation before the delete', () => {
    const f = volumeFixture('lk-t7c')
    installGitShim(f)
    installPerlWrapper(f)
    const r = runPrune(f, only('gone-wt'))
    const calls = r.dockerCalls
    const rm = calls.findIndex((c) => deletesVol(c, VOL))
    expect(rm).toBeGreaterThan(0)
    let prev = rm - 1
    while (calls[prev] === 'PERL bounded') prev--
    expect(calls[prev]).toBe('PERL same')
    const lastGit = calls
      .map((c, i) => (c.startsWith('GIT ') ? i : -1))
      .filter((i) => i >= 0)
      .pop()
    // The liveness read happens INSIDE the section: after this section's acquire
    // (presence: there is exactly one section, so exactly one acquire) and
    // before the identity check that is the last operation before the delete.
    const acquireIdx = calls.indexOf('PERL acquire')
    expect(calls.filter((c) => c === 'PERL acquire')).toHaveLength(1)
    expect(lastGit).toBeDefined()
    expect(acquireIdx).toBeLessThan(lastGit as number)
    expect(lastGit).toBeLessThan(prev)
  })

  it('T8. a lock that does not exclude (no-op flock) is refused by the self-probe', () => {
    const f = volumeFixture('lk-t8')
    installPerlWrapper(f, { fakeAcquire: true })
    const r = runPrune(f, only('gone-wt'))
    expect(r.dockerCalls).toContain('PERL probe')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('does not exclude')
    expect(r.dockerCalls.some((c) => deletesVol(c))).toBe(false)
  })

  it('T9. an unresolvable common dir fails closed', () => {
    const f = volumeFixture('lk-t9')
    const shim = [
      '#!/usr/bin/env bash',
      'for a in "$@"; do',
      `  if [ "$a" = "--git-common-dir" ]; then echo "GIT common-dir" >> "${f.logPath}"; exit 128; fi`,
      'done',
      'CLEAN_PATH="$(printf %s "$PATH" | tr ":" "\\n" | grep -vxF "$(dirname "$0")" | paste -sd: -)"',
      'exec env PATH="$CLEAN_PATH" git "$@"',
    ].join('\n')
    writeFileSync(join(f.binDir, 'git'), `${shim}\n`)
    chmodSync(join(f.binDir, 'git'), 0o755)
    const r = runPrune(f, only('gone-wt'))
    expect(r.dockerCalls).toContain('GIT common-dir')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('could not resolve or open the git common directory')
    expect(r.dockerCalls.some((c) => deletesVol(c))).toBe(false)
  })

  it('T10. perl absent fails closed (control: with perl it deletes)', () => {
    const control = volumeFixture('lk-t10-control')
    expect(runPrune(control, only('gone-wt')).dockerCalls.some((c) => deletesVol(c))).toBe(true)

    const f = volumeFixture('lk-t10')
    const noPerl = join(f.tempRoot, 'noperl')
    mkdirSync(noPerl)
    for (const dir of ['/usr/bin', '/bin']) {
      for (const n of readdirSync(dir)) {
        if (n.startsWith('perl') || existsSync(join(noPerl, n))) continue
        try {
          symlinkSync(join(dir, n), join(noPerl, n))
        } catch {
          /* duplicate or unreadable entry */
        }
      }
    }
    const r = runPrune(f, only('gone-wt'), { PATH: `${f.binDir}:${noPerl}` })
    // Presence: the run got as far as the candidate's attachment query.
    expect(r.dockerCalls.some((c) => c.includes(`ps -aq --filter volume=${VOL}`))).toBe(true)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('perl is required')
    expect(r.dockerCalls.some((c) => deletesVol(c))).toBe(false)
  })

  it('T11. report-only and --report-containers never take the lock', () => {
    const f = volumeFixture('lk-t11')
    const h = startHolder(f.repoDir, join(f.tempRoot, 'ready'))
    holders.push(h)
    for (const args of [[], ['--report-containers']]) {
      const t0 = Date.now()
      const r = runPrune(f, args, { SKILLSMITH_WORKTREE_LIFECYCLE_LOCK_WAIT: '20' })
      expect(Date.now() - t0).toBeLessThan(3000)
      expect(r.status).toBe(0)
      expect(r.stderr).not.toContain('lifecycle lock')
    }
    // Presence: the report-only run did see the orphan.
    expect(runPrune(f, []).stdout).toContain('REPORT-ONLY orphan')
    // Paired: --only-project in the same state is blocked (T2).
    expect(
      runPrune(f, only('gone-wt'), { SKILLSMITH_WORKTREE_LIFECYCLE_LOCK_WAIT: '1' }).status
    ).toBe(1)
  })

  it('T11b. the lock is not held during candidate construction', () => {
    const f = volumeFixture('lk-t11b')
    setDockerHook(f, `volume_inspect__${VOL}`, recordAcquire(f, 'build', 0))
    setDockerHook(f, `volume_rm__${VOL}`, recordAcquire(f, 'inside', 0))
    runPrune(f, only('gone-wt'))
    expect(marker(f, 'build')).toBe('0')
    expect(marker(f, 'inside')).toBe('75')
  })

  it('T11c. the delete is bounded and the lock is released (control: a fast delete works)', () => {
    const fast = volumeFixture('lk-t11c-control')
    expect(
      runPrune(fast, only('gone-wt'), {
        SKILLSMITH_ORPHAN_PRUNE_RM_TIMEOUT: '60',
      }).dockerCalls.some((c) => deletesVol(c, VOL))
    ).toBe(true)

    const f = volumeFixture('lk-t11c')
    // The hook ignores ALRM and TERM, like the Go docker CLI (measured).
    setDockerHook(f, `volume_rm__${VOL}`, "trap '' ALRM TERM\nsleep 13")
    const t0 = Date.now()
    const r = runPrune(f, only('gone-wt'), { SKILLSMITH_ORPHAN_PRUNE_RM_TIMEOUT: '2' })
    const elapsed = Date.now() - t0
    expect(hookRan(f, `volume_rm__${VOL}`)).toBe(true)
    expect(elapsed).toBeLessThan(8_000)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('outcome is UNKNOWN')
    expect(tryAcquire(f.repoDir, 1, {})).toBe(0)
  })

  it('T12b. SKILLSMITH_ORPHAN_PRUNE_DISABLE=1 deletes nothing', () => {
    const f = volumeFixture('lk-t12b')
    const r = runPrune(f, only('gone-wt'), { SKILLSMITH_ORPHAN_PRUNE_DISABLE: '1' })
    expect(r.stdout).toContain('skipping targeted orphan prune')
    expect(r.status).toBe(0)
    expect(r.dockerCalls).toEqual([])
  })

  it('T17. a delete child cannot inherit the lock', () => {
    const f = volumeFixture('lk-t17')
    setDockerHook(f, `volume_rm__${VOL}`, 'sleep 30 >/dev/null 2>&1 &')
    const r = runPrune(f, only('gone-wt'))
    expect(hookRan(f, `volume_rm__${VOL}`)).toBe(true)
    expect(r.status).toBe(0)
    expect(tryAcquire(f.repoDir, 1, {})).toBe(0)
  })
})
