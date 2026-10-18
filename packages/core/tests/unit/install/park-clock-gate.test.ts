/**
 * SMI-6531 (A1 step 3a): UD25's clock gate as a caller-side helper (A1 plan
 * §3.3, T-X18's gate cases for the helper itself; its per-caller runs come
 * with A1 step 8). Real filesystem for the gate's purpose (a tree made after
 * the gate is refused); stubs for the stops a healthy clock never produces.
 */
import fs from 'node:fs'
import type { BigIntStats } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CLOCK_GATE_CAP_MS,
  PROBE_PREFIX,
  gateAndBind,
  runClockGate,
} from '../../../src/install/park-clock-gate.js'
import { checkFsBoundarySource } from './park-tree.fs-boundary.js'
import {
  PARKED,
  cleanup,
  errnoError,
  exists,
  park,
  simpleFixture,
  withAllFsTrapped,
  withAsyncFsStub,
} from './park-tree.helpers.js'

type AnyFn = (...args: unknown[]) => unknown

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r)
})
/** A fixture plus its parked area, where the gate's probes go (rows 13, 14). */
const fixture = () => {
  const f = simpleFixture('park-gate-')
  roots.push(f.root)
  const probeDir = path.join(f.parent, PARKED)
  fs.mkdirSync(probeDir)
  return { ...f, probeDir }
}
const probes = (dir: string) => fs.readdirSync(dir).filter((n) => n.startsWith(PROBE_PREFIX))

/** An lstat stub that rewrites one bigint field of every probe's stats. */
const probeStat =
  (field: 'birthtimeNs' | 'dev', value: (st: BigIntStats) => bigint) =>
  (orig: AnyFn): AnyFn =>
  (...args: unknown[]) => {
    const st = orig(...args) as BigIntStats
    if (!path.basename(String(args[0])).startsWith(PROBE_PREFIX)) return st
    const out = Object.create(st) as BigIntStats
    Object.defineProperty(out, field, { value: value(st) })
    return out
  }

describe('the names and the cap are the plan literals (A1 plan §3.8, UD25)', () => {
  it('probes are .skillsmith-probe-<opId>-1 and -2, and the cap is 100 ms', () => {
    expect(PROBE_PREFIX).toBe('.skillsmith-probe-')
    expect(CLOCK_GATE_CAP_MS).toBe(100)
  })
})

describe('the gate on a real filesystem', () => {
  it('passes, leaves no probe, and a tree made before it parks under its threshold', async () => {
    const f = fixture()
    const g = await runClockGate({ probeDir: f.probeDir, parentAbs: f.parent, opId: 'op1' })
    expect(g.ok).toBe(true)
    if (!g.ok) return
    expect(probes(f.probeDir)).toEqual([])
    const r = park(f.parent, 'tree', { maxBirthtimeNs: g.maxBirthtimeNs })
    expect(r.status).toBe('parked')
  })

  // Newer than probe 2 is what this shows on any filesystem; the same-tick case
  // is the stubbed shared-tick test below.
  it('a tree removed and re-made after the gate is refused', async () => {
    const f = fixture()
    const g = await runClockGate({ probeDir: f.probeDir, parentAbs: f.parent, opId: 'op2' })
    if (!g.ok) throw new Error(JSON.stringify(g))
    fs.rmSync(f.origin, { recursive: true })
    fs.mkdirSync(path.join(f.origin, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(f.origin, 'sub', 'f.txt'), 'SUBSTITUTE')
    const r = park(f.parent, 'tree', { maxBirthtimeNs: g.maxBirthtimeNs })
    expect(r.status).toBe('kept')
    expect(r.reason).toBe('identity-not-older-than-probe')
    expect(fs.readFileSync(path.join(f.origin, 'sub', 'f.txt'), 'utf8')).toBe('SUBSTITUTE')
  })

  it('a tree sharing the tick of probe 1 still parks: the threshold is probe 2', async () => {
    const f = fixture()
    const treeBirth = fs.lstatSync(f.origin, { bigint: true }).birthtimeNs
    // Probe 1 lands in the tree's own tick and probe 2 one tick later: E48's
    // case, which a probe-1 threshold refuses spuriously.
    let n = 0
    const ticks =
      (orig: AnyFn): AnyFn =>
      (...args: unknown[]) => {
        const st = orig(...args) as BigIntStats
        if (!path.basename(String(args[0])).startsWith(PROBE_PREFIX)) return st
        n += 1
        const out = Object.create(st) as BigIntStats
        Object.defineProperty(out, 'birthtimeNs', { value: n === 1 ? treeBirth : treeBirth + 1n })
        return out
      }
    const g = await withAsyncFsStub('lstatSync', ticks, () =>
      runClockGate({ probeDir: f.probeDir, parentAbs: f.parent, opId: 'tick' })
    )
    if (!g.ok) throw new Error(JSON.stringify(g))
    expect(g.maxBirthtimeNs).toBe(treeBirth + 1n)
    expect(park(f.parent, 'tree', { maxBirthtimeNs: g.maxBirthtimeNs }).status).toBe('parked')
  })

  it('gateAndBind returns options a guarded, gated park accepts', async () => {
    const f = fixture()
    const b = await gateAndBind({
      probeDir: f.probeDir,
      parentAbs: f.parent,
      name: 'tree',
      opId: 'op3',
    })
    if (!b.ok) throw new Error(JSON.stringify(b))
    const { maxBirthtimeNs, guardHash, expectIdentity } = b
    const r = park(f.parent, 'tree', { maxBirthtimeNs, guardHash, expectIdentity })
    expect(r.status).toBe('parked')
    expect(r.treeHash).toBe(guardHash)
  })

  it('gateAndBind on a missing tree stops with bind-failed and makes nothing', async () => {
    const f = fixture()
    const b = await gateAndBind({
      probeDir: f.probeDir,
      parentAbs: f.parent,
      name: 'nope',
      opId: 'op4',
    })
    expect(b).toMatchObject({ ok: false, reason: 'bind-failed' })
    expect(probes(f.probeDir)).toEqual([])
  })
})

describe('the gate stops, with nothing moved, when the clock cannot be trusted', () => {
  it('a probe with a 0n birthtime', async () => {
    const f = fixture()
    const g = await withAsyncFsStub(
      'lstatSync',
      probeStat('birthtimeNs', () => 0n),
      () => runClockGate({ probeDir: f.probeDir, parentAbs: f.parent, opId: 'z' })
    )
    expect(g).toMatchObject({ ok: false, reason: 'identity-unverifiable', leftProbe: null })
    expect(g.ok ? '' : g.detail).toContain('no birthtime (0n)')
    expect(probes(f.probeDir)).toEqual([])
  })

  it('a probe birthtime that never advances stops at the cap, not sooner and not much later', async () => {
    const f = fixture()
    const t0 = performance.now()
    const g = await withAsyncFsStub(
      'lstatSync',
      probeStat('birthtimeNs', () => 1000n),
      () => runClockGate({ probeDir: f.probeDir, parentAbs: f.parent, opId: 'cap' })
    )
    const elapsed = performance.now() - t0
    expect(g).toMatchObject({ ok: false, reason: 'identity-unverifiable' })
    expect(g.ok ? '' : g.detail).toContain(`within ${CLOCK_GATE_CAP_MS} ms`)
    expect(elapsed).toBeGreaterThanOrEqual(CLOCK_GATE_CAP_MS)
    expect(elapsed).toBeLessThan(2000)
    expect(probes(f.probeDir)).toEqual([])
  })

  it('a probe on another device than the parent', async () => {
    const f = fixture()
    const g = await withAsyncFsStub(
      'lstatSync',
      probeStat('dev', (st) => st.dev + 1n),
      () => runClockGate({ probeDir: f.probeDir, parentAbs: f.parent, opId: 'dev' })
    )
    expect(g.ok ? '' : g.detail).toContain('different device than the parent')
  })

  it('a leftover probe from a killed run: EEXIST, and the leftover is not touched', async () => {
    const f = fixture()
    const left = path.join(f.probeDir, `${PROBE_PREFIX}kill-1`)
    fs.mkdirSync(left)
    fs.writeFileSync(path.join(left, 'keep.txt'), 'x')
    const g = await runClockGate({ probeDir: f.probeDir, parentAbs: f.parent, opId: 'kill' })
    expect(g).toMatchObject({ ok: false, reason: 'identity-unverifiable', errno: 'EEXIST' })
    expect(fs.readFileSync(path.join(left, 'keep.txt'), 'utf8')).toBe('x')
  })

  it('a probe that cannot be removed is reported as left behind', async () => {
    const f = fixture()
    const g = await withAsyncFsStub(
      'rmdirSync',
      () => () => {
        throw errnoError('EBUSY')
      },
      () => runClockGate({ probeDir: f.probeDir, parentAbs: f.parent, opId: 'busy' })
    )
    const left = path.join(f.probeDir, `${PROBE_PREFIX}busy-1`)
    expect(g).toMatchObject({ ok: false, errno: 'EBUSY', leftProbe: left })
    expect(exists(left)).toBe(true)
  })

  it('gateAndBind refuses a tree whose own birthtime is 0n', async () => {
    const f = fixture()
    const zeroTree =
      (orig: AnyFn): AnyFn =>
      (...args: unknown[]) => {
        const st = orig(...args) as BigIntStats
        if (args[0] !== f.origin || (args[1] as { bigint?: boolean })?.bigint !== true) return st
        const out = Object.create(st) as BigIntStats
        Object.defineProperty(out, 'birthtimeNs', { value: 0n })
        return out
      }
    const b = await withAsyncFsStub('lstatSync', zeroTree, () =>
      gateAndBind({ probeDir: f.probeDir, parentAbs: f.parent, name: 'tree', opId: 'zt' })
    )
    expect(b).toMatchObject({ ok: false, reason: 'identity-unverifiable' })
    expect(b.ok ? '' : b.detail).toBe(`${f.origin} has no birthtime (0n)`)
  })
})

describe('input', () => {
  for (const [label, args, message] of [
    [
      'a relative probeDir',
      { probeDir: 'rel', parentAbs: '/abs', opId: 'o' },
      'probeDir must be an absolute path, got "rel"',
    ],
    [
      'a non-string parentAbs',
      { probeDir: '/abs', parentAbs: 7, opId: 'o' },
      'parentAbs must be an absolute path, got number',
    ],
    [
      'an opId with a slash',
      { probeDir: '/abs', parentAbs: '/abs', opId: 'a/b' },
      'opId must be a single path segment',
    ],
    [
      'an opId starting with a dot',
      { probeDir: '/abs', parentAbs: '/abs', opId: '.x' },
      'opId must not start with "."',
    ],
  ] as const) {
    it(`${label} is a TypeError before any filesystem work`, async () => {
      const { value, touched } = withAllFsTrapped(() => runClockGate(args as never))
      expect(touched).toEqual([])
      await expect(value).rejects.toThrow(message)
    })
  }
})

describe('the gate module is outside the delete-free park graph, and rmdir is its only removal', () => {
  const src = fs.readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../src/install/park-clock-gate.ts'
    ),
    'utf8'
  )
  /** Every `fs.<member>(…)` call as [member, argument count]. */
  const fsCalls = (text: string): [string, number][] => {
    const out: [string, number][] = []
    const sf = ts.createSourceFile('g.ts', text, ts.ScriptTarget.Latest, true)
    const visit = (n: ts.Node): void => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        ts.isIdentifier(n.expression.expression) &&
        n.expression.expression.text === 'fs'
      ) {
        out.push([n.expression.name.text, n.arguments.length])
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
    return out
  }

  it('routes fs through the default import, with no rm or unlink', () => {
    const r = checkFsBoundarySource(src, { forbidMembers: ['rmSync', 'unlinkSync'] })
    expect(r.violations).toEqual([])
    expect(r.fsLocals).toEqual(['fs'])
  })

  it('its one removal is rmdirSync with a single argument (no options, so never recursive)', () => {
    const removals = fsCalls(src).filter(([m]) => /^(rm|unlink|rmdir)/.test(m))
    expect(removals).toEqual([['rmdirSync', 1]])
  })

  it('positive control: a planted recursive rmdir is seen as a two-argument removal', () => {
    const planted = `${src}\nexport const x = () => fs.rmdirSync('/x', { recursive: true })\n`
    expect(fsCalls(planted).filter(([m]) => m === 'rmdirSync')).toEqual([
      ['rmdirSync', 1],
      ['rmdirSync', 2],
    ])
  })
})
