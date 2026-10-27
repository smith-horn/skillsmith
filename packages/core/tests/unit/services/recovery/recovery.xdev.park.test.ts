/**
 * SMI-6531 (A1 step 6a-iii): the park of the op dir after cross-device keeps,
 * and the space block (T-J16, T-X17's doctor P4 row, T-F1's space-block half
 * and doctor's own full-device marker).
 *
 *  - T-J16: OP is parked only after `dest` exists, was synced and hashed equal
 *    to the source (trace order); never while only a partial copy exists (a
 *    kill after a P2 keep leaves no park); a source edited after its copy is
 *    kept as `partial-copy` and copied again, with the edit in `dest`.
 *  - T-X17 (P4 row): a park that ends `kept`, `held` or `stopped` leaves the
 *    backup complete, reports `removal-not-done` (the CLI maps it to exit 4),
 *    and deletes no tree entry.
 *  - T-F1 (space block): too little space or too few inodes for the copy
 *    refuses `state-root-full` with the free-space remedy (the prune command
 *    is 6c, so the message says it is not available yet), with zero mutation,
 *    and three attempts add no `partial-copy`; once the partial is removed by
 *    hand `--apply` completes. Doctor's own `ENOSPC` records the marker in the adopted record.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parkTreeIndexed } from '../../../../src/install/park-call.js'
import { inodesNeeded, shapeOf } from '../../../../src/services/skill-swap.space.js'
import type { SwapOptions } from '../../../../src/services/skill-swap.js'
import { areaOf, hashOf, OP_ID, readRecord, useTmpCleanup } from '../skill-swap.helpers.js'
import {
  errnoError,
  isCreateUnder,
  parkedCopies,
  useOtherDeviceCleanup,
  useStubs,
} from '../skill-swap.xdev.helpers.js'
import { s1, s3 } from './recovery.helpers.js'
import type { State } from './recovery.helpers.js'
import { act, contentSnapshot, done, killAt } from './recovery.act.helpers.js'
import {
  actSpied,
  backupOf,
  copyTemp,
  killed,
  partialTrees,
  theParkedCopy,
  treeDeletesDoctor,
  xfile,
  xs3,
} from './recovery.xdev.helpers.js'

useTmpCleanup()
useOtherDeviceCleanup()
const stub = useStubs()

const world = (st: State): string => contentSnapshot(st.fx.skillsDir, st.fx.stateRoot, st.fx.base)
const idx = (trace: readonly { op: string }[], f: (t: never) => boolean): number =>
  trace.findIndex((t) => f(t as never))

describe('T-J16: the op dir is parked only after dest verified and was synced', () => {
  it('a fresh cross-device keep: compare equal, rename temp to dest, sync the area, then the park', async () => {
    const st = await s3(xfile())
    const a = await done(st, 'apply')
    const area = areaOf(st.fx)
    const t = a.trace
    const cmp = idx(
      t,
      (x: { op: string; path: string; equal: boolean }) =>
        x.op === 'compare' && x.path === copyTemp(st.fx)
    )
    const ren = idx(
      t,
      (x: { op: string; path: string; dest: string }) =>
        x.op === 'rename' && x.path === copyTemp(st.fx) && x.dest === backupOf(st.fx)
    )
    const park = idx(t, (x: { op: string }) => x.op === 'park')
    expect(cmp).toBeGreaterThan(-1)
    expect((t[cmp] as { equal: boolean }).equal).toBe(true)
    expect(ren).toBeGreaterThan(cmp)
    expect(t[ren + 1]).toEqual({ op: 'dirsync', path: area })
    expect(park).toBeGreaterThan(ren + 1)
    expect(theParkedCopy(st.fx)).toBe(a.result.extraCopy)
  })

  it('a P4 resume: the area is synced before the park, and nothing is renamed into the area', async () => {
    const st = await xs3({ hooks: { afterBackupMove: () => killed('afterBackupMove') } })
    const a = await done(st, 'apply')
    const area = areaOf(st.fx)
    const sync = idx(
      a.trace,
      (x: { op: string; path: string }) => x.op === 'dirsync' && x.path === area
    )
    const park = idx(a.trace, (x: { op: string }) => x.op === 'park')
    expect(sync).toBeGreaterThan(-1)
    expect(park).toBeGreaterThan(sync)
    expect(a.trace.some((x) => x.op === 'rename' && x.dest === backupOf(st.fx))).toBe(false)
    expect(hashOf(backupOf(st.fx))).toBe(st.p.input.preTree)
  })

  it('P2 never parks: a kill after the partial keep leaves no park, and the rerun finishes', async () => {
    const st = await xs3({ duringBackupCopy: () => killed('mid-copy') })
    const first = await act(st, 'apply', {}, killAt('afterPartialKeep'))
    expect(first.result.status).toBe('stopped')
    expect(first.trace.some((x) => x.op === 'park')).toBe(false)
    expect(first.trace.some((x) => x.op === 'rename' && x.dest.includes('.partial-copy'))).toBe(
      true
    )
    expect(parkedCopies(st.fx)).toEqual([])
    expect(fs.existsSync(path.join(st.opDir, 'record.json'))).toBe(true)
    expect(partialTrees(st.fx)).toHaveLength(1)
    const again = await done(st, 'apply')
    expect(again.trace.some((x) => x.op === 'park')).toBe(true)
    expect(partialTrees(st.fx)).toHaveLength(1)
    expect(hashOf(backupOf(st.fx))).toBe(st.p.input.preTree)
  })

  it('P2 never parks: a kill inside the copy again leaves no park', async () => {
    const st = await xs3({ duringBackupCopy: () => killed('mid-copy') })
    let n = 0
    const first = await act(
      st,
      'apply',
      {},
      {
        swap: { duringBackupCopy: () => void (++n === 2 && killed('mid-copy again')) },
      }
    )
    expect(first.result.status).toBe('stopped')
    expect(first.trace.some((x) => x.op === 'park')).toBe(false)
    expect(parkedCopies(st.fx)).toEqual([])
    expect(fs.existsSync(st.opDir)).toBe(true)
  })

  it('a source edited after its copy: the copy kept as partial-copy, copied again, the edit in dest', async () => {
    const st = await s3(xfile())
    const src = path.join(st.opDir, 'old', 'a.txt')
    let edited = false
    const a = await actSpied(st, 'apply', {
      swap: {
        hooks: {
          afterBackupCopy: () => {
            if (edited) return
            edited = true
            fs.writeFileSync(src, 'edited between the copy and the compare\n')
          },
        },
      },
    })
    expect(a.result.status).toBe('done')
    const dest = backupOf(st.fx)
    expect(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8')).toBe(
      'edited between the copy and the compare\n'
    )
    const kept = partialTrees(st.fx)
    expect(kept).toHaveLength(1)
    expect(fs.readFileSync(path.join(kept[0]!, 'a.txt'), 'utf8')).toBe('a\n')
    const side = JSON.parse(fs.readFileSync(`${dest}.json`, 'utf8')) as { treeHash: string }
    expect(side.treeHash).toBe(hashOf(dest))
    const parked = theParkedCopy(st.fx)
    expect(fs.readFileSync(path.join(parked, 'old', 'a.txt'), 'utf8')).toBe(
      'edited between the copy and the compare\n'
    )
    expect(treeDeletesDoctor(st.fx, a.events)).toEqual([])
  })
})

type AnyFn = (...a: unknown[]) => unknown

interface NotDoneCase {
  status: 'kept' | 'held' | 'stopped'
  reason: string
  arrange: (st: State) => SwapOptions
}

const NOT_DONE: NotDoneCase[] = [
  {
    status: 'kept',
    reason: 'identity-changed',
    arrange: () => ({
      park: (parent, name, o) => parkTreeIndexed(parent, name, { ...o, guardHash: 'f'.repeat(64) }),
    }),
  },
  {
    status: 'held',
    reason: 'changed-during-move',
    arrange: (st) => {
      let fd: number | null = null
      stub(fs, 'renameSync', (orig: AnyFn) => (...a: unknown[]) => {
        const out = orig(...a)
        if (a[0] === st.opDir && fd !== null) {
          fs.writeSync(fd, 'through the fd\n')
          fs.closeSync(fd)
          fd = null
        }
        return out
      })
      return {
        hooks: {
          afterOwnerUnlink: () => {
            fd = fs.openSync(path.join(st.opDir, 'old', 'a.txt'), 'a')
          },
        },
      }
    },
  },
  {
    status: 'stopped',
    reason: 'park-failed',
    arrange: (st) => {
      stub(fs, 'renameSync', (orig: AnyFn) => (...a: unknown[]) => {
        if (a[0] === st.opDir) throw errnoError('EACCES')
        return orig(...a)
      })
      return {}
    },
  },
]

describe('T-X17 (doctor P4 row): a park that does not finish is a removal not done', () => {
  for (const c of NOT_DONE) {
    it(`${c.status}/${c.reason}: done with removal-not-done, the backup complete, no tree deleted`, async () => {
      const st = await xs3({ hooks: { afterBackupMove: () => killed('afterBackupMove') } })
      const a = await actSpied(st, 'apply', { swap: c.arrange(st) })
      expect(a.result.status).toBe('done')
      if (a.result.status !== 'done') return
      const w = a.result.warnings.filter((x) => x.code === 'removal-not-done')
      expect(w).toHaveLength(1)
      expect(w[0]).toMatchObject({ path: st.opDir, status: c.status, reason: c.reason })
      expect(a.result.extraCopy).toBeNull()
      expect(hashOf(backupOf(st.fx))).toBe(st.p.input.preTree)
      expect(fs.existsSync(`${backupOf(st.fx)}.json`)).toBe(true)
      const where = c.status === 'held' ? theParkedCopy(st.fx) : st.opDir
      if (c.status !== 'held') expect(parkedCopies(st.fx)).toEqual([])
      expect(fs.readdirSync(where).sort()).toEqual(['old', 'park-intent.json'])
      expect(treeDeletesDoctor(st.fx, a.events)).toEqual([])
      expect(a.events.some((e) => 'fs' in e && e.path === path.join(st.opDir, 'record.json'))).toBe(
        true
      )
    })
  }
})

/** A full-device state: the update's own copy hit ENOSPC, kept its partial and marked its record. */
async function fullDevice(): Promise<State> {
  const fx = xfile()
  let creates = 0
  let failing = true
  stub(fs.promises, 'open', (orig: AnyFn) => async (...a: unknown[]) => {
    if (failing && isCreateUnder(a, copyTemp(fx)) && ++creates === 2) throw errnoError('ENOSPC')
    return orig(...a)
  })
  const st = await xs3({}, fx)
  failing = false
  expect(readRecord(path.join(st.opDir, 'record.json')).fullDevice).toMatchObject({
    cause: 'ENOSPC',
    stage: 'copy',
  })
  expect(partialTrees(st.fx)).toHaveLength(1)
  return st
}

/** `statfs` of the area's device reports `over` (the rest as measured). */
function statfsAs(st: State, over: (s: fs.BigIntStatsFs) => Partial<fs.BigIntStatsFs>) {
  let on = true
  stub(fs.promises, 'statfs', (orig: AnyFn) => async (...a: unknown[]) => {
    const s = (await orig(...a)) as fs.BigIntStatsFs
    return on && String(a[0]).startsWith(st.fx.stateRoot) ? { ...s, ...over(s) } : s
  })
  return { off: () => void (on = false) }
}

/** The remedy, written out here so a change to it fails these tests (not imported). */
const REMEDY_TEXT =
  'free space on the device that holds the Skillsmith state directory (a prune command, `skillsmith doctor backups --prune`, is planned but not available yet)'

describe('T-F1 (space block): state-root-full with the free-space remedy, with zero mutation', () => {
  it('too few bytes: three attempts refuse with nothing changed; after freeing space by hand --apply completes', async () => {
    const st = await fullDevice()
    const lim = statfsAs(st, () => ({ bavail: 1n }))
    const before = world(st)
    for (let i = 0; i < 3; i++) {
      const a = await act(st, 'apply')
      expect(a.result).toMatchObject({ status: 'refused', reason: 'state-root-full' })
      if (a.result.status === 'refused') {
        const tail = `; nothing was changed; ${REMEDY_TEXT}, then run this command again`
        expect(a.result.detail.slice(-tail.length)).toBe(tail)
        expect(a.result.detail).toContain(
          'free space on the device that holds the Skillsmith state directory'
        )
        expect(a.result.detail).toContain('not available yet')
        expect(a.result.detail).toContain('run this command again')
        expect(a.result.detail).not.toContain('finish the update')
        expect(a.result.detail).not.toContain('run `skillsmith doctor backups --prune`')
      }
      expect(world(st)).toBe(before)
      expect(partialTrees(st.fx)).toHaveLength(1)
    }
    // Freeing space by hand (6c's prune command is not available yet): the partial and its sidecar.
    const partial = partialTrees(st.fx)[0]!
    fs.rmSync(partial, { recursive: true })
    fs.rmSync(`${partial}.json`)
    lim.off()
    const a = await done(st, 'apply')
    expect(a.result.status).toBe('done')
    expect(hashOf(backupOf(st.fx))).toBe(st.p.input.preTree)
    expect(fs.existsSync(st.opDir)).toBe(false)
  })

  it('too few inodes (free at need minus one) refuses; exactly the need does not (the pair)', async () => {
    const st = await xs3({ hooks: { afterSidecar: () => killed('afterSidecar') } })
    const need = inodesNeeded(shapeOf(path.join(st.opDir, 'old'), null))
    const lim = statfsAs(st, () => ({ ffree: need - 1n, files: need * 10n }))
    const before = world(st)
    const a = await act(st, 'apply')
    expect(a.result).toMatchObject({ status: 'refused', reason: 'state-root-full' })
    expect(world(st)).toBe(before)
    lim.off()
    statfsAs(st, () => ({ ffree: need, files: need * 10n }))
    expect((await done(st, 'apply')).result.status).toBe('done')
  })
})

describe("the copy's own space check, reached through doctor --undo", () => {
  it('stops state-root-full with the facts and the remedy only: no --apply, no "finish the update"', async () => {
    // S1 --undo installs O, then keeps N as unused-new across devices: a real
    // `publishTree` call from doctor. The space block (which would refuse first
    // and name "run this command again") sees plenty; the copy's own check, one
    // statfs later, sees a full device. So the refusal observed is `spaceFirst`'s.
    const st = await s1(xfile())
    let asked = 0
    stub(fs.promises, 'statfs', (orig: AnyFn) => async (...a: unknown[]) => {
      const s = (await orig(...a)) as fs.BigIntStatsFs
      if (!String(a[0]).startsWith(st.fx.stateRoot)) return s
      return ++asked === 1 ? s : { ...s, bavail: 1n }
    })
    const a = await act(st, 'undo')
    expect(asked).toBe(2)
    expect(a.result.status).toBe('stopped')
    if (a.result.status !== 'stopped') return
    expect(a.result.reason).toBe('state-root-full')
    expect(a.result.detail.slice(-(REMEDY_TEXT.length + 2))).toBe(`; ${REMEDY_TEXT}`)
    expect(a.result.detail).toContain(
      'free space on the device that holds the Skillsmith state directory'
    )
    expect(a.result.detail).toContain('not available yet')
    expect(a.result.detail).not.toContain('--apply')
    expect(a.result.detail).not.toContain('finish the update')
    expect(a.result.detail).not.toContain('run this command again')
  })
})

describe("doctor's own full-device stop records the marker in the adopted record", () => {
  it('ENOSPC in its copy: stopped, record.json marked (cause, stage, area, opId, dest), the partial kept', async () => {
    const st = await s3(xfile())
    let creates = 0
    let failing = true
    stub(fs.promises, 'open', (orig: AnyFn) => async (...a: unknown[]) => {
      if (failing && isCreateUnder(a, copyTemp(st.fx)) && ++creates === 2) {
        throw errnoError('ENOSPC')
      }
      return orig(...a)
    })
    const a = await act(st, 'apply')
    failing = false
    expect(a.result).toMatchObject({ status: 'stopped', reason: 'write-failed' })
    const rec = readRecord(path.join(st.opDir, 'record.json'))
    expect(rec.fullDevice).toEqual({
      cause: 'ENOSPC',
      stage: 'copy',
      area: areaOf(st.fx),
      opId: OP_ID,
      dest: backupOf(st.fx),
    })
    expect(fs.existsSync(path.join(st.opDir, 'record.json.tmp'))).toBe(false)
    expect(partialTrees(st.fx)).toHaveLength(1)
    // The marked record is one doctor resumes.
    expect((await done(st, 'apply')).result.status).toBe('done')
    expect(fs.existsSync(st.opDir)).toBe(false)
  })
})

describe('a park intent beside a record (a cross-device finish that stopped before the record went)', () => {
  /** P4 with the finish killed right after its intent was published. */
  async function intentLeft(): Promise<State> {
    const st = await xs3({ hooks: { afterBackupMove: () => killed('afterBackupMove') } })
    const first = await act(st, 'apply', {}, killAt('afterIntent'))
    expect(first.result.status).toBe('stopped')
    expect(fs.existsSync(path.join(st.opDir, 'park-intent.json'))).toBe(true)
    expect(fs.existsSync(path.join(st.opDir, 'record.json'))).toBe(true)
    return st
  }

  it("this op's move-source intent is reused: no second intent is published", async () => {
    const st = await intentLeft()
    const intent = path.join(st.opDir, 'park-intent.json')
    const ino = fs.lstatSync(intent).ino
    const a = await done(st, 'apply')
    expect(a.trace.some((t) => t.op === 'create' && t.path === `${intent}.tmp`)).toBe(false)
    const parked = theParkedCopy(st.fx)
    expect(fs.lstatSync(path.join(parked, 'park-intent.json')).ino).toBe(ino)
  })

  it("an intent that is not this op's is anything else: --apply refused, nothing changed", async () => {
    const st = await intentLeft()
    const intent = path.join(st.opDir, 'park-intent.json')
    const v = JSON.parse(fs.readFileSync(intent, 'utf8')) as Record<string, unknown>
    fs.writeFileSync(intent, JSON.stringify({ ...v, opId: 'b'.repeat(32) }))
    const before = world(st)
    const a = await act(st, 'apply')
    expect(a.result).toMatchObject({ status: 'refused', reason: 'recovery-not-offered' })
    expect(world(st)).toBe(before)
  })

  it('a leftover intent temp (killed after its write) is unlinked, then a new intent published', async () => {
    const st = await xs3({ hooks: { afterBackupMove: () => killed('afterBackupMove') } })
    const first = await act(st, 'apply', {}, killAt('afterIntentTemp'))
    expect(first.result.status).toBe('stopped')
    const tmp = path.join(st.opDir, 'park-intent.json.tmp')
    expect(fs.existsSync(tmp)).toBe(true)
    const a = await done(st, 'apply')
    expect(a.trace).toContainEqual({ op: 'unlink', path: tmp })
    expect(a.trace.some((t) => t.op === 'create' && t.path === tmp)).toBe(true)
    expect(fs.readdirSync(theParkedCopy(st.fx)).sort()).toEqual(['old', 'park-intent.json'])
  })

  it('a leftover intent temp that is not provable is anything else (the provable one, above, the pair)', async () => {
    const st = await xs3({ hooks: { afterBackupMove: () => killed('afterBackupMove') } })
    fs.writeFileSync(path.join(st.opDir, 'park-intent.json.tmp'), 'not an intent')
    const before = world(st)
    const a = await act(st, 'apply')
    expect(a.result).toMatchObject({ status: 'refused', reason: 'recovery-not-offered' })
    expect(world(st)).toBe(before)
  })
})
