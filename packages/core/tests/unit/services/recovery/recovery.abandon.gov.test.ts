/**
 * SMI-6531 (A1 step 6b-iii, governance on 8f27aabdb): what the plan of a
 * recorded op promises is what its run does.
 *
 *  - A stray entry in the op dir (a `.DS_Store`) refuses `--abandon`, `--apply`
 *    and `--undo` at plan time, with the world unchanged (owner decision
 *    2026-10-28, O2): no finish could empty the op dir after the keeps.
 *  - `--abandon` names each fresh keep as `destFor` will (a taken base gets
 *    `.1`), keeps an orphan copy temp before the role keeps (so its name never
 *    meets a fresh keep's copy temp across devices), lists only the resumes it
 *    runs, labels a role-less copy temp `OP`, and turns a class with no
 *    verified record into a stop, not a throw.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runAbandon } from '../../../../src/services/skill-recovery.abandon.js'
import { planAction } from '../../../../src/services/skill-recovery.plan.js'
import { planRecovery } from '../../../../src/services/skill-recovery.target.js'
import { areaOf, makeFixture, OP_ID, useTmpCleanup } from '../skill-swap.helpers.js'
import type { Fixture } from '../skill-swap.helpers.js'
import { useOtherDeviceCleanup } from '../skill-swap.xdev.helpers.js'
import { act, done, requestOf } from './recovery.act.helpers.js'
import { destOf, keepTree, opReport, s1, s2 } from './recovery.helpers.js'
import type { State } from './recovery.helpers.js'
import { world } from './recovery.abandon.helpers.js'
import { xfile } from './recovery.xdev.helpers.js'

useTmpCleanup()
useOtherDeviceCleanup()

const file = () => makeFixture({ 'SKILL.md': '# v1\n', 'docs/a.md': 'a\n' })

/** S2 (or `fx`'s) with a foreign tree at `OP/undone`: anything else, with O and U to keep. */
async function twoSources(fx: Fixture = file()): Promise<State> {
  const st = await s2(fx)
  fs.mkdirSync(path.join(st.opDir, 'undone'))
  fs.writeFileSync(path.join(st.opDir, 'undone', 'stray.md'), 'kept as it is\n')
  expect((await opReport(st)).cls.kind).toBe('anything-else')
  return st
}

/** Another op dir's identity, as an abandoned sidecar of a copy names it (O4). */
const OTHER = { opDirIdentity: { dev: '1', ino: '2', birthtimeNs: '3', fmt: '16384' } }

describe('a stray entry in the op dir refuses at plan time, the world unchanged (O2)', () => {
  const cases: Array<['abandon' | 'apply' | 'undo', () => Promise<State>]> = [
    ['abandon', () => twoSources()],
    ['apply', () => s2(file())],
    ['undo', () => s2(file())],
  ]
  for (const [action, build] of cases) {
    it(`--${action}: a .DS_Store in OP is recovery-not-offered, named; moved out, the same command acts`, async () => {
      const st = await build()
      const stray = path.join(st.opDir, '.DS_Store')
      fs.writeFileSync(stray, 'finder\n')
      const before = world(st)
      const a = await act(st, action)
      expect(world(st)).toBe(before)
      expect(a.result).toMatchObject({ status: 'refused', reason: 'recovery-not-offered' })
      const detail = a.result.status === 'refused' ? a.result.detail : ''
      expect(detail).toContain(stray)
      expect(detail).toContain('move it out of the op dir by hand, and run the command again')
      // The listing still shows the op as its class, with the facts naming the stray.
      const cls = (await opReport(st)).cls
      expect('facts' in cls && cls.facts !== null ? cls.facts.strays : null).toEqual(['.DS_Store'])
      // The positive: moved out by hand, the same command acts.
      fs.rmSync(stray)
      expect((await done(st, action)).result.status).toBe('done')
    })
  }
})

describe('--abandon names each fresh keep as destFor will', () => {
  it("a base another copy's keep holds (O4) is named .1 in the step and the old-folder note, and kept there", async () => {
    // S1 with a foreign U: O, N and U to keep, and T absent, so the plan says where the old folder goes.
    const st = await s1(file())
    fs.mkdirSync(path.join(st.opDir, 'undone'))
    keepTree(st, 'undone', 'abandoned-old', { move: false, over: OTHER })
    const cls = (await opReport(st)).cls
    expect(cls.kind).toBe('anything-else')
    const plan = planAction(cls, 'abandon')
    if (!plan.offered) throw new Error(plan.detail)
    const want = `${destOf(st, 'abandoned-old')}.1`
    expect(plan.steps.find((s) => s.tree === 'O')?.note).toBe(
      `old/ is kept as abandoned-old at ${want}`
    )
    expect(plan.notes).toContain(`the skill path stays empty; the old folder is kept at ${want}`)
    const a = await done(st, 'abandon')
    expect(a.result.kept.find((k) => k.tree === 'O')?.path).toBe(want)
  })
})

describe('--abandon lists only the resumes it runs', () => {
  it("two started keeps of O: the role's started keep is the one resume listed", async () => {
    const st = await twoSources()
    keepTree(st, 'old', 'backup', { move: false })
    keepTree(st, 'old', 'abandoned-old', { move: false })
    const cls = (await opReport(st)).cls
    expect(cls.kind).toBe('ab')
    const plan = planAction(cls, 'abandon')
    if (!plan.offered) throw new Error(plan.detail)
    expect(plan.remaining.filter((r) => r.startsWith('resume '))).toEqual([
      `resume the keep of ${OP_ID} from P1`,
    ])
  })
})

describe('orphan copy temps are kept first, and a role-less one is the op’s', () => {
  it('across devices, an orphan .tmp-<opId>.abandoned-old does not stop the fresh keep named <opId>.abandoned-old', async () => {
    const st = await twoSources(xfile())
    const area = areaOf(st.fx)
    fs.mkdirSync(area, { recursive: true })
    const temp = path.join(area, `.tmp-${OP_ID}.abandoned-old`)
    fs.mkdirSync(temp)
    fs.writeFileSync(path.join(temp, 'SKILL.md'), '# half\n')
    const planned = await planRecovery(requestOf(st, 'abandon'))
    if (planned.status !== 'planned') throw new Error(JSON.stringify(planned))
    // The plan's order is the run's: the orphan first.
    expect(planned.plan.remaining[0]).toBe(`keep the copy temp ${temp} as partial-copy`)
    const a = await done(st, 'abandon')
    expect(a.result.kept.map((k) => `${k.tree}:${k.kind}:${path.basename(k.path)}`)).toEqual([
      `O:partial-copy:${OP_ID}.partial-copy`,
      `O:abandoned-old:${OP_ID}.abandoned-old`,
      `U:abandoned-undone:${OP_ID}.abandoned-undone`,
    ])
    expect(fs.existsSync(temp)).toBe(false)
  })

  it('a copy temp whose kind names no role (.tmp-<opId>.partial-copy) is kept with tree OP', async () => {
    const st = await twoSources()
    const area = areaOf(st.fx)
    fs.mkdirSync(area, { recursive: true })
    const temp = path.join(area, `.tmp-${OP_ID}.partial-copy`)
    fs.mkdirSync(temp)
    fs.writeFileSync(path.join(temp, 'x.md'), 'x\n')
    const a = await done(st, 'abandon')
    const partial = a.result.kept.find((k) => k.kind === 'partial-copy')
    expect(partial?.tree).toBe('OP')
    expect(fs.existsSync(temp)).toBe(false)
  })
})

describe('a class with no verified record is a stop, not a throw', () => {
  it('runAbandon of anything-else with no facts resolves stopped staging-unsafe, naming no record', async () => {
    const r = await runAbandon({
      planned: { plan: { steps: [] }, opDir: '/st/x', sweep: [] } as never,
      opts: {},
      ctx: null as never,
      cls: {
        kind: 'anything-else',
        opId: 'x',
        opDir: '/st/x',
        reason: 'the op dir entry is not a directory',
        facts: null,
      },
      transcript: [],
      out: {} as never,
    })
    expect(r).toMatchObject({ status: 'stopped', reason: 'staging-unsafe', recordPath: null })
  })
})
