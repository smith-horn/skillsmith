/**
 * SMI-6531 (A1 step 6a-iii, owner decision 2026-10-27): an op whose dir is
 * gone but whose parked area `ST/.skillsmith-parked/<opId>` exists is report
 * only. `--apply` / `--undo` say it was already set aside and there is
 * nothing left to do (`already-parked`), and the listing names it; neither
 * acts, so nothing is authenticated, and a genuine killed park and a forged
 * container read the same. Each case asserts zero mutation and no directory
 * open (a dir sync opens its directory first, so no open means no fsync).
 *
 * Governance S2 also lives here: an opId that is not one path component is
 * refused before any read.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { planRecovery } from '../../../../src/services/skill-recovery.target.js'
import { OP_ID, useTmpCleanup } from '../skill-swap.helpers.js'
import { parkedCopies, useOtherDeviceCleanup, useStubs } from '../skill-swap.xdev.helpers.js'
import { report } from './recovery.helpers.js'
import type { State } from './recovery.helpers.js'
import { act, contentSnapshot, killAt } from './recovery.act.helpers.js'
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

/** Counts every `fs.promises.open`, the call a directory sync starts with. */
function countOpens(): { n: () => number } {
  let n = 0
  stub(fs.promises, 'open', (orig: AnyFn) => async (...a: unknown[]) => {
    n++
    return orig(...a)
  })
  return { n: () => n }
}

describe('already set aside: report only, nothing done', () => {
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
          expect(a.result.detail).toContain('nothing left to do')
          expect(a.result.detail).toContain('did not verify')
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

  it('an op dir that exists wins over a parked area of the same opId (not reported as parked)', async () => {
    const st = await xs3({ hooks: { afterBackupMove: () => killed('afterBackupMove') } })
    fs.mkdirSync(landingOf(st), { recursive: true })
    const r = await report(st)
    expect(r.parked).toEqual([])
    expect(r.ops.map((o) => o.opId)).toContain(OP_ID)
  })
})

describe('governance S2: an opId that is not one path component is refused before any read', () => {
  for (const opId of ['..', '.', '', 'a/b', `${OP_ID}\0`, '../escape']) {
    it(JSON.stringify(opId), async () => {
      let reads = 0
      const r = await planRecovery({
        action: 'apply',
        opId,
        roots: ['/nonexistent-skills-root'],
        reader: {
          statOverride: (_p, real) => {
            reads++
            return real
          },
        },
      })
      expect(r).toMatchObject({ status: 'refused', reason: 'recovery-not-offered' })
      if (r.status === 'refused') expect(r.detail).toContain('is not an operation id')
      expect(reads).toBe(0)
    })
  }

  it('the pair: a well-formed opId reaches the scan (and is not found)', async () => {
    const r = await planRecovery({ action: 'apply', opId: OP_ID, roots: ['/nonexistent-root'] })
    expect(r).toMatchObject({ status: 'refused', reason: 'recovery-not-offered' })
    if (r.status === 'refused') expect(r.detail).toContain('no operation directory named')
  })
})
