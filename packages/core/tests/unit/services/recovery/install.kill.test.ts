/**
 * SMI-6531 (A1 step 8-i-a-2), T-FIX and T-FI2u: doctor killed at each
 * boundary of each install row's action resumes with the same command.
 *
 * For each row and action, every firing of every hook in `POINTS` an
 * uninterrupted run fires is killed once (a throwing hook), and the same
 * action is run again: it must finish with the uninterrupted run's end state
 * (the skill path, the manifest entry, the kept trees by name and hash, the
 * area's entries, no op dir) and at most one manifest write. A kill inside
 * FI2's `--undo` after the folder was set aside is FI2u (or its keep), which
 * the rerun finishes. Every hook in `POINTS` must fire in at least one run.
 */
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { SwapHookPoint } from '../../../../src/services/skill-swap.types.js'
import { hashOf, useTmpCleanup } from '../skill-swap.helpers.js'
import { opReport } from './recovery.helpers.js'
import {
  act,
  areaNames,
  counting,
  done,
  entryOf,
  keptTrees,
  killAt,
} from './recovery.act.helpers.js'
import { fi0, fi1, fi2, fi2u, fi3, fi4, installFixture } from './install.helpers.js'
import type { IState } from './install.helpers.js'

useTmpCleanup()

const POINTS: readonly SwapHookPoint[] = [
  'beforeUndoAside',
  'afterUndoAside',
  'beforeRestore',
  'afterClaim',
  'afterInstall',
  'beforeCommitRehash',
  'afterCommit',
  'beforePublish',
  'beforeSidecar',
  'afterSidecarTemp',
  'afterSidecar',
  'afterPublishRename',
  'afterPublishAreaSync',
  'afterPublishOpSync',
  'beforeMetadataCleanup',
  'afterRecordUnlink',
  'afterRecoveredOpSync',
]

const ROWS: Array<[string, () => Promise<IState>, 'apply' | 'undo', boolean]> = [
  ['FI0', async () => fi0(installFixture()), 'apply', true],
  ['FI0', async () => fi0(installFixture()), 'undo', false],
  ['FI1', () => fi1(installFixture()), 'apply', true],
  ['FI1', () => fi1(installFixture()), 'undo', false],
  ['FI2', () => fi2(installFixture()), 'apply', true],
  ['FI2', () => fi2(installFixture()), 'undo', false],
  ['FI2u', () => fi2u(installFixture()), 'apply', false],
  ['FI3', () => fi3(installFixture()), 'apply', false],
  ['FI4', () => fi4(installFixture()), 'apply', false],
]

function endState(st: IState) {
  return {
    skill: fs.existsSync(st.fx.realDir) ? hashOf(st.fx.realDir) : 'absent',
    entry: entryOf(st.fx) ?? null,
    kept: keptTrees(st.fx),
    area: areaNames(st.fx),
    opDir: fs.existsSync(st.opDir),
  }
}

/** FI2 `--undo`'s kills that are not FI2u: before the set-aside, or once the record is gone. */
const BEFORE_ASIDE_OR_AFTER_RECORD: ReadonlySet<SwapHookPoint> = new Set<SwapHookPoint>([
  'beforeUndoAside',
  'afterRecordUnlink',
  'afterRecoveredOpSync',
])

const fired = new Set<SwapHookPoint>()

describe('T-FIX: an install action killed at each boundary resumes with the same command', () => {
  for (const [name, build, action, commits] of ROWS) {
    it(
      `${name} --${action}: every kill, then a rerun, ends as the uninterrupted run`,
      { timeout: 60_000 },
      async () => {
        const ref = await build()
        const c = counting(POINTS)
        await done(ref, action, {}, c.opts)
        const want = endState(ref)
        expect(want.opDir).toBe(false)
        const kills = [...c.counts].flatMap(([p, n]) =>
          Array.from({ length: n }, (_, i) => [p, i + 1] as const)
        )
        expect(kills.length).toBeGreaterThan(2)
        for (const [p] of kills) fired.add(p)
        for (const [point, nth] of kills) {
          const st = await build()
          const first = await act(st, action, {}, killAt(point, nth))
          expect(first.result.status, `${point} #${nth}`).toBe('stopped')
          if (name === 'FI2' && action === 'undo' && !BEFORE_ASIDE_OR_AFTER_RECORD.has(point)) {
            // Killed after the folder was set aside, with the record kept: FI2u, or its keep.
            expect((await opReport(st)).cls, `${point} #${nth}`).toMatchObject({ state: 'FI2u' })
          }
          const again = await act(st, action)
          expect(
            again.result.status,
            `${point} #${nth}: ${JSON.stringify(again.result).slice(0, 300)}`
          ).toBe('done')
          expect(endState(st), `${point} #${nth}`).toEqual(want)
          const writes = [...first.trace, ...again.trace].filter((t) => t.op === 'manifest-write')
          expect(writes.length, `${point} #${nth}`).toBe(commits ? 1 : 0)
        }
      }
    )
  }

  it('every boundary fired in at least one run', () => {
    expect(POINTS.filter((p) => !fired.has(p))).toEqual([])
  })
})
