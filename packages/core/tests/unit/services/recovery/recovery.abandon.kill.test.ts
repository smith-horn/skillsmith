/**
 * SMI-6531 (A1 step 6b-iii): `--abandon` killed at each boundary resumes with
 * the same command (T-J11 "Resume", T-J14's 6b half), and its one-device plan
 * states the finish exactly as `finishRecovered` runs it (the #3204 lesson).
 *
 * The kill matrix is generated from the hooks an uninterrupted run fires, as
 * `recovery.kill.test.ts` does for `--apply`/`--undo`: every firing of every
 * hook is killed once, then the same command runs again, and must reach the
 * uninterrupted run's end state: the same kept trees (by name and hash) and
 * area entries, the skill folder and manifest entry unchanged, no op dir.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { executeRecovery } from '../../../../src/services/skill-recovery.exec.js'
import { planRecovery } from '../../../../src/services/skill-recovery.target.js'
import type { SwapHookPoint, TraceOp } from '../../../../src/services/skill-swap.types.js'
import { hashOf, makeFixture, useTmpCleanup } from '../skill-swap.helpers.js'
import {
  act,
  areaNames,
  counting,
  done,
  entryOf,
  keptTrees,
  killAt,
  requestOf,
} from './recovery.act.helpers.js'
import { keepTree, opReport, s2 } from './recovery.helpers.js'
import type { State } from './recovery.helpers.js'
import { postKeepS2prime, renamedOp } from './recovery.abandon.helpers.js'

useTmpCleanup()

const file = () => makeFixture({ 'SKILL.md': '# v1\n', 'docs/a.md': 'a\n' })

const POINTS: readonly SwapHookPoint[] = [
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

/** S2 with a foreign tree at `OP/undone`: anything else, with O and U to keep. */
async function twoSources(): Promise<State> {
  const st = await s2(file())
  fs.mkdirSync(path.join(st.opDir, 'undone'))
  fs.writeFileSync(path.join(st.opDir, 'undone', 'stray.md'), 'kept as it is\n')
  return st
}

const FIXTURES: Array<[string, () => Promise<State>]> = [
  ['anything else (O and U)', twoSources],
  [
    'a started backup keep (P1) beside U',
    async () => {
      const st = await twoSources()
      keepTree(st, 'old', 'backup', { move: false })
      return st
    },
  ],
  ['post-keep S2′', () => postKeepS2prime(file())],
  ['moved (foreign-op-dir)', async () => renamedOp(await s2(file()))],
]

function endState(st: State) {
  return {
    skill: fs.existsSync(st.fx.realDir) ? hashOf(st.fx.realDir) : 'absent',
    entry: entryOf(st.fx),
    kept: keptTrees(st.fx),
    area: areaNames(st.fx),
    opDir: fs.existsSync(st.opDir),
  }
}

const fired = new Set<SwapHookPoint>()

describe('--abandon killed at each boundary, then the same command', () => {
  for (const [name, build] of FIXTURES) {
    it(`${name}: every kill, then a rerun, ends as the uninterrupted run`, async () => {
      const ref = await build()
      const c = counting(POINTS)
      await done(ref, 'abandon', {}, c.opts)
      const want = endState(ref)
      expect(want.opDir).toBe(false)
      const kills = [...c.counts].flatMap(([p, n]) =>
        Array.from({ length: n }, (_, i) => [p, i + 1] as const)
      )
      expect(kills.length).toBeGreaterThan(3)
      for (const [p] of kills) fired.add(p)
      for (const [point, nth] of kills) {
        const st = await build()
        const first = await act(st, 'abandon', {}, killAt(point, nth))
        expect(first.result.status, `${point} #${nth}`).toBe('stopped')
        const again = await act(st, 'abandon')
        expect(
          again.result.status,
          `${point} #${nth}: ${JSON.stringify(again.result).slice(0, 300)}`
        ).toBe('done')
        expect(endState(st), `${point} #${nth}`).toEqual(want)
      }
    })
  }

  it('every boundary fired in at least one run', () => {
    expect(POINTS.filter((p) => !fired.has(p))).toEqual([])
  })

  it('a kill after the first abandoned sidecar leaves AB, which --abandon resumes', async () => {
    const st = await twoSources()
    const first = await act(st, 'abandon', {}, killAt('afterSidecar'))
    expect(first.result.status).toBe('stopped')
    const cls = (await opReport(st)).cls
    expect(cls.kind).toBe('ab')
    expect((await act(st, 'apply')).result).toMatchObject({ status: 'refused' })
    expect((await done(st, 'abandon')).result.from).toBe('AB abandon started')
  })
})

/** The trace's finish, after `beforeMetadataCleanup`, in the plan's words. */
function finishWords(ev: Array<TraceOp | 'cleanup'>, opDir: string, staging: string): string[] {
  const out: string[] = []
  for (const e of ev.slice(ev.indexOf('cleanup') + 1)) {
    if (e === 'cleanup') continue
    if (e.op === 'unlink' && path.dirname(e.path) === opDir) {
      out.push(`unlink ${path.basename(e.path)}`)
    } else if (e.op === 'dirsync' && e.path === opDir) out.push('sync the op dir')
    else if (e.op === 'rmdir' && e.path === opDir) out.push('rmdir the emptied op dir')
    else if (e.op === 'dirsync' && e.path === staging) out.push('sync the staging dir')
  }
  return out
}

describe('the plan mirrors the executor: the one-device finish, step for step', () => {
  for (const action of ['abandon', 'apply'] as const) {
    it(`--${action} keeping a source states "on one device: ..." in the order finishRecovered runs it`, async () => {
      const st = action === 'abandon' ? await twoSources() : await s2(file())
      const planned = await planRecovery(requestOf(st, action))
      if (planned.status !== 'planned') throw new Error(JSON.stringify(planned))
      const line = planned.plan.remaining.find((r) => r.startsWith('on one device: '))
      expect(line, planned.plan.remaining.join('\n')).toBeDefined()
      const stated = line!.slice('on one device: '.length).split(', then ')
      const ev: Array<TraceOp | 'cleanup'> = []
      const r = await executeRecovery(planned, {
        swap: {
          trace: (t) => ev.push(t),
          hooks: { beforeMetadataCleanup: () => void ev.push('cleanup') },
        },
      })
      expect(r.status).toBe('done')
      const ran = finishWords(ev, st.opDir, st.fx.staging)
      expect(ran.length).toBeGreaterThan(4)
      for (let i = 0; i < Math.max(stated.length, ran.length); i++) {
        expect(ran[i], `step ${i}: stated ${JSON.stringify(stated)}`).toBe(stated[i])
      }
    })
  }
})
