/**
 * SMI-6531 (A1 step 6a-iii, owner decision 2026-10-26): `--apply` / `--undo`
 * finish the park of an op dir whose record is gone, from its verifying
 * `park-intent.json`. (An already-moved park is report-only:
 * `recovery.parked-report.test.ts`.)
 *
 * Positives: a doctor finish killed after it unlinked the record, and the
 * update's own step 13 killed after its record unlink (with `owner.json` still
 * there), each finished by the same command, as the uninterrupted run would.
 * Negatives, each with zero mutation: another user's (the intent's uid, and
 * `owner.json`'s uid winning over the intent's), an intent that does not
 * verify (another opId, OP replaced by a copy), an `abort-new` intent, a
 * `backupPath` outside this root's area, an entry the park would not carry,
 * and an intent edited between the plan and the lock (`plan-changed`).
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parkTreeIndexed } from '../../../../src/install/park-call.js'
import { hashOf, modify, OP_ID, plan, run, useTmpCleanup } from '../skill-swap.helpers.js'
import { useOtherDeviceCleanup } from '../skill-swap.xdev.helpers.js'
import { opReport, syncManifest } from './recovery.helpers.js'
import type { State } from './recovery.helpers.js'
import { act, contentSnapshot, done, killAt } from './recovery.act.helpers.js'
import { backupOf, killed, theParkedCopy, xfile, xs3 } from './recovery.xdev.helpers.js'
import { executeRecovery } from '../../../../src/services/skill-recovery.exec.js'
import { planRecovery } from '../../../../src/services/skill-recovery.target.js'
import { requestOf } from './recovery.act.helpers.js'

useTmpCleanup()
useOtherDeviceCleanup()

const world = (st: State): string => contentSnapshot(st.fx.skillsDir, st.fx.stateRoot, st.fx.base)
const intentOf = (st: State): string => path.join(st.opDir, 'park-intent.json')

/** A doctor cross-device finish killed right after it unlinked the record. */
async function doctorLeft(): Promise<State> {
  const st = await xs3({ hooks: { afterBackupMove: () => killed('afterBackupMove') } })
  const first = await act(st, 'apply', {}, killAt('afterRecordUnlink'))
  expect(first.result.status).toBe('done')
  expect(fs.readdirSync(st.opDir).sort()).toEqual(['old', 'park-intent.json'])
  return st
}

/** Edits the intent's JSON (same file name; a new inode is fine, the plan reads it fresh). */
function editIntent(st: State, f: (v: Record<string, unknown>) => Record<string, unknown>): void {
  const v = JSON.parse(fs.readFileSync(intentOf(st), 'utf8')) as Record<string, unknown>
  fs.writeFileSync(intentOf(st), JSON.stringify(f(v), null, 2) + '\n')
}

/** Plans `--apply` and requires it refused with `reason`, nothing changed. */
async function refusedWith(st: State, reason: string, words?: string): Promise<void> {
  const before = world(st)
  const a = await act(st, 'apply')
  expect(a.result).toMatchObject({ status: 'refused', reason })
  if (words !== undefined && a.result.status === 'refused') expect(a.result.detail).toContain(words)
  expect(world(st)).toBe(before)
}

describe('a no-record op dir with a verifying intent: the same command finishes the park', () => {
  for (const action of ['apply', 'undo'] as const) {
    it(`--${action}: the op dir parked whole with its source and intent; nothing removed`, async () => {
      const st = await doctorLeft()
      const op = await opReport(st)
      expect(op.cls).toMatchObject({ kind: 'no-record', intent: { blocked: null } })
      const ino = fs.lstatSync(intentOf(st)).ino
      const a = await done(st, action)
      expect(a.trace.filter((t) => t.op === 'park')).toHaveLength(1)
      expect(a.trace.filter((t) => t.op === 'unlink' || t.op === 'rmdir')).toEqual([])
      const parked = theParkedCopy(st.fx)
      expect(a.result.extraCopy).toBe(parked)
      expect(fs.readdirSync(parked).sort()).toEqual(['old', 'park-intent.json'])
      expect(fs.lstatSync(path.join(parked, 'park-intent.json')).ino).toBe(ino)
      expect(hashOf(path.join(parked, 'old'))).toBe(st.p.input.preTree)
      expect(fs.existsSync(st.opDir)).toBe(false)
      expect(a.result.warnings).toEqual([])
    })
  }

  it("the update's own step 13 killed after its record unlink: owner.json unlinked, then the park", async () => {
    const fx = xfile()
    const p = plan(fx, [modify('SKILL.md', '# v2\n')])
    const r = await run(p, { hooks: { afterRecordUnlink: () => killed('afterRecordUnlink') } })
    expect(r.result.status).toBe('committed')
    const st: State = { fx, p, opId: OP_ID, opDir: fx.opDir }
    syncManifest(st)
    expect(fs.readdirSync(st.opDir).sort()).toEqual(['old', 'owner.json', 'park-intent.json'])
    const a = await done(st, 'apply')
    const owner = path.join(st.opDir, 'owner.json')
    const u = a.trace.findIndex((t) => t.op === 'unlink' && t.path === owner)
    const k = a.trace.findIndex((t) => t.op === 'park')
    expect(u).toBeGreaterThan(-1)
    expect(a.trace[u + 1]).toEqual({ op: 'dirsync', path: st.opDir })
    expect(k).toBeGreaterThan(u)
    expect(a.trace.filter((t) => t.op === 'unlink').map((t) => t.path)).toEqual([owner])
    expect(fs.readdirSync(theParkedCopy(fx)).sort()).toEqual(['old', 'park-intent.json'])
    expect(hashOf(backupOf(fx))).toBe(p.input.preTree)
  })

  it('a park that does not finish: done with removal-not-done (the CLI exits 4), OP left whole', async () => {
    const st = await doctorLeft()
    const a = await done(
      st,
      'apply',
      {},
      {
        swap: {
          park: (parent, name, o) =>
            parkTreeIndexed(parent, name, { ...o, guardHash: 'f'.repeat(64) }),
        },
      }
    )
    expect(a.result.warnings).toMatchObject([
      { code: 'removal-not-done', path: st.opDir, status: 'kept', reason: 'identity-changed' },
    ])
    expect(a.result.extraCopy).toBeNull()
    expect(fs.readdirSync(st.opDir).sort()).toEqual(['old', 'park-intent.json'])
  })
})

describe('refused, with zero mutation', () => {
  it("another user's: the intent's uid", async () => {
    const st = await doctorLeft()
    editIntent(st, (v) => ({ ...v, owner: { ...(v.owner as object), uid: 424242 } }))
    await refusedWith(st, 'recovery-other-user', '424242')
  })

  it("owner.json's uid wins over the intent's", async () => {
    const st = await doctorLeft()
    fs.writeFileSync(
      path.join(st.opDir, 'owner.json'),
      JSON.stringify({ pid: 1, host: 'h', uid: 434343 })
    )
    await refusedWith(st, 'recovery-other-user', '434343')
  })

  it('an intent for another opId (it does not verify): offered only --clean-staging', async () => {
    const st = await doctorLeft()
    editIntent(st, (v) => ({ ...v, opId: 'b'.repeat(32) }))
    await refusedWith(st, 'recovery-not-offered', 'does not verify')
  })

  it("OP replaced by a copy (its identity is not the intent's)", async () => {
    const st = await doctorLeft()
    const aside = `${st.opDir}-aside`
    fs.renameSync(st.opDir, aside)
    fs.cpSync(aside, st.opDir, { recursive: true })
    await refusedWith(st, 'recovery-not-offered', 'does not verify')
  })

  it('an abort-new intent (no backupPath): --clean-staging, not --apply', async () => {
    const st = await doctorLeft()
    editIntent(st, (v) => {
      const { backupPath: _b, ...rest } = v
      return { ...rest, kind: 'abort-new' }
    })
    await refusedWith(st, 'recovery-not-offered', 'abort-new')
  })

  it("a backupPath outside this root's backup area", async () => {
    const st = await doctorLeft()
    editIntent(st, (v) => ({ ...v, backupPath: path.join(st.fx.base, OP_ID) }))
    await refusedWith(st, 'recovery-not-offered', 'backup area')
  })

  it('an entry the park would not carry', async () => {
    const st = await doctorLeft()
    fs.writeFileSync(path.join(st.opDir, 'stray.txt'), 'stray\n')
    await refusedWith(st, 'recovery-not-offered', 'stray.txt')
  })

  it('the intent edited between the plan and the lock: plan-changed', async () => {
    const st = await doctorLeft()
    const planned = await planRecovery(requestOf(st, 'apply'))
    expect(planned.status).toBe('planned')
    if (planned.status !== 'planned') return
    // Still a valid intent (another pid), but not the bytes the plan read.
    editIntent(st, (v) => ({ ...v, owner: { ...(v.owner as object), pid: 9 } }))
    const before = world(st)
    const r = await executeRecovery(planned)
    expect(r).toMatchObject({ status: 'refused', reason: 'plan-changed' })
    expect(world(st)).toBe(before)
  })
})
