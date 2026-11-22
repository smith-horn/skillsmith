/**
 * SMI-6531 (A1 step 8-i-a-2), T-FIC and T-FI4: the install classifier against
 * every combination of where the published folder (the inode with
 * `newIdentity`) is and what else is at each position. The record, the claim,
 * the publish, the park and every keep are the production primitives
 * (`install.helpers.ts`); the other trees (a foreign folder, a copy with the
 * built hash, the folder moved to `undone/` or out of the root) are made with
 * plain fs calls, modelling what a user, a crash or the undo's own rename
 * leaves. The expected class comes from
 * an oracle written from the design's § 3 tables, not from the classifier:
 * only the tuples of the row table are a row; every other tuple is
 * `identity-changed` or `anything-else`, with a reason.
 *
 * The folder can be in one place only, so the tuples are: where it is (L) ×
 * what else is at T, N and U × another set-aside copy × the manifest entry.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parkTree } from '../../../../src/install/park-tree.js'
import type { RecoveryClass } from '../../../../src/services/skill-recovery.types.js'
import { claimPublish } from '../../../../src/services/skill-tree.js'
import { useTmpCleanup } from '../skill-swap.helpers.js'
import { opReport, setEntry } from './recovery.helpers.js'
import {
  fi0,
  fi4,
  installFixture,
  keepWith,
  OTHER_ENTRY,
  parkedDirOf,
  POST_ENTRY,
} from './install.helpers.js'
import type { IState } from './install.helpers.js'

useTmpCleanup()

/** Where the published folder is. */
type L = 'T' | 'Nsrc' | 'Nkept' | 'Usrc' | 'Ukept' | 'P' | 'none'
type TOther = 'absent' | 'claim' | 'foreign' | 'file' | 'idchanged'
type NOther = 'absent' | 'foreign' | 'idchanged'
type UOther = 'absent' | 'other'
type M = 'pre' | 'post' | 'other'

interface Tuple {
  l: L
  t: TOther
  n: NOther
  u: UOther
  pExtra: boolean
  m: M
}

type Expected =
  | { kind: 'state'; state: string; postKeep: boolean }
  | { kind: 'identity-changed' }
  | { kind: 'anything-else' }

/** The design's § 3 tables, as an oracle over a tuple (gate order included). */
function oracle(x: Tuple): Expected {
  const tS = x.l === 'T' ? 'new' : x.t
  if (tS === 'file') return { kind: 'anything-else' }
  const nChanged = !x.l.startsWith('N') && x.n === 'idchanged'
  if (tS === 'idchanged' || nChanged) return { kind: 'identity-changed' }
  const nForeign = !x.l.startsWith('N') && x.n === 'foreign'
  if (nForeign) return { kind: 'anything-else' }
  const p = (x.l === 'P' ? 1 : 0) + (x.pExtra ? 1 : 0)
  if (x.pExtra) return { kind: 'anything-else' }
  const nPresent = x.l === 'Nsrc' || x.l === 'Nkept'
  const uPresent = x.l === 'Usrc' || x.l === 'Ukept' || x.u === 'other'
  if (p === 1) {
    // FI4: the manifest not the installed entry (8-i-a-3a, owner decision A).
    return tS === 'absent' && !nPresent && !uPresent && x.m !== 'post'
      ? { kind: 'state', state: 'FI4', postKeep: false }
      : { kind: 'anything-else' }
  }
  const pre = x.m === 'pre'
  if (tS === 'absent' && nPresent && !uPresent && pre) {
    return { kind: 'state', state: 'FI0', postKeep: x.l === 'Nkept' }
  }
  if (tS === 'claim' && nPresent && !uPresent && pre) {
    return { kind: 'state', state: 'FI1', postKeep: x.l === 'Nkept' }
  }
  if (tS === 'new' && !nPresent && !uPresent) {
    const state = x.m === 'pre' ? 'FI2' : x.m === 'other' ? 'FI2prime' : 'FI3'
    return { kind: 'state', state, postKeep: false }
  }
  if (tS === 'absent' && !nPresent && uPresent && x.m !== 'post') {
    return { kind: 'state', state: 'FI2u', postKeep: x.l === 'Ukept' }
  }
  return { kind: 'anything-else' }
}

/** Builds `x` in a fresh root with the production primitives. */
async function build(x: Tuple): Promise<IState> {
  const st = fi0(installFixture())
  const { fx } = st
  const snap = path.join(fx.outside, 'snap')
  fs.cpSync(st.newDir, snap, { recursive: true })
  const undone = path.join(st.opDir, 'undone')
  switch (x.l) {
    case 'Nsrc':
      break
    case 'Nkept':
      await keepWith(st, st.newDir, 'unused-new')
      break
    case 'T':
      expect((await claimPublish(st.newDir, fx.realDir)).ok).toBe(true)
      break
    case 'Usrc':
    case 'Ukept':
      fs.renameSync(st.newDir, undone)
      if (x.l === 'Ukept') await keepWith(st, undone, 'undone')
      break
    case 'P': {
      expect((await claimPublish(st.newDir, fx.realDir)).ok).toBe(true)
      const r = parkTree(fx.skillsDir, fx.dirName, {
        client: 'claude-code',
        caller: 'install-rollback',
        kind: 'install-rollback',
        opId: st.opId,
      })
      expect(r.status).toBe('parked')
      break
    }
    case 'none':
      fs.renameSync(st.newDir, path.join(fx.outside, 'gone'))
      break
  }
  if (x.l !== 'T') {
    if (x.t === 'claim') fs.mkdirSync(fx.realDir)
    if (x.t === 'foreign') {
      fs.mkdirSync(fx.realDir)
      fs.writeFileSync(path.join(fx.realDir, 'mine.txt'), 'user\n')
    }
    if (x.t === 'file') fs.writeFileSync(fx.realDir, 'a file\n')
    if (x.t === 'idchanged') fs.cpSync(snap, fx.realDir, { recursive: true })
  }
  if (!x.l.startsWith('N')) {
    if (x.n === 'foreign') {
      fs.mkdirSync(st.newDir)
      fs.writeFileSync(path.join(st.newDir, 'SKILL.md'), '# something else\n')
    }
    if (x.n === 'idchanged') fs.cpSync(snap, st.newDir, { recursive: true })
  }
  if (!x.l.startsWith('U') && x.u === 'other') {
    fs.mkdirSync(undone)
    fs.writeFileSync(path.join(undone, 'x.txt'), 'x\n')
  }
  if (x.pExtra) {
    fs.mkdirSync(parkedDirOf(st), { recursive: true })
    fs.cpSync(snap, path.join(parkedDirOf(st), `${fx.dirName}-deadbeef`), { recursive: true })
  }
  if (x.m === 'post') setEntry(fx, fx.dirName, POST_ENTRY)
  if (x.m === 'other') setEntry(fx, fx.dirName, OTHER_ENTRY)
  return st
}

function tuples(l: L): Tuple[] {
  const out: Tuple[] = []
  const ts: TOther[] = l === 'T' ? ['absent'] : ['absent', 'claim', 'foreign', 'file', 'idchanged']
  const ns: NOther[] = l.startsWith('N') ? ['absent'] : ['absent', 'foreign', 'idchanged']
  const us: UOther[] = l.startsWith('U') ? ['absent'] : ['absent', 'other']
  for (const t of ts)
    for (const n of ns)
      for (const u of us)
        for (const pExtra of [false, true])
          for (const m of ['pre', 'post', 'other'] as const) out.push({ l, t, n, u, pExtra, m })
  return out
}

const shapeOf = (cls: RecoveryClass): Expected =>
  cls.kind === 'state'
    ? { kind: 'state', state: cls.state, postKeep: cls.postKeep }
    : cls.kind === 'identity-changed'
      ? { kind: 'identity-changed' }
      : { kind: 'anything-else' }

describe('T-FIC: every tuple lands in exactly the class the design tables give', () => {
  for (const l of ['T', 'Nsrc', 'Nkept', 'Usrc', 'Ukept', 'P', 'none'] as const) {
    it(`the published folder at ${l}`, { timeout: 120_000 }, async () => {
      const rows = new Set<string>()
      let n = 0
      for (const x of tuples(l)) {
        const cls = (await opReport(await build(x))).cls
        const want = oracle(x)
        expect(shapeOf(cls), JSON.stringify(x)).toEqual(want)
        if (cls.kind === 'anything-else')
          expect(cls.reason.length, JSON.stringify(x)).toBeGreaterThan(0)
        if (cls.kind === 'state') rows.add(`${cls.state}${cls.postKeep ? '+' : ''}`)
        n++
      }
      // The denominator: every tuple of this L was built and classified.
      expect(n).toBe(tuples(l).length)
      // Each L reaches the rows the table gives it.
      const want: Record<L, string[]> = {
        T: ['FI2', 'FI2prime', 'FI3'],
        Nsrc: ['FI0', 'FI1'],
        Nkept: ['FI0+', 'FI1+'],
        Usrc: ['FI2u'],
        Ukept: ['FI2u+'],
        P: ['FI4'],
        none: ['FI2u'],
      }
      expect([...rows].sort()).toEqual(want[l].sort())
    })
  }
})

describe('T-FI4: the set-aside copy is found by identity', () => {
  it('with its sidecar, without it, and with a held one: FI4; with another identity: anything else', async () => {
    const a = await fi4(installFixture())
    expect((await opReport(a)).cls).toMatchObject({ kind: 'state', state: 'FI4' })
    const sidecar = `${a.parked}.json`
    const held = { ...JSON.parse(fs.readFileSync(sidecar, 'utf8')), hold: true }
    fs.writeFileSync(sidecar, JSON.stringify(held))
    const h = await opReport(a)
    expect(h.cls).toMatchObject({ kind: 'state', state: 'FI4' })
    if (h.cls.kind !== 'state') throw new Error('unreachable')
    expect(h.cls.facts.parked).toEqual([
      expect.objectContaining({
        path: a.parked,
        identityMatches: true,
        sidecar: expect.objectContaining({ hold: true }),
      }),
    ])
    fs.unlinkSync(sidecar)
    const none = await opReport(a)
    expect(none.cls).toMatchObject({ kind: 'state', state: 'FI4' })
    if (none.cls.kind !== 'state') throw new Error('unreachable')
    expect(none.cls.facts.parked?.[0]).toMatchObject({ sidecar: null, sidecarError: null })

    // Another identity at the same name (a copy, not the published folder): anything else.
    const b = await fi4(installFixture())
    const copy = `${b.parked}-copy`
    fs.cpSync(b.parked, copy, { recursive: true })
    fs.renameSync(b.parked, path.join(b.fx.outside, 'moved'))
    fs.renameSync(copy, b.parked)
    expect((await opReport(b)).cls).toMatchObject({
      kind: 'anything-else',
      reason: `${b.parked} is not the folder the install published`,
    })
  })

  it('a sidecar naming another kind or opId, or one that is not JSON: anything else', async () => {
    for (const [name, edit] of [
      ['kind', (o: Record<string, unknown>) => ({ ...o, kind: 'uninstall' })],
      ['opId', (o: Record<string, unknown>) => ({ ...o, opId: 'c'.repeat(32) })],
    ] as const) {
      const st = await fi4(installFixture())
      const sidecar = `${st.parked}.json`
      fs.writeFileSync(sidecar, JSON.stringify(edit(JSON.parse(fs.readFileSync(sidecar, 'utf8')))))
      expect((await opReport(st)).cls, name).toMatchObject({
        kind: 'anything-else',
        reason: expect.stringContaining('not this install'),
      })
    }
    const st = await fi4(installFixture())
    fs.writeFileSync(`${st.parked}.json`, '{')
    expect((await opReport(st)).cls).toMatchObject({
      kind: 'anything-else',
      reason: expect.stringContaining('its sidecar is not JSON'),
    })
  })
})

describe('negative states', () => {
  it('an old/ entry in an install op dir is a stray: --apply and --undo refuse naming it', async () => {
    const st = fi0(installFixture())
    fs.mkdirSync(path.join(st.opDir, 'old'))
    const op = await opReport(st)
    expect(op.cls).toMatchObject({ kind: 'state', state: 'FI0' })
    for (const p of op.plans.filter((x) => x.action === 'apply' || x.action === 'undo')) {
      expect(p).toMatchObject({
        offered: false,
        reason: 'recovery-not-offered',
        detail: expect.stringContaining(path.join(st.opDir, 'old')),
      })
    }
  })
})
