/**
 * SMI-6531: identity binding, the clock gate and the destination checks,
 * ported from the SMI-6676 spike's `harness/test-quarantine-identity.mjs`.
 *
 * The B2 exploit: the guard certified tree X and rename(2) moved tree Y. The
 * swaps here use a BYTE-IDENTICAL replacement, so its tree hash equals the
 * guard and only identity (UD24) separates them; a different-content swap
 * would be caught by the hash and prove nothing about identity.
 */
import fs from 'node:fs'
import type { BigIntStats } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computePathTreeHash } from '../../../src/install/park-tree.js'
import {
  CLIENT,
  PARKED,
  cleanup,
  exists,
  park,
  readText,
  simpleFixture,
  withFsStub,
  KIND,
} from './park-tree.helpers.js'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r)
})

const ident = (p: string) => {
  const st = fs.lstatSync(p, { bigint: true })
  return { dev: st.dev, ino: st.ino, birthtimeNs: st.birthtimeNs, fmt: st.mode & 0o170000n }
}

/** `tree/` plus a hash-identical spare outside the parent. */
function fixture() {
  const f = simpleFixture('park-id-', 'exact same bytes')
  fs.writeFileSync(path.join(f.origin, 'top.txt'), 'also identical')
  const spare = path.join(f.root, 'replacement')
  fs.mkdirSync(path.join(spare, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(spare, 'sub', 'f.txt'), 'exact same bytes')
  fs.writeFileSync(path.join(spare, 'top.txt'), 'also identical')
  roots.push(f.root)
  return { ...f, spare }
}
const hashOf = (p: string): string => {
  const h = computePathTreeHash(p)
  if (!h.ok) throw new Error('hash failed')
  return h.treeHash
}

describe('parkTree identity binding (B2, UD24)', () => {
  it('0: the premise holds: the replacement hashes identically but is a different inode', () => {
    const f = fixture()
    expect(hashOf(f.spare)).toBe(hashOf(f.origin))
    expect(ident(f.spare).ino).not.toBe(ident(f.origin).ino)
  })

  it('1: a tree swapped after the caller bound identity is kept, the replacement untouched', () => {
    const f = fixture()
    const bound = ident(f.origin)
    const guardHash = hashOf(f.origin)
    fs.renameSync(f.origin, path.join(f.root, 'aside'))
    fs.renameSync(f.spare, f.origin)
    const r = park(f.parent, 'tree', { guardHash, expectIdentity: bound })
    expect(r.status).toBe('kept')
    expect(r.reason).toBe('identity-changed')
    expect(readText(path.join(f.origin, 'sub', 'f.txt'))).toBe('exact same bytes')
  })

  it('2: an unswapped tree is parked and leaves the origin (a guard that refuses all is no guard)', () => {
    const f = fixture()
    const r = park(f.parent, 'tree', {
      guardHash: hashOf(f.origin),
      expectIdentity: ident(f.origin),
    })
    expect(r.status).toBe('parked')
    expect(exists(f.origin)).toBe(false)
  })

  it('3: UD25 gate: a tree not strictly older than probe 2 is kept; a strictly older one parks', () => {
    const f = fixture()
    const bound = ident(f.origin)
    const guardHash = hashOf(f.origin)
    const r = park(f.parent, 'tree', {
      guardHash,
      expectIdentity: bound,
      maxBirthtimeNs: bound.birthtimeNs,
    })
    expect(r.status).toBe('kept')
    expect(r.reason).toBe('identity-not-older-than-probe')
    expect(exists(f.origin)).toBe(true)
    const r2 = park(f.parent, 'tree', {
      guardHash,
      expectIdentity: bound,
      maxBirthtimeNs: bound.birthtimeNs + 1n,
    })
    expect(r2.status).toBe('parked')
  })

  it('4: a swap landing between the hash and the rename is caught by the pre-rename re-check', () => {
    const f = fixture()
    const bound = ident(f.origin)
    const guardHash = hashOf(f.origin)
    let swapped = false
    const r = withFsStub(
      'mkdirSync',
      (orig) =>
        (...args: unknown[]) => {
          const out = orig(...args)
          if (!swapped && String(args[0]).includes(PARKED)) {
            swapped = true
            orig(path.join(f.root, 'holder'), { recursive: true })
            fs.renameSync(f.origin, path.join(f.root, 'holder', 'aside'))
            fs.renameSync(f.spare, f.origin)
          }
          return out
        },
      () => park(f.parent, 'tree', { guardHash, expectIdentity: bound })
    )
    expect(swapped).toBe(true)
    expect(r.status).toBe('kept')
    expect(r.reason).toBe('identity-changed')
    expect(r.detail).toBe('bound identity does not match the tree now at this path')
    expect(readText(path.join(f.origin, 'sub', 'f.txt'))).toBe('exact same bytes')
  })
})

describe('parkTree identity and the gate without a guard hash', () => {
  it('5a: the clock gate fires without a guardHash', () => {
    const f = fixture()
    const bound = ident(f.origin)
    const r = park(f.parent, 'tree', { expectIdentity: bound, maxBirthtimeNs: bound.birthtimeNs })
    expect(r.status).toBe('kept')
    expect(r.reason).toBe('identity-not-older-than-probe')
    expect(exists(f.origin)).toBe(true)
  })

  it('5d: expectIdentity is honoured without a guardHash', () => {
    const f = fixture()
    const bound = ident(f.origin)
    fs.renameSync(f.origin, path.join(f.root, 'aside'))
    fs.renameSync(f.spare, f.origin)
    const r = park(f.parent, 'tree', { expectIdentity: bound })
    expect(r.status).toBe('kept')
    expect(r.reason).toBe('identity-changed')
    expect(exists(f.origin)).toBe(true)
  })

  it('5g: no identity and no hash still parks (the guard is opt-in)', () => {
    const f = fixture()
    expect(park(f.parent, 'tree').status).toBe('parked')
  })
})

describe('parkTree destination checks', () => {
  it('6: a parked area swapped after the op directory exists is refused', () => {
    const f = fixture()
    const area = path.join(f.parent, PARKED)
    let swapped = false
    const r = withFsStub(
      'mkdirSync',
      (orig) =>
        (...args: unknown[]) => {
          const out = orig(...args)
          const p = String(args[0])
          if (!swapped && p.startsWith(area) && p !== area) {
            swapped = true
            fs.renameSync(area, path.join(f.root, 'area-aside'))
            // A private op directory at the same path, so only the parked area's
            // identity differs and the mode check cannot be what refuses it.
            orig(p, { recursive: true, mode: 0o700 })
            fs.chmodSync(p, 0o700)
          }
          return out
        },
      () => park(f.parent, 'tree', { guardHash: hashOf(f.origin), expectIdentity: ident(f.origin) })
    )
    expect(swapped).toBe(true)
    expect(r.status).toBe('kept')
    expect(r.reason).toBe('park-destination-changed')
    expect(r.detail).toBe('parked area was substituted between validation and rename')
    expect(readText(path.join(f.origin, 'sub', 'f.txt'))).toBe('exact same bytes')
  })

  it('7: a pre-created symlink op directory is refused by the TYPE check', () => {
    const f = fixture()
    const loot = path.join(f.root, 'attacker-storage')
    fs.mkdirSync(loot)
    fs.mkdirSync(path.join(f.parent, PARKED))
    fs.symlinkSync(loot, path.join(f.parent, PARKED, 'op-abc123'))
    expect(fs.lstatSync(path.join(f.parent, PARKED)).dev).toBe(fs.lstatSync(loot).dev)
    const r = park(f.parent, 'tree', { opId: 'op-abc123', guardHash: hashOf(f.origin) })
    expect(r.status).toBe('kept')
    expect(r.reason).toBe('park-destination-changed')
    expect(r.detail).toBe(
      'op directory is a symlink; rename(2) would resolve it and land the tree elsewhere'
    )
    expect(exists(f.origin)).toBe(true)
    expect(fs.readdirSync(loot)).toEqual([])
  })

  it('7f: a real pre-existing 0700 op directory is accepted', () => {
    const f = fixture()
    const op = path.join(f.parent, PARKED, 'op-reuse')
    fs.mkdirSync(op, { recursive: true })
    fs.chmodSync(op, 0o700)
    expect(park(f.parent, 'tree', { opId: 'op-reuse' }).status).toBe('parked')
  })

  it('7h: a world-accessible op directory is refused by the MODE check', () => {
    const f = fixture()
    const op = path.join(f.parent, PARKED, 'op-open')
    fs.mkdirSync(op, { recursive: true })
    fs.chmodSync(op, 0o777)
    expect((fs.lstatSync(op).mode & 0o777).toString(8)).toBe('777')
    const r = park(f.parent, 'tree', { opId: 'op-open' })
    expect(r.status).toBe('kept')
    expect(r.reason).toBe('park-destination-changed')
    expect(r.detail).toBe('op directory is group- or world-accessible (mode 777)')
    expect(exists(f.origin)).toBe(true)
  })

  it('7k: an op directory swapped for a symlink after validation is refused by the rebind', () => {
    const f = fixture()
    const loot = path.join(f.root, 'attacker-storage')
    fs.mkdirSync(loot)
    const op = path.join(f.parent, PARKED, 'op-swap')
    fs.mkdirSync(op, { recursive: true })
    fs.chmodSync(op, 0o700)
    let seenOp = false
    let swapped = false
    const r = withFsStub(
      'lstatSync',
      (orig) =>
        (...args: unknown[]) => {
          const out = orig(...args)
          if (seenOp && !swapped) {
            swapped = true
            fs.rmdirSync(op)
            fs.symlinkSync(loot, op)
          }
          if (String(args[0]) === op) seenOp = true
          return out
        },
      () => park(f.parent, 'tree', { opId: 'op-swap' })
    )
    expect(swapped).toBe(true)
    expect(r.status).toBe('kept')
    expect(r.reason).toBe('park-destination-changed')
    expect(r.detail).toBe('op directory was substituted between validation and rename')
    expect(exists(f.origin)).toBe(true)
    expect(fs.readdirSync(loot)).toEqual([])
  })

  it('7p: a foreign-owned op directory is refused by the OWNERSHIP check; ours is accepted', () => {
    const f = fixture()
    const op = path.join(f.parent, PARKED, 'op-foreign')
    fs.mkdirSync(op, { recursive: true })
    fs.chmodSync(op, 0o700)
    const r = withFsStub(
      'lstatSync',
      (orig) =>
        (...args: unknown[]) => {
          const st = orig(...args) as BigIntStats
          if (String(args[0]) === op && typeof st.uid === 'bigint') {
            return new Proxy(st, {
              get: (t, k) => {
                if (k === 'uid') return t.uid + 1n
                const v = Reflect.get(t, k) as unknown
                return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v
              },
            })
          }
          return st
        },
      () => park(f.parent, 'tree', { opId: 'op-foreign' })
    )
    expect(r.status).toBe('kept')
    expect(r.reason).toBe('park-destination-changed')
    expect(r.detail).toBe('op directory is owned by another user')
    expect(exists(f.origin)).toBe(true)
    expect(park(f.parent, 'tree', { opId: 'op-foreign' }).status).toBe('parked')
  })

  it('7u: a symlinked parked area stops the park with detail trash-unusable (Q7 a)', () => {
    const f = fixture()
    const elsewhere = path.join(f.root, 'elsewhere')
    fs.mkdirSync(elsewhere)
    fs.symlinkSync(elsewhere, path.join(f.parent, PARKED))
    const r = park(f.parent, 'tree')
    expect(r.status).toBe('stopped')
    expect(r.reason).toBe('park-failed')
    expect(r.detail).toBe('trash-unusable')
    expect(exists(f.origin)).toBe(true)
    expect(fs.readdirSync(elsewhere)).toEqual([])
  })

  it('7z: deleting process.getuid after load does not disable the mode check', () => {
    const f = fixture()
    const op = path.join(f.parent, PARKED, 'op-noguid')
    fs.mkdirSync(op, { recursive: true })
    fs.chmodSync(op, 0o777)
    const realGetuid = process.getuid
    let r
    try {
      delete (process as { getuid?: unknown }).getuid
      r = park(f.parent, 'tree', { opId: 'op-noguid' })
    } finally {
      process.getuid = realGetuid
    }
    expect(r.status).toBe('kept')
    expect(r.reason).toBe('park-destination-changed')
    expect(exists(f.origin)).toBe(true)
  })

  it.skipIf(process.platform === 'win32')(
    '7L: no process.getuid at module load refuses (SMI-7128); with it the park succeeds',
    async () => {
      const load = async (stub: boolean) => {
        vi.resetModules()
        const realGetuid = process.getuid
        try {
          if (stub) delete (process as { getuid?: unknown }).getuid
          return await import('../../../src/install/park-tree.js')
        } finally {
          process.getuid = realGetuid
          vi.resetModules()
        }
      }
      const ctl = await load(false)
      const a = fixture()
      expect(
        ctl.parkTree(a.parent, 'tree', { client: CLIENT, kind: KIND, opId: 'op-l0' }).status
      ).toBe('parked')
      const stubbed = await load(true)
      const b = fixture()
      const r = stubbed.parkTree(b.parent, 'tree', { client: CLIENT, kind: KIND, opId: 'op-l1' })
      expect(r.status).toBe('kept')
      expect(r.reason).toBe('park-destination-changed')
      expect(r.detail).toBe('cannot verify op directory ownership: process.getuid is unavailable')
      expect(readText(path.join(b.origin, 'sub', 'f.txt'))).toBe('exact same bytes')
      expect(fs.readdirSync(path.join(b.parent, PARKED, 'op-l1'))).toEqual([])
    },
    60_000
  )
})
