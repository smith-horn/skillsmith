/**
 * SMI-6531 (A1 step 6b-ii): `--clean-staging` across devices (design
 * `step6b-design.md` § 1.2 case (b) step 7, § 6 "Cross-device
 * --clean-staging"; UD28, PLAN:1916 park-caller row 2). The state root is on
 * another device (`/dev/shm`): N is copied and verified into the area, the
 * verified N stays in OP, the move-source intent is made durable, the
 * metadata goes (`owner.json` last), and OP is parked whole. Zero tree
 * deletes (the fs spy); a kill at each boundary, then the same command, ends
 * as an uninterrupted run would. Also T-PI2's move-source half: a doctor
 * cross-device finish killed after its record went is finished by
 * `--clean-staging` too.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SwapHookPoint } from '../../../../src/services/skill-swap.js'
import { ALL_DELETES, contentOf, spyFs } from '../skill-swap.abort.helpers.js'
import type { Event } from '../skill-swap.abort.helpers.js'
import { areaOf, hashOf, OP_ID, useTmpCleanup } from '../skill-swap.helpers.js'
import { useOtherDeviceCleanup } from '../skill-swap.xdev.helpers.js'
import { act, done, killAt } from './recovery.act.helpers.js'
import type { State } from './recovery.helpers.js'
import { abortLeft, ALIVE, dead, keptAt, opNames, sidecarAt } from './recovery.clean.helpers.js'
import {
  contentSet,
  killed,
  nothingLost,
  theParkedCopy,
  treeDeletesDoctor,
  xfile,
  xs3,
} from './recovery.xdev.helpers.js'

useTmpCleanup()
useOtherDeviceCleanup()

const everything = (st: State): Set<string> => contentSet(st.fx.skillsDir, st.fx.stateRoot)

describe('cross-device --clean-staging: copy, verify, intent, park; no tree deleted', () => {
  it('N kept (verified copy) in the other-device area; OP parked whole with N and the intent', async () => {
    const st = await abortLeft('abortAfterCheck', { editN: true }, xfile())
    const nHash = hashOf(path.join(st.opDir, 'new'))
    const before = everything(st)
    const events: Event[] = []
    const restore = spyFs(ALL_DELETES, events)
    let a: Awaited<ReturnType<typeof done>>
    try {
      a = await done(st, 'clean-staging', dead)
    } finally {
      restore()
    }
    const dest = keptAt(st.fx, 'unrecorded-new')
    const parked = theParkedCopy(st.fx)
    expect(a.result.kept).toEqual([{ tree: 'N', kind: 'unrecorded-new', path: dest }])
    expect(a.result.extraCopy).toBe(parked)
    expect(hashOf(dest)).toBe(nHash)
    expect(sidecarAt(dest)).toMatchObject({ kind: 'unrecorded-new', treeHash: nHash })
    expect(fs.readdirSync(parked).sort()).toEqual(['new', 'park-intent.json'])
    expect(hashOf(path.join(parked, 'new'))).toBe(nHash)
    const intent = JSON.parse(fs.readFileSync(path.join(parked, 'park-intent.json'), 'utf8'))
    expect(intent).toMatchObject({ kind: 'move-source', backupPath: dest, schema: 1 })
    expect(fs.existsSync(st.opDir)).toBe(false)
    expect(treeDeletesDoctor(st.fx, events)).toEqual([])
    nothingLost(before, everything(st))
    // The order: the verified copy, then the intent, owner.json, OP's sync, the park.
    const trace = a.trace
    const idx = (pred: (t: (typeof trace)[number]) => boolean): number => trace.findIndex(pred)
    const intentLink = idx(
      (t) => t.op === 'link' && t.dest === path.join(st.opDir, 'park-intent.json')
    )
    const ownerGone = idx((t) => t.op === 'unlink' && t.path === path.join(st.opDir, 'owner.json'))
    const park = idx((t) => t.op === 'park')
    expect(intentLink).toBeGreaterThan(-1)
    expect(ownerGone).toBeGreaterThan(intentLink)
    expect(park).toBeGreaterThan(ownerGone)
  })

  const POINTS: SwapHookPoint[] = [
    'afterBackupCopy',
    'afterBackupVerify',
    'afterBackupMove',
    'afterIntentTemp',
    'afterIntent',
    'afterOwnerUnlink',
    'beforePark',
  ]
  for (const point of POINTS) {
    it(`killed at ${point}: the same command finishes; N kept once and parked; nothing lost`, async () => {
      const st = await abortLeft('abortAfterCheck', {}, xfile())
      const want = contentOf(path.join(st.opDir, 'new'))
      const before = everything(st)
      const first = await act(st, 'clean-staging', dead, killAt(point))
      expect(first.result.status).toBe('stopped')
      nothingLost(before, everything(st))
      const ownerThere = fs.existsSync(path.join(st.opDir, 'owner.json'))
      await done(st, 'clean-staging', ownerThere ? dead : { ownerProbe: ALIVE })
      expect(fs.existsSync(st.opDir)).toBe(false)
      expect(contentOf(keptAt(st.fx, 'unrecorded-new'))).toEqual(want)
      const parked = theParkedCopy(st.fx)
      expect(fs.readdirSync(parked).sort()).toEqual(['new', 'park-intent.json'])
      expect(contentOf(path.join(parked, 'new'))).toEqual(want)
      // Exactly one kept tree in the area (no second keep of N).
      const trees = fs
        .readdirSync(areaOf(st.fx))
        .filter(
          (n) => !n.endsWith('.json') && fs.lstatSync(path.join(areaOf(st.fx), n)).isDirectory()
        )
      expect(trees).toEqual([`${OP_ID}.unrecorded-new`])
      nothingLost(before, everything(st))
    })
  }
})

describe('T-PI2 (move-source half): a doctor cross-device finish killed after its record went', () => {
  it('--clean-staging finishes its park from the intent, as --apply would', async () => {
    const st = await xs3({ hooks: { afterBackupMove: () => killed('afterBackupMove') } })
    const first = await act(st, 'apply', {}, killAt('afterRecordUnlink'))
    expect(first.result.status).toBe('done')
    expect(opNames(st)).toEqual(['old', 'park-intent.json'])
    const a = await done(st, 'clean-staging', { ownerProbe: ALIVE })
    const parked = theParkedCopy(st.fx)
    expect(a.result.extraCopy).toBe(parked)
    expect(fs.readdirSync(parked).sort()).toEqual(['old', 'park-intent.json'])
    expect(hashOf(path.join(parked, 'old'))).toBe(st.p.input.preTree)
    expect(a.result.warnings).toEqual([])
  })
})
