/**
 * SMI-6531 (A1 step 6a-ii): doctor killed midway resumes (T-J14's one-device
 * half, the role-resolution kill tests of design § 6 "P5 role resolution",
 * and § 7's cleanup order).
 *
 * The kill matrix is generated from the hooks an uninterrupted run fires: for
 * each row and action, every firing of every hook in `POINTS` is killed once
 * (a throwing hook), and the same action is run again. Each rerun must reach
 * the uninterrupted run's end state: the same skill folder, manifest entry,
 * kept trees (by name and hash) and area entries (no second keep, no stray
 * temp), at most one manifest write and one audit record, and no op dir. A
 * final assertion requires every hook of `MUST_FIRE` to have fired in at
 * least one run, so a renamed or removed boundary cannot drop out silently.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SwapHookPoint } from '../../../../src/services/skill-swap.types.js'
import { hashOf, makeFixture, useTmpCleanup } from '../skill-swap.helpers.js'
import { s0, s1, s2, s3, un1, un2 } from './recovery.helpers.js'
import type { State } from './recovery.helpers.js'
import {
  act,
  areaNames,
  auditLines,
  counting,
  done,
  entryOf,
  killAt,
  keptTrees,
} from './recovery.act.helpers.js'

useTmpCleanup()

const POINTS: readonly SwapHookPoint[] = [
  'beforeUndoAside',
  'afterUndoAside',
  'beforeRestore',
  'afterClaim',
  'afterInstall',
  'beforeCommitRehash',
  'afterCommit',
  'afterAudit',
  'beforePublish',
  'beforeSidecar',
  'afterSidecarTemp',
  'afterSidecar',
  'afterPublishRename',
  'afterPublishAreaSync',
  'afterPublishOpSync',
  'beforeMetadataCleanup',
  'afterOwnerUnlink',
  'afterRecordUnlink',
  'afterRecoveredOpSync',
]

/** Boundaries the design names: each must fire in at least one uninterrupted run. */
const MUST_FIRE: readonly SwapHookPoint[] = POINTS

type Build = (fx: ReturnType<typeof makeFixture>) => Promise<State>
const ROWS: Array<[string, Build, 'apply' | 'undo', boolean]> = [
  ['S0', s0, 'apply', false],
  ['S1', s1, 'apply', true],
  ['S1', s1, 'undo', false],
  ['S2', s2, 'apply', true],
  ['S2', s2, 'undo', false],
  ['S3', s3, 'apply', true],
  ['UN1', un1, 'apply', false],
  ['UN2', un2, 'apply', false],
]

const file = () => makeFixture({ 'SKILL.md': '# v1\n', 'docs/a.md': 'a\n' })

/** What a finished action leaves, with the op's own name mapped out. */
function endState(st: State) {
  return {
    skill: fs.existsSync(st.fx.realDir) ? hashOf(st.fx.realDir) : 'absent',
    entry: entryOf(st.fx),
    kept: keptTrees(st.fx),
    area: areaNames(st.fx),
    opDir: fs.existsSync(st.opDir),
    audit: auditLines(st.fx, st.opId),
  }
}

const fired = new Set<SwapHookPoint>()

describe('T-J14: a doctor killed at each boundary resumes with the same command', () => {
  for (const [name, build, action, commits] of ROWS) {
    it(`${name} --${action}: every kill, then a rerun, ends as the uninterrupted run`, async () => {
      const ref = await build(file())
      const c = counting(POINTS)
      await done(ref, action, {}, c.opts)
      const want = endState(ref)
      expect(want.opDir).toBe(false)
      const kills = [...c.counts].flatMap(([p, n]) =>
        Array.from({ length: n }, (_, i) => [p, i + 1] as const)
      )
      expect(kills.length).toBeGreaterThan(5)
      for (const [p] of kills) fired.add(p)
      for (const [point, nth] of kills) {
        const st = await build(file())
        const first = await act(st, action, {}, killAt(point, nth))
        expect(first.result.status, `${point} #${nth}`).toBe('stopped')
        const again = await act(st, action)
        const status = again.result.status
        expect(status, `${point} #${nth}: ${JSON.stringify(again.result).slice(0, 300)}`).toBe(
          'done'
        )
        const got = endState(st)
        expect(got, `${point} #${nth}`).toEqual(want)
        const writes = [...first.trace, ...again.trace].filter((t) => t.op === 'manifest-write')
        expect(writes.length, `${point} #${nth}`).toBe(commits && name !== 'S3' ? 1 : 0)
      }
    })
  }

  it('every boundary the design names fired in at least one run', () => {
    const missing = MUST_FIRE.filter((p) => !fired.has(p))
    expect(missing).toEqual([])
    expect(fired.size).toBe(MUST_FIRE.length)
  })
})

describe('design § 7: the record is unlinked last', () => {
  it('a kill after owner.json goes leaves an op the same command finishes', async () => {
    const st = await s0(file())
    const first = await act(st, 'apply', {}, killAt('afterOwnerUnlink'))
    expect(first.result.status).toBe('stopped')
    expect(fs.existsSync(path.join(st.opDir, 'record.json'))).toBe(true)
    expect(fs.existsSync(path.join(st.opDir, 'owner.json'))).toBe(false)
    const again = await done(st, 'apply')
    expect(again.result.from).toContain('after its keep')
    expect(fs.existsSync(st.opDir)).toBe(false)
  })

  it('a kill after record.json goes leaves an empty op dir, which the rerun rmdirs', async () => {
    const st = await s0(file())
    const first = await act(st, 'apply', {}, killAt('afterRecoveredOpSync'))
    expect(first.result.status).toBe('stopped')
    expect(fs.readdirSync(st.opDir)).toEqual([])
    const again = await done(st, 'apply')
    expect(again.result.from).toBe('empty-op-dir')
    expect(again.trace).toContainEqual({ op: 'rmdir', path: st.opDir })
    expect(fs.existsSync(st.opDir)).toBe(false)
  })
})
