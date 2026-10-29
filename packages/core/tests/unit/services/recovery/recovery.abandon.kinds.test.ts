/**
 * SMI-6531 (A1 step 6b-iii): the `abandoned-*` kinds as the producers and the
 * reader share them (design `step6b-design.md` Q9, O4; delta § 6.2-6.5):
 *
 *  - every kind `destFor` can write fits the park-intent precheck's bound
 *    (`longestKeptName`), not only the kinds doctor resolves to a role;
 *  - an `abandoned-*` sidecar's optional `opDirIdentity` is part of the strict
 *    schema: one that names another op dir is that copy's keep (`otherCopy`),
 *    a malformed one invalidates the sidecar.
 */
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { KIND_ROLE } from '../../../../src/services/skill-recovery.pstate.js'
import { KEPT_KINDS } from '../../../../src/services/skill-swap.fullmark.js'
import { longestKeptName } from '../../../../src/services/skill-swap.intent.js'
import { makeFixture, OP_ID, useTmpCleanup } from '../skill-swap.helpers.js'
import { keepTree, opReport, s2 } from './recovery.helpers.js'

useTmpCleanup()

const file = () => makeFixture({ 'SKILL.md': '# v1\n' })

describe('the precheck bounds every kept name a keep can take', () => {
  it('for every kind in KEPT_KINDS and KIND_ROLE, <opId>.<kind>.<MAX_SAFE_INTEGER> is no longer than longestKeptName', () => {
    const bound = longestKeptName(OP_ID).length
    const kinds = [...KEPT_KINDS, ...Object.keys(KIND_ROLE)]
    // The producers' set holds doctor's own kinds (no separate list to keep in step).
    for (const k of ['unused-new', 'abandoned-old', 'abandoned-new', 'abandoned-undone']) {
      expect(KEPT_KINDS.has(k), k).toBe(true)
    }
    for (const k of kinds) {
      expect(`${OP_ID}.${k}.${Number.MAX_SAFE_INTEGER}`.length, k).toBeLessThanOrEqual(bound)
    }
    // And the bound is attained, so it is the longest name, not merely a long one.
    expect(kinds.some((k) => `${OP_ID}.${k}.${Number.MAX_SAFE_INTEGER}`.length === bound)).toBe(
      true
    )
  })
})

describe('O4: an abandoned sidecar names the op dir that kept it', () => {
  const groupsOf = async (st: Awaited<ReturnType<typeof s2>>) => {
    const cls = (await opReport(st)).cls
    return { cls, groups: 'facts' in cls && cls.facts !== null ? cls.facts.groups : [] }
  }

  it("one naming another op dir is another copy's keep: listed, and the op still classifies as its row", async () => {
    const st = await s2(file())
    keepTree(st, 'old', 'abandoned-old', {
      move: false,
      over: { opDirIdentity: { dev: '1', ino: '2', birthtimeNs: '3', fmt: '16384' } },
    })
    const { cls, groups } = await groupsOf(st)
    expect(cls).toMatchObject({ kind: 'state', state: 'S2' })
    expect(groups.map((g) => [g.base, g.otherCopy, g.state, g.unclassified])).toEqual([
      [`${OP_ID}.abandoned-old`, true, null, null],
    ])
  })

  it("one naming this op dir is this op's abandon: AB", async () => {
    const st = await s2(file())
    const s = fs.lstatSync(st.opDir, { bigint: true })
    keepTree(st, 'old', 'abandoned-old', {
      move: false,
      over: {
        opDirIdentity: {
          dev: s.dev.toString(),
          ino: s.ino.toString(),
          birthtimeNs: s.birthtimeNs.toString(),
          fmt: (s.mode & 0o170000n).toString(),
        },
      },
    })
    const { cls } = await groupsOf(st)
    expect(cls).toMatchObject({ kind: 'ab', abandoned: [`${OP_ID}.abandoned-old`] })
  })

  it('a malformed opDirIdentity invalidates the sidecar (the strict schema), so it is not taken as another copy’s', async () => {
    const st = await s2(file())
    keepTree(st, 'old', 'abandoned-old', { move: false, over: { opDirIdentity: 'x' } })
    const { cls, groups } = await groupsOf(st)
    expect(cls.kind).toBe('ab')
    const g = groups.find((x) => x.base === `${OP_ID}.abandoned-old`)
    expect(g?.otherCopy).toBe(false)
    expect(g?.sidecar).toMatchObject({ validForOp: false, invalid: 'opDirIdentity is malformed' })
  })
})
