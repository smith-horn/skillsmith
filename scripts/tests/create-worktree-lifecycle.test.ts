/**
 * SMI-6981: create-worktree.sh registers a worktree under the worktree lifecycle
 * lock (add_worktree_git_entry), refuses a live-project collision, and confirms
 * the orphan pruner can see what it created.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'

import { makeFixtureEnv, makeFixtureTempDir } from './_lib/git-fixture-env.js'
import {
  libPrelude,
  startHolder,
  tryAcquire,
  installPerlWrapper,
  setDockerHook,
  hookRan,
  marker,
  markerPath,
  REPLACE_GIT_DIR,
  type Holder,
} from './worktree-lifecycle.helpers.js'
import {
  setupFixture,
  volumeListResponse,
  volumeLabels,
  runPrune,
  type FixtureRepo,
} from './prune-orphaned-docker-volumes.helpers.js'

const SCRIPTS = resolve(__dirname, '..')
const CREATE = join(SCRIPTS, 'create-worktree.sh')
const REAL_BASH = execFileSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim()

interface Fx {
  root: string
  clone: string
  bin: string
  log: string
}

const tempDirs: string[] = []
const holders: Holder[] = []

afterEach(() => {
  for (const h of holders) h.release()
  holders.length = 0
  for (const d of tempDirs) if (existsSync(d)) rmSync(d, { recursive: true, force: true })
  tempDirs.length = 0
})

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: makeFixtureEnv(),
  }).trim()
}

function makeFx(prefix: string): Fx {
  const root = makeFixtureTempDir(prefix)
  tempDirs.push(root)
  const env = makeFixtureEnv()
  const remote = join(root, 'remote.git')
  const source = join(root, 'source')
  const clone = join(root, 'clone')
  execFileSync('git', ['init', '--bare', '--quiet', remote], { env })
  execFileSync('git', ['clone', '--quiet', remote, source], { env })
  writeFileSync(join(source, 'README.md'), 'one\n')
  git(source, ['add', 'README.md'])
  git(source, ['commit', '--quiet', '-m', 'initial'])
  git(source, ['push', '--quiet', '-u', 'origin', 'HEAD:main'])
  execFileSync('git', ['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main'], { env })
  execFileSync('git', ['clone', '--quiet', remote, clone], { env })
  // The lock tests' helpers source the libs from the repo they act on.
  mkdirSync(join(clone, 'scripts', 'lib'), { recursive: true })
  for (const f of ['_lib.sh', 'lib/worktree-lifecycle.sh']) {
    writeFileSync(join(clone, 'scripts', f), readFileSync(join(SCRIPTS, f)))
  }
  const bin = join(root, 'bin')
  mkdirSync(bin)
  return { root, clone, bin, log: join(root, 'calls.log') }
}

/** Run add_worktree_git_entry the way base-selection tests do. */
function runAdd(
  fx: Fx,
  args: { existing: boolean; path: string; branch: string; base?: string },
  extraEnv: NodeJS.ProcessEnv = {}
) {
  const script = [
    'set -euo pipefail',
    `source ${JSON.stringify(CREATE)}`,
    'USE_EXISTING_BRANCH="$1"',
    'add_worktree_git_entry "$2" "$3" "$4"',
  ].join('\n')
  return spawnSync(
    REAL_BASH,
    ['-c', script, 'test', String(args.existing), args.path, args.branch, args.base ?? 'HEAD'],
    {
      cwd: fx.clone,
      encoding: 'utf8',
      env: { ...makeFixtureEnv(), PATH: `${fx.bin}:${process.env.PATH ?? ''}`, ...extraEnv },
    }
  )
}

/** A git shim: `body` runs first, then the real git. */
function gitShim(fx: Fx, body: string): void {
  const shim = [
    '#!/usr/bin/env bash',
    'prev=""; sub=""; sub2=""',
    'for a in "$@"; do',
    '  [ "$prev" = worktree ] && sub="$a"',
    '  case "$a" in fetch) sub2=fetch ;; esac',
    '  prev="$a"',
    'done',
    'CLEAN_PATH="$(printf %s "$PATH" | tr ":" "\\n" | grep -vxF "$(dirname "$0")" | paste -sd: -)"',
    'realgit() { env PATH="$CLEAN_PATH" git "$@"; }',
    body,
    'exec env PATH="$CLEAN_PATH" git "$@"',
  ].join('\n')
  writeFileSync(join(fx.bin, 'git'), `${shim}\n`)
  chmodSync(join(fx.bin, 'git'), 0o755)
}

const probeScript = (fx: Fx, markerFile: string): string =>
  [
    libPrelude(fx.clone),
    `worktree_lifecycle_lock_acquire "${fx.clone}" 0 probe`,
    `echo $? > "${markerFile}"`,
  ].join('\n')

const listed = (fx: Fx): string => git(fx.clone, ['worktree', 'list', '--porcelain'])
const branchExists = (fx: Fx, b: string): boolean =>
  spawnSync('git', ['-C', fx.clone, 'show-ref', '--verify', '--quiet', `refs/heads/${b}`])
    .status === 0

describe('SMI-6981: create-worktree.sh under the lifecycle lock', () => {
  it.each([true, false])(
    'T13. both add arms wait on the lock and create nothing when it is busy (existing branch: %s)',
    (existing) => {
      const fx = makeFx('cw-t13')
      git(fx.clone, ['branch', 'feat-existing'])
      const h = startHolder(fx.clone, join(fx.root, 'ready'))
      holders.push(h)
      const wt = join(fx.clone, '.worktrees', 'busy-wt')
      const branch = existing ? 'feat-existing' : 'feat-busy'
      const r = runAdd(
        fx,
        { existing, path: wt, branch },
        { SKILLSMITH_WORKTREE_LIFECYCLE_LOCK_WAIT: '1' }
      )
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('lifecycle lock is busy')
      expect(listed(fx)).not.toContain(wt)
      if (!existing) expect(branchExists(fx, 'feat-busy')).toBe(false)
      // Paired: once the holder is gone the same call succeeds.
      h.release()
      const ok = runAdd(fx, { existing, path: wt, branch })
      expect(ok.status).toBe(0)
      expect(listed(fx)).toContain(wt)
    }
  )

  it('T13. the lock is taken after the fetch, not across it', () => {
    const fx = makeFx('cw-t13-fetch')
    const markerFile = join(fx.root, 'fetch-rc')
    const probe = join(fx.root, 'probe.sh')
    writeFileSync(probe, probeScript(fx, markerFile))
    gitShim(fx, `if [ "$sub2" = fetch ]; then bash "${probe}"; fi`)
    const r = runAdd(fx, {
      existing: false,
      path: join(fx.clone, '.worktrees', 'fetch-wt'),
      branch: 'feat-fetch',
      base: 'main',
    })
    expect(r.status).toBe(0)
    // Presence: the shim's probe ran during the fetch, and the lock was free.
    expect(readFileSync(markerFile, 'utf8').trim()).toBe('0')
  })

  it('T13b. no git hook runs under the lock', () => {
    const fx = makeFx('cw-t13b')
    const hooks = join(fx.root, 'hooks')
    mkdirSync(hooks)
    const markerFile = join(fx.root, 'hook-ran')
    writeFileSync(
      join(hooks, 'reference-transaction'),
      `#!/usr/bin/env bash\n${probeScript(fx, markerFile).replace(/echo \$\? > "([^"]+)"/, 'echo "ran rc=$?" >> "$1"')}\n`
    )
    chmodSync(join(hooks, 'reference-transaction'), 0o755)
    git(fx.clone, ['config', 'core.hooksPath', hooks])
    const r = runAdd(fx, {
      existing: false,
      path: join(fx.clone, '.worktrees', 'hook-wt'),
      branch: 'feat-hook',
    })
    expect(r.status).toBe(0)
    expect(existsSync(markerFile)).toBe(false)
    // Paired presence: the same hook does fire for a plain ref update.
    git(fx.clone, ['update-ref', 'refs/heads/zz-control', 'HEAD'])
    expect(readFileSync(markerFile, 'utf8')).toContain('ran rc=')
  })

  it('T14. the pruner predicate must see the new worktree (stateful wrapper hides it)', () => {
    const fx = makeFx('cw-t14')
    const flag = join(fx.root, 'added')
    gitShim(
      fx,
      [
        'if [ "$sub" = add ]; then realgit "$@"; rc=$?; touch "' + flag + '"; exit $rc; fi',
        'if [ "$sub" = list ] && [ -f "' +
          flag +
          '" ]; then realgit "$@" | sed -e "\\#^worktree .*/ext-wt\\$#,/^\\$/d"; exit 0; fi',
      ].join('\n')
    )
    const wt = join(fx.root, 'ext-wt')
    const r = runAdd(fx, { existing: false, path: wt, branch: 'feat-ext' })
    // Presence: the add happened (flag), so the refusal is about visibility.
    expect(existsSync(flag)).toBe(true)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('cannot see project')
    expect(existsSync(wt)).toBe(true)
  })

  it('T14b. a replaced common dir is announced loudly before release, worktree kept', () => {
    const replaced = makeFx('cw-t14b')
    gitShim(
      replaced,
      `if [ "$sub" = add ]; then realgit "$@"; rc=$?; ${REPLACE_GIT_DIR(replaced.clone)}; exit $rc; fi`
    )
    const wt = join(replaced.clone, '.worktrees', 'swap-wt')
    const r = runAdd(replaced, { existing: false, path: wt, branch: 'feat-swap' })
    expect(r.status).toBe(0)
    expect(r.stderr).toContain('LIFECYCLE LOCK IDENTITY CHANGED')
    expect(existsSync(wt)).toBe(true)

    const control = makeFx('cw-t14b-control')
    const ok = runAdd(control, {
      existing: false,
      path: join(control.clone, '.worktrees', 'swap-wt'),
      branch: 'feat-swap',
    })
    expect(ok.status).toBe(0)
    expect(ok.stderr).not.toContain('LIFECYCLE LOCK IDENTITY CHANGED')
  })

  it('T15. an empty sanitized name is refused before the add', () => {
    const fx = makeFx('cw-t15')
    const wt = join(fx.clone, '.worktrees', '___')
    const r = runAdd(fx, { existing: false, path: wt, branch: 'feat-empty' })
    expect(r.status).toBe(1)
    expect(listed(fx)).not.toContain('___')
    expect(r.stderr).toContain('sanitizes to an empty')
    expect(branchExists(fx, 'feat-empty')).toBe(false)
  })

  it('T15b. D-1: a name sanitizing to a live worktree project is refused', () => {
    const fx = makeFx('cw-t15b')
    const live = runAdd(fx, {
      existing: false,
      path: join(fx.clone, '.worktrees', 'foobar'),
      branch: 'feat-live',
    })
    expect(live.status).toBe(0)
    const dup = join(fx.clone, '.worktrees', 'foo.bar')
    const r = runAdd(fx, { existing: false, path: dup, branch: 'feat-dup' })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("'foobar'")
    expect(listed(fx)).not.toContain(dup)
    expect(branchExists(fx, 'feat-dup')).toBe(false)
    // Paired positive: a name that sanitizes differently is accepted.
    const ok = runAdd(fx, {
      existing: false,
      path: join(fx.clone, '.worktrees', 'foo.baz'),
      branch: 'feat-baz',
    })
    expect(ok.status).toBe(0)
  })

  it('T15d. the D-1 live-set read happens under the lock, not before it', () => {
    const fx = makeFx('cw-t15d')
    installPerlWrapper({ binDir: fx.bin, logPath: fx.log } as FixtureRepo)
    gitShim(fx, `if [ "$sub" = list ]; then echo "GIT worktree-list" >> "${fx.log}"; fi`)
    const live = runAdd(fx, {
      existing: false,
      path: join(fx.clone, '.worktrees', 'foobar'),
      branch: 'feat-live',
    })
    expect(live.status).toBe(0)
    rmSync(fx.log)

    const r = runAdd(fx, {
      existing: false,
      path: join(fx.clone, '.worktrees', 'foo.bar'),
      branch: 'feat-dup',
    })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("'foobar'")
    const calls = readFileSync(fx.log, 'utf8').split('\n').filter(Boolean)
    const firstRead = calls.indexOf('GIT worktree-list')
    const acquire = calls.indexOf('PERL acquire')
    // Presence: the refusal came from a live-set read, and a lock was taken.
    expect(firstRead).toBeGreaterThanOrEqual(0)
    expect(acquire).toBeGreaterThanOrEqual(0)
    expect(acquire).toBeLessThan(firstRead)
  })

  it('T12a. a creator inside a pruner section waits on the lock even with every opt-out set', () => {
    const f = setupFixture('cw-t12a')
    tempDirs.push(f.tempRoot)
    const VOL = 'gone-wt_node_modules'
    volumeListResponse(f, [VOL])
    volumeLabels(f, VOL, { volume: 'node_modules', project: 'gone-wt', owned: 'true' })
    const creator = join(f.tempRoot, 'creator.sh')
    writeFileSync(
      creator,
      [
        'set -uo pipefail',
        `source ${JSON.stringify(CREATE)}`,
        'USE_EXISTING_BRANCH=false',
        `( add_worktree_git_entry "${f.repoDir}/.worktrees/t12a" feat-t12a HEAD ) 2> "${markerPath(f, 'creator-err')}" && rc=0 || rc=$?`,
        `echo $rc > "${markerPath(f, 'creator')}"`,
        'exit $rc',
      ].join('\n')
    )
    setDockerHook(
      f,
      `volume_rm__${VOL}`,
      [
        'export SKILLSMITH_ORPHAN_PRUNE_DISABLE=1 SKILLSMITH_WORKTREE_LIFECYCLE_LOCK_DISABLE=1 SKILLSMITH_WORKTREE_LIFECYCLE_LOCK_WAIT=1',
        `cd "${f.repoDir}"`,
        `bash "${creator}" >/dev/null 2>&1`,
        `git -C "${f.repoDir}" worktree list > "${markerPath(f, 'during')}"`,
      ].join('\n')
    )
    const run = runPrune(f, ['--only-project', 'gone-wt'])
    expect(run.dockerCalls.some((c) => /volume rm\b/.test(c))).toBe(true)
    expect(hookRan(f, `volume_rm__${VOL}`)).toBe(true)
    expect(marker(f, 'creator')).toBe('1')
    const err = readFileSync(markerPath(f, 'creator-err'), 'utf8')
    expect(err).toContain('lifecycle lock is busy')
    expect(err).toContain('create-worktree waited 1s')
    // Presence partner: the listing was taken in the same run (it names the
    // fixture checkout), and it does not contain the creator's path.
    const during = readFileSync(markerPath(f, 'during'), 'utf8')
    expect(during).toContain(f.repoDir)
    expect(during).not.toContain('.worktrees/t12a')
    // Paired positive: outside the section the same creator call succeeds.
    const after = spawnSync('bash', [creator], {
      cwd: f.repoDir,
      encoding: 'utf8',
      env: makeFixtureEnv(),
    })
    expect(after.status).toBe(0)
  })

  it('T8. a lock that does not exclude stops the creator before anything is created', () => {
    const fx = makeFx('cw-t8')
    installPerlWrapper({ binDir: fx.bin, logPath: fx.log } as FixtureRepo, { fakeAcquire: true })
    const wt = join(fx.clone, '.worktrees', 'probe-wt')
    const r = runAdd(fx, { existing: false, path: wt, branch: 'feat-probe' })
    expect(readFileSync(fx.log, 'utf8')).toContain('PERL probe')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('does not exclude')
    expect(listed(fx)).not.toContain(wt)
    expect(r.stderr).toContain('bypasses the lock')
  })

  it('T10. perl missing: the creator refuses (control: with perl it creates)', () => {
    const fx = makeFx('cw-t10')
    const control = runAdd(fx, {
      existing: false,
      path: join(fx.clone, '.worktrees', 'ctl-wt'),
      branch: 'feat-ctl',
    })
    expect(control.status).toBe(0)

    const noPerl = join(fx.root, 'noperl')
    mkdirSync(noPerl)
    for (const dir of ['/usr/bin', '/bin']) {
      for (const n of readdirSync(dir)) {
        if (n.startsWith('perl') || existsSync(join(noPerl, n))) continue
        try {
          symlinkSync(join(dir, n), join(noPerl, n))
        } catch {
          /* duplicate */
        }
      }
    }
    const wt = join(fx.clone, '.worktrees', 'np-wt')
    const r = runAdd(fx, { existing: false, path: wt, branch: 'feat-np' }, { PATH: noPerl })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('perl is required')
    expect(listed(fx)).not.toContain(wt)
  })

  it('T3. the lock a creator takes is free again once it has exited', () => {
    const fx = makeFx('cw-t3')
    const r = runAdd(fx, {
      existing: false,
      path: join(fx.clone, '.worktrees', 'rel-wt'),
      branch: 'feat-rel',
    })
    expect(r.status).toBe(0)
    expect(tryAcquire(fx.clone, 0)).toBe(0)
  })
})
