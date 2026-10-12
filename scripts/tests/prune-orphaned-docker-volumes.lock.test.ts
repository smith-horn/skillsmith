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
  readFileSync,
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
  setVolumeRmExit,
  imageIdFor,
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
  gitHookRan,
  gitListCount,
  installPerlWrapper,
  startHolder,
  tryAcquire,
  REPLACE_GIT_DIR,
  type Holder,
} from './worktree-lifecycle.helpers.js'
import { shimDockerFailures } from './prune-orphaned-docker-volumes.shims.js'

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
    setDockerHook(f, `ps_ancestor__${imageIdFor(IMG)}`, plainAdd(f, 'feat-t5'))
    const r = runPrune(f, only('gone-wt'))
    expect(hookRan(f, `ps_ancestor__${imageIdFor(IMG)}`)).toBe(true)
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
    // The Docker re-inspect (ps / volume inspect) sits between the identity check
    // and the delete; it is not a git read or an identity check.
    while (calls[prev] === 'PERL bounded' || /^(ps -aq|volume inspect)/.test(calls[prev])) prev--
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

  describe('T21. any failed delete stops the run: the CLI cannot say whether the daemon still acts', () => {
    const accepted = (f: FixtureRepo): string => markerPath(f, 'accepted')

    // Each message is a measured docker CLI output (29.7.2) or empty; all exit 1.
    it.each([
      [
        'transport failure',
        'Cannot connect to the Docker daemon at tcp://127.0.0.1:1. Is the docker daemon running?',
      ],
      [
        'daemon: in use',
        'Error response from daemon: remove gone-wt_node_modules: volume is in use - [abc123]',
      ],
      [
        'daemon: no such volume',
        'Error response from daemon: get gone-wt_node_modules: no such volume',
      ],
      ['daemon: no such image', 'Error response from daemon: No such image: gone-wt-dev:latest'],
      [
        'stale daemon line, then a transport failure',
        'Error response from daemon: stale\nerror during connect: EOF',
      ],
      ['empty output', ''],
    ])('%s: the first delete runs, the second candidate is not deleted', (_name, message) => {
      const f = volumeFixture('lk-t21', [VOL, VOL2])
      setDockerHook(
        f,
        `volume_rm__${VOL}`,
        `echo "request accepted" > "${accepted(f)}"\n${message ? `printf '%s\\n' '${message.replace(/\n/g, "' '")}' >&2` : 'true'}`
      )
      setVolumeRmExit(f, VOL, 1)
      const r = runPrune(f, only('gone-wt'))
      // Presence: the first delete really ran and the request was accepted.
      expect(hookRan(f, `volume_rm__${VOL}`)).toBe(true)
      expect(readFileSync(accepted(f), 'utf8').trim()).toBe('request accepted')
      expect(r.dockerCalls.filter((c) => deletesVol(c, VOL))).toHaveLength(1)
      expect(r.status).toBe(1)
      expect(r.dockerCalls.filter((c) => deletesVol(c, VOL2))).toHaveLength(0)
      expect(r.stderr).toContain('outcome of a failed request is UNKNOWN')
      expect(r.stderr).toContain(`docker volume rm ${VOL} failed (exit 1:`)
      expect(tryAcquire(f.repoDir, 1, {})).toBe(0)
    })

    it('control: with no failure the second candidate IS deleted (the stop is the failure, not the shim)', () => {
      const f = volumeFixture('lk-t21-ok', [VOL, VOL2])
      setDockerHook(f, `volume_rm__${VOL}`, `echo "request accepted" > "${accepted(f)}"`)
      const r = runPrune(f, only('gone-wt'))
      expect(hookRan(f, `volume_rm__${VOL}`)).toBe(true)
      expect(r.dockerCalls.filter((c) => deletesVol(c, VOL))).toHaveLength(1)
      expect(r.dockerCalls.filter((c) => deletesVol(c, VOL2))).toHaveLength(1)
      expect(r.status).toBe(0)
    })
  })

  describe('T22. the Docker gates run inside the section, against the identity recorded at selection', () => {
    const volIncarnation = (f: FixtureRepo): string =>
      join(f.responsesDir, `volume_inspect__${VOL}__incarnation`)
    const ORIGINAL = '2026-10-01T10:00:00Z|node_modules|gone-wt|true'
    const volProbe = `volume inspect ${VOL} --format {{.CreatedAt}}|{{index .Labels "com.docker.compose.volume"}}|{{index .Labels "com.docker.compose.project"}}|{{index .Labels "app.skillsmith.owned"}}`

    /** A volume whose incarnation is rewritten while the section runs (at the in-lock liveness read, git call #2). */
    const replacedVolumeFixture = (name: string, replacement: string): FixtureRepo => {
      const f = volumeFixture(name)
      writeFileSync(volIncarnation(f), `${ORIGINAL}\n`)
      installGitShim(f, { hooks: { 2: `printf '%s\n' '${replacement}' > "${volIncarnation(f)}"` } })
      return f
    }

    it('control: an unchanged volume is deleted, with the incarnation read immediately before', () => {
      const f = replacedVolumeFixture('lk-t22-vol-ok', ORIGINAL)
      const r = runPrune(f, only('gone-wt'))
      const rm = r.dockerCalls.findIndex((c) => deletesVol(c, VOL))
      expect(rm).toBeGreaterThan(0)
      expect(r.dockerCalls[rm - 1]).toBe(volProbe)
      expect(r.dockerCalls.filter((c) => c === volProbe)).toHaveLength(2)
      expect(r.status).toBe(0)
    })

    describe('selection: predicates and identity come from ONE inspect', () => {
      const WRONG_PROJECT = '2026-10-01T10:00:09Z|node_modules|other-proj|true'
      const write = (f: FixtureRepo, line: string): string =>
        `printf '%s\n' '${line}' > "${volIncarnation(f)}"`

      it('control: with no replacement the owned volume is deleted after exactly one selection inspect', () => {
        const f = volumeFixture('lk-t22-sel-ok')
        writeFileSync(volIncarnation(f), `${ORIGINAL}\n`)
        const r = runPrune(f, only('gone-wt'))
        expect(r.dockerCalls.filter((c) => c === volProbe)).toHaveLength(2) // selection + section
        expect(r.dockerCalls.filter((c) => deletesVol(c))).toHaveLength(1)
      })

      it.each([
        [
          'an unowned replacement',
          '2026-10-01T10:00:09Z|node_modules|gone-wt|',
          'UNCONFIRMED ownership',
        ],
        ['a wrong-project replacement', WRONG_PROJECT, ''],
      ])('BEFORE the inspect: %s is judged as itself and is not a candidate', (_n, line, msg) => {
        const f = volumeFixture('lk-t22-sel-before')
        writeFileSync(volIncarnation(f), `${ORIGINAL}\n`)
        setDockerHook(f, `volume_inspect__${VOL}`, write(f, line))
        const r = runPrune(f, only('gone-wt'))
        // Presence: the swap happened before the one selection inspect, which read it.
        expect(hookRan(f, `volume_inspect__${VOL}`)).toBe(true)
        expect(r.dockerCalls.filter((c) => c === volProbe)).toHaveLength(1)
        expect(r.dockerCalls.filter((c) => deletesVol(c))).toHaveLength(0)
        if (msg) expect(r.stdout).toContain(msg)
      })

      it('AFTER the inspect: a wrong-project replacement is caught by the in-lock CreatedAt check', () => {
        const f = volumeFixture('lk-t22-sel-after')
        writeFileSync(volIncarnation(f), `${ORIGINAL}\n`)
        // Fires right after the selection read that carries the project label.
        setDockerHook(f, `volume_after_project_read__${VOL}`, write(f, WRONG_PROJECT))
        const r = runPrune(f, only('gone-wt'))
        expect(hookRan(f, `volume_after_project_read__${VOL}`)).toBe(true)
        expect(r.dockerCalls.filter((c) => c === volProbe)).toHaveLength(2)
        expect(r.dockerCalls.filter((c) => deletesVol(c))).toHaveLength(0)
        expect(r.stdout).toContain('re-created since selection')
      })
    })

    it('a volume replaced by an unowned one under the same name is not deleted', () => {
      const f = replacedVolumeFixture(
        'lk-t22-vol-swap',
        '2026-10-01T10:00:09Z|node_modules|gone-wt|'
      )
      const r = runPrune(f, only('gone-wt'))
      // Presence: the replacement happened (git call #2 ran) and the in-lock
      // re-inspect read it: two incarnation reads, the second one in the section.
      expect(gitHookRan(f, 2)).toBe(true)
      expect(r.dockerCalls.filter((c) => c === volProbe)).toHaveLength(2)
      expect(r.dockerCalls.filter((c) => deletesVol(c))).toHaveLength(0)
      expect(r.stdout).toContain(`SKIPPED volume ${VOL}`)
      expect(r.status).toBe(0)
    })

    it('a volume whose labels are identical but whose CreatedAt changed is not deleted', () => {
      const f = replacedVolumeFixture(
        'lk-t22-vol-marker',
        '2026-10-01T10:00:09Z|node_modules|gone-wt|true'
      )
      const r = runPrune(f, only('gone-wt'))
      expect(gitHookRan(f, 2)).toBe(true)
      expect(r.dockerCalls.filter((c) => c === volProbe)).toHaveLength(2)
      expect(r.dockerCalls.filter((c) => deletesVol(c))).toHaveLength(0)
      expect(r.stdout).toContain('re-created since selection')
    })

    describe('the four-field inspect line is parsed strictly', () => {
      const Z = '2026-10-01T10:00:00Z'
      // [name, line, parses]: `parses` rows are well-formed lines whose labels just do not qualify.
      const ROWS: Array<[string, string, boolean]> = [
        ['a | inside the compose-volume label', `${Z}|node|modules|gone-wt|true`, false],
        ['a | inside the compose-project label', `${Z}|node_modules|gone|wt|true`, false],
        ['a | inside the owned label (value "x|true")', `${Z}|node_modules|gone-wt|x|true`, false],
        ['three fields', `${Z}|node_modules|gone-wt`, false],
        ['five fields', `${Z}|node_modules|gone-wt|true|extra`, false],
        ['an empty CreatedAt', '|node_modules|gone-wt|true', false],
        ['an empty owned label', `${Z}|node_modules|gone-wt|`, true],
      ]

      it.each(ROWS)('at selection, %s proposes nothing and deletes nothing', (_n, line, parses) => {
        const f = volumeFixture('lk-t22-parse-sel')
        writeFileSync(volIncarnation(f), `${line}\n`)
        const r = runPrune(f, only('gone-wt'))
        // Presence: the selection inspect ran (once; the candidate never reached the section).
        expect(r.dockerCalls.filter((c) => c === volProbe)).toHaveLength(1)
        expect(r.dockerCalls.filter((c) => deletesVol(c))).toHaveLength(0)
        if (parses) {
          expect(r.stdout).toContain(`UNCONFIRMED ownership: ${VOL}`)
          expect(r.status).toBe(0)
        } else {
          expect(r.stderr).toContain(`Could not inspect volume ${VOL}`)
          expect(r.status).toBe(1)
        }
      })

      it('a missing label reads as empty: unowned, never deleted (the shim default)', () => {
        const f = volumeFixture('lk-t22-parse-missing')
        rmSync(join(f.responsesDir, `volume_inspect__${VOL}__owned`))
        const r = runPrune(f, only('gone-wt'))
        expect(r.dockerCalls.filter((c) => c === volProbe)).toHaveLength(1)
        expect(r.dockerCalls.filter((c) => deletesVol(c))).toHaveLength(0)
        expect(r.stdout).toContain(`UNCONFIRMED ownership: ${VOL}`)
      })

      it.each(ROWS)('inside the section, %s deletes nothing', (_n, line, parses) => {
        const f = volumeFixture('lk-t22-parse-lock')
        writeFileSync(`${volIncarnation(f)}.seq`, `${ORIGINAL}\n${line}\n`)
        const r = runPrune(f, only('gone-wt'))
        // Presence: selection and the in-lock re-inspect both ran.
        expect(r.dockerCalls.filter((c) => c === volProbe)).toHaveLength(2)
        expect(r.dockerCalls.filter((c) => deletesVol(c))).toHaveLength(0)
        if (parses) {
          // Well-formed but no longer ours (empty owned label, or CreatedAt differs): skipped.
          expect(r.stdout).toContain(`SKIPPED volume ${VOL}`)
          expect(r.status).toBe(0)
        } else {
          expect(r.stderr).toContain(`re-inspecting volume ${VOL}`)
          expect(r.status).toBe(1)
        }
        expect(tryAcquire(f.repoDir, 1, {})).toBe(0)
      })
    })

    it.each([
      ['an inspect that fails', 'FAIL'],
      ['unparseable inspect output', 'garbage'],
    ])('%s inside the section stops the run, deletes nothing and frees the lock', (_n, mode) => {
      const f = volumeFixture('lk-t22-vol-inspect', [VOL, VOL2])
      writeFileSync(volIncarnation(f), `${ORIGINAL}\n`)
      if (mode === 'garbage') {
        // candidate-time read is fine; the in-lock read returns junk
        writeFileSync(`${volIncarnation(f)}.seq`, `${ORIGINAL}\nnot-an-inspect-line\n`)
      }
      if (mode === 'FAIL') {
        // the 2nd incarnation read (in the section) exits nonzero
        shimDockerFailures(f, [
          { glob: `volume inspect ${VOL} *CreatedAt*`, stderr: 'i/o timeout', passFirst: 1 },
        ])
      }
      const r = runPrune(f, only('gone-wt'))
      // Presence: both reads ran, so the second (in-lock) one stopped the run.
      expect(r.dockerCalls.filter((c) => c === volProbe)).toHaveLength(2)
      expect(r.status).toBe(1)
      expect(r.stderr).toContain(`re-inspecting volume ${VOL}`)
      expect(r.dockerCalls.filter((c) => deletesVol(c))).toHaveLength(0)
      expect(tryAcquire(f.repoDir, 1, {})).toBe(0)
    })

    describe('every Docker call inside the section is bounded', () => {
      // The hook sleeps far past the 2 s timeout, standing in for a hung CLI.
      const HANG = 'sleep 12'
      const rows: Array<[string, (f: FixtureRepo) => string, string]> = [
        [
          'volume inspect',
          (f) => {
            setDockerHook(f, `volume_inspect_n__${VOL}__2`, HANG)
            return `volume_inspect_n__${VOL}__2`
          },
          `re-inspecting volume ${VOL} under the worktree lifecycle lock timed out after 2s`,
        ],
        [
          'attachment `docker ps`',
          (f) => {
            setDockerHook(f, `ps_n__ps_volume__${VOL}__2`, HANG)
            return `ps_n__ps_volume__${VOL}__2`
          },
          `checking containers on volume ${VOL} under the worktree lifecycle lock timed out after 2s`,
        ],
      ]

      it.each(rows)('a hung %s releases the lock and stops the run', (_n, arm, message) => {
        const f = volumeFixture('lk-t22-bound')
        writeFileSync(volIncarnation(f), `${ORIGINAL}\n`)
        const hook = arm(f)
        const t0 = Date.now()
        const r = runPrune(f, only('gone-wt'), { SKILLSMITH_ORPHAN_PRUNE_RM_TIMEOUT: '2' })
        const elapsed = Date.now() - t0
        // Presence: the in-lock call was reached and hung.
        expect(hookRan(f, hook)).toBe(true)
        expect(elapsed).toBeLessThan(8_000)
        expect(r.dockerCalls.filter((c) => deletesVol(c))).toHaveLength(0)
        expect(r.status).toBe(1)
        expect(r.stderr).toContain(message)
        expect(tryAcquire(f.repoDir, 1, {})).toBe(0)
      })

      it('a hung image ID resolve releases the lock and stops the run', () => {
        const f = imageFixture('lk-t22-bound-img')
        const hook = `image_id_after__${IMG}__2`
        setDockerHook(f, hook, HANG)
        const t0 = Date.now()
        const r = runPrune(f, only('gone-wt'), { SKILLSMITH_ORPHAN_PRUNE_RM_TIMEOUT: '2' })
        const elapsed = Date.now() - t0
        expect(hookRan(f, hook)).toBe(true)
        expect(elapsed).toBeLessThan(8_000)
        expect(r.dockerCalls.filter((c) => deletesImg(c))).toHaveLength(0)
        expect(r.status).toBe(1)
        expect(r.stderr).toContain(
          `re-resolving image ${IMG} under the worktree lifecycle lock timed out after 2s`
        )
        expect(tryAcquire(f.repoDir, 1, {})).toBe(0)
      })

      it('control: with fast calls and the same timeout the volume is deleted', () => {
        const f = volumeFixture('lk-t22-bound-ok')
        writeFileSync(volIncarnation(f), `${ORIGINAL}\n`)
        const r = runPrune(f, only('gone-wt'), { SKILLSMITH_ORPHAN_PRUNE_RM_TIMEOUT: '2' })
        expect(r.dockerCalls.filter((c) => c === volProbe)).toHaveLength(2)
        expect(r.dockerCalls.filter((c) => deletesVol(c))).toHaveLength(1)
        expect(r.status).toBe(0)
      })
    })

    describe('images', () => {
      const OLD_ID = imageIdFor(IMG)
      const NEW_ID = imageIdFor('someone-elses-image')
      const idFile = (f: FixtureRepo): string => join(f.responsesDir, `image_inspect__${IMG}__id`)
      const rewriteTag = (f: FixtureRepo): string => `printf '%s\n' '${NEW_ID}' > "${idFile(f)}"`

      it('control: an unchanged image is deleted BY ID, never by tag', () => {
        const f = imageFixture('lk-t22-img-ok')
        const r = runPrune(f, only('gone-wt'))
        expect(r.dockerCalls.filter((c) => deletesImg(c))).toEqual([`rmi ${OLD_ID}`])
        expect(r.status).toBe(0)
      })

      const labelReads = (calls: string[], who: string): string[] =>
        calls.filter(
          (c) =>
            c.startsWith(`image inspect ${who} --format {{index .Config.Labels`) ||
            c.startsWith(`image inspect ${who} --format {{json .Config.Labels`)
        )

      it('a tag retargeted right after the first ID resolution: every predicate is read by ID', () => {
        const f = imageFixture('lk-t22-img-sel')
        setDockerHook(f, `image_id_after__${IMG}__1`, rewriteTag(f))
        const r = runPrune(f, only('gone-wt'))
        // Presence: the retarget fired after selection's resolution, and the
        // predicates (the one JSON label read at selection, ownership in the
        // section) ran.
        expect(hookRan(f, `image_id_after__${IMG}__1`)).toBe(true)
        expect(labelReads(r.dockerCalls, OLD_ID).length).toBeGreaterThanOrEqual(2)
        // The predicates were evaluated on the resolved ID, never on the tag.
        expect(labelReads(r.dockerCalls, IMG)).toHaveLength(0)
        // And nothing outside the selected ID is deleted (the tag moved: skipped).
        expect(r.dockerCalls.filter((c) => deletesImg(c))).toHaveLength(0)
        expect(r.dockerCalls.some((c) => c.includes(NEW_ID) && deletesImg(c))).toBe(false)
        expect(r.stdout).toContain(`SKIPPED image ${IMG}`)
      })

      it('an image referenced by several tags: docker refuses the delete, the run stops, nothing else is tried', () => {
        const f = imageFixture('lk-t22-img-multi')
        shimDockerFailures(f, [
          {
            glob: `rmi ${OLD_ID}`,
            stderr:
              'Error response from daemon: conflict: unable to delete 210d3be062ba (must be forced) - image is referenced in multiple repositories',
          },
        ])
        const r = runPrune(f, only('gone-wt'))
        // Presence: the by-ID delete was attempted exactly once, and only that.
        expect(r.dockerCalls.filter((c) => deletesImg(c))).toEqual([`rmi ${OLD_ID}`])
        expect(r.status).toBe(1)
        expect(r.stderr).toContain(`docker rmi ${OLD_ID} failed (exit 1:`)
        expect(r.stderr).toContain('multiple repositories')
        expect(r.stderr).toContain('outcome of a failed request is UNKNOWN')
        expect(tryAcquire(f.repoDir, 1, {})).toBe(0)
      })

      it('a tag retargeted to another image before the section is not deleted', () => {
        const f = imageFixture('lk-t22-img-retarget')
        installGitShim(f, { hooks: { 2: rewriteTag(f) } })
        const r = runPrune(f, only('gone-wt'))
        // Presence: retargeted at the in-lock liveness read, and the tag was
        // re-resolved afterwards (scan + section = two `.Id` reads).
        expect(gitHookRan(f, 2)).toBe(true)
        expect(
          r.dockerCalls.filter((c) => c === `image inspect ${IMG} --format {{.Id}}`)
        ).toHaveLength(2)
        expect(r.dockerCalls.filter((c) => deletesImg(c))).toHaveLength(0)
        expect(r.stdout).toContain(`SKIPPED image ${IMG}`)
        expect(r.stdout).toContain(NEW_ID)
      })

      it('a tag retargeted AFTER the section checks still deletes only the selected ID', () => {
        const f = imageFixture('lk-t22-img-late')
        // Fires after the section's tag resolution (the 2nd `.Id` read) has answered.
        setDockerHook(f, `image_id_after__${IMG}__2`, rewriteTag(f))
        const r = runPrune(f, only('gone-wt'))
        expect(hookRan(f, `image_id_after__${IMG}__2`)).toBe(true)
        // Never the tag (which now means someone else's image) nor the new ID.
        expect(r.dockerCalls.filter((c) => deletesImg(c))).toEqual([`rmi ${OLD_ID}`])
        expect(r.dockerCalls.some((c) => c.includes(NEW_ID))).toBe(false)
      })
    })
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
