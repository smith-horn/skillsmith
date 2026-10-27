/**
 * SMI-6531 (A1 step 6a-iii): T-P4 and T-P5 for doctor's cross-device sequences
 * (design § 5: "[publish] P2 / P3 / P4" and "[finish] cross-device").
 *
 * T-P4: each resume's own trace holds its sequence in order. T-P5: the
 * crashed update's trace, then doctor's, replayed through the power-loss
 * model (`skill-swap.powerloss.ts`): no crash point loses a tree, leaves the
 * manifest at `postEntry` without the new tree, or leaves a backup or a
 * changed folder without a durable record. Control: the area sync after the
 * temp is renamed to `dest` dropped fails the model (the record's unlink can
 * then persist while the backup's new name does not).
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TraceOp } from '../../../../src/services/skill-swap.types.js'
import { areaOf, isSubsequence, OP_ID, useTmpCleanup } from '../skill-swap.helpers.js'
import type { Fixture } from '../skill-swap.helpers.js'
import { replay } from '../skill-swap.powerloss.js'
import type { ModelPaths } from '../skill-swap.powerloss.js'
import { useOtherDeviceCleanup } from '../skill-swap.xdev.helpers.js'
import { done } from './recovery.act.helpers.js'
import { backupOf, copyTemp, killed, xs3 } from './recovery.xdev.helpers.js'

useTmpCleanup()
useOtherDeviceCleanup()

type Want = Array<Partial<TraceOp> & { op: TraceOp['op'] }>

const pathsOf = (fx: Fixture): ModelPaths => ({
  realDir: fx.realDir,
  staging: fx.staging,
  opDir: fx.opDir,
  backupDest: backupOf(fx),
})

/** The verified copy and its rename to `dest`, then the area sync (publishTree step 4). */
function copySeq(fx: Fixture): Want {
  const area = areaOf(fx)
  return [
    { op: 'mkdir', path: copyTemp(fx) },
    { op: 'dirsync', path: area },
    { op: 'copy', path: path.join(fx.opDir, 'old'), dest: copyTemp(fx) },
    { op: 'compare', path: copyTemp(fx), equal: true },
    { op: 'rename', path: copyTemp(fx), dest: backupOf(fx) },
    { op: 'dirsync', path: area },
  ]
}

/** The cross-device finish: the intent published, owner, OP synced, the record last, then the park. */
function finishSeq(fx: Fixture): Want {
  const intent = path.join(fx.opDir, 'park-intent.json')
  const parkedRoot = path.join(fx.staging, '.skillsmith-parked')
  return [
    { op: 'create', path: `${intent}.tmp` },
    { op: 'fsync', path: `${intent}.tmp` },
    { op: 'link', path: `${intent}.tmp`, dest: intent },
    { op: 'unlink', path: `${intent}.tmp` },
    { op: 'dirsync', path: fx.opDir },
    { op: 'unlink', path: path.join(fx.opDir, 'owner.json') },
    { op: 'dirsync', path: fx.opDir },
    { op: 'unlink', path: path.join(fx.opDir, 'record.json') },
    { op: 'dirsync', path: fx.opDir },
    { op: 'guard', path: fx.opDir },
    { op: 'dirsync', path: parkedRoot },
    { op: 'dirsync', path: fx.staging },
    { op: 'park', path: fx.opDir, status: 'parked' },
    { op: 'dirsync', path: path.join(parkedRoot, OP_ID) },
    { op: 'dirsync', path: fx.staging },
  ]
}

type Case = [string, Parameters<typeof xs3>[0], (fx: Fixture) => Want]

const CASES: Case[] = [
  [
    'P1: the copy from the published sidecar, then the finish',
    { hooks: { afterSidecar: () => killed('afterSidecar') } },
    (fx) => [...copySeq(fx), ...finishSeq(fx)],
  ],
  [
    'P2: the partial keep (its sidecar, the rename, the area), then the copy again',
    { duringBackupCopy: () => killed('mid-copy') },
    (fx) => {
      const partial = path.join(areaOf(fx), `${OP_ID}.partial-copy`)
      return [
        { op: 'create', path: `${partial}.json.tmp` },
        { op: 'fsync', path: `${partial}.json.tmp` },
        { op: 'link', path: `${partial}.json.tmp`, dest: `${partial}.json` },
        { op: 'unlink', path: `${partial}.json.tmp` },
        { op: 'dirsync', path: areaOf(fx) },
        { op: 'rename', path: copyTemp(fx), dest: partial },
        { op: 'dirsync', path: areaOf(fx) },
        ...copySeq(fx),
        ...finishSeq(fx),
      ]
    },
  ],
  [
    'P3: the temp renamed to dest, the area synced, then the finish',
    { hooks: { afterBackupVerify: () => killed('afterBackupVerify') } },
    (fx) => [
      { op: 'rename', path: copyTemp(fx), dest: backupOf(fx) },
      { op: 'dirsync', path: areaOf(fx) },
      ...finishSeq(fx),
    ],
  ],
  [
    'P4: the area synced, then the finish',
    { hooks: { afterBackupMove: () => killed('afterBackupMove') } },
    (fx) => [{ op: 'dirsync', path: areaOf(fx) }, ...finishSeq(fx)],
  ],
]

describe('T-P4 (cross-device): each resume sequence is in its order', () => {
  for (const [label, options, want] of CASES) {
    it(label, async () => {
      const st = await xs3(options)
      const a = await done(st, 'apply')
      expect(isSubsequence(a.trace, want(st.fx))).toEqual({ ok: true })
    })
  }

  it('P3 and P4 copy nothing; P4 renames nothing into the area', async () => {
    for (const [label, options] of CASES.slice(2)) {
      const st = await xs3(options)
      const a = await done(st, 'apply')
      expect(
        a.trace.some((t) => t.op === 'copy'),
        label
      ).toBe(false)
      if (label.startsWith('P4')) {
        expect(a.trace.some((t) => t.op === 'rename' && t.dest === backupOf(st.fx))).toBe(false)
      }
    }
  })
})

describe('T-P5 (cross-device): the crash and the repair, replayed, survive every crash point', () => {
  for (const [label, options] of CASES) {
    it(label, async () => {
      const st = await xs3(options)
      const a = await done(st, 'apply')
      expect(a.trace.filter((t) => t.op === 'park')).toHaveLength(1)
      const all = [...st.trace, ...a.trace]
      expect(replay(all, pathsOf(st.fx))).toEqual({ ok: true, points: all.length + 1 })
    })
  }

  it('control: P1 with the area sync after the rename to dest dropped fails the model', async () => {
    const st = await xs3(CASES[0]![1])
    const a = await done(st, 'apply')
    const i = a.trace.findIndex(
      (t) => t.op === 'rename' && t.path === copyTemp(st.fx) && t.dest === backupOf(st.fx)
    )
    expect(a.trace[i + 1]).toEqual({ op: 'dirsync', path: areaOf(st.fx) })
    const mutated = [...st.trace, ...a.trace.slice(0, i + 1), ...a.trace.slice(i + 2)]
    expect(replay(mutated, pathsOf(st.fx)).ok).toBe(false)
  })

  it('the crashed trace is the real one: it stopped inside the cross-device publish', async () => {
    const st = await xs3(CASES[0]![1])
    expect(st.trace.some((t) => t.op === 'manifest-write')).toBe(true)
    expect(fs.existsSync(path.join(st.opDir, 'record.json'))).toBe(true)
  })
})
