/**
 * SMI-6531 (A1 step 6a-i): doctor acts only on updates the current user started
 * (Q8), and "current user" is the effective uid on both sides.
 *
 * Every class that says whose update it is refuses every mutating action with
 * `recovery-other-user` before any class-specific handling, so a moved or
 * unclassifiable op of another user is not offered `--abandon`. Each class has
 * a same-uid control that is not refused for that reason.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { planAction, RECOVERY_ACTIONS } from '../../../../src/services/skill-recovery.plan.js'
import type { RecoveryClass } from '../../../../src/services/skill-recovery.types.js'
import { makeFixture, readRecord, useTmpCleanup } from '../skill-swap.helpers.js'
import { opDirOf, opIdN } from '../skill-swap.scan.helpers.js'
import { copyTree, keepTree, opReport, report, s2 } from './recovery.helpers.js'
import type { State } from './recovery.helpers.js'

useTmpCleanup()

afterEach(() => {
  vi.restoreAllMocks()
})

const file = () => makeFixture({ 'SKILL.md': '# v1\n' })
const realEuid = (): number => process.geteuid?.() ?? 0

/** One class of each kind that carries an owner uid, classified as seen by `euid`. */
async function ownedClasses(euid: number): Promise<Array<[string, RecoveryClass]>> {
  const out: Array<[string, RecoveryClass]> = []
  const of = async (st: State): Promise<RecoveryClass> => (await opReport(st, { euid })).cls

  out.push(['state', await of(await s2(file()))])

  const idc = await s2(file())
  const old = path.join(idc.opDir, 'old')
  copyTree(old, `${old}.c`)
  fs.rmSync(old, { recursive: true })
  fs.renameSync(`${old}.c`, old)
  out.push(['identity-changed', await of(idc)])

  const ab = await s2(file())
  keepTree(ab, 'old', 'abandoned-old', { move: false })
  out.push(['ab', await of(ab)])

  const el = await s2(file())
  fs.mkdirSync(path.join(el.opDir, 'new'))
  fs.writeFileSync(path.join(el.opDir, 'new', 'x'), 'x')
  out.push(['anything-else', await of(el)])

  const mv = await s2(file())
  const other = opIdN('9')
  fs.mkdirSync(opDirOf(mv.fx, other))
  fs.copyFileSync(
    path.join(mv.opDir, 'record.json'),
    path.join(opDirOf(mv.fx, other), 'record.json')
  )
  const root = await report(mv, { euid })
  out.push(['moved', root.ops.find((o) => o.opId === other)!.cls])

  const nr = makeFixture({ 'SKILL.md': '# v1\n' })
  const dir = opDirOf(nr, opIdN('b'))
  fs.mkdirSync(path.join(dir, 'new'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'owner.json'),
    JSON.stringify({ pid: 1, host: 'h', uid: realEuid() })
  )
  out.push(['no-record', (await report({ fx: nr }, { euid })).ops[0]!.cls])
  return out
}

describe("another user's update is refused for every mutating action, whatever the class", () => {
  it('every class that names an owner refuses apply, undo, abandon, clean-staging and park', async () => {
    const classes = await ownedClasses(realEuid() + 1)
    expect(classes.map(([n]) => n)).toEqual([
      'state',
      'identity-changed',
      'ab',
      'anything-else',
      'moved',
      'no-record',
    ])
    for (const [name, cls] of classes) {
      expect(cls.kind, name).toBe(name)
      for (const action of RECOVERY_ACTIONS) {
        const plan = planAction(cls, action)
        expect(plan, `${name} ${action}`).toMatchObject({
          offered: false,
          reason: 'recovery-other-user',
        })
        expect(plan.offered ? '' : plan.detail).toContain(String(realEuid()))
      }
    }
  })

  it('control: the same classes as the same user are not refused for that reason, and some are offered', async () => {
    const classes = await ownedClasses(realEuid())
    let offered = 0
    for (const [name, cls] of classes) {
      expect(cls.kind, name).toBe(name)
      for (const action of RECOVERY_ACTIONS) {
        const plan = planAction(cls, action)
        if (plan.offered) offered++
        else expect(plan.reason, `${name} ${action}`).not.toBe('recovery-other-user')
      }
    }
    expect(offered).toBeGreaterThan(3)
  })
})

describe('the writer and the listing both use the effective uid', () => {
  it('a record and owner.json written by a process whose effective uid differs carry the effective uid', async () => {
    const euid = realEuid() + 1000
    vi.spyOn(process, 'geteuid').mockReturnValue(euid)
    const st = await s2(file())
    expect(readRecord(path.join(st.opDir, 'record.json')).uid).toBe(euid)
    const owner = JSON.parse(fs.readFileSync(path.join(st.opDir, 'owner.json'), 'utf8')) as {
      uid: number
    }
    expect(owner.uid).toBe(euid)
    // The listing, as that same process, sees its own update.
    expect((await opReport(st)).plans[0]).toMatchObject({ offered: true })
    vi.restoreAllMocks()
    // As the real user it is someone else's, and the plan says so.
    const theirs = await opReport(st)
    expect(planAction(theirs.cls, 'apply')).toMatchObject({
      offered: false,
      reason: 'recovery-other-user',
    })
  })
})
