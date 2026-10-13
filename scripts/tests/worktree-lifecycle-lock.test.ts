/**
 * SMI-6981: the worktree lifecycle lock primitive (lib/worktree-lifecycle.sh):
 * kernel release, re-entry, the filesystem allow-list, and two static scans.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join, resolve } from 'path'
import { spawnSync } from 'child_process'

import { makeFixtureEnv, makeFixtureTempDir } from './_lib/git-fixture-env.js'
import {
  setupFixture,
  volumeListResponse,
  volumeLabels,
  runPrune,
} from './prune-orphaned-docker-volumes.helpers.js'
import { runLib, startHolder, tryAcquire, type Holder } from './worktree-lifecycle.helpers.js'

const SCRIPTS = resolve(__dirname, '..')
const tempDirs: string[] = []
const holders: Holder[] = []

afterEach(() => {
  for (const h of holders) h.release()
  holders.length = 0
  for (const d of tempDirs) if (existsSync(d)) rmSync(d, { recursive: true, force: true })
  tempDirs.length = 0
})

/** A real git repo under the test temp dir (overlayfs/tmpfs, never /app). */
function makeRepo(prefix: string): { root: string; repo: string } {
  const root = makeFixtureTempDir(prefix)
  tempDirs.push(root)
  const repo = join(root, 'repo')
  const env = makeFixtureEnv()
  spawnSync('git', ['init', '-q', '-b', 'main', repo], { env })
  spawnSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'i'], { env })
  // The libs sit where runLib's prelude expects them.
  mkdirSync(join(repo, 'scripts', 'lib'), { recursive: true })
  for (const f of ['_lib.sh', 'lib/worktree-lifecycle.sh']) {
    writeFileSync(join(repo, 'scripts', f), readFileSync(join(SCRIPTS, f)))
  }
  return { root, repo }
}

describe('SMI-6981: lifecycle lock primitive', () => {
  it('T3. the kernel releases the lock when the holder is killed', () => {
    const { root, repo } = makeRepo('lk-t3')
    const h = startHolder(repo, join(root, 'ready'))
    holders.push(h)
    expect(tryAcquire(repo, 0)).toBe(75)
    h.release()
    expect(tryAcquire(repo, 2)).toBe(0)
  })

  it('T16. a second acquire in one process is refused with code 2; an outsider still gets 75', () => {
    const { repo } = makeRepo('lk-t16')
    const outsider = (label: string): string =>
      `bash -c '${[
        'set -uo pipefail',
        `source "${repo}/scripts/_lib.sh"`,
        `source "${repo}/scripts/lib/worktree-lifecycle.sh"`,
        `echo ${label}_pid=$$`,
        `worktree_lifecycle_lock_acquire "${repo}" 0 out; echo ${label}=$?`,
      ].join('; ')}'`
    // runLib is `bash -c`, and bash 5 execs the LAST command of a -c string in
    // place of the shell. An outsider in that position is the holder's own
    // process image (same PID, inherited fd 7), not a second process, so it
    // must never be last: the holder-side lines below follow it, and the PID
    // and `end` assertions fail if it ever replaces the holder.
    const r = runLib(
      repo,
      [
        'echo holder_pid=$$',
        `worktree_lifecycle_lock_acquire "${repo}" 0 a; echo first=$?`,
        'before="$(stat -L -c %d:%i /proc/$$/fd/7)"',
        `worktree_lifecycle_lock_acquire "${repo}" 0 a; echo second=$?`,
        'after="$(stat -L -c %d:%i /proc/$$/fd/7)"',
        '[ "$before" = "$after" ] && echo same-inode',
        // Forks that inherit fd 7 before the outsider runs.
        'for k in 1 2 3 4 5 6 7 8 9 10; do /bin/true; x="$(stat -L -c %i /proc/$$/fd/7)"; done',
        outsider('outsider'),
        // Presence: an independent open is still refused, so the lock is held
        // (by this process: the outsider has exited).
        'perl -e "$_WTL_PERL_LOCK" -- probe "$WORKTREE_LIFECYCLE_LOCK_PATH" 7<&- </dev/null; echo held_probe=$?',
        'worktree_lifecycle_lock_release',
        outsider('released'),
        'echo end',
      ].join('\n')
    )
    const pid = (name: string): string | undefined =>
      r.stdout.match(new RegExp(`^${name}_pid=(\\d+)$`, 'm'))?.[1]
    expect(pid('holder')).toMatch(/^\d+$/)
    expect(pid('outsider')).toMatch(/^\d+$/)
    expect(pid('outsider')).not.toBe(pid('holder'))
    expect(r.stdout).toContain('first=0')
    expect(r.stdout).toContain('second=2')
    expect(r.stdout).toContain('same-inode')
    expect(r.stdout).toContain('outsider=75')
    expect(r.stdout).toContain('held_probe=0')
    expect(r.stdout).toContain('released=0')
    expect(r.stdout).toMatch(/\nend\n$/)
  })

  describe('T20. the supervisor outlives an interrupt until its child group is gone', () => {
    // The child ignores TERM/INT/HUP, like a CLI mid-delete, so only the KILL
    // after the grace can end it. $D is a scratch dir the child writes its pid to.
    const childCmd = `bash -c "echo \\$\\$ > $D/pid; trap '' TERM INT HUP; exec sleep 8"`
    const waitPid =
      'for _ in $(seq 1 50); do [ -s "$D/pid" ] && break; sleep 0.1; done; CH=$(cat "$D/pid")'
    const group = (name: string, cmd: string): string =>
      `${cmd} && echo ${name}=yes || echo ${name}=no`

    it.each([
      ['INT', 130],
      ['TERM', 143],
      ['HUP', 129],
    ])('%s is forwarded and waited out (exit %i)', (sig, code) => {
      const { repo, root } = makeRepo(`lk-t20-${sig}`)
      const r = runLib(
        repo,
        [
          `export D="${root}"`,
          `perl -e "$_WTL_PERL_BOUNDED" -- 30 ${childCmd} </dev/null &`,
          'SUP=$!',
          waitPid,
          group('alive-before', 'kill -0 -- "-$CH" 2>/dev/null'),
          `kill -s ${sig} $SUP`,
          'wait $SUP; echo rc=$?',
          group('alive-after', 'kill -0 -- "-$CH" 2>/dev/null'),
          'kill -9 -- "-$CH" 2>/dev/null; true',
        ].join('\n')
      )
      // Presence first: the group existed before the signal.
      expect(r.stdout).toContain('alive-before=yes')
      expect(r.stdout).toContain(`rc=${code}`)
      expect(r.stdout).toContain('alive-after=no')
    })

    it('the death of the parent shell takes the child group down, ends the supervisor and frees the lock', () => {
      const { repo, root } = makeRepo('lk-t20-parent')
      const sources = `source "${repo}/scripts/_lib.sh"; source "${repo}/scripts/lib/worktree-lifecycle.sh"`
      // A process is alive unless gone or a zombie (a dead supervisor nobody reaps).
      const alive =
        'alive() { [ -r "/proc/$1/status" ] && ! grep -q "^State:[[:space:]]*Z" "/proc/$1/status"; }'
      const r = runLib(
        repo,
        [
          `export D="${root}"`,
          alive,
          // The parent shell takes the lock, then supervises the delete.
          `bash -c '${sources}; worktree_lifecycle_lock_acquire "${repo}" 0 parent || exit 9; worktree_lifecycle_bounded 30 ${childCmd.replace(/'/g, "'\\''")}; echo done' &`,
          'PB=$!',
          waitPid,
          'SUP=$(cat "/proc/$PB/task/$PB/children" | tr -d " ")',
          group('supervisor-alive-before', 'alive "$SUP"'),
          group('group-alive-before', 'kill -0 -- "-$CH" 2>/dev/null'),
          `bash -c '${sources}; worktree_lifecycle_lock_acquire "${repo}" 0 outsider; echo outsider-while-held=$?; true'`,
          'kill -TERM $PB',
          'for _ in $(seq 1 60); do kill -0 -- "-$CH" 2>/dev/null || break; sleep 0.1; done',
          'for _ in $(seq 1 30); do alive "$SUP" || break; sleep 0.1; done',
          group('group-alive-after', 'kill -0 -- "-$CH" 2>/dev/null'),
          group('supervisor-alive-after', 'alive "$SUP"'),
          'kill -9 -- "-$CH" "$SUP" 2>/dev/null; true',
        ].join('\n')
      )
      // Presence: everything was up before the parent was killed.
      expect(r.stdout).toContain('supervisor-alive-before=yes')
      expect(r.stdout).toContain('group-alive-before=yes')
      expect(r.stdout).toContain('outsider-while-held=75')
      expect(r.stdout).toContain('group-alive-after=no')
      expect(r.stdout).toContain('supervisor-alive-after=no')
      // The kernel released the lock with the parent; nothing else holds it.
      expect(tryAcquire(repo, 2)).toBe(0)
    })
  })

  it('T21. there is no output classification: the lib no longer defines one', () => {
    const { repo } = makeRepo('lk-t21-noclass')
    const r = runLib(
      repo,
      'type worktree_lifecycle_rejected >/dev/null 2>&1 && echo defined || echo absent'
    )
    // Presence partner: the delete function it used to serve is loaded.
    const p = runLib(
      repo,
      'type worktree_lifecycle_delete >/dev/null 2>&1 && echo defined || echo absent'
    )
    expect(p.stdout.trim()).toBe('defined')
    expect(r.stdout.trim()).toBe('absent')
  })

  describe('T10b. filesystem allow-list (Linux branch; Darwin is covered by the host script)', () => {
    const realStat = spawnSync('bash', ['-c', 'command -v stat'], {
      encoding: 'utf8',
    }).stdout.trim()
    const withStatShim = (root: string): string => {
      const bin = join(root, 'statbin')
      mkdirSync(bin, { recursive: true })
      writeFileSync(
        join(bin, 'stat'),
        [
          '#!/bin/sh',
          'if [ "$1" = "-f" ] && [ "$2" = "-c" ] && [ "$3" = "%T" ]; then',
          '  [ -n "${FSTYPE_FAIL:-}" ] && exit 1',
          '  printf "%s\\n" "${FSTYPE:-}"',
          '  exit 0',
          'fi',
          `exec ${realStat} "$@"`,
        ].join('\n') + '\n'
      )
      chmodSync(join(bin, 'stat'), 0o755)
      return bin
    }
    const acquireWith = (env: Record<string, string>) => {
      const { root, repo } = makeRepo('lk-t10b')
      const bin = withStatShim(root)
      return runLib(
        repo,
        `worktree_lifecycle_lock_acquire "${repo}" 0 t; echo rc=$?`,
        env,
        bin
      ).stdout.trim()
    }

    it.each([
      'nfs',
      'nfs4',
      'smbfs',
      'afpfs',
      'fuse',
      'fuseblk',
      'fuse.sshfs',
      'virtiofs',
      '9p',
      'grpcfuse',
      'fakeowner',
      'msdos',
      'ext2/ext3',
      'xfs',
      '',
    ])('rejects %j with code 76', (fstype) => {
      expect(acquireWith({ FSTYPE: fstype })).toBe('rc=76')
    })

    it('rejects a stat that fails', () => {
      expect(acquireWith({ FSTYPE_FAIL: '1' })).toBe('rc=76')
    })

    it.each(['overlayfs', 'tmpfs'])('accepts %j (paired control)', (fstype) => {
      expect(acquireWith({ FSTYPE: fstype })).toBe('rc=0')
    })
  })

  it('T10b. the pruner refuses an unsupported filesystem and deletes nothing', () => {
    const f = setupFixture('lk-t10b-prune')
    tempDirs.push(f.tempRoot)
    volumeListResponse(f, ['gone-wt_node_modules'])
    volumeLabels(f, 'gone-wt_node_modules', {
      volume: 'node_modules',
      project: 'gone-wt',
      owned: 'true',
    })
    const realStat = spawnSync('bash', ['-c', 'command -v stat'], {
      encoding: 'utf8',
    }).stdout.trim()
    writeFileSync(
      join(f.binDir, 'stat'),
      `#!/bin/sh\nif [ "$1" = "-f" ] && [ "$2" = "-c" ]; then echo nfs4; exit 0; fi\nexec ${realStat} "$@"\n`
    )
    chmodSync(join(f.binDir, 'stat'), 0o755)
    const r = runPrune(f, ['--only-project', 'gone-wt'])
    expect(
      r.dockerCalls.some((c) => c.includes('ps -aq --filter volume=gone-wt_node_modules'))
    ).toBe(true)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('does not support')
    expect(r.dockerCalls.some((c) => /volume rm/.test(c))).toBe(false)
  })
})

/** Files a script sources, found by parsing `source`/`.` lines (not a fixed list). */
function sourceClosure(entry: string): string[] {
  const seen = new Set<string>()
  const walk = (file: string): void => {
    if (seen.has(file) || !existsSync(file)) return
    seen.add(file)
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/^\s*(?:source|\.)\s+"\$SCRIPT_DIR\/([^"]+)"/gm)) {
      walk(join(SCRIPTS, m[1]))
    }
  }
  walk(entry)
  return [...seen]
}

const code = (text: string): string =>
  text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n')

describe('SMI-6981: static scans over the source closure', () => {
  const closure = [
    ...new Set([
      ...sourceClosure(join(SCRIPTS, 'prune-orphaned-docker-volumes.sh')),
      ...sourceClosure(join(SCRIPTS, 'create-worktree.sh')),
      // SMI-7089: the attribution library runs on the macOS host's bash 3.2 and
      // must keep fd 7 to the lock. worktree-docker.sh sources it through
      // $WORKTREE_DOCKER_LIB_DIR, which the closure walk does not follow, so it is
      // listed explicitly (with its libraries).
      ...sourceClosure(join(SCRIPTS, 'remove-worktree.sh')),
      join(SCRIPTS, 'worktree-docker.sh'),
      join(SCRIPTS, 'lib', 'worktree-project-attribution.sh'),
    ]),
  ]
  const LIB = join(SCRIPTS, 'lib', 'worktree-lifecycle.sh')

  it('T18a. fd 7 belongs to the lock alone, and no *_FD constant is 7', () => {
    // `7<&-` (closing it for a child) is the one sanctioned use outside the lock.
    const FD7 = /(?:^|[^0-9A-Za-z_])7(?:<(?!&-)|>)|[<>]&7(?![0-9-])|\bexec\s+7/
    const offenders: string[] = []
    let libHits = 0
    let portLockFd8 = false
    for (const file of closure) {
      const lines = code(readFileSync(file, 'utf8')).split('\n')
      lines.forEach((line, i) => {
        if (FD7.test(line)) {
          if (file === LIB) libHits++
          else offenders.push(`${file}:${i + 1}: ${line.trim()}`)
        }
        const fd = line.match(/\b_?[A-Z_]*_FD=(\d+)/)
        if (fd && fd[1] === '7') offenders.push(`${file}:${i + 1}: ${line.trim()}`)
        if (/_WORKTREE_PORT_LOCK_FD=8\b/.test(line)) portLockFd8 = true
      })
    }
    // Known-positive controls: the scanner sees the lock's own fd 7 and the
    // port lock's fd 8 constant, so "no offenders" is not an empty scan.
    expect(closure.map((f) => f.slice(SCRIPTS.length + 1))).toEqual(
      expect.arrayContaining(['_lib.sh', '_rebase-git-crypt.sh', 'lib/worktree-lifecycle.sh'])
    )
    expect(offenders).toEqual([])
    expect(libHits).toBeGreaterThan(0)
    expect(portLockFd8).toBe(true)
  })

  it('T18b. no bash-4-only construct in the closure (macOS ships bash 3.2)', () => {
    const FORBIDDEN: Array<[string, RegExp]> = [
      ['readarray', /\breadarray\b/],
      ['mapfile', /\bmapfile\b/],
      ['local -n', /\blocal\s+-[a-zA-Z]*n\b/],
      ['declare -n', /\bdeclare\s+-[a-zA-Z]*n\b/],
      ['[[ -v', /\[\[\s+-v\b/],
      ['declare -A', /\bdeclare\s+-[a-zA-Z]*A\b/],
      ['case modification', /\$\{[A-Za-z_]\w*(?:,,|\^\^)/],
      ['{fd}> redirect', /(?<!\$)\{[A-Za-z_]\w*\}[<>]/],
      ['coproc', /\bcoproc\b/],
      [';;&', /;;&/],
      [';&', /(?<!;);&/],
      ['&>>', /&>>/],
      ['|&', /\|&/],
      ['wait -n', /\bwait\s+-n\b/],
      ['printf %(..)T', /%\([^)]*\)T/],
      ['negative array subscript', /\$\{\w+\[-\d+\]\}/],
    ]
    const hits: string[] = []
    for (const file of closure) {
      code(readFileSync(file, 'utf8'))
        .split('\n')
        .forEach((line, i) => {
          for (const [name, re] of FORBIDDEN)
            if (re.test(line)) hits.push(`${file}:${i + 1} ${name}`)
        })
    }
    // Positive control: each pattern fires on the sample written for IT (zipped
    // by index, not "some pattern matches"), so a broken pattern cannot hide
    // behind a neighbour.
    const samples = [
      'readarray -t a',
      'mapfile a',
      'local -n r=x',
      'declare -n r=x',
      '[[ -v x ]]',
      'declare -A m',
      '${x,,}',
      'exec {fd}>f',
      'coproc c',
      ';;&',
      ';&',
      'a &>> f',
      'a |& b',
      'wait -n',
      "printf '%(%s)T'",
      '${a[-1]}',
    ]
    expect(samples).toHaveLength(FORBIDDEN.length)
    samples.forEach((sample, i) => {
      expect([FORBIDDEN[i][0], FORBIDDEN[i][1].test(sample)]).toEqual([FORBIDDEN[i][0], true])
    })
    expect(hits).toEqual([])
  })
})
