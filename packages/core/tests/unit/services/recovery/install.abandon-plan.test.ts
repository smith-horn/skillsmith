/**
 * SMI-6531 (A1 step 8-i-a-2, governance round): the `--abandon` plan's two
 * additions, for both ops.
 *
 *  - A source in the op dir that is the same folder as the one at the skill
 *    path is refused ("is the same folder as"): keeping it would move the skill
 *    folder. A directory cannot have two names on the filesystems these tests
 *    run on (`link(2)` of a directory is `EPERM`, asserted below; a bind mount
 *    needs privileges a test does not have), so the state cannot be built. The
 *    predicate is tested at the plan, on the facts the classifier observed for
 *    a real state, with the source's observed identity set to T's.
 *  - The note that the install's set-aside copies are untouched, present when
 *    the classifier found one and absent when it did not.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { planAction } from '../../../../src/services/skill-recovery.plan.js'
import type { RecoveryClass, Role } from '../../../../src/services/skill-recovery.types.js'
import { makeFixture, useTmpCleanup } from '../skill-swap.helpers.js'
import { opReport, s2 } from './recovery.helpers.js'
import { fi0, fi4, installFixture } from './install.helpers.js'

useTmpCleanup()

const SAME = 'is the same folder as'
const PARKED_NOTE = 'the copies this install set aside in its parked area are untouched'

/** `cls` with `role`'s observed source identity replaced by T's: one folder under two names. */
function sameAsT(cls: RecoveryClass, role: Role): RecoveryClass {
  const c = structuredClone(cls)
  if (!('facts' in c) || c.facts === null) throw new Error('no facts')
  const res = c.facts.roles[role]
  if (res.kind !== 'source' || !c.facts.t.present) throw new Error(`${role} or T not present`)
  res.obs.identity = { ...c.facts.t.identity }
  return c
}

/** Something the user made at the skill path: a non-empty folder that is not the install's. */
function foreignAt(p: string): void {
  fs.mkdirSync(p)
  fs.writeFileSync(path.join(p, 'user.txt'), 'mine\n')
}

describe('--abandon refuses a source that is the skill folder itself', () => {
  it('the state cannot be built: a directory cannot be hard-linked', () => {
    const fx = installFixture()
    const dir = path.join(fx.outside, 'd')
    fs.mkdirSync(dir)
    expect(() => fs.linkSync(dir, path.join(fx.outside, 'e'))).toThrow(
      expect.objectContaining({ code: 'EPERM' })
    )
  })

  it('an install record: N the same folder as T is refused; the observed state is offered (control)', async () => {
    const st = fi0(installFixture())
    foreignAt(st.fx.realDir)
    const cls = (await opReport(st)).cls
    expect(cls).toMatchObject({ kind: 'anything-else', facts: { record: { op: 'install' } } })
    expect(planAction(cls, 'abandon')).toMatchObject({ offered: true })
    const refused = planAction(sameAsT(cls, 'N'), 'abandon')
    expect(refused).toMatchObject({
      offered: false,
      reason: 'recovery-not-offered',
      detail: expect.stringContaining(`${path.join(st.opDir, 'new')} ${SAME} ${st.fx.realDir}`),
    })
  })

  it('an update record: O the same folder as T is refused; the observed state is offered (control)', async () => {
    const st = await s2(makeFixture({ 'SKILL.md': '# v1\n', 'docs/a.md': 'a\n' }))
    // O replaced by a copy of itself: the right content, another folder (identity-changed).
    const old = path.join(st.opDir, 'old')
    fs.renameSync(old, path.join(st.fx.outside, 'old-away'))
    fs.cpSync(path.join(st.fx.outside, 'old-away'), old, { recursive: true })
    const cls = (await opReport(st)).cls
    expect(cls).toMatchObject({ kind: 'identity-changed', facts: { record: { op: 'update' } } })
    expect(planAction(cls, 'abandon')).toMatchObject({ offered: true })
    expect(planAction(sameAsT(cls, 'O'), 'abandon')).toMatchObject({
      offered: false,
      reason: 'recovery-not-offered',
      detail: expect.stringContaining(`${old} ${SAME} ${st.fx.realDir}`),
    })
  })
})

describe('--abandon names the install’s set-aside copies', () => {
  it('present when one was found, absent when none was; both offered', async () => {
    const withCopy = await fi4(installFixture())
    foreignAt(withCopy.fx.realDir)
    const a = planAction((await opReport(withCopy)).cls, 'abandon')
    expect(a).toMatchObject({ offered: true })
    if (!a.offered) throw new Error('unreachable')
    expect(a.notes).toContain(PARKED_NOTE)

    const without = fi0(installFixture())
    foreignAt(without.fx.realDir)
    const b = planAction((await opReport(without)).cls, 'abandon')
    expect(b).toMatchObject({ offered: true })
    if (!b.offered) throw new Error('unreachable')
    expect(b.notes).not.toContain(PARKED_NOTE)
    expect(b.notes).toContain(
      'the skill folder, the manifest entry and the audit journal are untouched'
    )
  })
})
