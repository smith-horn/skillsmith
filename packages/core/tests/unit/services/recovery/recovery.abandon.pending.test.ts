/**
 * SMI-6531 (A1 step 6b-iii; owner decision 2026-10-29): a `partial-copy` keep
 * killed between its sidecar and its rename is finished only when the pair is
 * one-to-one (`skill-recovery.pending.ts`). A second sidecar naming the same
 * copy temp (here, the first one copied after the kill) is ambiguous: every
 * action refuses before any change, and the sidecars and the temp stay.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { executeRecovery } from '../../../../src/services/skill-recovery.exec.js'
import { AMBIGUOUS_PARTIAL } from '../../../../src/services/skill-recovery.pending.js'
import { planAction } from '../../../../src/services/skill-recovery.plan.js'
import { planRecovery } from '../../../../src/services/skill-recovery.target.js'
import type { RecoveryAction } from '../../../../src/services/skill-recovery.types.js'
import { areaOf, makeFixture, OP_ID, useTmpCleanup } from '../skill-swap.helpers.js'
import { useOtherDeviceCleanup } from '../skill-swap.xdev.helpers.js'
import { act, contentSnapshot, done, requestOf } from './recovery.act.helpers.js'
import { keepTree, opReport, s2, s3, un1 } from './recovery.helpers.js'
import type { State } from './recovery.helpers.js'
import { killed, xfile } from './recovery.xdev.helpers.js'

useTmpCleanup()
useOtherDeviceCleanup()

const file = () => makeFixture({ 'SKILL.md': '# v1\n', 'docs/a.md': 'a\n' })

/** Everything an action could touch, the state root (on another device or not) included. */
const world = (st: State): string => contentSnapshot(st.fx.skillsDir, st.fx.stateRoot, st.fx.base)

/** Runs `action`, killed once the partial-copy sidecar is published (the area sync after its link). */
async function killInPartialWindow(st: State, action: RecoveryAction): Promise<void> {
  const planned = await planRecovery(requestOf(st, action))
  if (planned.status !== 'planned') throw new Error(JSON.stringify(planned))
  const area = areaOf(st.fx)
  let linked = false
  const r = await executeRecovery(planned, {
    swap: {
      trace: (t) => {
        if (t.op === 'link' && t.dest === path.join(area, `${OP_ID}.partial-copy.json`))
          linked = true
        else if (linked && t.op === 'dirsync' && t.path === area) killed('partial window')
      },
    },
  })
  expect(r.status).toBe('stopped')
}

/** A second sidecar naming the same temp: the first, copied after the kill. */
function duplicateSidecar(st: State): { first: string; second: string } {
  const first = path.join(areaOf(st.fx), `${OP_ID}.partial-copy.json`)
  const second = path.join(areaOf(st.fx), `${OP_ID}.partial-copy.1.json`)
  fs.copyFileSync(first, second)
  return { first, second }
}

/** The ambiguous state refuses `action` (and `--abandon`) with nothing changed; the extra sidecar out, it acts. */
async function refusesThenActs(st: State, action: RecoveryAction, temp: string): Promise<void> {
  const { first, second } = duplicateSidecar(st)
  const before = world(st)
  const a = await act(st, action)
  expect(world(st)).toBe(before)
  expect(a.result.status).toBe('refused')
  // Each refusal names its reason: the ambiguous pair (for --apply and --undo too).
  expect(a.result.status === 'refused' ? a.result.detail : '').toContain(AMBIGUOUS_PARTIAL)
  for (const p of [first, second, temp]) expect(fs.existsSync(p), p).toBe(true)
  // Why: the pair is ambiguous, and --abandon says so (it refuses too).
  const abandon = planAction((await opReport(st)).cls, 'abandon')
  expect(abandon.offered ? '' : abandon.detail).toContain(AMBIGUOUS_PARTIAL)
  // The presence half: the copied sidecar moved out by hand, the same command finishes.
  fs.rmSync(second)
  expect((await done(st, action)).result.status).toBe('done')
  expect(fs.existsSync(path.join(areaOf(st.fx), `${OP_ID}.partial-copy`))).toBe(true)
}

/** Anything else with an orphan `.tmp-<opId>`, killed so its partial-copy sidecar names it (one-to-one). */
async function pendingOrphan(): Promise<State & { temp: string; dest: string }> {
  const st = await s2(file())
  fs.mkdirSync(path.join(st.opDir, 'undone'))
  fs.writeFileSync(path.join(st.opDir, 'undone', 'stray.md'), 'kept as it is\n')
  const temp = path.join(areaOf(st.fx), `.tmp-${OP_ID}`)
  fs.mkdirSync(temp, { recursive: true })
  fs.writeFileSync(path.join(temp, 'SKILL.md'), '# half a copy\n')
  await killInPartialWindow(st, 'abandon')
  return { ...st, temp, dest: path.join(areaOf(st.fx), `${OP_ID}.partial-copy`) }
}

/** `p` replaced by a copy of itself: the same bytes under a new identity. */
function replaceWithCopy(p: string): void {
  fs.renameSync(p, `${p}.aside`)
  fs.cpSync(`${p}.aside`, p, { recursive: true })
  fs.rmSync(`${p}.aside`, { recursive: true })
}

const OTHER = { opDirIdentity: { dev: '1', ino: '2', birthtimeNs: '3', fmt: '16384' } }

describe('a sidecar pairs only with the temp its identity names (PR-16 M2, M3)', () => {
  it("M3: a lone temp whose identity is not the sidecar's does not pair: refused, nothing changed", async () => {
    const st = await pendingOrphan()
    replaceWithCopy(st.temp)
    const before = world(st)
    const a = await act(st, 'abandon')
    expect(world(st)).toBe(before)
    expect(a.result).toMatchObject({ status: 'refused', reason: 'recovery-not-offered' })
    expect(a.result.status === 'refused' ? a.result.detail : '').toContain(
      `${st.dest} is kept but its tree is nowhere`
    )
  })

  it("M2: another copy's copy temp is never paired, even when the sidecar names its identity", async () => {
    const st = await pendingOrphan()
    // The temp becomes another copy's: an abandoned-old keep whose sidecar names another op dir.
    const theirs = path.join(areaOf(st.fx), `.tmp-${OP_ID}.abandoned-old`)
    fs.renameSync(st.temp, theirs)
    keepTree(st, 'old', 'abandoned-old', { move: false, over: OTHER })
    const cls = (await opReport(st)).cls
    const fx = 'facts' in cls && cls.facts !== null ? cls.facts.groups : []
    expect(fx.find((g) => g.base === `${OP_ID}.abandoned-old`)?.otherCopy).toBe(true)
    const before = world(st)
    const a = await act(st, 'abandon')
    expect(world(st)).toBe(before)
    expect(a.result).toMatchObject({ status: 'refused', reason: 'recovery-not-offered' })
    expect(a.result.status === 'refused' ? a.result.detail : '').toContain(
      `${st.dest} is kept but its tree is nowhere`
    )
    expect(fs.existsSync(theirs)).toBe(true)
  })
})

describe('the pending finish re-checks what the plan saw (PR-16 M4, M5)', () => {
  it('M4: the temp replaced by a copy after the re-plan stops backup-unsafe, nothing renamed', async () => {
    const st = await pendingOrphan()
    let atReplan = ''
    const a = await act(
      st,
      'abandon',
      {},
      {
        afterReplan: () => {
          replaceWithCopy(st.temp)
          atReplan = world(st)
        },
      }
    )
    expect(atReplan).not.toBe('')
    expect(world(st)).toBe(atReplan)
    expect(a.result).toMatchObject({ status: 'stopped', reason: 'backup-unsafe' })
  })

  it('M5: an empty directory made at the destination after the re-plan stops backup-unsafe, not renamed over', async () => {
    const st = await pendingOrphan()
    let atReplan = ''
    const a = await act(
      st,
      'abandon',
      {},
      {
        afterReplan: () => {
          fs.mkdirSync(st.dest)
          atReplan = world(st)
        },
      }
    )
    expect(atReplan).not.toBe('')
    expect(world(st)).toBe(atReplan)
    expect(a.result).toMatchObject({ status: 'stopped', reason: 'backup-unsafe' })
    expect(fs.existsSync(st.temp)).toBe(true)
  })
})

describe('two sidecars naming one copy temp are not a pending keep: refused, nothing changed', () => {
  it('(a) --abandon, beside an orphan copy temp', async () => {
    const st = await s2(file())
    fs.mkdirSync(path.join(st.opDir, 'undone'))
    fs.writeFileSync(path.join(st.opDir, 'undone', 'stray.md'), 'kept as it is\n')
    const temp = path.join(areaOf(st.fx), `.tmp-${OP_ID}`)
    fs.mkdirSync(temp, { recursive: true })
    fs.writeFileSync(path.join(temp, 'SKILL.md'), '# half a copy\n')
    await killInPartialWindow(st, 'abandon')
    await refusesThenActs(st, 'abandon', temp)
  })

  it('(b) --apply, beside a P2 copy temp (S3 across devices)', async () => {
    const st = await s3(xfile())
    const first = await act(st, 'apply', {}, { swap: { duringBackupCopy: () => killed('copy') } })
    expect(first.result.status).toBe('stopped')
    await killInPartialWindow(st, 'apply')
    await refusesThenActs(st, 'apply', path.join(areaOf(st.fx), `.tmp-${OP_ID}`))
  })

  it('(b) --undo, beside a P2 copy temp (UN2 across devices: an undo from UN1 stopped while keeping U)', async () => {
    const st = await un1(xfile())
    const first = await act(st, 'undo', {}, { swap: { duringBackupCopy: () => killed('copy') } })
    expect(first.result.status).toBe('stopped')
    await killInPartialWindow(st, 'undo')
    // The state the title names: O is back at the skill path, U still to be kept.
    expect((await opReport(st)).cls).toMatchObject({ kind: 'state', state: 'UN2' })
    await refusesThenActs(st, 'undo', path.join(areaOf(st.fx), `.tmp-${OP_ID}.undone`))
  })
})
