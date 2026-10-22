/**
 * SMI-6531 (A1 step 4a, UD22): `ensureSkillsRoot` creates an absent skills root
 * one level at a time, each level with its own parent's permission bits and
 * each followed by a sync of its parent.
 *
 * T-L16 (core half). The per-client half of T-L16 (all nine clients, install
 * and update) finishes with steps 7 and 8, where the install and update paths
 * call this before `bindSkillsRoot`.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/install/dir-sync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/install/dir-sync.js')>()
  return { ...actual, syncDirectory: vi.fn(actual.syncDirectory) }
})

const { syncDirectory } = await import('../../../src/install/dir-sync.js')
const realDirSync = (
  await vi.importActual<typeof import('../../../src/install/dir-sync.js')>(
    '../../../src/install/dir-sync.js'
  )
).syncDirectory
const { ensureSkillsRoot } = await import('../../../src/services/skill-root.ensure.js')
const { bindSkillsRoot, SkillWriteStop } = await import('../../../src/services/skill-write-lock.js')
import type { EnsureRootTraceOp } from '../../../src/services/skill-root.ensure.js'

const syncMock = vi.mocked(syncDirectory)
let base: string

beforeEach(() => {
  syncMock.mockReset()
  syncMock.mockImplementation(realDirSync)
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skill-root-ensure-')))
  // An unusual mode, so a fixed 0o755 (or the umask) cannot pass for propagation.
  fs.chmodSync(base, 0o750)
})

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

function modeOf(p: string): number {
  return fs.lstatSync(p).mode & 0o7777
}

function exists(p: string): boolean {
  try {
    fs.lstatSync(p)
    return true
  } catch {
    return false
  }
}

describe('ensureSkillsRoot: an absent root with two absent parents (T-L16, core half)', () => {
  it('makes each level in turn with its own parent bits, syncing the parent after each', async () => {
    const p1 = path.join(base, 'p1')
    const p2 = path.join(p1, 'p2')
    const skills = path.join(p2, 'skills')
    const trace: EnsureRootTraceOp[] = []

    const r = await ensureSkillsRoot(skills, { trace: (op) => trace.push(op) })

    expect(r).toEqual({ ok: true, created: [p1, p2, skills] })
    expect(trace).toEqual([
      { op: 'mkdir', path: p1 },
      { op: 'sync', path: base },
      { op: 'mkdir', path: p2 },
      { op: 'sync', path: p1 },
      { op: 'mkdir', path: skills },
      { op: 'sync', path: p2 },
    ])
    // The traced syncs are real calls, in the same order, not just reported ones.
    expect(syncMock.mock.calls.map((c) => c[0])).toEqual([base, p1, p2])
    for (const p of [p1, p2, skills]) {
      expect(fs.lstatSync(p).isDirectory()).toBe(true)
      expect(modeOf(p)).toBe(0o750)
    }
  })

  it('leaves a root that bindSkillsRoot then accepts', async () => {
    const skills = path.join(base, 'p1', 'p2', 'skills')
    expect((await ensureSkillsRoot(skills)).ok).toBe(true)

    const binding = await bindSkillsRoot(skills)

    expect(binding.root).toBe(skills)
    expect(fs.lstatSync(binding.stagingDir).isDirectory()).toBe(true)
  })

  it('control: bindSkillsRoot on the absent root fails root-unsafe because realpath throws ENOENT', async () => {
    const skills = path.join(base, 'q1', 'skills')

    const err = await bindSkillsRoot(skills).then(
      () => null,
      (e: unknown) => e
    )

    expect(err).toBeInstanceOf(SkillWriteStop)
    expect((err as InstanceType<typeof SkillWriteStop>).code).toBe('root-unsafe')
    expect(((err as Error).cause as NodeJS.ErrnoException).code).toBe('ENOENT')
    expect(exists(path.join(base, 'q1'))).toBe(false)
  })
})

describe('ensureSkillsRoot: what already exists', () => {
  it('an existing root is accepted: created is empty and nothing is made or synced', async () => {
    const skills = path.join(base, 'skills')
    fs.mkdirSync(skills)
    const trace: EnsureRootTraceOp[] = []

    const r = await ensureSkillsRoot(skills, { trace: (op) => trace.push(op) })

    expect(r).toEqual({ ok: true, created: [] })
    expect(trace).toEqual([])
    expect(syncMock).not.toHaveBeenCalled()
  })

  it('a symlink at the root that points at a directory is accepted as it is', async () => {
    const target = path.join(base, 'target')
    fs.mkdirSync(target)
    const skills = path.join(base, 'skills')
    fs.symlinkSync(target, skills)

    expect(await ensureSkillsRoot(skills)).toEqual({ ok: true, created: [] })
  })

  it('a dangling symlink at the root is root-unsafe and nothing is made through it', async () => {
    const skills = path.join(base, 'skills')
    fs.symlinkSync(path.join(base, 'nowhere'), skills)

    const r = await ensureSkillsRoot(skills)

    expect(r).toMatchObject({ ok: false, code: 'root-unsafe', path: skills, errno: 'ENOENT' })
    expect(exists(path.join(base, 'nowhere'))).toBe(false)
  })

  it('an existing ancestor that is a symlink is accepted, and only what is below it is created', async () => {
    const real = path.join(base, 'real')
    fs.mkdirSync(real, { mode: 0o750 })
    fs.chmodSync(real, 0o750)
    const link = path.join(base, 'link')
    fs.symlinkSync(real, link)
    const mid = path.join(link, 'mid')
    const skills = path.join(mid, 'skills')

    const r = await ensureSkillsRoot(skills)

    expect(r).toEqual({ ok: true, created: [mid, skills] })
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(modeOf(path.join(real, 'mid', 'skills'))).toBe(0o750)
  })

  it('a file at the root is root-unsafe', async () => {
    const skills = path.join(base, 'skills')
    fs.writeFileSync(skills, 'not a directory')

    const r = await ensureSkillsRoot(skills)

    expect(r).toMatchObject({ ok: false, code: 'root-unsafe', path: skills })
    expect(fs.readFileSync(skills, 'utf8')).toBe('not a directory')
  })

  it('a file where an ancestor should be is root-unsafe and nothing is made', async () => {
    const file = path.join(base, 'f')
    fs.writeFileSync(file, 'x')
    const trace: EnsureRootTraceOp[] = []

    const r = await ensureSkillsRoot(path.join(file, 'x', 'skills'), {
      trace: (op) => trace.push(op),
    })

    expect(r).toMatchObject({ ok: false, code: 'root-unsafe', path: file })
    expect(trace).toEqual([])
    expect(fs.readFileSync(file, 'utf8')).toBe('x')
  })
})

describe('ensureSkillsRoot: a component swapped for a symlink', () => {
  it('a symlink planted at a missing component before its mkdir is root-unsafe and nothing is made beyond it', async () => {
    const outside = path.join(base, 'outside')
    fs.mkdirSync(outside)
    const p1 = path.join(base, 'p1')
    const p2 = path.join(p1, 'p2')
    const skills = path.join(p2, 'skills')
    const trace: EnsureRootTraceOp[] = []

    const r = await ensureSkillsRoot(skills, {
      trace: (op) => {
        trace.push(op)
        // Between the walk and the mkdir: p2 appears as a symlink (EEXIST).
        if (op.op === 'mkdir' && op.path === p2) fs.symlinkSync(outside, p2)
      },
    })

    expect(r).toMatchObject({ ok: false, code: 'root-unsafe', path: p2, errno: null })
    expect(fs.lstatSync(p2).isSymbolicLink()).toBe(true)
    expect(fs.readdirSync(outside)).toEqual([])
    expect(exists(skills)).toBe(false)
    expect(trace.map((t) => t.path)).not.toContain(skills)
  })
})

describe('ensureSkillsRoot: the parent sync', () => {
  it('a failed sync is root-unsafe naming the sync errno, and stops before the next level', async () => {
    const p1 = path.join(base, 'p1')
    const skills = path.join(p1, 'skills')
    syncMock.mockImplementationOnce(async () => ({
      outcome: 'failed',
      // An uncommon code, so a hard-coded errno cannot pass for propagation.
      code: 'EDQUOT',
      error: new Error('EDQUOT'),
    }))

    const r = await ensureSkillsRoot(skills)

    expect(r).toMatchObject({ ok: false, code: 'root-unsafe', path: base, errno: 'EDQUOT' })
    expect(fs.lstatSync(p1).isDirectory()).toBe(true)
    expect(exists(skills)).toBe(false)
  })

  it('an unsupported sync is accepted', async () => {
    syncMock.mockImplementation(async () => ({ outcome: 'unsupported', code: 'EINVAL' }))
    const p1 = path.join(base, 'p1')
    const skills = path.join(p1, 'skills')

    expect(await ensureSkillsRoot(skills)).toEqual({ ok: true, created: [p1, skills] })
  })
})
