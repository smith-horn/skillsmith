/**
 * SMI-6531 (A1 step 6d-ii, governance round): path handling in restore. A
 * `..`-prefixed folder is inside a root, a path that vanishes mid-plan is a
 * refusal rather than a throw, and writes go to the bound real parent.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { executeRestoreWith } from '../../../src/services/skill-restore.exec.js'
import { planRestore } from '../../../src/services/skill-restore.js'
import { insideOrEqual } from '../../../src/services/skill-restore.lock.js'
import { indexKind, mkEnv, parkEntry, planOk, type Env } from './skill-restore.helpers.js'

let env: Env | undefined
afterEach(() => {
  vi.restoreAllMocks()
  if (env !== undefined) fs.rmSync(env.base, { recursive: true, force: true })
  env = undefined
})

/** The environment of the running test (each test makes its own). */
function fresh(): Env {
  env = mkEnv()
  return env
}

describe('insideOrEqual compares by path segments', () => {
  it.each([
    ['/r', '/r', true],
    ['/r', '/r/a', true],
    ['/r', '/r/..proj', true],
    ['/r', '/r/..', false],
    ['/r', '/x', false],
    ['/r', '/rx', false],
    ['/r/a', '/r', false],
  ])('insideOrEqual(%s, %s) is %s', (root, child, want) => {
    expect(insideOrEqual(root, child)).toBe(want)
  })

  it('a project folder named ..proj inside a skills root is locked by that root (lock 1)', async () => {
    const env = fresh()
    const r = path.join(env.base, 'rproj')
    const m = parkEntry(path.join(r, '..proj'), 'skill-i', { caller: 'init-rollback' })
    indexKind(env.stateRoot, m.copyPath, m.opId, 'init-rollback')
    const plan = await planOk(m.copyPath, { ...env.opts, roots: [r] })
    expect(plan.lock.kind).toBe('lock1')
    expect(plan.lock.path).toBe(path.join(r, '.skillsmith-writes.lock'))
  })
})

describe('a path that vanishes during planning is a refusal, not a throw', () => {
  it('the origin parent vanishes between realpath and stat: origin-parent-missing', async () => {
    const env = fresh()
    const m = parkEntry(env.root, 'skill-a')
    const real = fs.statSync.bind(fs)
    vi.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike, o?: unknown) => {
      if (String(p) === env.root && new Error().stack?.includes('isDirectory')) {
        throw Object.assign(new Error('gone'), { code: 'ENOENT' })
      }
      return (real as (a: fs.PathLike, b?: unknown) => unknown)(p, o)
    }) as never)
    const r = await planRestore(m.copyPath, env.opts)
    expect(r.status === 'refused' && r.reason).toBe('origin-parent-missing')
  })

  it('the skills root vanishes between binding and its identity read: origin-root-unbindable', async () => {
    const env = fresh()
    const m = parkEntry(env.root, 'skill-a')
    const real = fs.lstatSync.bind(fs)
    vi.spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike, o?: { bigint?: boolean }) => {
      if (String(p) === env.root && o?.bigint === true && new Error().stack?.includes('choose')) {
        throw Object.assign(new Error('gone'), { code: 'ENOENT' })
      }
      return (real as (a: fs.PathLike, b?: unknown) => unknown)(p, o)
    }) as never)
    const r = await planRestore(m.copyPath, env.opts)
    expect(r.status === 'refused' && r.reason).toBe('origin-root-unbindable')
  })
})

describe('writes go to the bound real parent, not the sidecar spelling', () => {
  /** A parked copy whose sidecar spells its origin through a symlink to the real folder. */
  function viaAlias(
    env: Env,
    type: 'dir' | 'file'
  ): {
    alias: string
    spelled: string
    real: string
    copy: string
  } {
    const m = parkEntry(env.root, 'thing', { type })
    const alias = path.join(env.base, 'alias')
    fs.symlinkSync(env.root, alias)
    const spelled = path.join(alias, 'thing')
    const s = JSON.parse(fs.readFileSync(m.sidecarPath, 'utf8')) as Record<string, unknown>
    fs.writeFileSync(m.sidecarPath, JSON.stringify({ ...s, originPath: spelled }))
    return { alias, spelled, real: path.join(env.root, 'thing'), copy: m.copyPath }
  }

  it('a folder is claimed at the real path', async () => {
    const env = fresh()
    const a = viaAlias(env, 'dir')
    const plan = await planOk(a.copy, env.opts)
    expect(plan.origin).toBe(a.spelled)
    expect(plan.target).toBe(a.real)
    const mkdir = vi.spyOn(fs.promises, 'mkdir')
    expect((await executeRestoreWith(plan)).status).toBe('restored')
    const made = mkdir.mock.calls.map((c) => String(c[0]))
    expect(made).toContain(a.real)
    expect(made).not.toContain(a.spelled)
    expect(fs.existsSync(path.join(a.real, 'SKILL.md'))).toBe(true)
  })

  it('a file is linked at the real path', async () => {
    const env = fresh()
    const a = viaAlias(env, 'file')
    const plan = await planOk(a.copy, env.opts)
    const link = vi.spyOn(fs, 'linkSync')
    expect((await executeRestoreWith(plan)).status).toBe('restored')
    expect(link.mock.calls.map((c) => String(c[1]))).toEqual([a.real])
    expect(fs.readFileSync(a.real, 'utf8')).toBe('file thing\n')
  })
})
