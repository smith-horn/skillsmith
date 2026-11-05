/**
 * SMI-6531 (A1 step 6c-i): the destructive walk is reachable only through the
 * walker child's entry (spike PR-17). An in-process importer, even one that
 * sets `SKILLSMITH_PRUNE_WALKER=1` itself, finds no export, and an importer
 * that points `process.argv[1]` at the walker does not make it the entry: the
 * entry test is `import.meta.main`, which in-process code cannot set. Ported
 * from the SMI-6676 spike's `harness/test-w5-walker-private.mjs`.
 */
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { encodeJob } from '../../../src/install/prune.job.js'
import {
  WALKER,
  exists,
  jobFor,
  makeParent,
  parkCopy,
  removeFixture,
  runWalker,
  stagingDirs,
  statusOf,
} from './prune.walk.helpers.js'
import type { PruneFixture } from './prune.walk.helpers.js'

let f: PruneFixture | null = null
afterEach(() => {
  if (f !== null) removeFixture(f)
  f = null
})

describe('the walker is reachable only as its own process entry', () => {
  it('A: an in-process import exports nothing and walks nothing, even with the env flag set', async () => {
    f = makeParent('prune-private-')
    const c = parkCopy(f.parent, 'a')
    const saved = process.env.SKILLSMITH_PRUNE_WALKER
    const cwd = process.cwd()
    process.env.SKILLSMITH_PRUNE_WALKER = '1'
    try {
      const mod = (await import(`${pathToFileURL(WALKER).href}?inproc=${Date.now()}`)) as Record<
        string,
        unknown
      >
      expect(Object.keys(mod)).toEqual([])
    } finally {
      if (saved === undefined) delete process.env.SKILLSMITH_PRUNE_WALKER
      else process.env.SKILLSMITH_PRUNE_WALKER = saved
      process.chdir(cwd)
    }
    expect(exists(c.copyPath)).toBe(true)
    expect(stagingDirs(c.stagingRoot)).toEqual([])
  })

  it('B: an importer that spoofs argv[1] and the env flag does not walk the job on stdin', () => {
    f = makeParent('prune-spoof-')
    const a = parkCopy(f.parent, 'a')
    const b = parkCopy(f.parent, 'b')
    const SPOOF =
      'process.argv[1] = process.env.PRUNE_WALKER; ' +
      "await import(process.env.PRUNE_WALKER_URL + '?spoof=' + Date.now())"
    const spoof = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', SPOOF],
      {
        input: JSON.stringify(encodeJob(jobFor(a))),
        encoding: 'utf8',
        env: {
          ...process.env,
          SKILLSMITH_PRUNE_WALKER: '1',
          PRUNE_WALKER: WALKER,
          PRUNE_WALKER_URL: pathToFileURL(WALKER).href,
        },
      }
    )
    expect(spoof.status, spoof.stderr).toBe(0)
    expect(spoof.stdout.trim()).toBe('')
    expect(exists(a.copyPath)).toBe(true)
    expect(stagingDirs(a.stagingRoot)).toEqual([])
    // Positive control: the same kind of job, run as the real entry, walks.
    // Without it, the survival above could be a walker that never runs at all.
    const real = runWalker(jobFor(b))
    expect(statusOf(real)).toBe('removed/null')
    expect(exists(b.copyPath)).toBe(false)
    expect(fs.existsSync(a.copyPath)).toBe(true)
  })

  it('C: the entry refuses to walk without the env flag', () => {
    f = makeParent('prune-noflag-')
    const c = parkCopy(f.parent, 'a')
    const run = runWalker(jobFor(c), { env: { SKILLSMITH_PRUNE_WALKER: '0' } })
    expect(run.item).toBeNull()
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('runs only in the dedicated prune walker child')
    expect(exists(c.copyPath)).toBe(true)
  })
})
