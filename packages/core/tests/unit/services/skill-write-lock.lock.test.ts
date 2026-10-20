/**
 * SMI-6531 (A1 step 2): lock 1, in one process. The lock-level halves of
 * T-L6/T-L7 (writers on one root serialize), T-L14 (two spellings of one root
 * share one lock) and T-L15 (a root or staging directory swapped after the bind
 * is refused with nothing mutated). The cross-process halves are in
 * `skill-write-lock.cross-process.test.ts`.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LockOrderError, setLockTrackerEnabledForTests } from '../../../src/config/lock-tracker.js'
import { bindIdentity } from '../../../src/install/park-tree.identity.js'
import {
  bindSkillsRoot,
  SkillWriteStop,
  STAGING_DIR_NAME,
  withSkillWriteLock,
} from '../../../src/services/skill-write-lock.js'

let base: string
let warnSpy: ReturnType<typeof vi.spyOn>

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

function makeRoot(name: string): string {
  const root = path.join(base, name)
  fs.mkdirSync(root)
  return fs.realpathSync(root)
}

/** Every entry under `dir` with its type and, for a file or link, its content. */
function snapshot(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string, rel: string): void => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name)
      const st = fs.lstatSync(p)
      const r = path.join(rel, name)
      if (st.isSymbolicLink()) out.push(`${r} -> ${fs.readlinkSync(p)}`)
      else if (st.isDirectory()) {
        out.push(`${r}/`)
        walk(p, r)
      } else out.push(`${r} = ${fs.readFileSync(p, 'utf8')}`)
    }
  }
  walk(dir, '')
  return out
}

beforeEach(() => {
  setLockTrackerEnabledForTests(true)
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skill-write-lock-lock-')))
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(base, { recursive: true, force: true })
})

describe('T-L6/T-L7 (lock level): writers on one root serialize', () => {
  it('concurrent writers never overlap, and every one of them runs', async () => {
    const root = makeRoot('r')
    const events: string[] = []
    let active = 0
    let maxActive = 0
    const writer = async (i: number) =>
      withSkillWriteLock(root, `w${i}`, async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        events.push(`in:${i}`)
        for (let k = 0; k < 4; k++) await tick()
        events.push(`out:${i}`)
        active -= 1
        return i
      })
    const results = await Promise.all([0, 1, 2, 3, 4].map(writer))
    expect(results.every((r) => r.ok)).toBe(true)
    expect(results.map((r) => r.ok && r.value).sort()).toEqual([0, 1, 2, 3, 4])
    expect(maxActive).toBe(1)
    // Each window is a contiguous in/out pair: no other writer's entry between them.
    for (let k = 0; k < events.length; k += 2) {
      const id = (events[k] as string).split(':')[1]
      expect(events.slice(k, k + 2)).toEqual([`in:${id}`, `out:${id}`])
    }
    expect(events).toHaveLength(10)
  })

  it('control: writers on DIFFERENT roots do run at the same time', async () => {
    const a = makeRoot('a')
    const b = makeRoot('b')
    const entered = [deferred(), deferred()] as const
    const bothInside = (i: 0 | 1) =>
      withSkillWriteLock(i === 0 ? a : b, `w${i}`, async () => {
        entered[i].resolve()
        const other = entered[i === 0 ? 1 : 0].promise
        const timedOut = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`root ${i} never saw the other writer inside`)), 3000)
        )
        await Promise.race([other, timedOut])
        return 'both'
      })
    const results = await Promise.all([bothInside(0), bothInside(1)])
    expect(results).toEqual([
      { ok: true, value: 'both' },
      { ok: true, value: 'both' },
    ])
  })

  it('a second writer waits, then ends busy when its wait runs out, having run nothing', async () => {
    const root = makeRoot('r')
    const inside = deferred()
    const release = deferred()
    const holder = withSkillWriteLock(root, 'holder', async () => {
      inside.resolve()
      await release.promise
    })
    await inside.promise
    const fn = vi.fn(async () => 'ran')
    const t0 = performance.now()
    const second = await withSkillWriteLock(root, 'second', fn, { timeoutMs: 300 })
    const waited = performance.now() - t0
    expect(fn).not.toHaveBeenCalled()
    expect(second.ok).toBe(false)
    if (second.ok) throw new Error('unreachable')
    expect(second.stop).toBeInstanceOf(SkillWriteStop)
    expect(second.stop.code).toBe('busy')
    expect(second.stop.reason).toBe('held')
    expect(second.stop.detail.length).toBeGreaterThan(0)
    expect(waited).toBeGreaterThanOrEqual(250) // it waited; it did not refuse at once
    release.resolve()
    expect(await holder).toMatchObject({ ok: true })
    // Once released, the same request takes the lock: busy was the wait, not a dead end.
    expect(await withSkillWriteLock(root, 'third', fn, { timeoutMs: 300 })).toMatchObject({
      ok: true,
      value: 'ran',
    })
  })
})

describe('T-L14 (lock level): two spellings of one root share lock 1', () => {
  it('re-entry through a symlinked spelling is refused promptly as a LockOrderError', async () => {
    const root = makeRoot('real')
    const link = path.join(base, 'link')
    fs.symlinkSync(root, link)
    const inner = vi.fn(async () => 'ran')
    let refusal: unknown
    let ms = Infinity
    const outer = await withSkillWriteLock(root, 'outer', async () => {
      const t0 = performance.now()
      try {
        await withSkillWriteLock(link, 'inner', inner, { timeoutMs: 5000 })
      } catch (err) {
        refusal = err
      }
      ms = performance.now() - t0
      return 'outer'
    })
    expect(outer).toMatchObject({ ok: true, value: 'outer' })
    expect(refusal).toBeInstanceOf(LockOrderError)
    expect((refusal as LockOrderError).kind).toBe('re-entry')
    expect(ms).toBeLessThan(1000)
    expect(inner).not.toHaveBeenCalled()
  })

  it('concurrent writers through the two spellings never overlap', async () => {
    const root = makeRoot('real')
    const link = path.join(base, 'link')
    fs.symlinkSync(root, link)
    let active = 0
    let maxActive = 0
    const writer = (spelling: string, i: number) =>
      withSkillWriteLock(spelling, `w${i}`, async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        for (let k = 0; k < 4; k++) await tick()
        active -= 1
      })
    const results = await Promise.all([
      writer(root, 0),
      writer(link, 1),
      writer(root, 2),
      writer(link, 3),
    ])
    expect(results.every((r) => r.ok)).toBe(true)
    expect(maxActive).toBe(1)
  })
})

describe('T-L15 (lock level): a root or staging directory swapped after the bind is refused', () => {
  it('control: with nothing swapped the same call runs fn once', async () => {
    const root = makeRoot('r')
    const b = await bindSkillsRoot(root)
    const fn = vi.fn(async () => 'ran')
    expect(await withSkillWriteLock(b, 't', fn)).toMatchObject({ ok: true, value: 'ran' })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('ST replaced by a symlink: staging-unsafe, fn never runs, the link target is untouched', async () => {
    const root = makeRoot('r')
    const elsewhere = makeRoot('elsewhere')
    const b = await bindSkillsRoot(root)
    fs.rmSync(b.stagingDir, { recursive: true })
    fs.symlinkSync(elsewhere, b.stagingDir)
    const before = snapshot(root)
    const fn = vi.fn(async () => 'ran')
    const r = await withSkillWriteLock(b, 't', fn)
    expect(!r.ok && r.stop.code).toBe('staging-unsafe')
    expect(fn).not.toHaveBeenCalled()
    expect(snapshot(root)).toEqual(before)
    expect(fs.readdirSync(elsewhere)).toEqual([])
  })

  it('ST replaced by another directory: staging-unsafe, fn never runs', async () => {
    const root = makeRoot('r')
    const b = await bindSkillsRoot(root)
    fs.renameSync(b.stagingDir, `${b.stagingDir}.moved`)
    fs.mkdirSync(b.stagingDir)
    const fn = vi.fn(async () => 'ran')
    const r = await withSkillWriteLock(b, 't', fn)
    expect(!r.ok && r.stop.code).toBe('staging-unsafe')
    expect(fn).not.toHaveBeenCalled()
  })

  it.each([
    ['empty', false],
    ['a cp -R copy of the old one', true],
  ])(
    'R renamed away and recreated as %s: root-changed, nothing written to the recreated root',
    async (_l, copy) => {
      const root = makeRoot('r')
      const b = await bindSkillsRoot(root)
      fs.writeFileSync(path.join(root, 'keep.txt'), 'user data')
      const moved = path.join(base, 'moved')
      fs.renameSync(root, moved)
      if (copy) fs.cpSync(moved, root, { recursive: true })
      else fs.mkdirSync(root)
      const movedBefore = snapshot(moved)
      const recreatedBefore = snapshot(root)
      const fn = vi.fn(async () => 'ran')
      const r = await withSkillWriteLock(b, 't', fn)
      expect(!r.ok && r.stop.code).toBe('root-changed')
      expect(fn).not.toHaveBeenCalled()
      expect(snapshot(root)).toEqual(recreatedBefore)
      expect(snapshot(moved)).toEqual(movedBefore)
    }
  )

  it('a symlinked skillsDir retargeted after the bind: root-changed', async () => {
    const real = makeRoot('real')
    const other = makeRoot('other')
    const link = path.join(base, 'link')
    fs.symlinkSync(real, link)
    const b = await bindSkillsRoot(link)
    fs.rmSync(link)
    fs.symlinkSync(other, link)
    const fn = vi.fn(async () => 'ran')
    const r = await withSkillWriteLock(b, 't', fn)
    expect(!r.ok && r.stop.code).toBe('root-changed')
    expect(fn).not.toHaveBeenCalled()
    expect(fs.readdirSync(other)).toEqual([])
  })

  it('ST swapped while the writer waits for lock 1: refused on entry, under the lock, fn never runs', async () => {
    const root = makeRoot('r')
    const b = await bindSkillsRoot(root)
    const inside = deferred()
    const release = deferred()
    const holder = withSkillWriteLock(b.root, 'holder', async () => {
      inside.resolve()
      await release.promise
    })
    await inside.promise
    const fn = vi.fn(async () => 'ran')
    // The pre-lock check has already passed when this call starts waiting.
    const waiter = withSkillWriteLock(b, 'waiter', fn, { timeoutMs: 5000 })
    fs.renameSync(b.stagingDir, `${b.stagingDir}.moved`)
    fs.mkdirSync(b.stagingDir)
    release.resolve()
    await holder
    const r = await waiter
    expect(!r.ok && r.stop.code).toBe('staging-unsafe')
    expect(fn).not.toHaveBeenCalled()
  })
})

describe('ctx.check inside lock 1', () => {
  it('passes while nothing has changed', async () => {
    const root = makeRoot('r')
    const r = await withSkillWriteLock(root, 't', async (ctx) => {
      ctx.check()
      return 'ok'
    })
    expect(r).toMatchObject({ ok: true, value: 'ok' })
  })

  it('R renamed away and an empty directory recreated: root-changed, and the code after check does not run', async () => {
    const root = makeRoot('r')
    const after = vi.fn()
    const r = await withSkillWriteLock(root, 't', async (ctx) => {
      fs.renameSync(root, path.join(base, 'moved'))
      fs.mkdirSync(root)
      ctx.check()
      after()
    })
    expect(!r.ok && r.stop.code).toBe('root-changed')
    expect(after).not.toHaveBeenCalled()
    expect(snapshot(root)).toEqual([])
  })

  it('the lock file replaced under us: root-changed, though R itself is the same', async () => {
    const root = makeRoot('r')
    const r = await withSkillWriteLock(root, 't', async (ctx) => {
      ctx.check()
      // The replacement exists BEFORE the old file goes (rename over it), so the
      // two inodes coexist and cannot share a number: an unlink-then-create can
      // recycle the inode within one clock tick on overlayfs (SMI-7130).
      const replacement = `${ctx.lockPath}.replacement`
      fs.writeFileSync(replacement, 'someone else')
      fs.renameSync(replacement, ctx.lockPath)
      ctx.check()
    })
    expect(!r.ok && r.stop.code).toBe('root-changed')
    expect(!r.ok && r.stop.path).toMatch(/\.skillsmith-writes\.lock$/)
    expect(warnSpy).toHaveBeenCalled() // the release found a claim that is not ours and left it
  })

  it('ST swapped inside the lock: staging-unsafe', async () => {
    const root = makeRoot('r')
    const r = await withSkillWriteLock(root, 't', async (ctx) => {
      fs.renameSync(ctx.stagingDir, `${ctx.stagingDir}.moved`)
      fs.mkdirSync(ctx.stagingDir)
      ctx.check()
    })
    expect(!r.ok && r.stop.code).toBe('staging-unsafe')
  })

  it('an operation directory (scope.op) swapped: staging-unsafe; unswapped it passes', async () => {
    const root = makeRoot('r')
    const r = await withSkillWriteLock(root, 't', async (ctx) => {
      const op = path.join(ctx.stagingDir, 'op1')
      fs.mkdirSync(op)
      const identity = bindIdentity(op)
      if (!identity.ok) throw new Error('bind failed')
      ctx.check({ op: { path: op, identity } }) // control: unswapped passes
      fs.renameSync(op, `${op}.moved`)
      fs.mkdirSync(op)
      ctx.check({ op: { path: op, identity } })
    })
    expect(!r.ok && r.stop.code).toBe('staging-unsafe')
  })

  it('a backup-area component (scope.backupArea) swapped: backup-unsafe; unswapped it passes', async () => {
    const root = makeRoot('r')
    const area = path.join(base, 'backups')
    fs.mkdirSync(area)
    const identity = bindIdentity(area)
    if (!identity.ok) throw new Error('bind failed')
    const r = await withSkillWriteLock(root, 't', async (ctx) => {
      ctx.check({ backupArea: [{ path: area, identity }] }) // control: unswapped passes
      fs.renameSync(area, `${area}.moved`)
      fs.mkdirSync(area)
      ctx.check({ backupArea: [{ path: area, identity }] })
    })
    expect(!r.ok && r.stop.code).toBe('backup-unsafe')
  })

  it('anything else fn throws propagates; the stop is only for a check', async () => {
    const root = makeRoot('r')
    await expect(
      withSkillWriteLock(root, 't', async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(fs.existsSync(path.join(root, '.skillsmith-writes.lock'))).toBe(false)
    expect(fs.existsSync(path.join(root, STAGING_DIR_NAME))).toBe(true)
  })
})
