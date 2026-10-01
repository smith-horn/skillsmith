/**
 * SMI-6919: the attribution harness's fixture setup runs `git init` and
 * `git config user.*` in a temp directory. When a hook environment exports
 * GIT_DIR (every husky hook does, and a worktree's pre-push runs this file's
 * suite), git addresses THAT repository instead of the temp one, so the
 * fixture's `core.bare=true` and `user.email=t@t.example` landed in the main
 * repo's shared `.git/config` (measured 2026-10-01 20:54Z, reproduced
 * prospectively by a peer with a whole-config snapshot and diff).
 *
 * Red arm: with GIT_DIR exported to a scratch repository, `setupFixtures()`
 * must leave that repository's config byte-identical and must create the
 * fixture's own `.git`. Fails on the unfixed harness (the scratch config
 * gains the three keys and the fixture gets no `.git`); passes once the
 * harness isolates its git environment.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { isolatedGitEnv } from './check-native-modules-attribution.git-env'
import { setupFixtures } from './check-native-modules-attribution.harness'

const SCRATCH_PREFIX = 'smi6919-scratch-'

// The scratch repo's own creation must not itself be subject to the leak,
// so it uses the same isolated environment the fix gives the harness.
function makeScratchRepo(): { dir: string; configPath: string } {
  const dir = mkdtempSync(join(tmpdir(), SCRATCH_PREFIX))
  const r = spawnSync('git', ['init', '-q'], { cwd: dir, env: isolatedGitEnv(dir) })
  if (r.status !== 0) throw new Error(`scratch git init failed: ${r.stderr}`)
  return { dir, configPath: join(dir, '.git', 'config') }
}

describe('check-native-modules-attribution.harness — SMI-6919: fixture git calls cannot reach an inherited GIT_DIR', () => {
  const cleanups: Array<() => void> = []
  const saved: Record<string, string | undefined> = {}
  afterEach(() => {
    for (const k of ['GIT_DIR', 'GIT_WORK_TREE']) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    for (const c of cleanups.splice(0)) c()
  })

  it('leaves a GIT_DIR-exported repository byte-identical and gives the fixture its own .git', () => {
    const scratch = makeScratchRepo()
    cleanups.push(() => rmSync(scratch.dir, { recursive: true, force: true }))
    const before = readFileSync(scratch.configPath, 'utf8')
    // Known-positive control for the instrument: the scratch config is a
    // real git config that a leaking `git config` would extend.
    expect(before).toContain('[core]')

    saved['GIT_DIR'] = process.env['GIT_DIR']
    saved['GIT_WORK_TREE'] = process.env['GIT_WORK_TREE']
    process.env['GIT_DIR'] = join(scratch.dir, '.git')
    delete process.env['GIT_WORK_TREE']

    const fx = setupFixtures()
    cleanups.push(() => fx.cleanup())

    const after = readFileSync(scratch.configPath, 'utf8')
    expect(after).toBe(before)
    expect(after).not.toContain('t@t.example')
    expect(after).not.toContain('bare = true')
    // The fixture repository exists where the harness meant it to.
    expect(existsSync(join(fx.repoDir, '.git'))).toBe(true)
    const log = spawnSync('git', ['log', '--format=%an <%ae>', '-1'], {
      cwd: fx.repoDir,
      env: isolatedGitEnv(fx.root),
      encoding: 'utf8',
    })
    expect(log.status).toBe(0)
    expect(log.stdout.trim()).toBe('test <t@t.example>')
  })
})
