/**
 * SMI-6531 (A1 step 6d-ii, governance round): what restore reports when its lock
 * stops holding at each stage after something changed (the claim, the new name,
 * the record), that its lock 1 check runs before every write, and that the record
 * is only unlinked when it is still the one the plan read.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ParkedLockChanged, runLockedForTests } from '../../../src/config/file-lock.parked.js'
import { executeRestoreWith } from '../../../src/services/skill-restore.exec.js'
import type { RestoreHooks } from '../../../src/services/skill-restore.types.js'
import {
  indexKind,
  mkEnv,
  parkEntry,
  planOk,
  type Env,
  type Made,
} from './skill-restore.helpers.js'

let env: Env
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(env.base, { recursive: true, force: true })
})

type RunLock = NonNullable<RestoreHooks['runLock']>

function outside(type: 'dir' | 'file'): Made {
  const p = path.join(env.base, 'proj-outside')
  const m = parkEntry(p, 'thing', { caller: 'init-rollback', type })
  indexKind(env.stateRoot, m.copyPath, m.opId, 'init-rollback')
  return m
}

/** A lock 1prime runner whose `recheck` throws on its `at`-th call (1 is the first guard). */
const throwingAt =
  (at: number): RunLock =>
  (lockPath, label, fn, options) => {
    let n = 0
    return runLockedForTests(
      lockPath,
      label,
      (ctx) =>
        fn({
          recheck: () => {
            if (++n === at) throw new ParkedLockChanged(env.stateRoot, 'test swap')
            ctx.recheck()
          },
        }),
      options ?? {}
    ) as ReturnType<RunLock>
  }

describe('a lock that stops holding after something changed is reported for what was done', () => {
  it('(a) after the claim mkdir: the claim-left message, the empty folder stays, the copy and record stay', async () => {
    env = mkEnv()
    const m = outside('dir')
    const plan = await planOk(m.copyPath, env.opts)
    // calls: 1 initial, 2 before the claim, 3 immediately before the rename
    const r = await executeRestoreWith(plan, { runLock: throwingAt(3) })
    expect(r.status).toBe('stopped')
    if (r.status === 'restored') return
    expect(r.reason).toBe('claim-left')
    expect(r.changed).toBe(true)
    expect(r.message).toContain('an empty folder was created')
    expect(r.message).toContain('rmdir')
    expect(fs.readdirSync(m.origin)).toEqual([])
    expect(fs.existsSync(m.copyPath)).toBe(true)
    expect(fs.existsSync(m.sidecarPath)).toBe(true)
  })

  it('(b) after the link, before the parked unlink: both names are reported', async () => {
    env = mkEnv()
    const m = outside('file')
    const plan = await planOk(m.copyPath, env.opts)
    // calls: 1 initial, 2 before the link, 3 before the parked unlink
    const r = await executeRestoreWith(plan, { runLock: throwingAt(3) })
    expect(r.status).toBe('stopped')
    if (r.status === 'restored') return
    expect(r.reason).toBe('unlink-failed')
    expect(r.changed).toBe(true)
    expect(r.message).toContain(m.origin)
    expect(r.message).toContain(m.copyPath)
    expect(r.message).toContain('Both names are the same entry')
    expect(fs.existsSync(m.origin)).toBe(true)
    expect(fs.existsSync(m.copyPath)).toBe(true)
    expect(fs.existsSync(m.sidecarPath)).toBe(true)
  })

  it('(c) inside the record unlink after a successful restore: restored, with the by-hand warning', async () => {
    env = mkEnv()
    const m = outside('file')
    const plan = await planOk(m.copyPath, env.opts)
    // calls: 1 initial, 2 before the link, 3 before the parked unlink, 4 before the record unlink
    const r = await executeRestoreWith(plan, { runLock: throwingAt(4) })
    expect(r.status).toBe('restored')
    if (r.status !== 'restored') return
    expect(r.warnings.join(' ')).toContain('could not be removed')
    expect(r.warnings.join(' ')).toContain('remove it by hand')
    expect(r.warnings.join(' ')).toContain('the lock no longer holds')
    expect(fs.existsSync(m.origin)).toBe(true)
    expect(fs.existsSync(m.copyPath)).toBe(false)
    expect(fs.existsSync(m.sidecarPath)).toBe(true)
  })
})

describe('lock 1: the check runs before every write', () => {
  /** Throws on the `at`-th check; the first is the guard before the re-plan. */
  const failAt =
    (at: number): NonNullable<RestoreHooks['wrapCheck']> =>
    (real) => {
      let n = 0
      return () => {
        if (++n === at) throw new Error('forced check failure')
        real()
      }
    }

  it('before the claim: no mkdir, nothing at the origin', async () => {
    env = mkEnv()
    const m = parkEntry(env.root, 'skill-a')
    const plan = await planOk(m.copyPath, env.opts)
    const mkdir = vi.spyOn(fs.promises, 'mkdir')
    const r = await executeRestoreWith(plan, { wrapCheck: failAt(2) })
    expect(r.status).toBe('refused')
    if (r.status !== 'restored') {
      expect(r.changed).toBe(false)
      // Lock 1 is the skills folder's lock, not the set-aside-area lock.
      expect(r.reason).toBe('origin-root-unbindable')
      expect(r.message).toContain('skills folder lock')
    }
    expect(mkdir.mock.calls.map((c) => String(c[0]))).not.toContain(plan.target)
    expect(fs.existsSync(m.origin)).toBe(false)
    expect(fs.existsSync(m.copyPath)).toBe(true)
  })

  it('before the link: no link, nothing at the origin', async () => {
    env = mkEnv()
    const m = parkEntry(env.root, 'f.txt', { type: 'file' })
    const plan = await planOk(m.copyPath, env.opts)
    const link = vi.spyOn(fs, 'linkSync')
    const r = await executeRestoreWith(plan, { wrapCheck: failAt(2) })
    expect(r.status).toBe('refused')
    if (r.status !== 'restored') expect(r.reason).toBe('origin-root-unbindable')
    expect(link).not.toHaveBeenCalled()
    expect(fs.existsSync(m.origin)).toBe(false)
  })

  it('a root swapped after the plan was checked and before the lock: the lock refuses as the skills folder', async () => {
    env = mkEnv()
    const m = parkEntry(env.root, 'skill-a')
    const plan = await planOk(m.copyPath, env.opts)
    const r = await executeRestoreWith(plan, {
      beforeLock: () => {
        fs.renameSync(env.root, `${env.root}.aside`)
        fs.mkdirSync(env.root)
      },
    })
    expect(r.status).toBe('refused')
    if (r.status === 'restored') return
    expect(r.reason).toBe('origin-root-unbindable')
    expect(r.message).toContain('skills folder lock refused')
    expect(r.changed).toBe(false)
  })

  it('before the parked unlink: the link is done, neither the copy nor the record is unlinked', async () => {
    env = mkEnv()
    const m = parkEntry(env.root, 'f.txt', { type: 'file' })
    const plan = await planOk(m.copyPath, env.opts)
    const unlink = vi.spyOn(fs, 'unlinkSync')
    const r = await executeRestoreWith(plan, { wrapCheck: failAt(3) })
    expect(r.status).toBe('stopped')
    const unlinked = unlink.mock.calls.map((c) => String(c[0]))
    expect(unlinked).not.toContain(m.copyPath)
    expect(unlinked).not.toContain(m.sidecarPath)
    expect(fs.existsSync(m.origin)).toBe(true)
    expect(fs.existsSync(m.copyPath)).toBe(true)
  })
})

describe('the record is unlinked only when it is still the one the plan read', () => {
  const swapRecord =
    (m: Made, how: 'new-inode' | 'edited'): (() => void) =>
    () => {
      const bytes = fs.readFileSync(m.sidecarPath)
      if (how === 'edited') {
        fs.writeFileSync(m.sidecarPath, Buffer.concat([bytes, Buffer.from(' ')]))
        return
      }
      // Same bytes, a new inode: the new file exists before the old name is replaced.
      fs.writeFileSync(`${m.sidecarPath}.new`, bytes)
      fs.renameSync(`${m.sidecarPath}.new`, m.sidecarPath)
    }

  for (const how of ['new-inode', 'edited'] as const) {
    it(`${how}: restored, the record is left and reported`, async () => {
      env = mkEnv()
      const m = parkEntry(env.root, 'f.txt', { type: 'file' })
      const plan = await planOk(m.copyPath, env.opts)
      const r = await executeRestoreWith(plan, { beforeUnlink: swapRecord(m, how) })
      expect(r.status).toBe('restored')
      if (r.status !== 'restored') return
      expect(r.warnings.join(' ')).toContain('changed since it was read')
      expect(r.warnings.join(' ')).toContain('remove it by hand')
      expect(fs.existsSync(m.sidecarPath)).toBe(true)
      expect(fs.existsSync(m.copyPath)).toBe(false)
    })
  }
})
