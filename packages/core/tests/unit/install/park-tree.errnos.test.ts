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
  withAllFsTrapped,
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

describe('the parked area carries the parent mode (ADR-166 D-3, SMI-7149)', () => {
  for (const parentMode of [0o755, 0o700, 0o1777]) {
    it(`mkdir of .skillsmith-parked asks for the parent's permission bits (${parentMode.toString(8)})`, () => {
      const f = fixture()
      fs.chmodSync(f.parent, parentMode)
      const requested: unknown[] = []
      const r = withFsStub(
        'mkdirSync',
        (orig) =>
          (...args: unknown[]) => {
            if (args[0] === path.join(f.parent, PARKED)) requested.push(args[1])
            return orig(...args)
          },
        () => park(f.parent, 'tree')
      )
      expect(r.status).toBe('parked')
      // The mkdir only requests the bits (the umask masks the request); the
      // area is then chmod-ed to the parent's bits, sticky and setgid included
      // (SMI-7149), so the property is the resulting mode, not the request.
      expect(requested).toEqual([{ mode: parentMode & 0o3777 }])
      expect(fs.statSync(path.join(f.parent, PARKED)).mode & 0o7777).toBe(parentMode)
    })
  }
})

describe('the parent must be absolute (retro of PR #3110)', () => {
  it('a relative parent throws TypeError before any filesystem work, with nothing moved', () => {
    const f = fixture()
    const rel = path.relative(process.cwd(), f.parent)
    expect(path.isAbsolute(rel)).toBe(false)
    const { value, touched, deletes } = withAllFsTrapped(() => {
      try {
        park(rel, 'tree')
        return 'returned'
      } catch (e) {
        return `${(e as Error).constructor.name}: ${(e as Error).message}`
      }
    })
    expect(value).toBe(
      `TypeError: parkTree: parentAbs must be an absolute path, got ${JSON.stringify(rel)}`
    )
    expect(touched).toEqual([])
    expect(deletes).toEqual([])
    untouched(f)
    expect(exists(path.join(f.parent, PARKED))).toBe(false)
  })

  for (const [label, value, rendered] of [
    ['a number', 5, 'number'],
    ['a null-prototype object', Object.create(null) as unknown, 'object'],
    [
      'an object whose toString throws',
      {
        toString: () => {
          throw new RangeError('boom')
        },
      },
      'object',
    ],
  ] as const) {
    it(`a non-string parent (${label}) throws this TypeError, rendered without calling into it`, () => {
      const f = fixture()
      const { value: out, touched } = withAllFsTrapped(() => {
        try {
          park(value as unknown as string, 'tree')
          return 'returned'
        } catch (e) {
          return `${(e as Error).constructor.name}: ${(e as Error).message}`
        }
      })
      expect(out).toBe(`TypeError: parkTree: parentAbs must be an absolute path, got ${rendered}`)
      expect(touched).toEqual([])
      untouched(f)
    })
  }

  // The parent check runs first: each case pairs the relative parent with one
  // other invalid input, a name or an option key, and the parent's own
  // TypeError is the one thrown (pre-merge gate PR-16).
  for (const [label, name, options] of [
    ['an invalid name', '../escape', {}],
    ['an unknown option key', 'tree', { notAnOption: true }],
  ] as const) {
    it(`a relative parent is reported before ${label}`, () => {
      const f = fixture()
      const rel = path.relative(process.cwd(), f.parent)
      let msg = 'returned'
      try {
        park(rel, name, options as never)
      } catch (e) {
        msg = `${(e as Error).constructor.name}: ${(e as Error).message}`
      }
      expect(msg).toBe(
        `TypeError: parkTree: parentAbs must be an absolute path, got ${JSON.stringify(rel)}`
      )
    })
  }

  it('control: the same tree with its absolute parent parks', () => {
    const f = fixture()
    expect(park(f.parent, 'tree').status).toBe('parked')
  })
})
