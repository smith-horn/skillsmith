/**
 * SMI-7143 (A1 step 0, part 2): T-M2, the release rules of
 * `skillsmith doctor locks` (A1 plan §3.9).
 *
 * T-M2 fails if `--release` without the unsafe flag removes a bare-PID claim,
 * an unparseable claim, an other-host claim, or a same-host claim whose pid is
 * alive; if it removes a lock whose inode or bytes changed after inspection;
 * and unless it removes a same-host v1 claim with a dead pid. Also here: a
 * claim it can't read is never released, a held `.reclaim` refuses, and the
 * listing reports each field.
 *
 * The dead pid is a child process that has exited. The can't-read case fails
 * `openSync` with EACCES for one path through a `node:fs` mock, since tests
 * run as root in the container, where file permissions wouldn't stop a read.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

const inject = vi.hoisted(() => ({
  deniedOpen: null as string | null,
  failAsideUnlink: false,
  failReadOf: null as string | null,
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const openSync = ((p: fs.PathLike, ...rest: unknown[]) => {
    if (inject.deniedOpen !== null && String(p) === inject.deniedOpen) {
      throw Object.assign(new Error(`EACCES: permission denied, open '${String(p)}'`), {
        code: 'EACCES',
      })
    }
    return (actual.openSync as (p: fs.PathLike, ...r: unknown[]) => number)(p, ...rest)
  }) as typeof actual.openSync
  const readSync = ((fd: number, ...rest: unknown[]) => {
    if (inject.failReadOf !== null) {
      throw Object.assign(new Error('EISDIR: illegal operation on a directory, read'), {
        code: 'EISDIR',
      })
    }
    return (actual.readSync as (fd: number, ...r: unknown[]) => number)(fd, ...rest)
  }) as typeof actual.readSync
  const unlinkSync = ((p: fs.PathLike) => {
    if (inject.failAsideUnlink && String(p).includes('.doctor-')) {
      throw Object.assign(new Error(`EBUSY: resource busy, unlink '${String(p)}'`), {
        code: 'EBUSY',
      })
    }
    return actual.unlinkSync(p)
  }) as typeof actual.unlinkSync
  return {
    ...actual,
    openSync,
    readSync,
    unlinkSync,
    default: { ...actual, openSync, readSync, unlinkSync },
  }
})

import { inspectLock, releaseLock, stateRootLockPaths } from '../../../src/config/lock-doctor.js'
import { probePidAlive, tryReclaimUnderLock } from '../../../src/config/owned-lock.claim.js'

/** Leftover rename-aside files beside the lock. */
function asideFiles(root: string): string[] {
  return fs.readdirSync(root).filter((n) => n.includes('.doctor-'))
}

const roots: string[] = []
afterEach(() => {
  inject.deniedOpen = null
  inject.failAsideUnlink = false
  inject.failReadOf = null
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

/** A fresh state root and its manifest lock path. */
function stateRoot(): { root: string; lockPath: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lock-doctor-')))
  roots.push(root)
  return { root, lockPath: stateRootLockPaths(root)[0]! }
}

/** The pid of a process that has exited. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', ''])
  expect(r.status).toBe(0)
  expect(() => process.kill(r.pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
  return r.pid!
}

function v1(pid: number, host = os.hostname()): string {
  return JSON.stringify({ v: 1, pid, token: 'abcdef0123456789', host, acquiredAt: 1 }) + '\n'
}

describe('T-M2: releasing without --unsafe-unverified-owner', () => {
  const unverifiable: Array<[string, () => string]> = [
    ['a bare-PID claim', () => String(deadPid())],
    ['an unparseable claim', () => 'not a claim'],
    ['an other-host claim with a dead pid here', () => v1(deadPid(), 'some-other-host')],
    ['a same-host claim whose pid is alive', () => v1(process.pid)],
  ]
  for (const [label, content] of unverifiable) {
    it(`does not remove ${label}`, () => {
      const { lockPath } = stateRoot()
      const text = content()
      fs.writeFileSync(lockPath, text)

      const r = releaseLock(lockPath)

      expect(r.outcome).toBe('refused')
      expect(r.outcome === 'refused' && r.refusal).toBe('unverified-owner')
      expect(fs.readFileSync(lockPath, 'utf8')).toBe(text)
      expect(fs.existsSync(`${lockPath}.reclaim`)).toBe(false)
    })
    it(`removes ${label} with the flag, naming why its owner was unverified`, () => {
      const { lockPath } = stateRoot()
      fs.writeFileSync(lockPath, content())

      const r = releaseLock(lockPath, { unsafeUnverifiedOwner: true })

      expect(r.outcome).toBe('released')
      expect(r.outcome === 'released' && r.unverifiedReason).toBeTruthy()
      expect(fs.existsSync(lockPath)).toBe(false)
      expect(fs.existsSync(`${lockPath}.reclaim`)).toBe(false)
    })
  }

  it('removes a same-host v1 claim whose pid is dead, and its reclaim lock afterwards', () => {
    const { lockPath } = stateRoot()
    fs.writeFileSync(lockPath, v1(deadPid()))

    const r = releaseLock(lockPath)

    expect(r.outcome).toBe('released')
    expect(r.outcome === 'released' && r.unverifiedReason).toBe(null)
    expect(fs.existsSync(lockPath)).toBe(false)
    expect(fs.existsSync(`${lockPath}.reclaim`)).toBe(false)
  })
})

describe('T-M2: the lock removed is the lock inspected', () => {
  it('refuses, removing nothing, when the bytes change after inspection', () => {
    const { lockPath } = stateRoot()
    fs.writeFileSync(lockPath, v1(deadPid()))
    const live = v1(process.pid)

    const r = releaseLock(lockPath, {
      beforeFinalCheck: () => fs.writeFileSync(lockPath, live), // same inode, new claim
    })

    expect(r.outcome === 'refused' && r.refusal).toBe('changed')
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(live)
    expect(fs.existsSync(`${lockPath}.reclaim`)).toBe(false)
  })

  it('refuses, removing nothing, when the inode changes after inspection, even with the same bytes', () => {
    const { root, lockPath } = stateRoot()
    const text = v1(deadPid())
    fs.writeFileSync(lockPath, text)
    const inoBefore = fs.statSync(lockPath).ino

    const r = releaseLock(lockPath, {
      beforeFinalCheck: () => {
        const other = path.join(root, 'other')
        fs.writeFileSync(other, text)
        fs.renameSync(other, lockPath)
      },
    })

    expect(r.outcome === 'refused' && r.refusal).toBe('changed')
    expect(fs.statSync(lockPath).ino).not.toBe(inoBefore)
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(text)
  })

  it('a newer lock put in place after inspection survives: released A, acquired B', () => {
    const { root, lockPath } = stateRoot()
    fs.writeFileSync(lockPath, v1(deadPid()))
    const b = v1(process.pid)

    const r = releaseLock(lockPath, {
      beforeFinalCheck: () => {
        fs.rmSync(lockPath) // A released
        fs.writeFileSync(lockPath, b, { flag: 'wx' }) // B acquired
      },
    })

    expect(r.outcome === 'refused' && r.refusal).toBe('changed')
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(b)
    expect(asideFiles(root)).toEqual([])
  })

  it('a newer lock put back whose extra name could not be removed is reported as back in place', () => {
    const { root, lockPath } = stateRoot()
    fs.writeFileSync(lockPath, v1(deadPid()))
    const b = v1(process.pid)

    const r = releaseLock(lockPath, {
      beforeFinalCheck: () => {
        fs.rmSync(lockPath)
        fs.writeFileSync(lockPath, b, { flag: 'wx' })
        inject.failAsideUnlink = true
      },
    })

    expect(r.outcome === 'refused' && r.refusal).toBe('changed')
    expect(r.outcome === 'refused' && r.message).toContain('the newer lock is back in place')
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(b)
    expect(asideFiles(root)).toHaveLength(1)
  })

  it('a newer lock that cannot be put back (a third lock took the path) is left aside and named', () => {
    const { root, lockPath } = stateRoot()
    fs.writeFileSync(lockPath, v1(deadPid()))
    const b = v1(process.pid)
    const c = v1(process.pid, 'third-holder')

    const r = releaseLock(lockPath, {
      beforeFinalCheck: () => {
        fs.rmSync(lockPath)
        fs.writeFileSync(lockPath, b, { flag: 'wx' })
      },
      afterMoveAside: () => fs.writeFileSync(lockPath, c, { flag: 'wx' }),
    })

    expect(r.outcome === 'refused' && r.refusal).toBe('changed')
    const aside = asideFiles(root)
    expect(aside).toHaveLength(1)
    expect(fs.readFileSync(path.join(root, aside[0]!), 'utf8')).toBe(b)
    expect(r.outcome === 'refused' && r.message).toContain(path.join(root, aside[0]!))
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(c)
  })

  it('holds the reclaim lock while it decides: an owned-lock reclaimer is shut out', () => {
    const { lockPath } = stateRoot()
    fs.writeFileSync(lockPath, v1(deadPid()))
    let reclaimer: string | null = null

    const r = releaseLock(lockPath, {
      beforeFinalCheck: () => {
        reclaimer = tryReclaimUnderLock(lockPath, `${lockPath}.reclaim`, {
          reclaimLockTimeoutMs: 0,
        })
      },
    })

    expect(reclaimer).toBe('unavailable')
    expect(r.outcome).toBe('released')
  })

  it('refuses as gone when the lock disappears after inspection', () => {
    const { root, lockPath } = stateRoot()
    fs.writeFileSync(lockPath, v1(deadPid()))

    const r = releaseLock(lockPath, { beforeFinalCheck: () => fs.rmSync(lockPath) })

    expect(r.outcome === 'refused' && r.refusal).toBe('gone')
    expect(asideFiles(root)).toEqual([])
  })

  it('refuses when the lock is not the one the caller showed (expected)', () => {
    const { lockPath } = stateRoot()
    const text = String(deadPid())
    fs.writeFileSync(lockPath, text)
    const shown = { ino: BigInt(fs.statSync(lockPath).ino), bytes: Buffer.from('other claim') }

    const r = releaseLock(lockPath, { unsafeUnverifiedOwner: true, expected: shown })

    expect(r.outcome === 'refused' && r.refusal).toBe('changed')
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(text)
  })

  it('refuses while another process holds the reclaim lock, removing nothing', () => {
    const { lockPath } = stateRoot()
    const text = v1(deadPid())
    fs.writeFileSync(lockPath, text)
    fs.writeFileSync(`${lockPath}.reclaim`, v1(process.pid))

    const r = releaseLock(lockPath)

    expect(r.outcome === 'refused' && r.refusal).toBe('reclaim-held')
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(text)
    expect(fs.existsSync(`${lockPath}.reclaim`)).toBe(true)
  })
})

describe("a claim doctor can't read or compare is never released", () => {
  it("refuses an unreadable claim, with or without the flag, naming its owner's uid", () => {
    const { lockPath } = stateRoot()
    fs.writeFileSync(lockPath, String(deadPid()))
    inject.deniedOpen = lockPath

    for (const unsafeUnverifiedOwner of [false, true]) {
      const r = releaseLock(lockPath, { unsafeUnverifiedOwner })
      expect(r.outcome === 'refused' && r.refusal).toBe('cant-read')
      expect(r.outcome === 'refused' && r.message).toContain(`uid ${fs.statSync(lockPath).uid}`)
    }
    expect(fs.existsSync(lockPath)).toBe(true)
  })

  it('refuses a symlink at the lock path, with the flag, and leaves it', () => {
    const { root, lockPath } = stateRoot()
    fs.symlinkSync(path.join(root, 'nowhere'), lockPath)

    const r = releaseLock(lockPath, { unsafeUnverifiedOwner: true })

    expect(r.outcome === 'refused' && r.refusal).toBe('not-comparable')
    expect(fs.lstatSync(lockPath).isSymbolicLink()).toBe(true)
  })

  it('refuses an oversize lock as not comparable, with the flag', () => {
    const { lockPath } = stateRoot()
    fs.writeFileSync(lockPath, 'x'.repeat(5000))

    const r = releaseLock(lockPath, { unsafeUnverifiedOwner: true })

    expect(r.outcome === 'refused' && r.refusal).toBe('not-comparable')
    expect(fs.statSync(lockPath).size).toBe(5000)
  })

  it('a read that fails after open is unparseable and not comparable, never a throw', () => {
    const { lockPath } = stateRoot()
    fs.writeFileSync(lockPath, v1(deadPid()))
    inject.failReadOf = lockPath

    const i = inspectLock(lockPath)!
    expect(i.kind).toBe('unparseable')
    expect(i.note).toContain('EISDIR')
    const r = releaseLock(lockPath, { unsafeUnverifiedOwner: true })
    expect(r.outcome === 'refused' && r.refusal).toBe('not-comparable')
    inject.failReadOf = null
    expect(fs.existsSync(lockPath)).toBe(true)
  })

  it('refuses when nothing is there', () => {
    const { lockPath } = stateRoot()
    const r = releaseLock(lockPath)
    expect(r.outcome === 'refused' && r.refusal).toBe('absent')
  })
})

describe('probePidAlive, the liveness probe owned-lock and doctor share', () => {
  it('does not probe a pid that is not a positive safe integer', () => {
    for (const pid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2])
      expect(probePidAlive(pid)).toBe(null)
  })
  it('alive for this process, dead for an exited one, alive for EPERM', () => {
    expect(probePidAlive(process.pid)).toBe(true)
    expect(probePidAlive(deadPid())).toBe(false)
    const eperm = (() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
    }) as unknown as typeof process.kill
    expect(probePidAlive(4242, eperm)).toBe(true)
  })
})

describe('inspectLock reports what it can know', () => {
  it('a same-host v1 claim: pid, host, same host, alive here, and age', () => {
    const { lockPath } = stateRoot()
    fs.writeFileSync(lockPath, v1(process.pid))
    const past = new Date(Date.now() - 40_000)
    fs.utimesSync(lockPath, past, past)

    const i = inspectLock(lockPath)!

    expect(i.kind).toBe('v1')
    expect(i.pid).toBe(process.pid)
    expect(i.host).toBe(os.hostname())
    expect(i.sameHost).toBe(true)
    expect(i.pidAliveHere).toBe(true)
    expect(i.ageNs).toBeGreaterThanOrEqual(39_000_000_000n)
    expect(i.ageNs).toBeLessThan(60_000_000_000n)
  })

  it("another host's claim is not probed; a bare-PID claim names no host", () => {
    const { lockPath } = stateRoot()
    fs.writeFileSync(lockPath, v1(process.pid, 'some-other-host'))
    const other = inspectLock(lockPath)!
    expect(other.sameHost).toBe(false)
    expect(other.pidAliveHere).toBe(null)

    fs.writeFileSync(lockPath, String(process.pid))
    const bare = inspectLock(lockPath)!
    expect(bare.kind).toBe('bare-pid')
    expect(bare.host).toBe(null)
    expect(bare.sameHost).toBe(null)
    expect(bare.pidAliveHere).toBe(true)
  })

  it('an absent lock is null; the state root lists the manifest lock and its reclaim lock', () => {
    const { root, lockPath } = stateRoot()
    expect(inspectLock(lockPath)).toBe(null)
    expect(stateRootLockPaths(root)).toEqual([
      path.join(root, 'manifest.json.lock'),
      path.join(root, 'manifest.json.lock.reclaim'),
    ])
  })
})
