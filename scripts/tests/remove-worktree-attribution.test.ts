/**
 * SMI-7089: remove-worktree.sh must never delete, stop or replace Docker resources
 * that belong to a checkout other than the one it is removing.
 *
 * A Compose project name is COMPUTED from a directory basename, so `_foo`, `-foo`
 * and `foo` all resolve to the project `foo`. Every project-scoped Compose call acts
 * on all of the project's resources whichever directory created them. Before any
 * side effect the script now runs lib/worktree-project-attribution.sh (R0, U1-U6)
 * and refuses if it cannot show the project belongs to the worktree alone.
 *
 * Row ids (T1, T7f, ...) are the plan's test-plan ids
 * (docs/internal/implementation/smi-7089-remove-worktree-cleanup-plan.md).
 * Convention: every ABSENCE assertion ("no `down`") has a PRESENCE partner from the
 * same run, because R0 runs first and leaves a `docker info` call in the log: a
 * refusal's log is exactly `['info']`, or `info` plus the reads that preceded it.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { join } from 'path'

import { makeFixtureEnv } from './_lib/git-fixture-env.js'
import {
  addWt,
  makeAttrFixture,
  pathWithoutDocker,
  primeAttribution,
  readRegLog,
  run,
  runRemove,
  setContainers,
  setExit,
  setHook,
  setLabels,
  setResp,
  workdirLabels,
  type AttrFixture,
} from './_lib/worktree-attribution-fixture.js'
import {
  shimGitWorktreeList,
  worktreeListCallCount,
} from './prune-orphaned-docker-volumes.shims.js'
import {
  setVolumeRmExit,
  volumeLabels,
  volumeListResponse,
} from './prune-orphaned-docker-volumes.helpers.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }
  tempDirs.length = 0
})

function mk(prefix: string): AttrFixture {
  const fx = makeAttrFixture(prefix)
  tempDirs.push(fx.tempRoot)
  return fx
}

const listed = (fx: AttrFixture): string =>
  execFileSync('git', ['-C', fx.repoDir, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8',
    env: makeFixtureEnv(),
  })

const text = (r: { stdout: string; stderr: string }): string => r.stdout + r.stderr
const downs = (calls: string[]): string[] => calls.filter((c) => /^compose .*\bdown$/.test(c))
const deletes = (c: string): boolean => /^(rmi|image rm|volume rm|volume remove)\b/.test(c)

/** Wrap `git` so `worktree list --porcelain` prints its real answer TWICE. */
function shimGitDuplicateListing(fx: AttrFixture): void {
  const shim = [
    '#!/usr/bin/env bash',
    'prev=""; is_list=0',
    'for a in "$@"; do',
    '  if [ "$prev" = "worktree" ] && [ "$a" = "list" ]; then is_list=1; fi',
    '  prev="$a"',
    'done',
    'CLEAN_PATH="$(printf %s "$PATH" | tr ":" "\\n" | grep -vxF "$(dirname "$0")" | paste -sd: -)"',
    'if [ "$is_list" = 1 ]; then',
    '  out="$(env PATH="$CLEAN_PATH" git "$@")" || exit $?',
    '  printf "%s\\n\\n%s\\n" "$out" "$out"',
    '  exit 0',
    'fi',
    'exec env PATH="$CLEAN_PATH" git "$@"',
  ].join('\n')
  writeFileSync(join(fx.binDir, 'git'), `${shim}\n`)
  chmodSync(join(fx.binDir, 'git'), 0o755)
}

describe('SMI-7089: attribution refuses a project another checkout shares (U1-U4)', () => {
  it('T1. refuses when a registered worktree resolves to the same project, changing nothing', () => {
    const fx = mk('attr-t1')
    const foo = addWt(fx, 'foo')
    const underscoreFoo = addWt(fx, '_foo')
    primeAttribution(fx, underscoreFoo)

    const r = runRemove(fx, [underscoreFoo, '--force'])

    expect(r.status).toBe(1)
    // The property first: R0 ran and NOTHING else did (no `down`, no pruner), and
    // both worktrees are still registered. The pruner's own liveness check would
    // also refuse this project after the fact, so the exit status alone cannot
    // tell a refusal-before-any-side-effect from a refusal-after-one.
    expect(r.dockerCalls).toEqual(['info'])
    expect(listed(fx)).toContain(`worktree ${foo}\n`)
    expect(listed(fx)).toContain(`worktree ${underscoreFoo}\n`)
    expect(text(r)).toContain(underscoreFoo)
    expect(text(r)).toContain(foo)
    expect(text(r)).toContain('project foo')
  })

  it('T2. a near miss (foo_ beside foo) is NOT a peer: removal proceeds, `down` has no --volumes', () => {
    const fx = mk('attr-t2')
    addWt(fx, 'foo_')
    const foo = addWt(fx, 'foo')
    primeAttribution(fx, foo)

    const r = runRemove(fx, [foo, '--force'])

    expect(r.status).toBe(0)
    expect(r.dockerCalls).toContain('compose --profile dev down')
    expect(r.dockerCalls.some((c) => c.includes('--volumes') || c.includes('--rmi'))).toBe(false)
    expect(text(r)).toContain('Orphan prune scope: foo')
    expect(existsSync(foo)).toBe(false)
  })

  it('T3. refuses when the MAIN checkout resolves to the same project (_Repo vs repo)', () => {
    const fx = mk('attr-t3')
    const wt = addWt(fx, '_Repo')
    primeAttribution(fx, wt)

    const r = runRemove(fx, [wt, '--force'])

    expect(r.status).toBe(1)
    expect(text(r)).toContain('main checkout')
    expect(text(r)).toContain(fx.repoDir)
    expect(r.dockerCalls).toEqual(['info'])
    expect(listed(fx)).toContain(`worktree ${wt}\n`)
  })

  it('T4. refuses when an UNREGISTERED .worktrees directory resolves to the same project', () => {
    const fx = mk('attr-t4')
    const stray = join(fx.repoDir, '.worktrees', 'foo')
    mkdirSync(stray, { recursive: true })
    const wt = addWt(fx, '_foo', { parent: join(fx.repoDir, '.worktrees') })
    primeAttribution(fx, wt)

    const r = runRemove(fx, [wt, '--force'])

    expect(r.status).toBe(1)
    expect(r.dockerCalls).toEqual(['info'])
    expect(existsSync(wt)).toBe(true)
    expect(text(r)).toContain('unregistered .worktrees directory')
    expect(text(r)).toContain(stray)
  })

  it('T5. a `git worktree list` that fails after printing a record refuses (no partial listing)', () => {
    const fx = mk('attr-t5')
    const wt = addWt(fx, 'foo')
    primeAttribution(fx, wt)
    shimGitWorktreeList(fx, 'partial')

    const r = runRemove(fx, [wt, '--force'])

    expect(r.status).toBe(1)
    expect(text(r)).toContain('`git worktree list` failed')
    // Presence: the shim was actually reached, and R0 had run.
    expect(worktreeListCallCount(fx)).toBeGreaterThan(0)
    expect(r.dockerCalls).toEqual(['info'])
    expect(existsSync(wt)).toBe(true)
  })

  it('T6. a path git does not list exactly once is refused (listed zero times)', () => {
    const fx = mk('attr-t6')
    const wt = addWt(fx, 'foo')
    primeAttribution(fx, wt)
    shimGitWorktreeList(fx, 'empty-ok')

    const r = runRemove(fx, [wt, '--force'])

    expect(r.status).toBe(1)
    // Presence: the shim was reached. Then the property: nothing but R0 ran.
    expect(worktreeListCallCount(fx)).toBeGreaterThan(0)
    expect(r.dockerCalls).toEqual(['info'])
    expect(existsSync(wt)).toBe(true)
    expect(text(r)).toContain('not listed exactly once')
  })

  it('T6b. a path listed TWICE is refused too', () => {
    const fx = mk('attr-t6b')
    const wt = addWt(fx, 'foo')
    primeAttribution(fx, wt)
    shimGitDuplicateListing(fx)

    const r = runRemove(fx, [wt, '--force'])

    expect(r.status).toBe(1)
    expect(r.dockerCalls).toEqual(['info'])
    expect(existsSync(wt)).toBe(true)
    expect(text(r)).toContain('not listed exactly once')
  })

  it('T4b. an unregistered DOT-named .worktrees directory (.foo -> project foo) is a peer too', () => {
    const fx = mk('attr-t4b')
    const stray = join(fx.repoDir, '.worktrees', '.foo')
    mkdirSync(stray, { recursive: true })
    const wt = addWt(fx, 'foo', { parent: join(fx.repoDir, '.worktrees') })
    primeAttribution(fx, wt)

    const r = runRemove(fx, [wt, '--force'])

    expect(r.status).toBe(1)
    expect(r.dockerCalls).toEqual(['info'])
    expect(existsSync(wt)).toBe(true)
    expect(text(r)).toContain(stray)
  })

  it('T4c. derive_protected counts a dot-named .worktrees directory as live', () => {
    const fx = mk('attr-t4c')
    mkdirSync(join(fx.repoDir, '.worktrees', '.foo'), { recursive: true })
    const scripts = join(fx.repoDir, 'scripts')

    const out = execFileSync(
      'bash',
      [
        '-c',
        `source "${scripts}/_lib.sh"; source "${scripts}/lib/worktree-lifecycle.sh"; derive_protected "" "${fx.repoDir}"`,
      ],
      { encoding: 'utf8', env: makeFixtureEnv() }
    )

    expect(out.split('\n')).toContain('foo')
  })

  it('T4d. a .worktrees directory whose name contains a NEWLINE is one entry, and a peer', () => {
    const fx = mk('attr-t4d')
    // `fo\no` sanitizes to `foo` (Compose drops the newline), so it shares the project.
    const stray = join(fx.repoDir, '.worktrees', 'fo\no')
    mkdirSync(stray, { recursive: true })
    const wt = addWt(fx, 'foo', { parent: join(fx.repoDir, '.worktrees') })
    primeAttribution(fx, wt)

    const r = runRemove(fx, [wt, '--force'])

    expect(r.status).toBe(1)
    expect(r.dockerCalls).toEqual(['info'])
    expect(existsSync(wt)).toBe(true)
    expect(text(r)).toContain('unregistered .worktrees directory')
    // The peer list is printed line by line, so the message shows the name up to
    // its newline; the refusal itself (above) is what matters.
    expect(text(r)).toContain(join(fx.repoDir, '.worktrees', 'fo'))
  })

  it('T16b. a directory name that sanitizes to nothing is refused with the way out', () => {
    const fx = mk('attr-t16b')
    const wt = addWt(fx, '___')
    primeAttribution(fx, wt)

    const r = runRemove(fx, [wt, '--force'])

    expect(r.status).toBe(1)
    expect(r.dockerCalls).toEqual([])
    expect(existsSync(wt)).toBe(true)
    expect(text(r)).toContain('sanitizes to an empty Compose project name')
    // Under remove-worktree this hint would bypass its own dirty-tree check, so it
    // must send the user to look at the tree FIRST.
    expect(text(r)).toContain(`git -C ${wt} status --porcelain`)
    expect(text(r)).toContain(`git worktree remove --force ${wt}`)
  })

  it('T16. refuses an own non-worktree Compose project (skillsmith-eval-cron)', () => {
    const fx = mk('attr-t16')
    const wt = addWt(fx, 'skillsmith-eval-cron')
    primeAttribution(fx, wt)

    const r = runRemove(fx, [wt, '--force'])

    expect(r.status).toBe(1)
    expect(text(r)).toContain('own non-worktree Compose project')
    expect(r.dockerCalls).toEqual(['info'])
    expect(existsSync(wt)).toBe(true)
  })
})

describe('SMI-7089: every container of the project must point at this worktree (U5, U6)', () => {
  const foreignDir = (fx: AttrFixture): string => {
    const d = join(fx.tempRoot, 'someone-elses-checkout')
    mkdirSync(d, { recursive: true })
    return d
  }
  const inspects = (calls: string[], id: string): boolean =>
    calls.includes(`inspect --type container ${id} --format {{json .Config.Labels}}`)

  it('T7. a container created from another existing directory refuses, naming it', () => {
    const fx = mk('attr-t7')
    const wt = addWt(fx, 'foo')
    primeAttribution(fx, wt)
    const other = foreignDir(fx)
    setContainers(fx, { running: ['c1'] })
    setLabels(fx, 'c1', workdirLabels(other))

    const r = runRemove(fx, [wt, '--force'])

    expect(r.status).toBe(1)
    expect(text(r)).toContain('c1')
    expect(text(r)).toContain(other)
    expect(r.dockerCalls).toContain('info')
    expect(r.dockerCalls).toContain('ps -aq --filter label=com.docker.compose.project=foo')
    expect(inspects(r.dockerCalls, 'c1')).toBe(true)
    expect(downs(r.dockerCalls)).toEqual([])
    expect(existsSync(wt)).toBe(true)
  })

  it('T7b. working_dir naming this worktree through a symlink is the SAME file: removal proceeds', () => {
    const fx = mk('attr-t7b')
    const wt = addWt(fx, 'foo')
    primeAttribution(fx, wt)
    const link = join(fx.tempRoot, 'link-to-foo')
    symlinkSync(wt, link)
    setContainers(fx, { running: ['c1'] })
    setLabels(fx, 'c1', workdirLabels(link))

    const r = runRemove(fx, [wt, '--force'])

    expect(r.status).toBe(0)
    expect(inspects(r.dockerCalls, 'c1')).toBe(true)
    expect(downs(r.dockerCalls)).toEqual(['compose --profile dev down'])
    expect(existsSync(wt)).toBe(false)
  })

  it.each([
    ['<no value>', workdirLabels('<no value>'), 'no readable'],
    ['a deleted directory', workdirLabels('/nonexistent/sk7089-gone'), 'no longer exists'],
    ['a null label map', 'null', 'no readable'],
    ['an unparseable label map', '{not json', 'no readable'],
  ])('T7c. working_dir that is %s is refused, never treated as ours', (_name, labels, needle) => {
    const fx = mk('attr-t7c')
    const wt = addWt(fx, 'foo')
    primeAttribution(fx, wt)
    setContainers(fx, { running: ['c1'] })
    setLabels(fx, 'c1', labels)

    const r = runRemove(fx, [wt, '--force'])

    expect(r.status).toBe(1)
    expect(text(r)).toContain(needle)
    expect(text(r)).toContain('c1')
    expect(inspects(r.dockerCalls, 'c1')).toBe(true)
    expect(downs(r.dockerCalls)).toEqual([])
  })

  it('T7d. the FIRST container is ours but the SECOND is foreign: refused, both inspected', () => {
    const fx = mk('attr-t7d')
    const wt = addWt(fx, 'foo')
    primeAttribution(fx, wt)
    setContainers(fx, { running: ['c1', 'c2'] })
    setLabels(fx, 'c1', workdirLabels(wt))
    setLabels(fx, 'c2', workdirLabels(foreignDir(fx)))

    const r = runRemove(fx, [wt, '--force'])

    expect(r.status).toBe(1)
    expect(text(r)).toContain('c2')
    expect(inspects(r.dockerCalls, 'c1')).toBe(true)
    expect(inspects(r.dockerCalls, 'c2')).toBe(true)
    expect(downs(r.dockerCalls)).toEqual([])
  })

  it('T7f. a STOPPED foreign container is seen: `ps -a`, not `ps`', () => {
    const fx = mk('attr-t7f')
    const wt = addWt(fx, 'foo')
    primeAttribution(fx, wt)
    setContainers(fx, { running: ['c1'], stopped: ['c2'] })
    setLabels(fx, 'c1', workdirLabels(wt))
    setLabels(fx, 'c2', workdirLabels(foreignDir(fx)))

    const r = runRemove(fx, [wt, '--force'])

    expect(r.status).toBe(1)
    expect(text(r)).toContain('c2')
    // Presence partners: X's running container was inspected and passed, and the
    // stopped one was inspected too.
    expect(inspects(r.dockerCalls, 'c1')).toBe(true)
    expect(inspects(r.dockerCalls, 'c2')).toBe(true)
    expect(r.dockerCalls).toContain('ps -aq --filter label=com.docker.compose.project=foo')
    expect(downs(r.dockerCalls)).toEqual([])
  })

  it('T7e. (characterises E4) a label naming this PATH passes even if an earlier occupant wrote it', () => {
    const fx = mk('attr-t7e')
    const wt = addWt(fx, 'foo')
    // The earlier occupant of this exact path left a container behind, then the
    // directory was replaced by a new worktree at the same path.
    const stale = workdirLabels(wt)
    execFileSync('git', ['-C', fx.repoDir, 'worktree', 'remove', '--force', wt], {
      env: makeFixtureEnv(),
    })
    const reborn = addWt(fx, 'foo')
    expect(reborn).toBe(wt)
    primeAttribution(fx, wt)
    setContainers(fx, { running: ['c1'] })
    setLabels(fx, 'c1', stale)

    const r = runRemove(fx, [wt, '--force'])

    // A path label cannot prove which incarnation created a container (ADR-180 E4);
    // this row flips to a refusal when a per-checkout identity label lands (SMI-7096).
    expect(r.status).toBe(0)
    expect(downs(r.dockerCalls)).toEqual(['compose --profile dev down'])
  })

  it('T8. an unreadable container listing refuses (a failed `ps` is not an empty one)', () => {
    const fx = mk('attr-t8')
    const wt = addWt(fx, 'foo')
    primeAttribution(fx, wt)
    setExit(fx, 'ps', 1)

    const r = runRemove(fx, [wt, '--force'])

    expect(r.status).toBe(1)
    expect(text(r)).toContain('could not list the containers')
    expect(r.dockerCalls).toContain('info')
    expect(r.dockerCalls).toContain('ps -aq --filter label=com.docker.compose.project=foo')
    expect(downs(r.dockerCalls)).toEqual([])
    expect(existsSync(wt)).toBe(true)
  })

  it('T8b. Compose resolving a different project name than the directory refuses', () => {
    const fx = mk('attr-t8b')
    const wt = addWt(fx, 'foo')
    primeAttribution(fx, wt, 'something-else')

    const r = runRemove(fx, [wt, '--force'])

    expect(r.status).toBe(1)
    expect(text(r)).toContain("resolves the project 'something-else'")
    expect(r.dockerCalls).toContain('compose config --format json')
    expect(r.dockerCalls.some((c) => c.startsWith('ps '))).toBe(false)
    expect(downs(r.dockerCalls)).toEqual([])
  })

  it('T8c. an unreadable Compose configuration refuses', () => {
    const fx = mk('attr-t8c')
    const wt = addWt(fx, 'foo')
    primeAttribution(fx, wt)
    setExit(fx, 'compose_config', 1)

    const r = runRemove(fx, [wt, '--force'])

    expect(r.status).toBe(1)
    expect(text(r)).toContain('could not read the Compose configuration')
    expect(r.dockerCalls).toContain('compose config --format json')
    expect(downs(r.dockerCalls)).toEqual([])
  })
})

describe('SMI-7089: ordering, deletes and failure reporting', () => {
  it('T9. the dirty-tree refusal happens BEFORE any Docker side effect', () => {
    const fx = mk('attr-t9')
    const wt = addWt(fx, 'foo')
    primeAttribution(fx, wt)
    writeFileSync(join(wt, 'README.md'), 'edited\n')

    const r = runRemove(fx, [wt])

    expect(r.status).toBe(1)
    expect(text(r)).toContain('uncommitted change')
    // Presence: attribution ran (R0), so the absence of `down` is not "docker never ran".
    expect(r.dockerCalls).toContain('info')
    expect(downs(r.dockerCalls)).toEqual([])
    expect(r.dockerCalls.some(deletes)).toBe(false)
    expect(existsSync(wt)).toBe(true)
  })

  it('T10. every volume/image delete happens with the worktree already deregistered', () => {
    const fx = mk('attr-t10')
    const wt = addWt(fx, 'foo')
    primeAttribution(fx, wt)
    const vol = 'foo_website-vercel-output'
    volumeListResponse(fx, [vol])
    volumeLabels(fx, vol, { volume: 'website-vercel-output', project: 'foo', owned: 'true' })
    const reg = (): string[] => readRegLog(fx)

    const r = runRemove(fx, [wt, '--force'])

    expect(r.status).toBe(0)
    const rm = reg().filter((l) => /^(rmi|volume rm)\b/.test(l))
    // Presence: a delete DID happen, so "every delete saw it unregistered" is not vacuous.
    expect(rm.length).toBeGreaterThan(0)
    expect(rm.every((l) => l.endsWith('registered=no'))).toBe(true)
    // And the control that the probe can see the other state: the stop ran, and
    // it ran while the worktree was still registered.
    const stop = reg().find((l) => l.startsWith('compose') && l.includes('down'))
    expect(stop).toBeDefined()
    expect(stop).toMatch(/registered=yes$/)
  })

  it('T13. a creator racing the stop is refused: the removed worktree is still registered', () => {
    const fx = mk('attr-t13')
    const wt = addWt(fx, 'foobar')
    primeAttribution(fx, wt)
    const hookRc = join(fx.tempRoot, 'hook.rc')
    const hookErr = join(fx.tempRoot, 'hook.err')
    const hookList = join(fx.tempRoot, 'hook.list')
    // Fires on the FIRST effect-phase docker call, whatever it is, so the test
    // does not depend on `down` still running.
    setHook(
      fx,
      'effect',
      [
        'set +e',
        `cd "${fx.repoDir}"`,
        `source "${join(__dirname, '..', 'create-worktree.sh')}"`,
        'USE_EXISTING_BRANCH=false',
        `( add_worktree_git_entry "${fx.repoDir}/.worktrees/foo.bar" feat-dup HEAD ) 2> "${hookErr}" && rc=0 || rc=$?`,
        `echo $rc > "${hookRc}"`,
        `git -C "${fx.repoDir}" worktree list > "${hookList}"`,
      ].join('\n')
    )

    const r = runRemove(fx, [wt, '--force'])

    // The property first: the racing creator was REFUSED because the worktree
    // being removed was still registered when the hook fired.
    expect(existsSync(hookRc)).toBe(true)
    expect(readFileSync(hookRc, 'utf8').trim()).toBe('1')
    expect(readFileSync(hookErr, 'utf8')).toContain('already used by a live worktree')
    expect(readFileSync(hookList, 'utf8')).not.toContain('foo.bar')
    expect(readFileSync(hookList, 'utf8')).toContain('foobar')
    // Then that the effect phase it interrupted was the stop itself.
    expect(readFileSync(join(fx.responsesDir, 'hook.trigger'), 'utf8')).toContain('down')
    expect(downs(r.dockerCalls)).toEqual(['compose --profile dev down'])
    // Last: a creator that got in would make the pruner refuse the project later,
    // so the exit status follows from the property rather than proving it.
    expect(r.status).toBe(0)
  })

  it('T14. --keep-docker still runs attribution: a collision refuses', () => {
    const fx = mk('attr-t14')
    addWt(fx, 'foo')
    const wt = addWt(fx, '_foo')
    primeAttribution(fx, wt)

    const r = runRemove(fx, [wt, '--force', '--keep-docker'])

    expect(r.status).toBe(1)
    expect(r.dockerCalls).toEqual(['info'])
    expect(existsSync(wt)).toBe(true)
  })

  it('T14b. --keep-docker without a collision: `down` runs, the pruner never does', () => {
    const fx = mk('attr-t14b')
    const wt = addWt(fx, 'foo')
    primeAttribution(fx, wt)

    const r = runRemove(fx, [wt, '--force', '--keep-docker'])

    expect(r.status).toBe(0)
    expect(downs(r.dockerCalls)).toEqual(['compose --profile dev down'])
    expect(r.dockerCalls.some((c) => c.startsWith('volume ls'))).toBe(false)
    expect(r.dockerCalls.some(deletes)).toBe(false)
  })

  it('T15. a pruner that fails AFTER the worktree is removed exits 1 and prints the re-run command', () => {
    const fx = mk('attr-t15')
    const wt = addWt(fx, 'foo')
    primeAttribution(fx, wt)
    const vol = 'foo_website-vercel-output'
    volumeListResponse(fx, [vol])
    volumeLabels(fx, vol, { volume: 'website-vercel-output', project: 'foo', owned: 'true' })
    setVolumeRmExit(fx, vol, 1)

    const r = runRemove(fx, [wt, '--force'])

    expect(r.status).toBe(1)
    expect(text(r)).toContain('Worktree removed; Docker cleanup incomplete')
    expect(text(r)).toContain('prune-orphaned-docker-volumes.sh --only-project foo')
    // Presence: the delete was attempted, and the worktree really is gone.
    expect(r.dockerCalls).toContain(`volume rm ${vol}`)
    expect(existsSync(wt)).toBe(false)
    expect(listed(fx)).not.toContain(wt)
  })

  it('T15b. with docker not installed the worktree is still removed, and Docker is not touched', () => {
    const fx = mk('attr-t15b')
    const wt = addWt(fx, 'foo')
    primeAttribution(fx, wt)

    const r = run(fx, 'remove-worktree.sh', [wt, '--force'], {}, pathWithoutDocker(fx))

    expect(r.status).toBe(0)
    expect(text(r)).toContain('Docker is absent')
    expect(text(r)).toContain('no Docker resources were touched')
    // Presence: the removal really happened; absence: the recording shim was never reached.
    expect(existsSync(wt)).toBe(false)
    expect(listed(fx)).not.toContain(wt)
    expect(r.dockerCalls).toEqual([])
    // A missing binary is a different state from an unreachable daemon: still a success.
    expect(text(r)).not.toContain('cleanup incomplete')
    expect(text(r)).toContain('Worktree removal complete!')
  })

  it('T15d. an unreachable daemon: the worktree is removed, but the run ends incomplete (exit 1) with the re-run command', () => {
    const fx = mk('attr-t15d')
    const wt = addWt(fx, 'foo')
    primeAttribution(fx, wt)
    setExit(fx, 'info', 1)

    const r = runRemove(fx, [wt, '--force'])

    // Presence: R0 ran and nothing but R0 did (no Compose, ps, inspect, volume,
    // image, network or df call).
    expect(r.dockerCalls).toEqual(['info'])
    expect(existsSync(wt)).toBe(false)
    expect(listed(fx)).not.toContain(wt)
    expect(text(r)).toContain('Docker is unreachable')
    expect(text(r)).toContain('Worktree removed; Docker cleanup incomplete')
    expect(text(r)).toContain(
      `${join(fx.repoDir, 'scripts')}/prune-orphaned-docker-volumes.sh --only-project foo`
    )
    expect(text(r)).not.toContain('Worktree removal complete!')
    expect(r.status).toBe(1)
  })

  it.each([
    ['--keep-docker', ['--keep-docker']],
    ['--no-orphan-prune', ['--no-orphan-prune']],
  ])(
    'T15e. an unreachable daemon with %s: the user asked to keep the resources, so exit 0',
    (_n, flags) => {
      const fx = mk('attr-t15e')
      const wt = addWt(fx, 'foo')
      primeAttribution(fx, wt)
      setExit(fx, 'info', 1)

      const r = runRemove(fx, [wt, '--force', ...flags])

      expect(r.dockerCalls).toEqual(['info'])
      expect(existsSync(wt)).toBe(false)
      expect(text(r)).not.toContain('cleanup incomplete')
      expect(text(r)).toContain('Worktree removal complete!')
      expect(r.status).toBe(0)
    }
  )

  it('T17. profiles are discovered: `down` carries each, and never --volumes/--rmi', () => {
    const fx = mk('attr-t17')
    const wt = addWt(fx, 'foo')
    primeAttribution(fx, wt)
    setResp(fx, 'profiles', 'dev\ntest')

    const r = runRemove(fx, [wt, '--force'])

    expect(r.status).toBe(0)
    expect(r.dockerCalls).toContain('compose config --profiles')
    expect(downs(r.dockerCalls)).toEqual(['compose --profile dev --profile test down'])
    expect(r.dockerCalls.some((c) => c.includes('--volumes') || c.includes('--rmi'))).toBe(false)
  })

  it('T17b. a worktree with no Compose files is attributed on git alone: no Compose call is made', () => {
    const fx = mk('attr-t17b')
    const wt = addWt(fx, 'foo', { override: false })
    primeAttribution(fx, wt)

    const r = runRemove(fx, [wt, '--force'])

    expect(r.status).toBe(0)
    expect(r.dockerCalls).toContain('info')
    expect(r.dockerCalls.some((c) => c.startsWith('compose'))).toBe(false)
    expect(existsSync(wt)).toBe(false)
  })
})

describe('SMI-7089: static guarantees', () => {
  const SCRIPTS = join(__dirname, '..')
  const code = (file: string): string =>
    readFileSync(join(SCRIPTS, file), 'utf8')
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n')
  const FORBIDDEN: Array<[string, RegExp]> = [
    ['--volumes', /--volumes/],
    ['--rmi', /--rmi/],
    ['volume rm', /volume rm/],
    ['docker rmi', /docker rmi/],
  ]
  const offences = (src: string): string[] =>
    FORBIDDEN.filter(([, re]) => re.test(src)).map(([name]) => name)

  it('T18. remove-worktree issues no delete of its own: the pruner is its only deleter', () => {
    // Known positive: the scanner does flag a delete when one is present.
    expect(offences('docker volume rm foo_node_modules')).toEqual(['volume rm'])
    expect(offences('docker compose down --volumes --rmi local')).toEqual(['--volumes', '--rmi'])

    expect(offences(code('remove-worktree.sh'))).toEqual([])
    expect(offences(code('lib/remove-worktree-docker.sh'))).toEqual([])
    // Presence: the same read finds the pruner call that replaced them.
    expect(code('remove-worktree.sh')).toContain('--only-project')
  })
})
