/**
 * SMI-6531 (A1 step 6b-iii): `--abandon` of a moved op, and O4 (design
 * `step6b-design.md` § 1.3 "Where the abandoned trees go", "The classifier for
 * `moved`", O4; delta § 1 `abandonState`).
 *
 * A moved op's keeps go into the area of the root being scanned (`rootKey`
 * over R), named with the op dir's own name, and each `abandoned-*` sidecar
 * names the op dir that kept it. The record's own area is never written.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { abandonState } from '../../../../src/services/skill-recovery.abandon.js'
import { planAction } from '../../../../src/services/skill-recovery.plan.js'
import { computeRecordSha256 } from '../../../../src/services/skill-swap.js'
import type { SwapRecord } from '../../../../src/services/skill-swap.js'
import type { SkillsRootBinding } from '../../../../src/services/skill-write-lock.types.js'
import { areaOf, hashOf, makeFixture, OP_ID, useTmpCleanup } from '../skill-swap.helpers.js'
import { opIdN } from '../skill-swap.scan.helpers.js'
import { act, done, removedBy } from './recovery.act.helpers.js'
import { keepTree, opReport, s2 } from './recovery.helpers.js'
import type { State } from './recovery.helpers.js'
import {
  abandonedIn,
  copiedOp,
  copiedRoot,
  renamedOp,
  sidecarAt,
  world,
} from './recovery.abandon.helpers.js'

useTmpCleanup()

const file = () => makeFixture({ 'SKILL.md': '# v1\n', 'docs/a.md': 'a\n' })

const recordOf = (st: State): SwapRecord =>
  JSON.parse(fs.readFileSync(path.join(st.opDir, 'record.json'), 'utf8')) as SwapRecord

const real = (p: string): string => fs.realpathSync(p)

describe('foreign-op-dir and op-dir-identity: kept under the op dir’s own name and identity', () => {
  it('a renamed op dir: O kept as <its name>.abandoned-old; check passes on the identity observed', async () => {
    const orig = await s2(file())
    const st = renamedOp(orig)
    expect((await opReport(st)).cls).toMatchObject({ kind: 'moved', why: 'foreign-op-dir' })
    const oHash = hashOf(path.join(st.opDir, 'old'))
    const a = await done(st, 'abandon')
    const dest = path.join(areaOf(st.fx), `${st.opId}.abandoned-old`)
    expect(a.result.kept).toEqual([{ tree: 'O', kind: 'abandoned-old', path: dest }])
    expect(hashOf(dest)).toBe(oHash)
    expect(sidecarAt(dest)).toMatchObject({ opId: st.opId, kind: 'abandoned-old' })
    // The record's own op id names nothing in the area.
    expect(fs.readdirSync(areaOf(st.fx)).filter((n) => n.startsWith(OP_ID))).toEqual([])
    expect(fs.existsSync(st.opDir)).toBe(false)
  })

  it('a copied op dir (same name, new identity): abandoned with the identity the re-plan saw', async () => {
    const st = copiedOp(await s2(file()))
    expect((await opReport(st)).cls).toMatchObject({ kind: 'moved', why: 'op-dir-identity' })
    const seen = fs.lstatSync(st.opDir, { bigint: true })
    const a = await done(st, 'abandon')
    const dest = path.join(areaOf(st.fx), `${OP_ID}.abandoned-old`)
    expect(a.result.kept).toEqual([{ tree: 'O', kind: 'abandoned-old', path: dest }])
    expect(sidecarAt(dest).opDirIdentity).toMatchObject({
      dev: seen.dev.toString(),
      ino: seen.ino.toString(),
    })
    expect(removedBy(a.trace)).toContain(path.join(st.opDir, 'record.json'))
  })

  it('abandonState: OP is ST/<argument>, bound with the observed identity; the backup path is the R-keyed area plus the argument', () => {
    const fx = file()
    const rec = {
      opId: OP_ID,
      backupDest: '/the/other/root/area/' + OP_ID,
      oldIdentity: { dev: '1', ino: '2', birthtimeNs: '3', fmt: '16384' },
      newIdentity: { dev: '1', ino: '4', birthtimeNs: '5', fmt: '16384' },
      preTree: 'p',
      postTree: 'q',
      preEntry: null,
      postEntry: null,
      target: {
        client: 'claude-code',
        scope: 'global',
        dirName: fx.dirName,
        manifestPath: path.join(fx.stateRoot, 'manifest.json'),
        manifestKey: fx.dirName,
        skillsDir: '/the/other/root',
        realDir: `/the/other/root/${fx.dirName}`,
        comparedPath: `/the/other/root/${fx.dirName}`,
      },
    } as unknown as SwapRecord
    const root = real(fx.skillsDir)
    const binding = { root, stagingDir: path.join(root, '.skillsmith-staging') }
    const name = opIdN('c')
    const observed = { dev: '9', ino: '8', birthtimeNs: '7', fmt: '16384' }
    const st = abandonState({
      record: rec,
      opId: name,
      opIdentity: observed,
      binding: binding as unknown as SkillsRootBinding,
      ctx: null as never,
      options: {},
    })
    expect(st.opDir).toBe(path.join(binding.stagingDir, name))
    expect(st.op?.identity).toMatchObject({ dev: 9n, ino: 8n })
    expect(st.areaPath).toBe(areaOf(fx))
    expect(st.backupDest).toBe(path.join(areaOf(fx), name))
    expect(st.backupDest).not.toBe(rec.backupDest)
    expect(st.owner).toBeNull()
    expect(st.self.pid).toBe(process.pid)
    expect(st.record).toBe(rec)
  })
})

describe('foreign-root: a copied root keeps into its own area; the original keeps --apply', () => {
  it('--abandon --root B keeps into B’s area; A’s op still classifies as its row and offers --apply', async () => {
    const a = await s2(file())
    const b = copiedRoot(a)
    expect((await opReport(b)).cls).toMatchObject({ kind: 'moved', why: 'foreign-root' })
    const aArea = areaOf(a.fx)
    const aAreaBefore = fs.existsSync(aArea) ? fs.readdirSync(aArea).sort() : []
    const r = await done(b, 'abandon')
    const dest = path.join(areaOf(b.fx), `${OP_ID}.abandoned-old`)
    expect(r.result.kept).toEqual([{ tree: 'O', kind: 'abandoned-old', path: dest }])
    expect(areaOf(b.fx)).not.toBe(aArea)
    // The sidecar names B, the root it is filed under.
    expect(sidecarAt(dest).skillsDir).toBe(real(b.fx.skillsDir))
    expect(fs.existsSync(aArea) ? fs.readdirSync(aArea).sort() : []).toEqual(aAreaBefore)
    const back = (await opReport(a)).cls
    expect(back).toMatchObject({ kind: 'state', state: 'S2' })
    expect(planAction(back, 'apply').offered).toBe(true)
  })

  it('a started backup keep of B’s op (P1 in B’s area) resumes there as backup', async () => {
    const a = await s2(file())
    const b = copiedRoot(a)
    keepTree(b, 'old', 'backup', { move: false })
    const oHash = hashOf(path.join(b.opDir, 'old'))
    const cls = (await opReport(b)).cls
    expect(cls).toMatchObject({ kind: 'moved', why: 'foreign-root' })
    const r = await done(b, 'abandon')
    const dest = path.join(areaOf(b.fx), OP_ID)
    expect(r.result.kept).toEqual([{ tree: 'O', kind: 'backup', path: dest }])
    expect(hashOf(dest)).toBe(oHash)
    expect(abandonedIn(areaOf(b.fx))).toEqual({})
    expect(fs.existsSync(path.join(areaOf(a.fx), OP_ID))).toBe(false)
    expect((await opReport(a)).cls).toMatchObject({ kind: 'state', state: 'S2' })
  })
})

describe('the moved classifier runs the root-free consistency checks', () => {
  it('a moved record whose backupDest is not its area is unreadable (inconsistent-record): --park, not --abandon', async () => {
    const orig = await s2(file())
    const recPath = path.join(orig.opDir, 'record.json')
    const { recordSha256: _h, ...body } = recordOf(orig)
    const bad = { ...body, backupDest: '/elsewhere/x' } as Omit<SwapRecord, 'recordSha256'>
    fs.writeFileSync(recPath, JSON.stringify({ ...bad, recordSha256: computeRecordSha256(bad) }))
    const st = renamedOp(orig)
    const cls = (await opReport(st)).cls
    expect(cls).toMatchObject({ kind: 'unreadable', why: 'inconsistent-record' })
    expect(planAction(cls, 'park').offered).toBe(true)
    const before = world(st)
    const r = await act(st, 'abandon')
    expect(r.result).toMatchObject({ status: 'refused', reason: 'recovery-not-offered' })
    expect(world(st)).toBe(before)
  })
})

describe('O4: a copy’s abandon in the area the original uses does not make the original AB', () => {
  it('the original, moved back, still classifies as its row and offers --apply; the copy’s keep is listed as another copy’s', async () => {
    const st = await s2(file())
    const A = st.fx.skillsDir
    const aside = `${A}-moved`
    fs.renameSync(A, aside)
    fs.cpSync(aside, A, { recursive: true })
    expect((await opReport(st)).cls).toMatchObject({ kind: 'moved', why: 'root-identity' })
    await done(st, 'abandon')
    expect(Object.keys(abandonedIn(areaOf(st.fx)))).toEqual([`${OP_ID}.abandoned-old`])
    // The copy goes; the original comes back to A.
    fs.rmSync(A, { recursive: true })
    fs.renameSync(aside, A)
    const back = (await opReport(st)).cls
    expect(back).toMatchObject({ kind: 'state', state: 'S2' })
    expect(planAction(back, 'apply').offered).toBe(true)
    if (back.kind !== 'state') return
    expect(back.facts.groups.filter((g) => g.otherCopy).map((g) => g.base)).toEqual([
      `${OP_ID}.abandoned-old`,
    ])
    // And it still applies: the copy's keep is left alone.
    await done(st, 'apply')
    expect(Object.keys(abandonedIn(areaOf(st.fx)))).toEqual([`${OP_ID}.abandoned-old`])
  })
})
