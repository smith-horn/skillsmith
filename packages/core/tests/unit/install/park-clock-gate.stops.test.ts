/**
 * SMI-6531 (A1 step 3a): the clock gate's remaining stops, its retry, and its
 * order, from the governance review of 29cbcf380. Each stub here is wrong for
 * one probe only, so a check that looked at only one probe would pass a case.
 */
import fs from 'node:fs'
import type { BigIntStats } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PROBE_PREFIX, gateAndBind, runClockGate } from '../../../src/install/park-clock-gate.js'
import {
  PARKED,
  cleanup,
  errnoError,
  exists,
  simpleFixture,
  withAllFsTrapped,
  withAsyncFsStub,
} from './park-tree.helpers.js'

type AnyFn = (...args: unknown[]) => unknown

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r)
})
const fixture = () => {
  const f = simpleFixture('park-gate-stops-')
  roots.push(f.root)
  const probeDir = path.join(f.parent, PARKED)
  fs.mkdirSync(probeDir)
  return { ...f, probeDir }
}
const isProbe = (p: unknown, n?: 1 | 2): boolean => {
  const b = path.basename(String(p))
  return b.startsWith(PROBE_PREFIX) && (n === undefined || b.endsWith(`-${n}`))
}
/** An lstat stub giving the i-th probe read (1-based) the stats `edit` returns. */
const perRead =
  (edit: (i: number, st: BigIntStats, p: string) => Partial<Record<string, unknown>> | null) =>
  (orig: AnyFn): AnyFn => {
    let i = 0
    return (...args: unknown[]) => {
      const st = orig(...args) as BigIntStats
      if (!isProbe(args[0])) return st
      i += 1
      const over = edit(i, st, String(args[0]))
      if (over === null) return st
      const out = Object.create(st) as BigIntStats
      for (const [k, v] of Object.entries(over)) Object.defineProperty(out, k, { value: v })
      return out
    }
  }
const gate = (f: ReturnType<typeof fixture>, opId: string) =>
  runClockGate({ probeDir: f.probeDir, parentAbs: f.parent, opId })

describe('each probe is checked on its own', () => {
  for (const which of [1, 2] as const) {
    it(`a 0n birthtime on probe ${which} only stops the gate`, async () => {
      const f = fixture()
      const g = await withAsyncFsStub(
        'lstatSync',
        perRead((_i, _st, p) => (isProbe(p, which) ? { birthtimeNs: 0n } : null)),
        () => gate(f, `z${which}`)
      )
      expect(g.ok ? '' : g.detail).toBe(
        `probe ${path.join(f.probeDir, `${PROBE_PREFIX}z${which}-${which}`)} has no birthtime (0n)`
      )
    })

    it(`a device mismatch on probe ${which} only stops the gate`, async () => {
      const f = fixture()
      const g = await withAsyncFsStub(
        'lstatSync',
        perRead((_i, st, p) => (isProbe(p, which) ? { dev: st.dev + 1n } : null)),
        () => gate(f, `d${which}`)
      )
      expect(g.ok ? '' : g.detail).toBe(
        `probe ${path.join(f.probeDir, `${PROBE_PREFIX}d${which}-${which}`)} is on a different device than the parent`
      )
    })
  }
})

describe('probe 2 must be strictly later, and the gate retries until it is', () => {
  it('a probe 2 earlier than probe 1 (a clock stepped back) is never accepted', async () => {
    const f = fixture()
    const g = await withAsyncFsStub(
      'lstatSync',
      perRead((i) => ({ birthtimeNs: i === 1 ? 5000n : 4000n })),
      () => gate(f, 'back')
    )
    expect(g).toMatchObject({ ok: false, reason: 'identity-unverifiable' })
    expect(g.ok ? '' : g.detail).toContain('within 100 ms')
  })

  it('probe 2 equal to probe 1 twice, then later: ok on the third probe 2, with its birthtime', async () => {
    const f = fixture()
    let reads = 0
    const g = await withAsyncFsStub(
      'lstatSync',
      perRead((i) => {
        reads = i
        return { birthtimeNs: i <= 3 ? 7000n : 7001n }
      }),
      () => gate(f, 'retry')
    )
    expect(g).toEqual({ ok: true, maxBirthtimeNs: 7001n })
    expect(reads).toBe(4)
    expect(fs.readdirSync(f.probeDir)).toEqual([])
  })
})

describe('the other stops', () => {
  it('a probe 2 left by a killed run: EEXIST on probe 2, and the leftover is untouched', async () => {
    const f = fixture()
    const left = path.join(f.probeDir, `${PROBE_PREFIX}k2-2`)
    fs.mkdirSync(left)
    fs.writeFileSync(path.join(left, 'keep.txt'), 'x')
    const g = await gate(f, 'k2')
    expect(g.ok ? '' : g.detail).toBe(`probe ${left} could not be created`)
    expect(g).toMatchObject({ errno: 'EEXIST', leftProbe: null })
    expect(fs.readFileSync(path.join(left, 'keep.txt'), 'utf8')).toBe('x')
    expect(exists(path.join(f.probeDir, `${PROBE_PREFIX}k2-1`))).toBe(false)
  })

  it('a probe the lstat cannot read is still removed, and the stop names the read', async () => {
    const f = fixture()
    const failRead =
      (orig: AnyFn): AnyFn =>
      (...args: unknown[]) => {
        if (isProbe(args[0], 1)) throw errnoError('EIO')
        return orig(...args)
      }
    const g = await withAsyncFsStub('lstatSync', failRead, () => gate(f, 'eio'))
    expect(g).toMatchObject({ ok: false, errno: 'EIO', leftProbe: null })
    expect(g.ok ? '' : g.detail).toContain('could not be read')
    expect(fs.readdirSync(f.probeDir)).toEqual([])
  })

  it('a probe read as a non-directory is left in place and named', async () => {
    const f = fixture()
    const g = await withAsyncFsStub(
      'lstatSync',
      perRead((_i, _st, p) => (isProbe(p, 1) ? { isDirectory: () => false } : null)),
      () => gate(f, 'swap')
    )
    const p1 = path.join(f.probeDir, `${PROBE_PREFIX}swap-1`)
    expect(g).toMatchObject({ ok: false, leftProbe: p1 })
    expect(g.ok ? '' : g.detail).toContain('was replaced before it was read')
    expect(exists(p1)).toBe(true)
  })

  it('a mkdir failure other than EEXIST stops with its errno', async () => {
    const f = fixture()
    const deny =
      (orig: AnyFn): AnyFn =>
      (...args: unknown[]) => {
        if (isProbe(args[0])) throw errnoError('EACCES')
        return orig(...args)
      }
    const g = await withAsyncFsStub('mkdirSync', deny, () => gate(f, 'acc'))
    expect(g).toMatchObject({ ok: false, reason: 'identity-unverifiable', errno: 'EACCES' })
  })

  it('an unreadable parent stops before any probe is made', async () => {
    const f = fixture()
    const g = await runClockGate({
      probeDir: f.probeDir,
      parentAbs: path.join(f.root, 'missing'),
      opId: 'np',
    })
    expect(g).toMatchObject({ ok: false, reason: 'identity-unverifiable', errno: 'ENOENT' })
    expect(fs.readdirSync(f.probeDir)).toEqual([])
  })
})

describe('gateAndBind', () => {
  it('a traversing name is a TypeError before any filesystem work', async () => {
    const f = fixture()
    const { value, touched } = withAllFsTrapped(() =>
      gateAndBind({ probeDir: f.probeDir, parentAbs: f.parent, name: '../x', opId: 'o' })
    )
    expect(touched).toEqual([])
    await expect(value).rejects.toThrow('name must be a single path segment')
  })

  it('runs the gate, then the hash, then the bind', async () => {
    const f = fixture()
    const calls: string[] = []
    const record =
      (fn: string) =>
      (orig: AnyFn): AnyFn =>
      (...args: unknown[]) => {
        const p = String(args[0])
        if (isProbe(p)) calls.push(`${fn}:probe`)
        else if (p === f.origin) calls.push(`${fn}:root`)
        else if (p.startsWith(f.origin + path.sep)) calls.push(`${fn}:tree`)
        return orig(...args)
      }
    const b = await withAsyncFsStub('rmdirSync', record('rmdir'), () =>
      withAsyncFsStub('readdirSync', record('readdir'), () =>
        withAsyncFsStub('lstatSync', record('lstat'), () =>
          gateAndBind({ probeDir: f.probeDir, parentAbs: f.parent, name: 'tree', opId: 'ord' })
        )
      )
    )
    expect(b.ok).toBe(true)
    const lastProbe = calls.lastIndexOf('rmdir:probe')
    const firstTree = calls.findIndex((c) => c.endsWith(':root') || c.endsWith(':tree'))
    const lastList = Math.max(calls.lastIndexOf('readdir:tree'), calls.lastIndexOf('readdir:root'))
    expect(lastProbe).toBeGreaterThanOrEqual(0)
    // The gate finishes before the tree is touched at all.
    expect(firstTree).toBeGreaterThan(lastProbe)
    // The hash walk starts at the root and lists it; the bind is one more lstat
    // of the root itself, and the last call, after the walk's last listing.
    expect(calls[firstTree]).toBe('lstat:root')
    expect(calls[calls.length - 1]).toBe('lstat:root')
    expect(calls.filter((c) => c === 'lstat:root')).toHaveLength(2)
    expect(lastList).toBeGreaterThan(firstTree)
    expect(calls.length - 1).toBeGreaterThan(lastList)
  })

  it('a bind that fails after the hash stops with bind-failed and its errno', async () => {
    const f = fixture()
    let rootLstats = 0
    const failBind =
      (orig: AnyFn): AnyFn =>
      (...args: unknown[]) => {
        // The hash walk lstats the root first; the bind is the second.
        if (args[0] === f.origin && ++rootLstats === 2) throw errnoError('ESTALE')
        return orig(...args)
      }
    const b = await withAsyncFsStub('lstatSync', failBind, () =>
      gateAndBind({ probeDir: f.probeDir, parentAbs: f.parent, name: 'tree', opId: 'bf' })
    )
    expect(b).toEqual({
      ok: false,
      reason: 'bind-failed',
      detail: 'the identity bind failed',
      errno: 'ESTALE',
    })
  })

  it('a hash that fails stops with bind-failed and the walk errno', async () => {
    const f = fixture()
    const b = await gateAndBind({
      probeDir: f.probeDir,
      parentAbs: f.parent,
      name: 'none',
      opId: 'hf',
    })
    expect(b).toEqual({
      ok: false,
      reason: 'bind-failed',
      detail: 'the tree hash failed (guard-unreadable)',
      errno: 'ENOENT',
    })
  })
})
