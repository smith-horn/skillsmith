/**
 * SMI-7089 (OD-6, OD-8): `worktree-docker.sh stop` and `start` run a project-scoped
 * Compose call (the old `down`, and `up`) that acts on EVERY container of the Compose project,
 * whichever directory created it. The project name is computed from the directory
 * basename, so a second directory resolving to the same name loses its container
 * (`stop` removes it, `start` recreates it). Both now run the shared attribution
 * check (lib/worktree-project-attribution.sh) first and refuse, changing nothing,
 * when they cannot show the project belongs to this checkout alone.
 *
 * Row ids (T21-T30) are the plan's. Every refusal row asserts on the shim log, and
 * R0 means a refusal's log always starts with `info`, which is the presence partner
 * for each "no removal / no `up`" assertion.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'

import {
  addWt,
  composeBase,
  composeOverride,
  makeAttrFixture,
  ourContainers,
  primeAttribution,
  runDocker,
  setExit,
  setContainers,
  setExit,
  setLabels,
  setPsSequence,
  workdirLabels,
  type AttrFixture,
} from './_lib/worktree-attribution-fixture.js'
import { shimGitWorktreeList } from './prune-orphaned-docker-volumes.shims.js'

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

/** A worktree with the base Compose file `worktree-docker.sh` requires. */
const wt = (fx: AttrFixture, name: string, parent?: string): string =>
  addWt(fx, name, { base: true, override: false, parent })

const text = (r: { stdout: string; stderr: string }): string => r.stdout + r.stderr
// The destructive container/network calls: `rm -f <ids>` and `network rm <id>`.
const removals = (calls: string[]): string[] => calls.filter((c) => /^(rm -f |network rm )/.test(c))
const ups = (calls: string[]): string[] => calls.filter((c) => /^compose .* up /.test(c))
const inspects = (calls: string[], id: string): boolean =>
  calls.includes(`inspect --type container ${id} --format {{json .Config.Labels}}`)

const foreignDir = (fx: AttrFixture): string => {
  const d = join(fx.tempRoot, 'someone-elses-checkout')
  mkdirSync(d, { recursive: true })
  return d
}

describe('SMI-7089: worktree-docker.sh stop is attributed before it removes anything', () => {
  it('T21. refuses when a registered worktree shares the project, naming it', () => {
    const fx = mk('wd-t21')
    const foo = wt(fx, 'foo')
    const x = wt(fx, '_foo')
    primeAttribution(fx, x)

    const r = runDocker(fx, ['stop', x])

    expect(r.status).toBe(1)
    expect(text(r)).toContain(foo)
    expect(r.dockerCalls).toEqual(['info'])
  })

  it('T22. refuses when the MAIN checkout shares the project (_Repo vs repo)', () => {
    const fx = mk('wd-t22')
    const x = wt(fx, '_Repo')
    primeAttribution(fx, x)

    const r = runDocker(fx, ['stop', x])

    expect(r.status).toBe(1)
    expect(text(r)).toContain('main checkout')
    expect(text(r)).toContain(fx.repoDir)
    expect(r.dockerCalls).toEqual(['info'])
  })

  describe('T23. every container of the project must be this worktree’s', () => {
    const cases: Array<[string, (fx: AttrFixture, x: string) => void]> = [
      [
        'a foreign working_dir',
        (fx) => {
          setContainers(fx, { running: ['c1'] })
          setLabels(fx, 'c1', workdirLabels(foreignDir(fx)))
        },
      ],
      [
        'a missing working_dir label',
        (fx) => {
          setContainers(fx, { running: ['c1'] })
          setLabels(fx, 'c1', '{}')
        },
      ],
      [
        'a <no value> working_dir',
        (fx) => {
          setContainers(fx, { running: ['c1'] })
          setLabels(fx, 'c1', workdirLabels('<no value>'))
        },
      ],
      [
        'ours first and a foreign one second',
        (fx, x) => {
          setContainers(fx, { running: ['c1', 'c2'] })
          setLabels(fx, 'c1', workdirLabels(x))
          setLabels(fx, 'c2', workdirLabels(foreignDir(fx)))
        },
      ],
      [
        'a STOPPED foreign container beside our running one',
        (fx, x) => {
          setContainers(fx, { running: ['c1'], stopped: ['c2'] })
          setLabels(fx, 'c1', workdirLabels(x))
          setLabels(fx, 'c2', workdirLabels(foreignDir(fx)))
        },
      ],
    ]
    it.each(cases)('refuses on %s', (name, arrange) => {
      const fx = mk('wd-t23')
      const x = wt(fx, 'foo')
      primeAttribution(fx, x)
      arrange(fx, x)

      const r = runDocker(fx, ['stop', x])

      expect(r.status).toBe(1)
      // Presence: the reads happened; absence: the destructive call did not.
      expect(r.dockerCalls).toContain(
        'ps -aq --no-trunc --filter label=com.docker.compose.project=foo'
      )
      expect(inspects(r.dockerCalls, 'c1')).toBe(true)
      if (name.includes('second') || name.includes('STOPPED')) {
        expect(inspects(r.dockerCalls, 'c2')).toBe(true)
        expect(text(r)).toContain('c2')
      }
      expect(removals(r.dockerCalls)).toEqual([])
    })
  })

  it('T24. a near miss (foo_ beside foo) is not a peer: the approved container is removed', () => {
    const fx = mk('wd-t24')
    wt(fx, 'foo_')
    const x = wt(fx, 'foo')
    primeAttribution(fx, x)
    ourContainers(fx, x)

    const r = runDocker(fx, ['stop', x])

    expect(r.status).toBe(0)
    expect(removals(r.dockerCalls)).toEqual(['rm -f c1'])
  })

  it('T24b. only the approved ids go: a container in a later `ps` is untouched; no compose down', () => {
    const fx = mk('wd-t24b')
    const x = wt(fx, 'foo')
    primeAttribution(fx, x)
    ourContainers(fx, x)
    setPsSequence(fx, ['c1', 'c1 c9'])

    const r = runDocker(fx, ['stop', x])

    expect(r.status).toBe(0)
    expect(removals(r.dockerCalls)).toEqual(['rm -f c1'])
    expect(r.dockerCalls.some((c) => c.includes('c9'))).toBe(false)
    expect(r.dockerCalls.some((c) => c.startsWith('compose') && /\bdown\b/.test(c))).toBe(false)
  })

  it('T24c. a failed `rm -f` makes stop exit non-zero and names the ids', () => {
    const fx = mk('wd-t24c')
    const x = wt(fx, 'foo')
    primeAttribution(fx, x)
    ourContainers(fx, x, ['c1', 'c2'])
    setExit(fx, 'rm', 1)

    const r = runDocker(fx, ['stop', x])

    expect(r.dockerCalls).toContain('rm -f c1 c2')
    expect(text(r)).toContain('c1 c2')
    expect(text(r)).not.toContain('Docker containers stopped')
    expect(r.status).toBe(1)
  })

  it('T24d. a symlinked worktree path is refused before any Docker call (stop and start)', () => {
    const fx = mk('wd-t24d')
    const real = wt(fx, 'fooreal')
    composeOverride(real)
    primeAttribution(fx, real)
    const link = join(fx.tempRoot, 'foolink')
    symlinkSync(real, link)

    const stop = runDocker(fx, ['stop', link])
    const start = runDocker(fx, ['start', link])

    for (const r of [stop, start]) {
      expect(r.status).toBe(1)
      expect(r.dockerCalls).toEqual([])
      expect(text(r)).toContain('fooreal')
      expect(text(r)).toContain(`Use the real path: ${real}`)
    }
  })

  it('T27b. stop from the MAIN checkout removes only the DEV-profile service: ruflo and test survive', () => {
    const fx = mk('wd-t27b')
    composeBase(fx.repoDir)
    primeAttribution(fx, fx.repoDir)
    ourContainers(fx, fx.repoDir, ['cdev', 'cruflo', 'ctest'], { cruflo: 'ruflo', ctest: 'test' })

    const r = runDocker(fx, ['stop', fx.repoDir])

    expect(r.status).toBe(0)
    // Presence: the dev-profile service set was read, and the dev container went.
    expect(r.dockerCalls).toContain('compose --profile dev config --services')
    expect(removals(r.dockerCalls)).toEqual(['rm -f cdev'])
    expect(r.dockerCalls.some((c) => c.includes('cruflo') && c.startsWith('rm'))).toBe(false)
    expect(text(r)).toContain("service 'ruflo' is not in the dev profile")
  })

  it.each([
    ['the services read fails', (fx: AttrFixture) => setExit(fx, 'compose_services', 1)],
    [
      'the services answer is empty (unparseable)',
      (fx: AttrFixture) => writeFileSync(join(fx.responsesDir, 'compose_services'), ''),
    ],
  ])('T27c. %s: stop refuses and removes nothing (fail closed)', (_n, arrange) => {
    const fx = mk('wd-t27c')
    composeBase(fx.repoDir)
    primeAttribution(fx, fx.repoDir)
    ourContainers(fx, fx.repoDir, ['cdev', 'cruflo'], { cruflo: 'ruflo' })
    arrange(fx)

    const r = runDocker(fx, ['stop', fx.repoDir])

    expect(r.dockerCalls).toContain('compose --profile dev config --services')
    expect(removals(r.dockerCalls)).toEqual([])
    expect(r.dockerCalls.some((c) => c.startsWith('network rm'))).toBe(false)
    expect(text(r)).toContain('dev profile')
    expect(r.status).toBe(1)
  })

  it('T25. refuses when Compose resolves a different project name', () => {
    const fx = mk('wd-t25')
    const x = wt(fx, 'foo')
    primeAttribution(fx, x, 'something-else')

    const r = runDocker(fx, ['stop', x])

    expect(r.status).toBe(1)
    expect(r.dockerCalls).toContain('compose config --format json')
    expect(removals(r.dockerCalls)).toEqual([])
  })

  describe('T26. any unreadable input refuses', () => {
    it('git worktree list fails after printing a record', () => {
      const fx = mk('wd-t26a')
      const x = wt(fx, 'foo')
      primeAttribution(fx, x)
      shimGitWorktreeList(fx, 'partial')

      const r = runDocker(fx, ['stop', x])

      expect(r.status).toBe(1)
      expect(r.dockerCalls).toEqual(['info'])
    })

    it('docker ps fails', () => {
      const fx = mk('wd-t26b')
      const x = wt(fx, 'foo')
      primeAttribution(fx, x)
      setExit(fx, 'ps', 1)

      const r = runDocker(fx, ['stop', x])

      expect(r.status).toBe(1)
      expect(r.dockerCalls).toContain(
        'ps -aq --no-trunc --filter label=com.docker.compose.project=foo'
      )
      expect(removals(r.dockerCalls)).toEqual([])
    })

    it('docker info fails: docker-required mode refuses (no fall-through)', () => {
      const fx = mk('wd-t26c')
      const x = wt(fx, 'foo')
      primeAttribution(fx, x)
      setExit(fx, 'info', 1)

      const r = runDocker(fx, ['stop', x])

      expect(r.status).toBe(1)
      expect(r.dockerCalls).toEqual(['info'])
    })
  })

  it('T27. stopping the MAIN checkout’s own container is legitimate: no peer, its container is removed', () => {
    const fx = mk('wd-t27')
    composeBase(fx.repoDir)
    primeAttribution(fx, fx.repoDir)
    ourContainers(fx, fx.repoDir)

    const r = runDocker(fx, ['stop', fx.repoDir])

    expect(r.status).toBe(0)
    expect(removals(r.dockerCalls)).toEqual(['rm -f c1'])
  })
})

describe('SMI-7089: an empty sanitized name in docker-required mode', () => {
  it('start refuses, makes no docker call, and advises a rename -- not a worktree remove', () => {
    const fx = mk('wd-empty-name')
    const x = wt(fx, '___')
    composeOverride(x)
    primeAttribution(fx, x)

    const r = runDocker(fx, ['start', x])

    expect(r.status).toBe(1)
    expect(r.dockerCalls).toEqual([])
    expect(text(r)).toContain('sanitizes to an empty Compose project name')
    expect(text(r)).toContain('git worktree move')
    expect(text(r)).not.toContain('worktree remove')
  })
})

describe('SMI-7089 (OD-8): worktree-docker.sh start is attributed before `compose up`', () => {
  it('T28. refuses when a registered worktree shares the project: no `up`', () => {
    const fx = mk('wd-t28')
    wt(fx, 'foo')
    const x = wt(fx, '_foo')
    composeOverride(x)
    primeAttribution(fx, x)

    const r = runDocker(fx, ['start', x])

    expect(r.status).toBe(1)
    expect(r.dockerCalls).toEqual(['info'])
    expect(ups(r.dockerCalls)).toEqual([])
  })

  it('T28b. a refused start leaves NO override file behind (the gate precedes auto-generation)', () => {
    const fx = mk('wd-t28b')
    wt(fx, 'foo')
    const x = wt(fx, '_foo')
    primeAttribution(fx, x)
    const override = join(x, 'docker-compose.override.yml')
    // Control: the precondition really is "no override yet".
    expect(existsSync(override)).toBe(false)

    const r = runDocker(fx, ['start', x])

    expect(r.status).toBe(1)
    // The property first: a refused start wrote nothing.
    expect(existsSync(override)).toBe(false)
    expect(r.dockerCalls).toEqual(['info'])
  })

  it('T29. a near miss (foo_ beside foo) is not a peer: `compose --profile dev up -d` runs', () => {
    const fx = mk('wd-t29')
    wt(fx, 'foo_')
    const x = wt(fx, 'foo')
    composeOverride(x)
    primeAttribution(fx, x)

    const r = runDocker(fx, ['start', x])

    expect(r.status).toBe(0)
    expect(ups(r.dockerCalls)).toEqual(['compose --profile dev up -d'])
  })

  it('T30. a foreign container of the project refuses (the up-recreates-it shape): no `up`', () => {
    const fx = mk('wd-t30')
    const x = wt(fx, 'foo')
    composeOverride(x)
    primeAttribution(fx, x)
    setContainers(fx, { running: ['c1'] })
    setLabels(fx, 'c1', workdirLabels(foreignDir(fx)))

    const r = runDocker(fx, ['start', x])

    expect(r.status).toBe(1)
    expect(r.dockerCalls).toContain(
      'ps -aq --no-trunc --filter label=com.docker.compose.project=foo'
    )
    expect(inspects(r.dockerCalls, 'c1')).toBe(true)
    expect(ups(r.dockerCalls)).toEqual([])
  })

  it('T31. a foreign container that appears AFTER the first check is refused by the recheck before `up`', () => {
    const fx = mk('wd-t31')
    const x = wt(fx, 'foo')
    composeOverride(x)
    primeAttribution(fx, x)
    setLabels(fx, 'c2', workdirLabels(foreignDir(fx)))
    // The 1st `ps` (the gate) sees nothing; the 2nd (the recheck) sees c2.
    setPsSequence(fx, ['', 'c2'])

    const r = runDocker(fx, ['start', x])

    expect(r.status).toBe(1)
    // Presence: both checks ran.
    expect(r.dockerCalls.filter((c) => c.startsWith('ps -aq'))).toHaveLength(2)
    expect(inspects(r.dockerCalls, 'c2')).toBe(true)
    expect(text(r)).toContain('c2')
    expect(ups(r.dockerCalls)).toEqual([])
  })
})
