/**
 * SMI-6531 (A1 step 6a-iii, GPT-5.6-Sol bf-zyg F1, governance S2 and S4):
 * what doctor accepts as "already parked", and the opId check.
 *
 * Positive control: the genuine case (a doctor finish killed at `afterPark`,
 * the park moved OP but its syncs did not run) is finished by the same command:
 * the landing directory, then ST, synced, and the validated parked copy named.
 * Negatives, each refused with zero mutation and no sync: a forged `<opId>`
 * container, a missing or malformed sidecar, a sidecar with the wrong kind,
 * opId, origin, root or a held park's keys, a parked tree with the wrong intent
 * `backupPath` or edited contents, two parked trees, a state root doctor was
 * not given; and the sidecar's bytes changed between the plan and the lock
 * (`plan-changed`). An opId that is not one path component is refused before
 * any read.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { executeRecovery } from '../../../../src/services/skill-recovery.run.js'
import { planRecovery } from '../../../../src/services/skill-recovery.target.js'
import type { TraceOp } from '../../../../src/services/skill-swap.types.js'
import { OP_ID, useTmpCleanup } from '../skill-swap.helpers.js'
import { useOtherDeviceCleanup } from '../skill-swap.xdev.helpers.js'
import type { State } from './recovery.helpers.js'
import { act, contentSnapshot, done, killAt, requestOf } from './recovery.act.helpers.js'
import { killed, theParkedCopy, xs3 } from './recovery.xdev.helpers.js'

useTmpCleanup()
useOtherDeviceCleanup()

const world = (st: State): string => contentSnapshot(st.fx.skillsDir, st.fx.stateRoot, st.fx.base)
const landingOf = (st: State): string => path.join(st.fx.staging, '.skillsmith-parked', OP_ID)

/** A doctor finish killed right after its park moved OP (the park's syncs did not run). */
async function parkedLeft(): Promise<State & { copy: string }> {
  const st = await xs3({ hooks: { afterBackupMove: () => killed('afterBackupMove') } })
  const first = await act(st, 'apply', {}, killAt('afterPark'))
  expect(first.result.status).toBe('done')
  expect(fs.existsSync(st.opDir)).toBe(false)
  return { ...st, copy: theParkedCopy(st.fx) }
}

function editJson(p: string, f: (v: Record<string, unknown>) => Record<string, unknown>): void {
  const v = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>
  // Compact, unlike the park's own two-space JSON: the bytes differ even when the fields do not.
  fs.writeFileSync(p, JSON.stringify(f(v)))
}

/** `--apply` refused with `reason` (and `words`), nothing changed, nothing synced. */
async function refused(st: State, reason: string, words: string, over = {}): Promise<void> {
  const before = world(st)
  const a = await act(st, 'apply', over)
  expect(a.result).toMatchObject({ status: 'refused', reason })
  if (a.result.status === 'refused') expect(a.result.detail).toContain(words)
  expect(a.trace).toEqual([])
  expect(world(st)).toBe(before)
}

describe('the genuine killed park (positive control)', () => {
  it('done: the landing directory, then ST, synced; the validated parked copy named', async () => {
    const st = await parkedLeft()
    const a = await done(st, 'apply')
    expect(a.result.from).toBe('already parked')
    expect(a.result.extraCopy).toBe(st.copy)
    expect(a.trace).toEqual([
      { op: 'dirsync', path: landingOf(st) },
      { op: 'dirsync', path: st.fx.staging },
    ])
  })
})

describe('refused, with zero mutation and no sync', () => {
  it('a forged <opId> container (an empty directory)', async () => {
    const st = await xs3({ hooks: { afterBackupMove: () => killed('afterBackupMove') } })
    // The op dir moved away by hand, and an empty container put in the parked area.
    fs.renameSync(st.opDir, path.join(st.fx.base, 'moved-away'))
    fs.mkdirSync(landingOf(st), { recursive: true })
    await refused(st, 'recovery-not-offered', '0 parked trees')
  })

  it('a forged container holding a directory with the right name and no sidecar', async () => {
    const st = await xs3({ hooks: { afterBackupMove: () => killed('afterBackupMove') } })
    fs.renameSync(st.opDir, path.join(st.fx.base, 'moved-away'))
    fs.mkdirSync(path.join(landingOf(st), `${OP_ID}-deadbeef`), { recursive: true })
    await refused(st, 'recovery-not-offered', 'no sidecar')
  })

  it('the sidecar missing', async () => {
    const st = await parkedLeft()
    fs.renameSync(`${st.copy}.json`, path.join(st.fx.base, 'sidecar-aside.json'))
    await refused(st, 'recovery-not-offered', 'no sidecar')
  })

  it('the sidecar malformed', async () => {
    const st = await parkedLeft()
    fs.writeFileSync(`${st.copy}.json`, 'not json')
    await refused(st, 'recovery-not-offered', 'missing or not JSON')
  })

  const FIELDS: Array<[string, (st: State & { copy: string }) => Record<string, unknown>, string]> =
    [
      ['the wrong kind (another caller)', () => ({ kind: 'abort-new' }), 'kind is abort-new'],
      ['another opId', () => ({ opId: 'b'.repeat(32) }), 'another opId'],
      ['another origin', (st) => ({ originPath: st.fx.realDir }), 'origin is not'],
      ['another skills root', () => ({ rootKey: '0'.repeat(16) }), 'another skills root'],
      ['a held park (hold)', () => ({ hold: true }), 'held or foreign'],
    ]
  for (const [label, over, words] of FIELDS) {
    it(`a sidecar with ${label}`, async () => {
      const st = await parkedLeft()
      editJson(`${st.copy}.json`, (v) => ({ ...v, ...over(st) }))
      await refused(st, 'recovery-not-offered', words)
    })
  }

  it("the parked intent's backupPath outside this root's area", async () => {
    const st = await parkedLeft()
    editJson(path.join(st.copy, 'park-intent.json'), (v) => ({
      ...v,
      backupPath: path.join(st.fx.base, OP_ID),
    }))
    await refused(st, 'recovery-not-offered', 'backupPath')
  })

  it('the parked tree edited after the park (it no longer hashes to its sidecar)', async () => {
    const st = await parkedLeft()
    fs.writeFileSync(path.join(st.copy, 'old', 'a.txt'), 'edited in the parked copy\n')
    await refused(st, 'recovery-not-offered', 'no longer hashes')
  })

  it('two parked trees', async () => {
    const st = await parkedLeft()
    fs.mkdirSync(path.join(landingOf(st), `${OP_ID}-abcdef12`))
    await refused(st, 'recovery-not-offered', '2 parked trees')
  })

  it('a state root doctor did not discover and was not given (governance S4)', async () => {
    const st = await parkedLeft()
    await refused(st, 'recovery-not-offered', 'not one doctor discovered', { stateRoots: [] })
  })
})

describe('the plan re-read under lock 1 (F1: a real digest)', () => {
  it('the sidecar bytes changed between the plan and the lock: plan-changed, nothing synced', async () => {
    const st = await parkedLeft()
    const planned = await planRecovery(requestOf(st, 'apply'))
    expect(planned.status).toBe('planned')
    if (planned.status !== 'planned') return
    // The same fields, other bytes: only a digest of the bytes read sees it.
    editJson(`${st.copy}.json`, (v) => v)
    const before = world(st)
    const trace: TraceOp[] = []
    const r = await executeRecovery(planned, { swap: { trace: (t) => trace.push(t) } })
    expect(r).toMatchObject({ status: 'refused', reason: 'plan-changed' })
    expect(trace).toEqual([])
    expect(world(st)).toBe(before)
  })
})

describe('governance S2: an opId that is not one path component is refused before any read', () => {
  for (const opId of ['..', '.', '', 'a/b', `${OP_ID}\0`, '../escape']) {
    it(JSON.stringify(opId), async () => {
      let reads = 0
      const r = await planRecovery({
        action: 'apply',
        opId,
        roots: ['/nonexistent-skills-root'],
        reader: {
          statOverride: (_p, real) => {
            reads++
            return real
          },
        },
      })
      expect(r).toMatchObject({ status: 'refused', reason: 'recovery-not-offered' })
      if (r.status === 'refused') expect(r.detail).toContain('is not an operation id')
      expect(reads).toBe(0)
    })
  }

  it('the pair: a well-formed opId reaches the scan (and is not found)', async () => {
    const r = await planRecovery({ action: 'apply', opId: OP_ID, roots: ['/nonexistent-root'] })
    expect(r).toMatchObject({ status: 'refused', reason: 'recovery-not-offered' })
    if (r.status === 'refused') expect(r.detail).toContain('no operation directory named')
  })
})
