/**
 * SMI-6919: a push from a linked worktree runs pre-push with
 * GIT_DIR=<main>/.git/worktrees/<wt> exported (measured; a commit hook and a
 * push from the main checkout do not export it), and the attribution
 * harness's fixture setup ran `git init` and `git config user.*` under it, so
 * git addressed THAT repository: the main checkout's shared .git/config gained
 * core.bare=true and the test identity (2026-10-01 20:54Z, reproduced by
 * peers with a whole-config snapshot and diff around a root-suite run).
 *
 * The scratch repository here has the same shape, a linked worktree whose
 * gitdir is exported as GIT_DIR, because only that shape provokes the
 * core.bare write: against a plain .git, `git init` writes nothing to config
 * and the first version's config-only assertions never fired (the governance
 * review of cde048ff7 measured this, assertion by assertion). Each property
 * is its own test, so the red arm names which fail: with the harness's git
 * env removed (and its status checks silenced, as the original had none), the
 * shared config gains `bare = true`, the fixture gets no .git of its own and
 * its log fails; under the fixture env all of them hold.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { makeFixtureEnv, makeFixtureTempDir } from './_lib/git-fixture-env'
import { setupFixtures } from './check-native-modules-attribution.harness'

type Scratch = { dir: string; sharedConfigPath: string; gitDir: string; worktree: string }
type Observation = { config: string; history: string }

function git(args: string[], cwd: string): string {
  const r = spawnSync('git', args, { cwd, env: makeFixtureEnv(), encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`scratch git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout
}

// A repository with one commit and one linked worktree, built under the
// fixture env so its own creation is not subject to the leak.
function makeScratchRepo(): Scratch {
  const dir = makeFixtureTempDir('smi6919-scratch')
  git(['init', '-q', '-b', 'main'], dir)
  writeFileSync(join(dir, 'a'), 'x')
  git(['add', 'a'], dir)
  git(['commit', '-q', '-m', 'a'], dir)
  const worktree = join(dir, 'wt')
  git(['worktree', 'add', '-q', worktree, '-b', 'wtbr'], dir)
  return {
    dir,
    sharedConfigPath: join(dir, '.git', 'config'),
    gitDir: join(dir, '.git', 'worktrees', 'wt'),
    worktree,
  }
}

function observe(scratch: Scratch): Observation {
  return {
    config: readFileSync(scratch.sharedConfigPath, 'utf8'),
    history: git(['log', '--oneline', '--all'], scratch.dir),
  }
}

describe('check-native-modules-attribution.harness — SMI-6919: fixture git calls cannot reach an inherited worktree GIT_DIR', () => {
  const cleanups: Array<() => void> = []
  let scratch: Scratch
  let before: Observation
  let after: Observation
  let fx: ReturnType<typeof setupFixtures>

  beforeAll(() => {
    scratch = makeScratchRepo()
    cleanups.push(() => rmSync(scratch.dir, { recursive: true, force: true }))
    before = observe(scratch)
    // Known-positive controls for the instrument: a real config with the
    // worktree registered, and a history with the one commit.
    expect(before.config).toContain('[core]')
    expect(before.history.trim()).not.toBe('')

    const saved = { GIT_DIR: process.env['GIT_DIR'], GIT_WORK_TREE: process.env['GIT_WORK_TREE'] }
    process.env['GIT_DIR'] = scratch.gitDir
    delete process.env['GIT_WORK_TREE']
    try {
      fx = setupFixtures()
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
    cleanups.push(() => fx.cleanup())
    after = observe(scratch)
  })

  afterAll(() => {
    for (const c of cleanups.splice(0)) c()
  })

  it('leaves the shared config byte-identical', () => {
    expect(after.config).toBe(before.config)
  })

  it('writes no core.bare into the shared config', () => {
    expect(after.config).not.toContain('bare = true')
  })

  it("leaves the scratch repository's history untouched", () => {
    expect(after.history).toBe(before.history)
  })

  it('gives the fixture its own .git', () => {
    expect(existsSync(join(fx.repoDir, '.git'))).toBe(true)
  })

  it("commits in the fixture under the fixture env's own identity", () => {
    const env = makeFixtureEnv()
    const log = spawnSync('git', ['log', '--format=%an <%ae>', '-1'], {
      cwd: fx.repoDir,
      env,
      encoding: 'utf8',
    })
    expect(log.status).toBe(0)
    // The property, not a literal: the author came from the fixture env, so a
    // host identity bleeding in fails this even if the helper's constants change.
    expect(log.stdout.trim()).toBe(`${env['GIT_AUTHOR_NAME']} <${env['GIT_AUTHOR_EMAIL']}>`)
  })
})
