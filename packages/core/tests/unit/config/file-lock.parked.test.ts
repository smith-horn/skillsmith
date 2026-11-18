/**
 * SMI-6531 (A1 step 6c-ii-b, 6d-i): `parkedLockPath` is the PLAN:915 formula,
 * `<stateRoot>/locks/parked-<first 16 hex of sha256(areaReal)>.lock` (M-L1);
 * `withParkedAreaLock` takes it as lock 1′ and guards the `locks/` directory
 * (design note §3.3, W1, W2, W4-W10; W3 is in lock-ranks.call-sites.test.ts).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ParkedLockChanged,
  parkedLockPath,
  parkedLockTarget,
  runLockedForTests,
  strandedOf,
  withParkedAreaLock,
  type ParkedLockHooks,
} from '../../../src/config/file-lock.parked.js'
import { StuckLockError } from '../../../src/config/owned-lock.js'
import {
  assertSkillWriteLockNotHeld,
  LockOrderError,
  runPureCallback,
  setLockTrackerEnabledForTests,
} from '../../../src/config/lock-tracker.js'
import { withSkillWriteLock } from '../../../src/services/skill-write-lock.js'

describe('parkedLockPath', () => {
  it('is the PLAN:915 formula on a fixed realpath', () => {
    // sha256('/srv/skillsmith/area') = e2b1ec75336d8f3d..., measured with shasum -a 256.
    expect(parkedLockPath('/state', '/srv/skillsmith/area')).toBe(
      '/state/locks/parked-e2b1ec75336d8f3d.lock'
    )
    expect(parkedLockTarget('/state', '/srv/skillsmith/area')).toBe(
      '/state/locks/parked-e2b1ec75336d8f3d'
    )
  })

  it('keys on the area, so two areas never share a lock and one area always does', () => {
    const a = parkedLockPath('/state', '/srv/a')
    expect(parkedLockPath('/state', '/srv/b')).not.toBe(a)
    expect(parkedLockPath('/state', '/srv/a')).toBe(a)
  })

  it('hashes the UTF-8 bytes of the realpath', () => {
    expect(parkedLockPath('/s', '/srv/\u{1F600}')).toMatch(
      /^\/s\/locks\/parked-[0-9a-f]{16}\.lock$/
    )
    expect(parkedLockPath('/s', '/srv/\u{1F600}')).not.toBe(parkedLockPath('/s', '/srv/ｚ'))
  })
})

let root: string
let stateRoot: string
let lockPath: string
let locksDir: string

beforeEach(() => {
  setLockTrackerEnabledForTests(true)
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'parked-lock-')))
  stateRoot = path.join(root, 'state')
  fs.mkdirSync(stateRoot)
  lockPath = parkedLockPath(stateRoot, '/srv/skillsmith/area')
  locksDir = path.join(stateRoot, 'locks')
})

afterEach(() => {
  vi.restoreAllMocks()
  setLockTrackerEnabledForTests(true)
  fs.rmSync(root, { recursive: true, force: true })
})

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (error) {
    return error
  }
  return undefined
}

/** Replace `locks/` by a symlink to a fresh directory T; returns T. */
function swapForSymlink(): string {
  const target = path.join(root, 'T')
  fs.renameSync(locksDir, path.join(root, 'locks.aside'))
  fs.mkdirSync(target)
  fs.symlinkSync(target, locksDir)
  return target
}

const LOCK_NAME = 'parked-e2b1ec75336d8f3d.lock'

/** Move `locks/` aside to `locks.moved` and put a fresh private one in its place. */
function swapFreshDir(): void {
  fs.renameSync(locksDir, path.join(root, 'locks.moved'))
  fs.mkdirSync(locksDir, { mode: 0o700 })
}

describe('withParkedAreaLock', () => {
  it('W1: holds exactly <stateRoot>/locks/parked-<key>.lock while fn runs, and releases it', async () => {
    let during: string[] = []
    let existsDuring = false
    let doubledDuring = true
    const r = await withParkedAreaLock(lockPath, 'w1', async () => {
      existsDuring = fs.existsSync(lockPath)
      doubledDuring = fs.existsSync(`${lockPath}.lock`)
      during = fs.readdirSync(locksDir)
    })
    expect(r.ok).toBe(true)
    expect(lockPath).toBe(path.join(stateRoot, 'locks', 'parked-e2b1ec75336d8f3d.lock'))
    expect(existsDuring).toBe(true)
    expect(doubledDuring).toBe(false)
    expect(during).toEqual([LOCK_NAME])
    expect(fs.existsSync(lockPath)).toBe(false)
    // The run created locks/, so its mode is the one the wrapper asked for.
    expect(fs.lstatSync(locksDir).mode & 0o777).toBe(0o700)
  })

  it('W2: is refused inside lock 1 (second-skills-root-lock) and creates no locks/', async () => {
    const skills = path.join(root, 'skills')
    fs.mkdirSync(skills)
    let inner: unknown
    const outer = await withSkillWriteLock(skills, 'outer lock 1', async () => {
      inner = await rejection(withParkedAreaLock(lockPath, 'w2', async () => 'ran'))
    })
    expect(outer.ok).toBe(true)
    expect(inner).toBeInstanceOf(LockOrderError)
    expect((inner as LockOrderError).kind).toBe('second-skills-root-lock')
    expect(fs.existsSync(locksDir)).toBe(false)
  })

  it('W4: a prompt wrapper trips inside fn (the lock is a skills-root lock)', async () => {
    let thrown: unknown
    await withParkedAreaLock(lockPath, 'w4', async () => {
      try {
        assertSkillWriteLockNotHeld('x')
      } catch (error) {
        thrown = error
      }
    })
    expect(thrown).toBeInstanceOf(LockOrderError)
    expect((thrown as LockOrderError).kind).toBe('held-while-planning')
  })

  it('W5: a second acquisition while the first holds returns busy and never runs', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered: () => void = () => {}
    const firstIn = new Promise<void>((resolve) => {
      entered = resolve
    })
    const first = withParkedAreaLock(lockPath, 'first', async () => {
      entered()
      await gate
    })
    await firstIn
    let secondRan = false
    const second = await withParkedAreaLock(
      lockPath,
      'second',
      async () => {
        secondRan = true
      },
      { timeoutMs: 200 }
    )
    release()
    await first
    expect(second.ok).toBe(false)
    if (second.ok) throw new Error('unreachable')
    expect(second.stop.code).toBe('busy')
    expect(second.stop).toMatchObject({ lockPath, reason: 'held' })
    expect(secondRan).toBe(false)
  })

  it('W6: an absent state root is state-root-missing and nothing is created', async () => {
    const missing = path.join(root, 'missing-state')
    const before = fs.readdirSync(root).sort()
    const r = await withParkedAreaLock(parkedLockPath(missing, '/srv/a'), 'w6', async () => 1)
    expect(r).toEqual({ ok: false, stop: { code: 'state-root-missing', path: missing } })
    expect(fs.readdirSync(root).sort()).toEqual(before)
  })

  it('W7a: a locks/ that is a symlink is locks-dir-unsafe and its target stays empty', async () => {
    const elsewhere = path.join(root, 'elsewhere')
    fs.mkdirSync(elsewhere)
    fs.symlinkSync(elsewhere, locksDir)
    let ran = false
    const r = await withParkedAreaLock(lockPath, 'w7a', async () => {
      ran = true
    })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.stop.code).toBe('locks-dir-unsafe')
    expect(ran).toBe(false)
    expect(fs.readdirSync(elsewhere)).toEqual([])
  })

  // Each guard of check 1 has a fixture that only it catches (the symlink above is caught by
  // several). The realpath-equality guard has none and was removed (see bindLocksDir).
  async function expectUnsafe(): Promise<void> {
    let ran = false
    const r = await withParkedAreaLock(lockPath, 'w7a', async () => {
      ran = true
    })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.stop.code).toBe('locks-dir-unsafe')
    expect(ran).toBe(false)
  }

  it('W7a (isDirectory only): a private regular file at locks/ is locks-dir-unsafe', async () => {
    fs.writeFileSync(locksDir, '', { mode: 0o600 })
    await expectUnsafe()
  })

  it.each([0o770, 0o707])(
    'W7a (mode only): a real locks/ directory with mode %o is locks-dir-unsafe',
    async (mode) => {
      fs.mkdirSync(locksDir)
      fs.chmodSync(locksDir, mode)
      await expectUnsafe()
    }
  )

  it.skipIf(process.getuid?.() !== 0)(
    'W7a (uid only): a private locks/ directory owned by another user is locks-dir-unsafe',
    async () => {
      fs.mkdirSync(locksDir, { mode: 0o700 })
      fs.chownSync(locksDir, 12345, 12345)
      await expectUnsafe()
    }
  )

  it('a state root that is a symlink to a real directory works', async () => {
    const link = path.join(root, 'state-link')
    fs.symlinkSync(stateRoot, link)
    const r = await withParkedAreaLock(parkedLockPath(link, '/srv/a'), 'linked', async () => 7)
    expect(r).toEqual({ ok: true, value: 7 })
  })

  it('W7b: a swap after validation stops before anything is created (check 2)', async () => {
    let target = ''
    let ran = false
    const r = await runLockedForTests(
      lockPath,
      'w7b',
      async () => {
        ran = true
      },
      { hooks: { afterValidate: () => void (target = swapForSymlink()) } }
    )
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.stop.code).toBe('locks-dir-changed')
    // Check 2 stops before the claim exists; check 3 would stop after it.
    expect(r.stop).toMatchObject({ detail: expect.stringContaining('before the lock') })
    expect(ran).toBe(false)
    expect(fs.readdirSync(target)).toEqual([])
    expect(fs.readdirSync(path.join(root, 'locks.aside'))).toEqual([])
  })

  it('W7c: a swap after check 2 never runs fn and leaves no claim or temp in the replacement', async () => {
    let target = ''
    let ran = false
    const r = await runLockedForTests(
      lockPath,
      'w7c',
      async () => {
        ran = true
      },
      { hooks: { afterRecheck: () => void (target = swapForSymlink()) } }
    )
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.stop.code).toBe('locks-dir-changed')
    expect(r.stop).not.toMatchObject({ detail: expect.stringContaining('before the lock') })
    expect(ran).toBe(false)
    expect(fs.readdirSync(target)).toEqual([])
    // Check 3 cannot tell a swap before the link (the claim was made in the
    // replacement and released) from one after it, and does not guess from what
    // is visible at the path, so it reports an uncertain stranded claim.
    expect(r.stranded).toMatchObject({ certain: false, lockName: LOCK_NAME })
    expect(r.stranded?.claim).toBeUndefined()
  })

  describe('W10: a swap after check 3', () => {
    const swapFresh = (decoy: boolean): (() => void) => {
      return () => {
        fs.renameSync(locksDir, path.join(root, 'locks.moved'))
        fs.mkdirSync(locksDir, { mode: 0o700 })
        if (decoy) fs.writeFileSync(lockPath, 'decoy')
      }
    }
    const run = (decoy: boolean): Promise<Awaited<ReturnType<typeof runSwapped>>> =>
      runSwapped(decoy ? { beforeFn: swapFresh(true) } : { beforeFn: swapFresh(false) })

    async function runSwapped(hooks: ParkedLockHooks) {
      return runLockedForTests(
        lockPath,
        'w10',
        async (ctx) => {
          try {
            ctx.recheck()
            return null
          } catch (error) {
            return error
          }
        },
        { hooks }
      )
    }

    it('throws ParkedLockChanged from recheck and reports the real stranded claim', async () => {
      const r = await run(false)
      expect(r.ok).toBe(true)
      if (!r.ok) throw new Error('unreachable')
      expect(r.value).toBeInstanceOf(ParkedLockChanged)
      const stranded = r.stranded
      expect(stranded).toBeDefined()
      const moved = fs.lstatSync(path.join(root, 'locks.moved', LOCK_NAME), { bigint: true })
      // The stranding is real: the claim file is still in the moved directory.
      expect(stranded?.certain).toBe(true)
      expect(stranded?.claim).toEqual({ dev: moved.dev, ino: moved.ino })
      expect(stranded?.lockName).toBe(LOCK_NAME)
      const movedDir = fs.lstatSync(path.join(root, 'locks.moved'), { bigint: true })
      expect(stranded?.locksDir).toEqual({ dev: movedDir.dev, ino: movedDir.ino })
      expect(fs.existsSync(lockPath)).toBe(false)
    })

    it('a ParkedLockChanged that fn lets propagate still carries the stranded claim', async () => {
      const error = await rejection(
        runLockedForTests(
          lockPath,
          'w10d',
          async (ctx) => {
            ctx.recheck()
          },
          { hooks: { beforeFn: swapFresh(false) } }
        )
      )
      expect(error).toBeInstanceOf(ParkedLockChanged)
      const stranded = strandedOf(error)
      expect(stranded).toBeDefined()
      const moved = fs.lstatSync(path.join(root, 'locks.moved', LOCK_NAME), { bigint: true })
      expect(stranded?.claim).toEqual({ dev: moved.dev, ino: moved.ino })
      expect(stranded?.lockName).toBe(LOCK_NAME)
    })

    it('recheck also rejects a replacement holding a file at the claim path', async () => {
      const r = await run(true)
      expect(r.ok).toBe(true)
      if (!r.ok) throw new Error('unreachable')
      expect(r.value).toBeInstanceOf(ParkedLockChanged)
      expect(r.stranded).toBeDefined()
    })
  })

  it('W10 (control): with no swap, recheck passes and nothing is stranded', async () => {
    let checked: unknown = 'unset'
    const r = await withParkedAreaLock(lockPath, 'w10c', async (ctx) => {
      ctx.recheck()
      checked = null
    })
    expect(r.ok).toBe(true)
    expect(checked).toBeNull()
    if (r.ok) expect(r.stranded).toBeUndefined()
  })

  it('W10 (afterAcquire): a swap between the claim and check 3 still reports the stranded claim', async () => {
    let ran = false
    const r = await runLockedForTests(
      lockPath,
      'w10e',
      async () => {
        ran = true
      },
      {
        hooks: {
          afterAcquire: () => {
            fs.renameSync(locksDir, path.join(root, 'locks.moved'))
            fs.mkdirSync(locksDir, { mode: 0o700 })
          },
        },
      }
    )
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.stop.code).toBe('locks-dir-changed')
    expect(ran).toBe(false)
    // The stranding is real: the claim is in the folder that moved away.
    expect(fs.existsSync(path.join(root, 'locks.moved', LOCK_NAME))).toBe(true)
    expect(r.stranded).toBeDefined()
    expect(r.stranded?.certain).toBe(false)
    expect(r.stranded?.lockName).toBe(LOCK_NAME)
    const movedDir = fs.lstatSync(path.join(root, 'locks.moved'), { bigint: true })
    expect(r.stranded?.locksDir).toEqual({ dev: movedDir.dev, ino: movedDir.ino })
    expect(r.stranded?.claim).toBeUndefined()
    expect(r.stranded?.detail).toMatch(/may have been left/)
  })

  it('W10 (afterAcquire + decoy): a file planted at the lock path in the replacement changes nothing', async () => {
    let ran = false
    const r = await runLockedForTests(
      lockPath,
      'w10f',
      async () => {
        ran = true
      },
      {
        hooks: {
          afterAcquire: () => {
            fs.renameSync(locksDir, path.join(root, 'locks.moved'))
            fs.mkdirSync(locksDir, { mode: 0o700 })
            fs.writeFileSync(lockPath, 'decoy')
          },
        },
      }
    )
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.stop.code).toBe('locks-dir-changed')
    expect(ran).toBe(false)
    expect(fs.existsSync(path.join(root, 'locks.moved', LOCK_NAME))).toBe(true)
    expect(r.stranded).toMatchObject({ certain: false, lockName: LOCK_NAME })
  })

  describe('W5b: a StuckLockError from fn is not a busy stop', () => {
    const stuck = (p: string): StuckLockError =>
      Object.assign(Object.create(StuckLockError.prototype) as StuckLockError, {
        lockPath: p,
        reclaimPath: `${p}.reclaim`,
        reason: 'held' as const,
      })

    it.each([
      ['the same lock path', () => lockPath],
      ['another lock path', () => path.join(locksDir, 'parked-0000000000000000.lock')],
    ])('rejects with that exact error (%s)', async (_name, pick) => {
      const thrown = stuck(pick())
      const error = await rejection(
        withParkedAreaLock(lockPath, 'w5b', async () => {
          throw thrown
        })
      )
      expect(error).toBe(thrown)
    })
  })

  it('the tracker refusal inside a pure callback is not an unhandled rejection', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      let refusal: unknown
      try {
        runPureCallback(() => {
          void withParkedAreaLock(lockPath, 'pure', async () => 1)
        })
      } catch (error) {
        refusal = error
      }
      await new Promise((resolve) => setImmediate(resolve))
      await new Promise((resolve) => setImmediate(resolve))
      expect(refusal).toBeInstanceOf(LockOrderError)
      expect((refusal as LockOrderError).kind).toBe('in-pure-callback')
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    expect(fs.existsSync(locksDir)).toBe(false)
  })

  it('one error object reused across calls reports stranded only for the call that stranded', async () => {
    const shared = new Error('shared')
    await rejection(
      runLockedForTests(
        lockPath,
        'first',
        async () => {
          throw shared
        },
        { hooks: { beforeFn: swapFreshDir } }
      )
    )
    expect(strandedOf(shared)).toBeDefined()
    fs.rmSync(path.join(root, 'locks.moved'), { recursive: true, force: true })
    const second = await rejection(
      withParkedAreaLock(lockPath, 'second', async () => {
        throw shared
      })
    )
    expect(second).toBe(shared)
    expect(strandedOf(shared)).toBeUndefined()
  })

  it('a locks/ removed between check 2 and the claim is locks-dir-changed, not a raw ENOENT', async () => {
    let ran = false
    const r = await runLockedForTests(
      lockPath,
      'removed',
      async () => {
        ran = true
      },
      { hooks: { afterRecheck: () => fs.rmSync(locksDir, { recursive: true }) } }
    )
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.stop.code).toBe('locks-dir-changed')
    expect(r.stop).toMatchObject({ detail: expect.stringContaining('removed') })
    expect(ran).toBe(false)
  })

  it('the public signature has no test hooks (type-level: the directive below must stay needed)', async () => {
    const r = await withParkedAreaLock(
      lockPath,
      'public',
      async () => 1,
      // @ts-expect-error hooks are internal; only runLockedForTests takes them
      { hooks: {} }
    )
    expect(r).toEqual({ ok: true, value: 1 })
  })

  describe('a claim that is not our own', () => {
    /** Another valid v1 claim (a different pid), written over the same file: same inode, new content. */
    const foreignRecord =
      JSON.stringify({
        v: 1,
        pid: process.pid + 1,
        token: 'foreign-token',
        host: os.hostname(),
        acquiredAt: Date.now(),
      }) + '\n'
    const overwriteInPlace = (): void => fs.writeFileSync(lockPath, foreignRecord)

    it('afterAcquire: check 3 stops, fn never runs, and nothing is reported as ours', async () => {
      let ran = false
      const r = await runLockedForTests(
        lockPath,
        'foreign-a',
        async () => {
          ran = true
        },
        { hooks: { afterAcquire: overwriteInPlace } }
      )
      expect(ran).toBe(false)
      expect(r.ok).toBe(false)
      if (r.ok) throw new Error('unreachable')
      expect(r.stop.code).toBe('locks-dir-changed')
      expect(r.stop).toMatchObject({ detail: expect.stringContaining('claim-not-ours') })
      expect(r.stranded).toBeUndefined()
    })

    it('afterAcquire: a claim with our pid but another host is not ours', async () => {
      let ran = false
      const sameInodeOtherHost = (): void =>
        fs.writeFileSync(
          lockPath,
          JSON.stringify({
            v: 1,
            pid: process.pid,
            token: 'other-host-token',
            host: `${os.hostname()}-elsewhere`,
            acquiredAt: Date.now(),
          }) + '\n'
        )
      const r = await runLockedForTests(
        lockPath,
        'foreign-host',
        async () => {
          ran = true
        },
        { hooks: { afterAcquire: sameInodeOtherHost } }
      )
      expect(ran).toBe(false)
      expect(r.ok).toBe(false)
      if (r.ok) throw new Error('unreachable')
      expect(r.stop).toMatchObject({ detail: expect.stringContaining('claim-not-ours') })
    })

    it('beforeFn (after check 3): recheck() throws ParkedLockChanged', async () => {
      const r = await runLockedForTests(
        lockPath,
        'foreign-b',
        async (ctx) => {
          try {
            ctx.recheck()
            return null
          } catch (error) {
            return error
          }
        },
        { hooks: { beforeFn: overwriteInPlace } }
      )
      expect(r.ok).toBe(true)
      if (!r.ok) throw new Error('unreachable')
      expect(r.value).toBeInstanceOf(ParkedLockChanged)
      expect(String((r.value as Error).message)).toMatch(/not this process/)
    })

    it('a move of locks/ after the replacement never reports the foreign claim as ours', async () => {
      let ran = false
      const r = await runLockedForTests(
        lockPath,
        'foreign-c',
        async () => {
          ran = true
          fs.renameSync(locksDir, path.join(root, 'locks.moved'))
          fs.mkdirSync(locksDir, { mode: 0o700 })
        },
        { hooks: { afterAcquire: overwriteInPlace } }
      )
      expect(r.ok).toBe(false)
      expect(r.stranded).toBeUndefined()
      expect(ran).toBe(false)
    })
  })

  it('W8: an error from fn propagates and the lock is released', async () => {
    const boom = new Error('boom')
    const error = await rejection(
      withParkedAreaLock(lockPath, 'w8', async () => {
        throw boom
      })
    )
    expect(error).toBe(boom)
    expect(strandedOf(error)).toBeUndefined()
    expect(fs.existsSync(lockPath)).toBe(false)
  })

  it('W9: a path that is not a lock 1′ file is a TypeError before any fs call', async () => {
    const mkdir = vi.spyOn(fs, 'mkdirSync')
    const lstat = vi.spyOn(fs, 'lstatSync')
    const lockOne = path.join(root, 'skills', '.skillsmith-writes.lock')
    let ran = false
    const error = await rejection(
      withParkedAreaLock(lockOne, 'w9', async () => {
        ran = true
      })
    )
    expect(error).toBeInstanceOf(TypeError)
    expect(ran).toBe(false)
    expect(mkdir).not.toHaveBeenCalled()
    expect(lstat).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(root, 'locks'))).toBe(false)
  })
})
