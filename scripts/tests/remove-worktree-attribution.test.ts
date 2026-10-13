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
 * Convention: every ABSENCE assertion ("no removal") has a PRESENCE partner from the
 * same run, because R0 runs first and leaves a `docker info` call in the log: a
 * refusal's log is exactly `['info']`, or `info` plus the reads that preceded it.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import {
  chmodSync,
  cpSync,
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
  ourContainers,
  pathWithoutDocker,
  primeAttribution,
  readRegLog,
  run,
  runRemove,
  setContainers,
  setExit,
  setHook,
  setLabels,
  setPsSequence,
  setProjectNetworks,
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
// The destructive container/network calls: `rm -f <ids>` and `network rm <id>`.
const removals = (calls: string[]): string[] => calls.filter((c) => /^(rm -f |network rm )/.test(c))
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
    // The property first: R0 ran and NOTHING else did (no removal, no pruner), and
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

  it('T2. a near miss (foo_ beside foo) is NOT a peer: removal proceeds, no project-scoped call', () => {
    const fx = mk('attr-t2')
    addWt(fx, 'foo_')
    const foo = addWt(fx, 'foo')
    primeAttribution(fx, foo)

    const r = runRemove(fx, [foo, '--force'])

    expect(r.status).toBe(0)
    // Presence: the stop phase ran (it listed the project's networks).
    expect(r.dockerCalls).toContain(
      'network ls --filter label=com.docker.compose.project=foo --format {{.ID}}'
    )
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

  it.each([
    ['a trailing `/.`', (wt: string) => `${wt}/.`],
    ['a `/sub/..` hop', (wt: string) => `${wt}/sub/..`],
  ])(
    'T16c. %s resolves to the worktree\u2019s own project (SMI-7111), not an empty name',
    (_n, spell) => {
      const fx = mk('attr-t16c')
      const wt = addWt(fx, 'foo')
      mkdirSync(join(wt, 'sub'))
      primeAttribution(fx, wt)
      ourContainers(fx, wt, ['c1'])

      const r = runRemove(fx, [spell(wt), '--force'])

      expect(r.status).toBe(0)
      expect(text(r)).not.toContain('sanitizes to an empty Compose project name')
      // Presence: project foo was acted on, not merely not-refused.
      expect(removals(r.dockerCalls)).toEqual(['rm -f c1'])
      expect(text(r)).toContain('Orphan prune scope: foo')
      expect(existsSync(wt)).toBe(false)
    }
  )

  it('T16d. `<wt>/sl/..` with sl pointing outside the worktree is refused, not canonicalized to <wt> (SMI-7111)', () => {
    const fx = mk('attr-t16d')
    const wt = addWt(fx, 'foo')
    const outside = join(fx.tempRoot, 'elsewhere', 'inner')
    mkdirSync(outside, { recursive: true })
    symlinkSync(outside, join(wt, 'sl'))
    primeAttribution(fx, wt)
    ourContainers(fx, wt, ['c1'])

    const r = runRemove(fx, [`${wt}/sl/..`, '--force'])

    expect(r.status).toBe(1)
    expect(text(r)).toContain('are not the same directory (a symlink inside the path)')
    expect(text(r)).toContain('Nothing was changed.')
    expect(r.dockerCalls).toEqual([])
    expect(existsSync(wt)).toBe(true)
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
    expect(r.dockerCalls).toContain(
      'ps -aq --no-trunc --filter label=com.docker.compose.project=foo'
    )
    expect(inspects(r.dockerCalls, 'c1')).toBe(true)
    expect(removals(r.dockerCalls)).toEqual([])
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
    expect(removals(r.dockerCalls)).toEqual(['rm -f c1'])
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
    expect(removals(r.dockerCalls)).toEqual([])
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
    expect(removals(r.dockerCalls)).toEqual([])
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
    expect(r.dockerCalls).toContain(
      'ps -aq --no-trunc --filter label=com.docker.compose.project=foo'
    )
    expect(removals(r.dockerCalls)).toEqual([])
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
    expect(removals(r.dockerCalls)).toEqual(['rm -f c1'])
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
    expect(r.dockerCalls).toContain(
      'ps -aq --no-trunc --filter label=com.docker.compose.project=foo'
    )
    expect(removals(r.dockerCalls)).toEqual([])
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
    expect(removals(r.dockerCalls)).toEqual([])
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
    expect(removals(r.dockerCalls)).toEqual([])
  })
})

describe('SMI-7089: ordering, deletes and failure reporting', () => {
  it('T9. the dirty-tree refusal happens BEFORE any Docker side effect', () => {
    const fx = mk('attr-t9')
    const wt = addWt(fx, 'foo')
    primeAttribution(fx, wt)
    writeFileSync(join(wt, 'README.md'), 'edited\n')

    ourContainers(fx, wt)

    const r = runRemove(fx, [wt])

    expect(r.status).toBe(1)
    expect(text(r)).toContain('uncommitted change')
    // The dirty-tree refusal comes BEFORE the attribution check (G: so U6's list is
    // as fresh as possible when the removal acts), hence before even `docker info`:
    // no Docker call of any kind was made, and the worktree is untouched.
    expect(r.dockerCalls).toEqual([])
    expect(existsSync(wt)).toBe(true)
  })

  it('T10. every volume/image delete happens with the worktree already deregistered', () => {
    const fx = mk('attr-t10')
    const wt = addWt(fx, 'foo')
    primeAttribution(fx, wt)
    const vol = 'foo_website-vercel-output'
    volumeListResponse(fx, [vol])
    volumeLabels(fx, vol, { volume: 'website-vercel-output', project: 'foo', owned: 'true' })
    ourContainers(fx, wt)
    const reg = (): string[] => readRegLog(fx)

    const r = runRemove(fx, [wt, '--force'])

    expect(r.status).toBe(0)
    const rm = reg().filter((l) => /^(rmi|volume rm)\b/.test(l))
    // Presence: a delete DID happen, so "every delete saw it unregistered" is not vacuous.
    expect(rm.length).toBeGreaterThan(0)
    expect(rm.every((l) => l.endsWith('registered=no'))).toBe(true)
    // And the control that the probe can see the other state: the stop ran, and
    // it ran while the worktree was still registered.
    const stop = reg().find((l) => l.startsWith('rm -f '))
    expect(stop).toBeDefined()
    expect(stop).toMatch(/registered=yes$/)
  })

  it('T13. a creator racing the stop is refused: the removed worktree is still registered', () => {
    const fx = mk('attr-t13')
    const wt = addWt(fx, 'foobar')
    primeAttribution(fx, wt)
    ourContainers(fx, wt)
    const hookRc = join(fx.tempRoot, 'hook.rc')
    const hookErr = join(fx.tempRoot, 'hook.err')
    const hookList = join(fx.tempRoot, 'hook.list')
    // Fires on the FIRST effect-phase docker call, whatever it is (here the
    // approved `rm -f`), so the test does not depend on one verb still running.
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
    expect(readFileSync(join(fx.responsesDir, 'hook.trigger'), 'utf8')).toContain('rm -f c1')
    expect(removals(r.dockerCalls)).toEqual(['rm -f c1'])
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

  it('T14b. --keep-docker without a collision: the containers go, the pruner never runs', () => {
    const fx = mk('attr-t14b')
    const wt = addWt(fx, 'foo')
    primeAttribution(fx, wt)
    ourContainers(fx, wt)

    const r = runRemove(fx, [wt, '--force', '--keep-docker'])

    expect(r.status).toBe(0)
    expect(removals(r.dockerCalls)).toEqual(['rm -f c1'])
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
    // The project's containers were not stopped either: say so, and how to look.
    expect(text(r)).toContain('containers were NOT stopped or removed')
    expect(text(r)).toContain('docker ps -a --filter label=com.docker.compose.project=foo')
    // No by-name `compose -p P down` fallback.
    expect(r.dockerCalls).toEqual(['info'])
    expect(r.status).toBe(1)
  })

  it.each([
    ['--keep-docker', ['--keep-docker'], {}],
    ['--no-orphan-prune', ['--no-orphan-prune'], {}],
    ['SKILLSMITH_ORPHAN_PRUNE_DISABLE=1', [], { SKILLSMITH_ORPHAN_PRUNE_DISABLE: '1' }],
  ])(
    'T15e. an unreachable daemon with %s: the user asked to keep the resources, so exit 0',
    (_n, flags, env) => {
      const fx = mk('attr-t15e')
      const wt = addWt(fx, 'foo')
      primeAttribution(fx, wt)
      setExit(fx, 'info', 1)

      const r = runRemove(fx, [wt, '--force', ...flags], env)

      expect(r.dockerCalls).toEqual(['info'])
      expect(existsSync(wt)).toBe(false)
      expect(text(r)).not.toContain('cleanup incomplete')
      expect(text(r)).toContain('Worktree removal complete!')
      expect(r.status).toBe(0)
    }
  )

  it('T17. removes exactly the approved ids, then the project networks by id; no `compose down` anywhere', () => {
    const fx = mk('attr-t17')
    const wt = addWt(fx, 'foo')
    primeAttribution(fx, wt)
    ourContainers(fx, wt, ['c1', 'c2'])
    setProjectNetworks(fx, ['n1', 'n2'])

    const r = runRemove(fx, [wt, '--force'])

    expect(r.status).toBe(0)
    expect(removals(r.dockerCalls)).toEqual(['rm -f c1 c2', 'network rm n1', 'network rm n2'])
    expect(r.dockerCalls.some((c) => c.startsWith('compose') && /\bdown\b/.test(c))).toBe(false)
    expect(r.dockerCalls.some((c) => c.includes('--profiles'))).toBe(false)
    expect(r.dockerCalls.some((c) => c.includes('--volumes') || c.includes('--rmi'))).toBe(false)
  })

  it('T17c. a container that appears in a LATER `ps` is not removed: only U6\u2019s ids are', () => {
    const fx = mk('attr-t17c')
    const wt = addWt(fx, 'foo')
    primeAttribution(fx, wt)
    ourContainers(fx, wt, ['c1'])
    // The 1st `ps` (U6) sees c1; any LATER `ps` would also see c9.
    setPsSequence(fx, ['c1', 'c1 c9', 'c1 c9'])

    const r = runRemove(fx, [wt, '--force'])

    expect(r.status).toBe(0)
    // Presence: U6 listed once, and c1 went.
    expect(r.dockerCalls.filter((c) => c.startsWith('ps -aq'))).toHaveLength(1)
    expect(removals(r.dockerCalls)).toEqual(['rm -f c1'])
    expect(r.dockerCalls.some((c) => c.includes('c9'))).toBe(false)
  })

  it('T17d. no approved container -> no `rm` call at all', () => {
    const fx = mk('attr-t17d')
    const wt = addWt(fx, 'foo')
    primeAttribution(fx, wt)

    const r = runRemove(fx, [wt, '--force'])

    expect(r.status).toBe(0)
    // Presence: the stop phase ran (networks were listed).
    expect(r.dockerCalls).toContain(
      'network ls --filter label=com.docker.compose.project=foo --format {{.ID}}'
    )
    expect(r.dockerCalls.some((c) => c.startsWith('rm '))).toBe(false)
  })

  it('T17e. a failed `rm -f` is fatal BEFORE Step 2: the worktree stays registered, exit 1, ids named', () => {
    const fx = mk('attr-t17e')
    const wt = addWt(fx, 'foo')
    primeAttribution(fx, wt)
    ourContainers(fx, wt, ['c1', 'c2'])
    setProjectNetworks(fx, ['n1'])
    setExit(fx, 'rm', 1)

    const r = runRemove(fx, [wt, '--force'])

    expect(r.status).toBe(1)
    // Presence: the rm was attempted; then the run stopped: no network call, no
    // pruner, and the worktree is still on disk and registered.
    expect(r.dockerCalls).toContain('rm -f c1 c2')
    expect(r.dockerCalls.some((c) => c.startsWith('network rm'))).toBe(false)
    expect(r.dockerCalls.some((c) => c.startsWith('volume ls'))).toBe(false)
    expect(existsSync(wt)).toBe(true)
    expect(listed(fx)).toContain(`worktree ${wt}\n`)
    expect(text(r)).toContain('c1 c2')
    expect(text(r)).not.toContain('Worktree removal complete!')
  })

  it('T17f. a symlinked worktree path is refused before any Docker call, naming both paths', () => {
    const fx = mk('attr-t17f')
    const real = addWt(fx, 'fooreal')
    primeAttribution(fx, real)
    const link = join(fx.tempRoot, 'foolink')
    symlinkSync(real, link)

    const r = runRemove(fx, [link, '--force'])

    expect(r.status).toBe(1)
    expect(r.dockerCalls).toEqual([])
    expect(existsSync(real)).toBe(true)
    expect(text(r)).toContain('foolink')
    expect(text(r)).toContain('fooreal')
    expect(text(r)).toContain(`Use the real path: ${real}`)
  })

  it('T17g. SHELLOPTS=physical does not turn a symlinked worktree path into its target (SMI-7111)', () => {
    const fx = mk('attr-t17g')
    const real = addWt(fx, 'fooreal')
    primeAttribution(fx, real)
    const link = join(fx.tempRoot, 'foolink')
    symlinkSync(real, link)

    const r = runRemove(fx, [link, '--force'], { SHELLOPTS: 'physical' })

    expect(r.status).toBe(1)
    expect(r.dockerCalls).toEqual([])
    expect(existsSync(real)).toBe(true)
    expect(text(r)).toContain('foolink')
    expect(text(r)).toContain(`Use the real path: ${real}`)
  })

  it.each([
    ['the repo root', (fx: AttrFixture) => fx.repoDir],
    ['a subdirectory of the repo', (fx: AttrFixture) => join(fx.repoDir, 'scripts')],
  ])('T17h. a repository-relative path works with the cwd at %s (SMI-7111)', (_n, cwdOf) => {
    const fx = mk('attr-t17h')
    mkdirSync(join(fx.repoDir, '.worktrees'), { recursive: true })
    const foo = addWt(fx, 'foo', { parent: join(fx.repoDir, '.worktrees') })
    primeAttribution(fx, foo)
    ourContainers(fx, foo, ['c1'])

    const r = run(
      fx,
      'remove-worktree.sh',
      ['.worktrees/foo', '--force'],
      {},
      undefined,
      undefined,
      cwdOf(fx)
    )

    expect(r.status).toBe(0)
    expect(removals(r.dockerCalls)).toEqual(['rm -f c1'])
    expect(text(r)).toContain('Orphan prune scope: foo')
    expect(existsSync(foo)).toBe(false)
    expect(listed(fx)).not.toContain(`worktree ${foo}\n`)
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

describe('SMI-7089: a copy of the script inside the worktree it would remove', () => {
  const copyScriptsInto = (fx: AttrFixture, wt: string): string => {
    cpSync(join(fx.repoDir, 'scripts'), join(wt, 'scripts'), { recursive: true })
    return join(wt, 'scripts')
  }

  it('T33. is refused before ANY side effect (not even `docker info`), naming the main checkout copy', () => {
    const fx = mk('attr-t31')
    const wt = addWt(fx, 'x')
    primeAttribution(fx, wt)
    const inside = copyScriptsInto(fx, wt)

    const r = run(fx, 'remove-worktree.sh', [wt, '--force'], {}, undefined, inside)

    expect(r.status).toBe(1)
    // The refusal comes before Step 0, so no Docker call of any kind was made.
    expect(r.dockerCalls).toEqual([])
    expect(listed(fx)).toContain(`worktree ${wt}\n`)
    expect(existsSync(wt)).toBe(true)
    expect(text(r)).toContain(`${fx.repoDir}/scripts/remove-worktree.sh ${wt}`)
  })

  it('T33b. a script copy nested deeper inside the worktree is refused too', () => {
    const fx = mk('attr-t31b')
    const wt = addWt(fx, 'x')
    primeAttribution(fx, wt)
    const deep = join(wt, 'tools', 'bin')
    mkdirSync(join(wt, 'tools'), { recursive: true })
    cpSync(join(fx.repoDir, 'scripts'), deep, { recursive: true })

    const r = run(fx, 'remove-worktree.sh', [wt, '--force'], {}, undefined, deep)

    expect(r.status).toBe(1)
    expect(r.dockerCalls).toEqual([])
    expect(existsSync(wt)).toBe(true)
  })

  it('T34. a SIBLING whose name merely starts with the target\u2019s (x2 holds the script, x is removed) is not "inside" it', () => {
    const fx = mk('attr-t32')
    const x = addWt(fx, 'x')
    const x2 = addWt(fx, 'x2')
    primeAttribution(fx, x)
    const inX2 = copyScriptsInto(fx, x2)

    const r = run(fx, 'remove-worktree.sh', [x, '--force'], {}, undefined, inX2)

    // Presence: it ran to completion and removed x; x2 (which holds the script) stays.
    expect(r.dockerCalls).toContain('info')
    expect(existsSync(x)).toBe(false)
    expect(existsSync(x2)).toBe(true)
    expect(text(r)).not.toContain('lives inside the worktree')
    expect(r.status).toBe(0)
  })
})

describe('SMI-7089: the target is identified by FILE identity, not by how its path is spelled', () => {
  // The fixture's temp dir reached through a symlink: the worktree's BASENAME is
  // unchanged (so the symlinked-basename refusal does not fire), but its path string
  // differs from the physical one git prints.
  const viaAlias = (fx: AttrFixture, wt: string): string => {
    const alias = join(fx.tempRoot, 'alias')
    symlinkSync(fx.tempRoot, alias)
    return join(alias, wt.slice(fx.tempRoot.length + 1))
  }

  it('T35. a lone worktree reached through a symlinked parent is found exactly once and removed', () => {
    const fx = mk('attr-t35')
    const foo = addWt(fx, 'foo')
    primeAttribution(fx, foo)
    ourContainers(fx, foo)

    const r = runRemove(fx, [viaAlias(fx, foo), '--force'])

    expect(text(r)).not.toContain('not listed exactly once')
    expect(text(r)).not.toContain('is not unique')
    expect(removals(r.dockerCalls)).toEqual(['rm -f c1'])
    expect(existsSync(foo)).toBe(false)
    expect(r.status).toBe(0)
  })

  it('T35b. through the alias a genuine colliding sibling is still the ONLY peer reported, and nothing is removed', () => {
    const fx = mk('attr-t35b')
    const foo = addWt(fx, 'foo')
    const sibling = addWt(fx, '_foo')
    primeAttribution(fx, foo)
    ourContainers(fx, foo)

    const r = runRemove(fx, [viaAlias(fx, foo), '--force'])

    expect(r.status).toBe(1)
    expect(r.dockerCalls).toEqual(['info'])
    expect(removals(r.dockerCalls)).toEqual([])
    // The sibling is named as a peer; the target itself is not a peer of itself.
    expect(text(r)).toContain(`registered worktree: ${sibling}`)
    expect(text(r)).not.toContain(`registered worktree: ${foo}`)
    expect(text(r)).not.toContain('not listed exactly once')
    expect(existsSync(foo)).toBe(true)
  })

  it('T35c. a .worktrees entry that is just another spelling of the target (symlink) is not a peer', () => {
    const fx = mk('attr-t35c')
    const foo = addWt(fx, 'foo')
    primeAttribution(fx, foo)
    mkdirSync(join(fx.repoDir, '.worktrees'), { recursive: true })
    // `.foo` sanitizes to `foo`: by name it looks like a second foo, by identity it IS foo.
    symlinkSync(foo, join(fx.repoDir, '.worktrees', '.foo'))

    const r = runRemove(fx, [foo, '--force'])

    expect(text(r)).not.toContain('unregistered .worktrees directory')
    expect(existsSync(foo)).toBe(false)
    expect(r.status).toBe(0)
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

  it('T18c. --help states the exit contract for an unreachable daemon and for a missing binary', () => {
    const fx = mk('attr-t18c')
    const r = run(fx, 'remove-worktree.sh', ['--help'])
    const help = r.stdout.replace(/\s+/g, ' ')

    expect(r.status).toBe(0)
    expect(help).toContain('daemon is unreachable and you did not opt out')
    expect(help).toContain('exits 1 with the re-run command')
    expect(help).toContain('A missing docker binary exits 0')
  })

  it('T18b. neither script nor the attribution library issues a project-scoped `compose ... down`', () => {
    const DOWN = /compose[^\n]*\bdown\b/
    // Known positive: the scanner flags the old call.
    expect(DOWN.test('(cd "$d" && docker compose --profile dev down)')).toBe(true)
    for (const f of [
      'remove-worktree.sh',
      'lib/remove-worktree-docker.sh',
      'worktree-docker.sh',
      'lib/worktree-project-attribution.sh',
    ]) {
      expect([f, DOWN.test(code(f))]).toEqual([f, false])
    }
    // Presence: the helper that replaced it is wired into both scripts.
    expect(code('lib/remove-worktree-docker.sh')).toContain('worktree_project_remove_approved')
    expect(code('worktree-docker.sh')).toContain('worktree_project_remove_approved')
  })
})
