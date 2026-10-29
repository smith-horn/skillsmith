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
      // The same words for every action: nothing in them is --abandon's alone.
      expect(detail).toBe(
        `${stray} is not a file or folder doctor knows in an op dir, so the action could not ` +
          'empty the op dir when it finishes; move it out of the op dir by hand, and run the command again'
      )
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
    // Run-side: the run resumes that same group (O lands at the backup's name), and no other.
    const a = await done(st, 'abandon')
    expect(a.result.kept.filter((k) => k.tree === 'O')).toEqual([
      { tree: 'O', kind: 'backup', path: destOf(st, 'backup') },
    ])
    expect(fs.existsSync(destOf(st, 'abandoned-old'))).toBe(false)
  })
})

describe('a sidecar temp the run could not prove is refused at plan time (O2)', () => {
  it('a non-empty invalid <opId>.abandoned-new.json.tmp beside N (P0): recovery-not-offered, nothing changed', async () => {
    // S1 with a foreign U: O is kept before N, so a run that reached N's temp would have changed things.
    const st = await s1(file())
    fs.mkdirSync(path.join(st.opDir, 'undone'))
    const tmp = `${destOf(st, 'abandoned-new')}.json.tmp`
    fs.mkdirSync(path.dirname(tmp), { recursive: true })
    fs.writeFileSync(tmp, 'not a sidecar\n')
    const cls = (await opReport(st)).cls
    const groups = 'facts' in cls && cls.facts !== null ? cls.facts.groups : []
    expect(groups.find((g) => g.base === `${OP_ID}.abandoned-new`)?.state).toBe('P0')
    const before = world(st)
    const a = await act(st, 'abandon')
    expect(world(st)).toBe(before)
    expect(a.result).toMatchObject({ status: 'refused', reason: 'recovery-not-offered' })
    expect(a.result.status === 'refused' ? a.result.detail : '').toBe(
      `${tmp} is not provably this operation's sidecar temp, so it is not unlinked; ` +
        'move it out of the op dir by hand, and run the command again'
    )
    // The positive: moved out by hand, the same command acts.
    fs.rmSync(tmp)
    expect((await done(st, 'abandon')).result.status).toBe('done')
  })
})

describe('a started R1 whose sidecar temp is not provable is refused at plan time (O2)', () => {
  it("N's started abandoned-new keep at R1 with a foreign temp: recovery-not-offered naming it, nothing changed", async () => {
    // S1 with a foreign U: O is kept before N, so a run that reached N's resume would have changed things.
    const st = await s1(file())
    fs.mkdirSync(path.join(st.opDir, 'undone'))
    keepTree(st, 'new', 'abandoned-new', { move: false })
    const tmp = `${destOf(st, 'abandoned-new')}.json.tmp`
    fs.writeFileSync(tmp, 'not a sidecar\n')
    const cls = (await opReport(st)).cls
    expect(cls.kind).toBe('ab')
    if (cls.kind !== 'ab') return
    expect(cls.facts.roles.N.kind === 'source' ? cls.facts.roles.N.started?.state : null).toBe('R1')
    const before = world(st)
    const a = await act(st, 'abandon')
    expect(world(st)).toBe(before)
    expect(a.result).toMatchObject({ status: 'refused', reason: 'recovery-not-offered' })
    expect(a.result.status === 'refused' ? a.result.detail : '').toBe(
      `${tmp} is not provably this operation's sidecar temp, so it is not unlinked; ` +
        'move it out of the op dir by hand, and run the command again'
    )
    // The positive: moved out by hand, the same command acts (the keep resumes from P1).
    fs.rmSync(tmp)
    expect((await done(st, 'abandon')).result.status).toBe('done')
  })
})

describe('every source is checked before the first mutation (the orphan keeps included)', () => {
  it('a source swapped after the re-plan stops staging-unsafe with nothing changed', async () => {
    const st = await twoSources()
    const area = areaOf(st.fx)
    fs.mkdirSync(area, { recursive: true })
    fs.mkdirSync(path.join(area, `.tmp-${OP_ID}`))
    fs.writeFileSync(path.join(area, `.tmp-${OP_ID}`, 'x.md'), 'x\n')
    const u = path.join(st.opDir, 'undone')
    let atReplan = ''
    const a = await act(
      st,
      'abandon',
      {},
      {
        afterReplan: () => {
          fs.renameSync(u, `${u}.aside`)
          fs.cpSync(`${u}.aside`, u, { recursive: true })
          fs.rmSync(`${u}.aside`, { recursive: true })
          atReplan = world(st)
        },
      }
    )
    expect(atReplan).not.toBe('')
    expect(world(st)).toBe(atReplan)
    expect(a.result).toMatchObject({ status: 'stopped', reason: 'staging-unsafe' })
    expect(a.result.status === 'stopped' ? a.result.detail : '').toContain(u)
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
