/**
 * SMI-6531 (A1 step 8-i-a-1): T-N1's uninstall half (UD5a′, D8). Uninstall now
 * takes lock 1 and parks, so in a root that never had a staging or parked area
 * it creates both. In a git work tree that ignores neither, the first
 * uninstall returns one staging hint and one parked-area hint; the next one in
 * the same root returns neither. No git file is written. An uninstall the gate
 * stops still gives the staging hint when it created the staging area in a git
 * work tree, and none when `.skillsmith-staging/` already existed or the root
 * is outside any git work tree.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeFixtureEnv } from '../../_lib/git-fixture-env.js'
import {
  PARKED_GITIGNORE_HINT,
  STAGING_GITIGNORE_HINT,
} from '../../../src/services/skill-write-lock.gitignore.js'
import { bindSkillsRoot } from '../../../src/services/skill-write-lock.js'
import { makeSandbox } from './skill-write-lock.gitignore.helpers.js'
import type { Sandbox } from './skill-write-lock.gitignore.helpers.js'
import type { BigIntStats } from 'node:fs'
import { PROBE_PREFIX } from '../../../src/install/park-clock-gate.js'
import { cleanupFixture, makeFixture, stubFs, uninstall } from './uninstall-park.helpers.js'
import type { UFixture } from './uninstall-park.helpers.js'

let sandbox: Sandbox | null = null
const fixtures: UFixture[] = []
afterEach(() => {
  for (const f of fixtures.splice(0)) cleanupFixture(f)
  sandbox?.cleanup()
  sandbox = null
})

/** Every probe lstat reads a 0n birthtime, so the gate stops after the bind (UD25). */
const zeroProbeBirthtimes = (): (() => void) =>
  stubFs('lstatSync', (orig) => (...a: unknown[]) => {
    const st = orig(...a) as BigIntStats
    if (!path.basename(String(a[0])).startsWith(PROBE_PREFIX)) return st
    if (typeof st.birthtimeNs !== 'bigint') return st
    return Object.defineProperty(Object.create(st), 'birthtimeNs', { value: 0n }) as BigIntStats
  })

/** The uninstall with the gate stopped by the stub; restored whatever happens. */
async function stoppedUninstall(f: UFixture): Promise<Awaited<ReturnType<typeof uninstall>>> {
  const restore = zeroProbeBirthtimes()
  try {
    return await uninstall(f)
  } finally {
    restore()
  }
}

const snapshot = (root: string): Record<string, string | null> => {
  const read = (p: string): string | null => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null)
  return {
    gitignore: read(path.join(root, '.gitignore')),
    skillsGitignore: read(path.join(root, 'skills', '.gitignore')),
    exclude: read(path.join(root, '.git', 'info', 'exclude')),
    config: read(path.join(root, '.git', 'config')),
  }
}

describe('T-N1 (uninstall half): the hints for the areas uninstall creates', () => {
  it('the first uninstall in a git-tracked root gives both hints once; the next gives none', async () => {
    sandbox = makeSandbox()
    const first = makeFixture('uninstall-n1-', 'dir', 'first-skill')
    fixtures.push(first)
    execFileSync('git', ['init', '-q', first.root], { env: makeFixtureEnv() })
    // A second skill in the same root, tracked in its own manifest.
    const second = makeFixture('uninstall-n1-b-', 'dir', 'second-skill')
    fixtures.push(second)
    fs.renameSync(second.installPath, path.join(first.skillsDir, 'second-skill'))
    const before = snapshot(first.root)

    const r1 = await uninstall(first)
    expect(r1.success, r1.message).toBe(true)
    expect(r1.hints).toEqual([STAGING_GITIGNORE_HINT, PARKED_GITIGNORE_HINT])

    const moved: UFixture = {
      ...second,
      skillsDir: first.skillsDir,
      installPath: path.join(first.skillsDir, 'second-skill'),
    }
    const manifest = JSON.parse(fs.readFileSync(second.manifestPath, 'utf8')) as {
      installedSkills: Record<string, { installPath: string }>
    }
    manifest.installedSkills['second-skill']!.installPath = moved.installPath
    fs.writeFileSync(second.manifestPath, JSON.stringify(manifest))
    const r2 = await uninstall(moved)
    expect(r2.success, r2.message).toBe(true)
    expect(r2.hints).toBeUndefined()

    expect(snapshot(first.root)).toEqual(before)
  })

  it('a gate stop after the bind made the staging folder still returns its hint (0n probe)', async () => {
    sandbox = makeSandbox()
    const f = makeFixture('uninstall-n1-stop-')
    fixtures.push(f)
    execFileSync('git', ['init', '-q', f.root], { env: makeFixtureEnv() })
    const restore = stubFs('lstatSync', (orig) => (...a: unknown[]) => {
      const st = orig(...a) as BigIntStats
      if (!path.basename(String(a[0])).startsWith(PROBE_PREFIX)) return st
      if (typeof st.birthtimeNs !== 'bigint') return st
      return Object.defineProperty(Object.create(st), 'birthtimeNs', { value: 0n }) as BigIntStats
    })
    let r: Awaited<ReturnType<typeof uninstall>>
    try {
      r = await uninstall(f)
    } finally {
      restore()
    }
    expect(r.notDone).toMatchObject({ status: 'stopped', reason: 'identity-unverifiable' })
    expect(fs.existsSync(path.join(f.skillsDir, '.skillsmith-staging'))).toBe(true)
    expect(r.hints).toEqual([STAGING_GITIGNORE_HINT])
  })

  it('a gate stop where .skillsmith-staging/ already existed: no staging hint', async () => {
    sandbox = makeSandbox()
    const f = makeFixture('uninstall-n1-existing-')
    fixtures.push(f)
    execFileSync('git', ['init', '-q', f.root], { env: makeFixtureEnv() })
    // An earlier bind made ST; this uninstall's bind finds it.
    expect((await bindSkillsRoot(f.skillsDir)).stagingCreated).toBe(true)
    const r = await stoppedUninstall(f)
    expect(r.notDone).toMatchObject({ status: 'stopped', reason: 'identity-unverifiable' })
    expect(fs.existsSync(path.join(f.skillsDir, '.skillsmith-staging'))).toBe(true)
    expect(r.hints).toBeUndefined()
  })

  it('a gate stop after the bind made ST outside any git work tree: no hint', async () => {
    sandbox = makeSandbox()
    const f = makeFixture('uninstall-n1-stop-nogit-')
    fixtures.push(f)
    const r = await stoppedUninstall(f)
    expect(r.notDone).toMatchObject({ status: 'stopped', reason: 'identity-unverifiable' })
    expect(fs.existsSync(path.join(f.skillsDir, '.skillsmith-staging'))).toBe(true)
    expect(r.hints).toBeUndefined()
  })

  it('a root outside any git work tree gets no hint', async () => {
    sandbox = makeSandbox()
    const f = makeFixture('uninstall-n1-nogit-')
    fixtures.push(f)
    const r = await uninstall(f)
    expect(r.success, r.message).toBe(true)
    expect(r.hints).toBeUndefined()
  })
})
