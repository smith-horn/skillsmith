/**
 * SMI-6531 (A1 step 6a-iii): doctor killed at each cross-device boundary
 * resumes with the same command (T-J14's and T-X14's cross-device halves,
 * T-J16's "kill before doctor keeps N (S0) and U (UN1)").
 *
 * The kill matrix is generated from the hooks an uninterrupted run fires: for
 * each row, every firing of every hook in `POINTS` and `AFTER_RECORD` is
 * killed once, and the same action run again. Each rerun must end done, with
 * no `removal-not-done`, as the uninterrupted run: the same skill folder,
 * manifest entry, kept trees (by name and hash), at most one manifest write
 * and one audit record, no op dir in ST, and one parked copy holding the same
 * source. A kill inside the copy (`duringBackupCopy`) leaves a P2 temp, which
 * the rerun keeps as `partial-copy` (the one difference allowed, and required).
 *
 * A kill before `record.json` is unlinked stops with the record kept. A kill
 * after it (owner decision 2026-10-26) leaves either OP with its sources and a
 * verifying `move-source` intent and no record, whose park the same command
 * finishes from the intent (`skill-recovery.intent-park.ts`), or OP already
 * parked (`afterPark`, `afterParkSync`), whose park the same command makes
 * durable (`skill-recovery.parked.ts`).
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SwapHookPoint } from '../../../../src/services/skill-swap.types.js'
import { hashOf, useTmpCleanup } from '../skill-swap.helpers.js'
import type { Fixture } from '../skill-swap.helpers.js'
import { parkedCopies, useOtherDeviceCleanup } from '../skill-swap.xdev.helpers.js'
import { opReport, s0, s2, s3, un1 } from './recovery.helpers.js'
import type { State } from './recovery.helpers.js'
import {
  act,
  areaNames,
  auditLines,
  counting,
  done,
  entryOf,
  keptTrees,
  killAt,
} from './recovery.act.helpers.js'
import { partialTrees, xfile } from './recovery.xdev.helpers.js'

useTmpCleanup()
useOtherDeviceCleanup()

/** The boundaries before `record.json` is unlinked: a kill there stops, and the rerun finishes. */
const POINTS: readonly SwapHookPoint[] = [
  'beforeUndoAside',
  'afterUndoAside',
  'beforeRestore',
  'afterClaim',
  'afterInstall',
  'afterCommit',
  'afterAudit',
  'beforePublish',
  'beforeSidecar',
  'afterSidecarTemp',
  'afterSidecar',
  'afterBackupCopy',
  'afterBackupVerify',
  'afterBackupMove',
  'beforeMetadataCleanup',
  'afterIntentTemp',
  'afterIntent',
  'afterOwnerUnlink',
]

/** After the record unlink: a kill there is a removal not done. */
const AFTER_RECORD: readonly SwapHookPoint[] = [
  'afterRecordUnlink',
  'afterRecoveredOpSync',
  'beforePark',
  'afterPark',
  'afterParkSync',
]

/** Boundaries that must fire in at least one uninterrupted cross-device run. */
const MUST_FIRE: readonly SwapHookPoint[] = [
  'afterInstall',
  'afterCommit',
  'afterAudit',
  'beforePublish',
  'beforeSidecar',
  'afterSidecarTemp',
  'afterSidecar',
  'afterBackupCopy',
  'afterBackupVerify',
  'afterBackupMove',
  'beforeMetadataCleanup',
  'afterIntentTemp',
  'afterIntent',
  'afterOwnerUnlink',
  ...AFTER_RECORD,
]

type Build = (fx: Fixture) => Promise<State>
const ROWS: Array<[string, Build, 'apply' | 'undo', number]> = [
  // [row, build, action, manifest writes]
  ['S3 (O kept across devices)', s3, 'apply', 0],
  ['S2 (commit, then O kept across devices)', s2, 'apply', 1],
  ['S0 (N kept across devices)', s0, 'apply', 0],
  ['UN1 (O installed, U kept across devices)', un1, 'apply', 0],
  ['S2 --undo (O installed, T kept as undone across devices)', s2, 'undo', 0],
]

/** The parked op dir's entries other than its intent, by name and hash. */
function parkedSources(fx: Fixture): Record<string, string> {
  const copies = parkedCopies(fx)
  expect(copies).toHaveLength(1)
  const out: Record<string, string> = {}
  for (const n of fs.readdirSync(copies[0]!).sort()) {
    if (n !== 'park-intent.json') out[n] = hashOf(path.join(copies[0]!, n))
  }
  return out
}

/** What a finished action leaves. Partial copies are compared by count, separately. */
function endState(st: State) {
  const kept = keptTrees(st.fx)
  for (const k of Object.keys(kept)) if (k.includes('.partial-copy')) delete kept[k]
  return {
    skill: fs.existsSync(st.fx.realDir) ? hashOf(st.fx.realDir) : 'absent',
    entry: entryOf(st.fx),
    kept,
    area: areaNames(st.fx).filter((n) => !n.includes('.partial-copy')),
    opDir: fs.existsSync(st.opDir),
    audit: auditLines(st.fx, st.opId),
    parked: parkedSources(st.fx),
  }
}

const fired = new Set<SwapHookPoint>()

describe('T-J14 (cross-device): a doctor killed at each boundary resumes with the same command', () => {
  for (const [name, build, action, writes] of ROWS) {
    it(`${name} --${action}: every kill, then a rerun of the same command, ends as the uninterrupted run`, async () => {
      const ref = await build(xfile())
      const c = counting([...POINTS, ...AFTER_RECORD])
      const r = await done(ref, action, {}, c.opts)
      expect(r.result.extraCopy).not.toBeNull()
      const want = endState(ref)
      expect(want.opDir).toBe(false)
      for (const p of c.counts.keys()) fired.add(p)
      const kills = [...c.counts].flatMap(([p, n]) =>
        Array.from({ length: n }, (_, i) => [p, i + 1] as const)
      )
      expect(kills.length).toBeGreaterThan(8)
      expect(kills.filter(([p]) => AFTER_RECORD.includes(p)).map(([p]) => p)).toEqual(AFTER_RECORD)
      for (const [point, nth] of kills) {
        const st = await build(xfile())
        const first = await act(st, action, {}, killAt(point, nth))
        const recordKept = fs.existsSync(path.join(st.opDir, 'record.json'))
        if (POINTS.includes(point)) {
          expect(first.result.status, `${point} #${nth}`).toBe('stopped')
          expect(recordKept, `${point} #${nth}`).toBe(true)
        } else {
          // After the record unlink the kill cannot be a stop: done, the park not finished.
          expect(first.result.status, `${point} #${nth}`).toBe('done')
          expect(recordKept, `${point} #${nth}`).toBe(false)
        }
        const again = await act(st, action)
        expect(
          again.result.status,
          `${point} #${nth}: ${JSON.stringify(again.result).slice(0, 300)}`
        ).toBe('done')
        if (again.result.status === 'done') {
          expect(
            again.result.warnings.map((w) => w.code),
            `${point} #${nth}`
          ).not.toContain('removal-not-done')
          expect(again.result.extraCopy, `${point} #${nth}`).toBe(parkedCopies(st.fx)[0])
        }
        expect(endState(st), `${point} #${nth}`).toEqual(want)
        expect(partialTrees(st.fx), `${point} #${nth}`).toEqual([])
        const w = [...first.trace, ...again.trace].filter((t) => t.op === 'manifest-write')
        expect(w.length, `${point} #${nth}`).toBe(writes)
      }
    })
  }

  it('a kill inside the copy leaves a P2 temp: the rerun keeps it as partial-copy and finishes', async () => {
    const ref = await s3(xfile())
    await done(ref, 'apply')
    const want = endState(ref)
    const st = await s3(xfile())
    const first = await act(
      st,
      'apply',
      {},
      {
        swap: {
          duringBackupCopy: () => {
            throw new Error('killed mid-copy')
          },
        },
      }
    )
    expect(first.result.status).toBe('stopped')
    const op = await opReport(st)
    if (op.cls.kind !== 'state') throw new Error(op.label)
    expect(op.cls.facts.groups.find((g) => g.base === st.opId)?.state).toBe('P2')
    expect((await act(st, 'apply')).result.status).toBe('done')
    expect(endState(st)).toEqual(want)
    expect(partialTrees(st.fx)).toHaveLength(1)
  })

  it('every boundary the design names fired in at least one uninterrupted run', () => {
    expect(MUST_FIRE.filter((p) => !fired.has(p))).toEqual([])
  })
})
