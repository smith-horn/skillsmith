/**
 * SMI-7089 (OD-6, OD-8): `worktree-docker.sh stop` and `start` run a project-scoped
 * Compose call (`down`, `up`) that acts on EVERY container of the Compose project,
 * whichever directory created it. The project name is computed from the directory
 * basename, so a second directory resolving to the same name loses its container
 * (`stop` removes it, `start` recreates it). Both now run the shared attribution
 * check (lib/worktree-project-attribution.sh) first and refuse, changing nothing,
 * when they cannot show the project belongs to this checkout alone.
 *
 * Row ids (T21-T30) are the plan's. Every refusal row asserts on the shim log, and
 * R0 means a refusal's log always starts with `info`, which is the presence partner
 * for each "no `down` / no `up`" assertion.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'

import {
  addWt,
  composeBase,
  composeOverride,
  makeAttrFixture,
  primeAttribution,
  runDocker,
  setContainers,
  setExit,
  setLabels,
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
const downs = (calls: string[]): string[] => calls.filter((c) => /^compose .*\bdown$/.test(c))
const ups = (calls: string[]): string[] => calls.filter((c) => /^compose .* up /.test(c))
const inspects = (calls: string[], id: string): boolean =>
  calls.includes(`inspect --type container ${id} --format {{json .Config.Labels}}`)

const foreignDir = (fx: AttrFixture): string => {
  const d = join(fx.tempRoot, 'someone-elses-checkout')
  mkdirSync(d, { recursive: true })
  return d
}

describe('SMI-7089: worktree-docker.sh stop is attributed before `compose down`', () => {
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
      expect(r.dockerCalls).toContain('ps -aq --filter label=com.docker.compose.project=foo')
      expect(inspects(r.dockerCalls, 'c1')).toBe(true)
      if (name.includes('second') || name.includes('STOPPED')) {
        expect(inspects(r.dockerCalls, 'c2')).toBe(true)
        expect(text(r)).toContain('c2')
      }
      expect(downs(r.dockerCalls)).toEqual([])
    })
  })

  it('T24. a near miss (foo_ beside foo) is not a peer: `compose --profile dev down` runs', () => {
    const fx = mk('wd-t24')
    wt(fx, 'foo_')
    const x = wt(fx, 'foo')
    primeAttribution(fx, x)

    const r = runDocker(fx, ['stop', x])

    expect(r.status).toBe(0)
    expect(downs(r.dockerCalls)).toEqual(['compose --profile dev down'])
  })

  it('T25. refuses when Compose resolves a different project name', () => {
    const fx = mk('wd-t25')
    const x = wt(fx, 'foo')
    primeAttribution(fx, x, 'something-else')

    const r = runDocker(fx, ['stop', x])

    expect(r.status).toBe(1)
    expect(r.dockerCalls).toContain('compose config --format json')
    expect(downs(r.dockerCalls)).toEqual([])
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
      expect(r.dockerCalls).toContain('ps -aq --filter label=com.docker.compose.project=foo')
      expect(downs(r.dockerCalls)).toEqual([])
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

  it('T27. stopping the MAIN checkout’s own container is legitimate: no peer, `down` runs', () => {
    const fx = mk('wd-t27')
    composeBase(fx.repoDir)
    primeAttribution(fx, fx.repoDir)

    const r = runDocker(fx, ['stop', fx.repoDir])

    expect(r.status).toBe(0)
    expect(downs(r.dockerCalls)).toEqual(['compose --profile dev down'])
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
    expect(r.dockerCalls).toContain('ps -aq --filter label=com.docker.compose.project=foo')
    expect(inspects(r.dockerCalls, 'c1')).toBe(true)
    expect(ups(r.dockerCalls)).toEqual([])
  })
})
