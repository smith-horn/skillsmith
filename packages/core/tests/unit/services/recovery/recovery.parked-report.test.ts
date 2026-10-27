/**
 * SMI-6531 (A1 step 6a-iii, owner decision 2026-10-27): an op whose dir is
 * gone but whose parked area `ST/.skillsmith-parked/<opId>` exists is report
 * only. `--apply` / `--undo` say it was already set aside and doctor takes
 * no action (`already-parked`), and the listing names it; neither
 * acts, so nothing is authenticated, and a genuine killed park and a forged
 * container read the same. Each already-parked case asserts zero mutation
 * and no directory open (a dir sync opens its directory first, so no open
 * means no fsync); the positive controls prove the open counter sees a sync.
 *
 * Governance S2 also lives here: an opId that is not one path component is
 * refused before the roots are scanned.
 */
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { syncDirectory } from '../../../../src/install/dir-sync.js'
import type { ReaderOptions } from '../../../../src/services/skill-recovery.reader.js'
import { planRecovery } from '../../../../src/services/skill-recovery.target.js'
import { OP_ID, useTmpCleanup } from '../skill-swap.helpers.js'
import { parkedCopies, useOtherDeviceCleanup, useStubs } from '../skill-swap.xdev.helpers.js'
import { report } from './recovery.helpers.js'
import type { State } from './recovery.helpers.js'
import { act, contentSnapshot, killAt, requestOf } from './recovery.act.helpers.js'
import { killed, xs3 } from './recovery.xdev.helpers.js'

useTmpCleanup()
useOtherDeviceCleanup()
const stub = useStubs()
type AnyFn = (...a: unknown[]) => unknown

const world = (st: State): string => contentSnapshot(st.fx.skillsDir, st.fx.stateRoot, st.fx.base)
const landingOf = (st: State): string => path.join(st.fx.staging, '.skillsmith-parked', OP_ID)

/** A doctor finish killed right after its park moved OP. */
async function genuine(): Promise<State> {
  const st = await xs3({ hooks: { afterBackupMove: () => killed('afterBackupMove') } })
  const first = await act(st, 'apply', {}, killAt('afterPark'))
  expect(first.result.status).toBe('done')
  expect(fs.existsSync(st.opDir)).toBe(false)
  expect(parkedCopies(st.fx)).toHaveLength(1)
  return st
}

/** A forged container: the op dir moved away by hand, an empty `<opId>` dir in the parked area. */
async function forged(): Promise<State> {
  const st = await xs3({ hooks: { afterBackupMove: () => killed('afterBackupMove') } })
  fs.renameSync(st.opDir, path.join(st.fx.base, 'moved-away'))
  fs.mkdirSync(landingOf(st), { recursive: true })
  return st
}

/**
 * Counts every `fs.promises.open`, the call a directory sync starts with.
 * `syncDirectory` takes `open` by a named `fs/promises` import, which a stub
 * reaches only after `syncBuiltinESMExports()`; `useStubs` re-publishes on restore.
 */
function countOpens(): { n: () => number } {
  let n = 0
  stub(fs.promises, 'open', (orig: AnyFn) => async (...a: unknown[]) => {
    n++
    return orig(...a)
  })
  syncBuiltinESMExports()
  return { n: () => n }
}

describe('already set aside (report only, nothing done), its controls and neighbours', () => {
  for (const [label, build] of [
    ['a genuine killed park', genuine],
    ['a forged container', forged],
  ] as const) {
    for (const action of ['apply', 'undo'] as const) {
      it(`${label}, --${action}: already-parked, zero mutation, no open, no trace`, async () => {
        const st = await build()
        const before = world(st)
        const opens = countOpens()
        const a = await act(st, action)
        expect(a.result).toMatchObject({
          status: 'refused',
          reason: 'already-parked',
          paths: [landingOf(st)],
        })
        if (a.result.status === 'refused') {
          expect(a.result.detail).toContain('takes no action')
          expect(a.result.detail).toContain('neither verifies nor syncs')
        }
        expect(a.trace).toEqual([])
        expect(opens.n()).toBe(0)
        expect(world(st)).toBe(before)
      })
    }

    it(`${label}: the listing names it as already set aside`, async () => {
      const st = await build()
      const r = await report(st)
      expect(r.parked).toEqual([{ opId: OP_ID, path: landingOf(st) }])
      expect(r.ops.map((o) => o.opId)).not.toContain(OP_ID)
    })
  }

  it('the pair: with no op dir and no parked area, the plain refusal (nothing named)', async () => {
    const st = await xs3({ hooks: { afterBackupMove: () => killed('afterBackupMove') } })
    const a = await act({ ...st, opId: 'c'.repeat(32) }, 'apply')
    expect(a.result).toMatchObject({ status: 'refused', reason: 'recovery-not-offered' })
    if (a.result.status === 'refused') expect(a.result.detail).toContain('no operation directory')
  })

  it('a parked area for one opId does not make a different opId already-parked', async () => {
    const st = await forged()
    const other = 'c'.repeat(32)
    expect(other).not.toBe(OP_ID)
    const before = world(st)
    const a = await act({ ...st, opId: other }, 'apply')
    expect(a.result).toMatchObject({ status: 'refused', reason: 'recovery-not-offered' })
    expect(world(st)).toBe(before)
  })

  describe('the open counter sees a directory sync (known-positive control)', () => {
    it('a direct syncDirectory counts an open', async () => {
      const st = await forged()
      const opens = countOpens()
      expect(await syncDirectory(st.fx.base)).toEqual({ outcome: 'synced' })
      expect(opens.n()).toBeGreaterThan(0)
    })

    it('an offered apply, which does sync directories, counts opens', async () => {
      const st = await xs3({ hooks: { afterBackupMove: () => killed('afterBackupMove') } })
      const opens = countOpens()
      const a = await act(st, 'apply')
      expect(a.result.status).toBe('done')
      expect(opens.n()).toBeGreaterThan(0)
    })
  })

  describe('a root whose staging is unreadable may hold the operation', () => {
    it('unsafe root A plus a parked copy in root B: recovery-ambiguous, not already-parked', async () => {
      const bad = await xs3({ hooks: { afterBackupMove: () => killed('afterBackupMove') } })
      const good = await forged()
      const badRoot = fs.realpathSync(bad.fx.skillsDir)
      const goodRoot = fs.realpathSync(good.fx.skillsDir)
      // The staging dir becomes a plain file: bindSkillsRootReadOnly refuses it.
      fs.rmSync(bad.fx.staging, { recursive: true, force: true })
      fs.writeFileSync(bad.fx.staging, 'x')
      const before = world(good)
      const r = await planRecovery(requestOf(good, 'apply', { roots: [badRoot, goodRoot] }))
      expect(r).toMatchObject({ status: 'refused', reason: 'recovery-ambiguous' })
      if (r.status !== 'refused') throw new Error('expected a refusal')
      expect(r.detail).toContain(badRoot)
      expect(r.detail).toContain(landingOf(good))
      expect(r.detail).toContain('may hold the operation')
      expect([...r.paths].sort()).toEqual([badRoot, landingOf(good)].sort())
      expect(world(good)).toBe(before)
    })

    it('the pair: with --root on the readable root, it is already-parked', async () => {
      const bad = await xs3({ hooks: { afterBackupMove: () => killed('afterBackupMove') } })
      const good = await forged()
      const goodRoot = fs.realpathSync(good.fx.skillsDir)
      fs.rmSync(bad.fx.staging, { recursive: true, force: true })
      fs.writeFileSync(bad.fx.staging, 'x')
      const roots = [fs.realpathSync(bad.fx.skillsDir), goodRoot]
      const r = await planRecovery(requestOf(good, 'apply', { roots, root: goodRoot }))
      expect(r).toMatchObject({ status: 'refused', reason: 'already-parked' })
    })
  })

  it('an op dir that exists wins over a parked area of the same opId (not reported as parked)', async () => {
    const st = await xs3({ hooks: { afterBackupMove: () => killed('afterBackupMove') } })
    fs.mkdirSync(landingOf(st), { recursive: true })
    const r = await report(st)
    expect(r.parked).toEqual([])
    expect(r.ops.map((o) => o.opId)).toContain(OP_ID)
  })
})

/** The forged state with the op dir moved away and `.skillsmith-parked` left for the case to fill. */
async function moved(): Promise<{ st: State; parkedDir: string; away: string }> {
  const st = await xs3({ hooks: { afterBackupMove: () => killed('afterBackupMove') } })
  const away = path.join(st.fx.base, 'moved-away')
  fs.renameSync(st.opDir, away)
  return { st, parkedDir: path.join(st.fx.staging, '.skillsmith-parked'), away }
}

describe('the listing and the plan agree on what counts as set aside', () => {
  const cases: Array<[string, (c: Awaited<ReturnType<typeof moved>>) => void]> = [
    [
      'a regular file named <opId>',
      (c) => {
        fs.mkdirSync(c.parkedDir, { recursive: true })
        fs.writeFileSync(path.join(c.parkedDir, OP_ID), 'x')
      },
    ],
    [
      'a symlink named <opId>',
      (c) => {
        fs.mkdirSync(c.parkedDir, { recursive: true })
        fs.symlinkSync(c.away, path.join(c.parkedDir, OP_ID))
      },
    ],
    [
      '.skillsmith-parked itself a symlink to a dir holding <opId>/',
      (c) => {
        const elsewhere = path.join(c.st.fx.base, 'elsewhere')
        fs.mkdirSync(path.join(elsewhere, OP_ID), { recursive: true })
        fs.symlinkSync(elsewhere, c.parkedDir)
      },
    ],
  ]
  for (const [label, plant] of cases) {
    it(`${label}: absent from the listing, and not already-parked`, async () => {
      const c = await moved()
      plant(c)
      expect((await report(c.st)).parked).toEqual([])
      const a = await act(c.st, 'apply')
      expect(a.result).toMatchObject({ status: 'refused', reason: 'recovery-not-offered' })
    })
  }

  it('a .prune-x directory is absent from the listing and not already-parked', async () => {
    const c = await moved()
    fs.mkdirSync(path.join(c.parkedDir, '.prune-x'), { recursive: true })
    expect((await report(c.st)).parked).toEqual([])
    const a = await act({ ...c.st, opId: '.prune-x' }, 'apply')
    expect(a.result).toMatchObject({ status: 'refused', reason: 'recovery-not-offered' })
  })

  it('control: a real directory named <opId> is listed and already-parked', async () => {
    const c = await moved()
    fs.mkdirSync(path.join(c.parkedDir, OP_ID), { recursive: true })
    expect((await report(c.st)).parked).toEqual([
      { opId: OP_ID, path: path.join(c.parkedDir, OP_ID) },
    ])
    const a = await act(c.st, 'apply')
    expect(a.result).toMatchObject({ status: 'refused', reason: 'already-parked' })
  })

  it('an opId parked in two roots is already-parked naming both paths', async () => {
    const one = await forged()
    const two = await forged()
    const a = await act(one, 'apply', {
      roots: [fs.realpathSync(one.fx.skillsDir), fs.realpathSync(two.fx.skillsDir)],
    })
    expect(a.result).toMatchObject({ status: 'refused', reason: 'already-parked' })
    if (a.result.status !== 'refused') throw new Error('expected a refusal')
    expect([...a.result.paths].sort()).toEqual([landingOf(one), landingOf(two)].sort())
    for (const p of a.result.paths) expect(a.result.detail).toContain(p)
  })

  it('an op dir in one root and a parked copy in another: ambiguous; --root picks each', async () => {
    const live = await xs3({ hooks: { afterBackupMove: () => killed('afterBackupMove') } })
    const gone = await forged()
    const liveRoot = fs.realpathSync(live.fx.skillsDir)
    const goneRoot = fs.realpathSync(gone.fx.skillsDir)
    const roots = [liveRoot, goneRoot]
    const before = world(live)
    const bare = await planRecovery(requestOf(live, 'apply', { roots }))
    expect(bare).toMatchObject({ status: 'refused', reason: 'recovery-ambiguous' })
    if (bare.status !== 'refused') throw new Error('expected a refusal')
    expect([...bare.paths].sort()).toEqual([live.opDir, landingOf(gone)].sort())
    expect(world(live)).toBe(before)
    const pickLive = await planRecovery(requestOf(live, 'apply', { roots, root: liveRoot }))
    expect(pickLive).toMatchObject({ status: 'planned', opDir: live.opDir })
    const pickGone = await planRecovery(requestOf(live, 'apply', { roots, root: goneRoot }))
    expect(pickGone).toMatchObject({ status: 'refused', reason: 'already-parked' })
  })
})

describe('governance S2: an opId that is not one path component is refused before the roots are scanned', () => {
  /** A real root holding a parked area, with a counter on every reader stat. */
  async function counted(): Promise<{
    roots: string[]
    reads: () => number
    reader: ReaderOptions
  }> {
    const st = await forged()
    let n = 0
    const reader: ReaderOptions = {
      statOverride: (_p, real) => {
        n++
        return real
      },
    }
    return { roots: [fs.realpathSync(st.fx.skillsDir)], reads: () => n, reader }
  }

  for (const opId of ['..', '.', '', 'a/b', `${OP_ID}\0`, '../escape']) {
    it(JSON.stringify(opId), async () => {
      const c = await counted()
      const r = await planRecovery({ action: 'apply', opId, roots: c.roots, reader: c.reader })
      expect(r).toMatchObject({ status: 'refused', reason: 'recovery-not-offered' })
      if (r.status === 'refused') expect(r.detail).toContain('is not an operation id')
      expect(c.reads()).toBe(0)
    })
  }

  it('the pair (known-positive control): a well-formed opId on the same root does read', async () => {
    const c = await counted()
    const r = await planRecovery({ action: 'apply', opId: OP_ID, roots: c.roots, reader: c.reader })
    expect(r).toMatchObject({ status: 'refused', reason: 'already-parked' })
    expect(c.reads()).toBeGreaterThan(0)
  })

  it('the pair: a well-formed opId reaches the scan (and is not found)', async () => {
    const r = await planRecovery({ action: 'apply', opId: OP_ID, roots: ['/nonexistent-root'] })
    expect(r).toMatchObject({ status: 'refused', reason: 'recovery-not-offered' })
    if (r.status === 'refused') expect(r.detail).toContain('no operation directory named')
  })
})
