/**
 * SMI-6531: a park that cannot rename never deletes (ADR-166 D-4), ported from
 * the SMI-6676 spike's `harness/test-quarantine-errnos.mjs`, with A1 plan row
 * Q7's cases.
 *
 * The spike forced each errno with real mounts, chmod and a second user, which
 * needs a privileged Linux container and a non-root uid. Those cases run only
 * there (they skip, with that reason, in the dev container, which is root
 * without CAP_SYS_ADMIN). Every errno is also forced deterministically at each
 * failure point through the fs default object, so the invariant (nothing
 * moves, nothing is deleted, the errno is reported) runs everywhere.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PARKED,
  cleanup,
  countDeletes,
  errnoError,
  exists,
  guardOf,
  park,
  readText,
  simpleFixture,
  withFsStub,
} from './park-tree.helpers.js'
import type { Fixture } from './park-tree.helpers.js'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r)
})
const fixture = (): Fixture => {
  const f = simpleFixture('park-errno-', 'user-data-f2')
  fs.writeFileSync(path.join(f.origin, 'f1'), 'user-data-f1')
  roots.push(f.root)
  return f
}
const untouched = (f: Fixture) => {
  expect(readText(path.join(f.origin, 'f1'))).toBe('user-data-f1')
  expect(readText(path.join(f.origin, 'sub', 'f.txt'))).toBe('user-data-f2')
}

const ERRNOS = ['EXDEV', 'EACCES', 'EROFS', 'EBUSY', 'ENOSPC', 'EPERM'] as const

describe('every errno at every failure point stops the park with nothing moved and nothing deleted', () => {
  for (const code of ERRNOS) {
    for (const guarded of [false, true]) {
      const g = guarded ? 'guarded' : 'unguarded'
      it(`${code} from the parked area's mkdir (${g})`, () => {
        const f = fixture()
        const opts = guarded ? { guardHash: guardOf(f.origin) } : {}
        const { value: r, deletes } = countDeletes(() =>
          withFsStub(
            'mkdirSync',
            (orig) =>
              (...args: unknown[]) => {
                if (String(args[0]).endsWith(PARKED)) throw errnoError(code)
                return orig(...args)
              },
            () => park(f.parent, 'tree', opts)
          )
        )
        expect(r.status).toBe('stopped')
        expect(r.reason).toBe('park-failed')
        expect(r.errno).toBe(code)
        expect(r.entry).toBe('tree')
        expect(deletes).toEqual([])
        untouched(f)
      })

      it(`${code} from the op directory's mkdir (${g})`, () => {
        const f = fixture()
        const opts = guarded ? { guardHash: guardOf(f.origin), opId: 'op-e' } : { opId: 'op-e' }
        const { value: r, deletes } = countDeletes(() =>
          withFsStub(
            'mkdirSync',
            (orig) =>
              (...args: unknown[]) => {
                if (String(args[0]).endsWith(path.join(PARKED, 'op-e'))) throw errnoError(code)
                return orig(...args)
              },
            () => park(f.parent, 'tree', opts)
          )
        )
        expect(r.status).toBe('stopped')
        expect(r.reason).toBe('park-failed')
        expect(r.errno).toBe(code)
        expect(r.path).toBe(path.join(f.parent, PARKED, 'op-e'))
        expect(deletes).toEqual([])
        untouched(f)
      })

      it(`${code} from rename(2) itself (${g}): the rename was attempted, and nothing fell back to a delete`, () => {
        const f = fixture()
        const opts = guarded ? { guardHash: guardOf(f.origin) } : {}
        let renameAttempts = 0
        const { value: r, deletes } = countDeletes(() =>
          withFsStub(
            'renameSync',
            (orig) =>
              (...args: unknown[]) => {
                if (String(args[0]) === f.origin) {
                  renameAttempts += 1
                  throw errnoError(code)
                }
                return orig(...args)
              },
            () => park(f.parent, 'tree', opts)
          )
        )
        expect(renameAttempts).toBe(1)
        expect(r.status).toBe('stopped')
        expect(r.reason).toBe('park-failed')
        expect(r.errno).toBe(code)
        expect(r.path).toBe(f.origin)
        expect(deletes).toEqual([])
        untouched(f)
      })
    }
  }

  it('control: with no forced failure the same fixture parks and leaves the origin', () => {
    const f = fixture()
    const { value: r, deletes } = countDeletes(() => park(f.parent, 'tree'))
    expect(r.status).toBe('parked')
    expect(exists(f.origin)).toBe(false)
    expect(deletes).toEqual([])
  })

  it('a missing origin stops park-failed/ENOENT (unguarded and guarded)', () => {
    const f = fixture()
    expect(park(f.parent, 'nope')).toMatchObject({
      status: 'stopped',
      reason: 'park-failed',
      errno: 'ENOENT',
    })
    expect(park(f.parent, 'nope', { guardHash: 'a'.repeat(64) })).toMatchObject({
      status: 'stopped',
      reason: 'park-failed',
      errno: 'ENOENT',
    })
  })
})

describe.skipIf(process.platform !== 'linux' || process.getuid?.() === 0)(
  'real permissions (Linux, non-root only: root bypasses DAC)',
  () => {
    it('Q7 c: a parent without write permission and no parked area: park-failed/EACCES from its mkdir', () => {
      const f = fixture()
      fs.chmodSync(f.parent, 0o555)
      try {
        const r = park(f.parent, 'tree')
        expect(r).toMatchObject({ status: 'stopped', reason: 'park-failed', errno: 'EACCES' })
      } finally {
        fs.chmodSync(f.parent, 0o755)
      }
      untouched(f)
    })

    it('Q7 d: a valid parked area, then the parent made read-only: the rename fails EACCES', () => {
      const f = fixture()
      fs.mkdirSync(path.join(f.parent, PARKED))
      fs.chmodSync(f.parent, 0o555)
      try {
        const r = park(f.parent, 'tree')
        expect(r).toMatchObject({
          status: 'stopped',
          reason: 'park-failed',
          errno: 'EACCES',
          path: f.origin,
        })
      } finally {
        fs.chmodSync(f.parent, 0o755)
      }
      untouched(f)
    })
  }
)

const CAN_MOUNT = (() => {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) return false
  try {
    const m = /CapEff:\s*([0-9a-f]+)/.exec(fs.readFileSync('/proc/self/status', 'utf8'))
    return m !== null && (BigInt(`0x${m[1]}`) & (1n << 21n)) !== 0n
  } catch {
    return false
  }
})()

describe.skipIf(!CAN_MOUNT)('real errnos from mounts (Linux root with CAP_SYS_ADMIN only)', () => {
  const umount = (p: string) => {
    try {
      execFileSync('umount', [p], { stdio: 'pipe' })
    } catch {
      /* best effort */
    }
  }
  it('EROFS: the parent on a read-only bind mount', () => {
    const f = fixture()
    execFileSync('mount', ['--bind', f.parent, f.parent])
    execFileSync('mount', ['-o', 'remount,ro,bind', f.parent])
    try {
      expect(park(f.parent, 'tree')).toMatchObject({
        status: 'stopped',
        reason: 'park-failed',
        errno: 'EROFS',
      })
    } finally {
      umount(f.parent)
    }
    untouched(f)
  })

  it('EXDEV: the parked area pre-exists as a mount of another device (trash-other-mount)', () => {
    const f = fixture()
    const area = path.join(f.parent, PARKED)
    fs.mkdirSync(area)
    execFileSync('mount', ['-t', 'tmpfs', '-o', 'size=4m', 'none', area])
    try {
      expect(park(f.parent, 'tree')).toMatchObject({
        status: 'stopped',
        reason: 'park-failed',
        detail: 'trash-other-mount',
      })
    } finally {
      umount(area)
    }
    untouched(f)
  })
})
