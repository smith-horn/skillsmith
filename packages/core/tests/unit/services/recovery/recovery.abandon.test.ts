/**
 * SMI-6531 (A1 step 6b-iii): `doctor recovery --abandon <opId>` on one device
 * (A1 plan §3.9 PLAN:2022, T-J11; design `step6b-design.md` § 1.3).
 *
 * Every fixture is a real crash moved the way a person or a copy would move
 * it (`recovery.abandon.helpers.ts`). Each "only metadata removed" assertion
 * is paired with the exact list of what was removed in the same run, and each
 * "nothing changed" with a refusal that names what does run.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { planAction } from '../../../../src/services/skill-recovery.plan.js'
import { planRecovery } from '../../../../src/services/skill-recovery.target.js'
import { areaOf, hashOf, makeFixture, OP_ID, useTmpCleanup } from '../skill-swap.helpers.js'
import {
  act,
  areaNames,
  done,
  entryOf,
  keptTrees,
  onlyMetadataRemoved,
  removedBy,
  requestOf,
} from './recovery.act.helpers.js'
import { copyTree, destOf, keepTree, opReport, s1, s2, s3, writeEntry } from './recovery.helpers.js'
import type { State } from './recovery.helpers.js'
import { abandonable, postKeepS2prime, sidecarAt, world } from './recovery.abandon.helpers.js'

useTmpCleanup()

const file = () => makeFixture({ 'SKILL.md': '# v1\n', 'docs/a.md': 'a\n' })

/** The record-string identity of `p` (no-follow). */
function idOf(p: string) {
  const s = fs.lstatSync(p, { bigint: true })
  return {
    dev: s.dev.toString(),
    ino: s.ino.toString(),
    birthtimeNs: s.birthtimeNs.toString(),
    fmt: (s.mode & 0o170000n).toString(),
  }
}

/** S2 with a foreign tree at `OP/undone` (no row has U beside T new and O): anything else with O and U. */
async function twoSources(): Promise<State> {
  const st = await s2(file())
  fs.mkdirSync(path.join(st.opDir, 'undone'))
  fs.writeFileSync(path.join(st.opDir, 'undone', 'stray.md'), 'kept as it is\n')
  expect((await opReport(st)).cls.kind).toBe('anything-else')
  return st
}

const at = (st: State, name: string): string => path.join(st.opDir, name)

describe('the offered classes: every tree kept, only metadata removed', () => {
  it('anything else (S1 with its old folder set aside by hand, T absent): N kept as abandoned-new', async () => {
    const st = await abandonable(file())
    const nHash = hashOf(at(st, 'new'))
    const opIdentity = idOf(st.opDir)
    const entry = entryOf(st.fx)
    const planned = await planRecovery(requestOf(st, 'abandon'))
    if (planned.status !== 'planned') throw new Error(JSON.stringify(planned))
    // An absent role has no step: O was moved out and T is absent, so N is the only one.
    expect(planned.plan.steps).toEqual([
      expect.objectContaining({ tree: 'N', disposition: { kind: 'kept', as: 'abandoned-new' } }),
    ])
    expect(planned.plan.notes).toContain('the skill path stays empty')
    const a = await done(st, 'abandon')
    const dest = destOf(st, 'abandoned-new')
    expect(a.result.kept).toEqual([{ tree: 'N', kind: 'abandoned-new', path: dest }])
    expect(hashOf(dest)).toBe(nHash)
    // O4: the abandoned sidecar names the op dir that kept it.
    expect(sidecarAt(dest)).toMatchObject({ kind: 'abandoned-new', opDirIdentity: opIdentity })
    expect(fs.existsSync(st.opDir)).toBe(false)
    expect(fs.existsSync(st.fx.realDir)).toBe(false)
    expect(entryOf(st.fx)).toEqual(entry)
    expect(fs.existsSync(st.aside)).toBe(true)
    // Exactly the sidecar's own temp, then the metadata, record last, then the emptied op dir.
    expect(removedBy(a.trace)).toEqual([
      `${dest}.json.tmp`,
      at(st, 'owner.json'),
      at(st, 'record.json'),
      st.opDir,
    ])
    onlyMetadataRemoved(a.trace, st.fx)
  })

  it('post-keep S2′: only metadata goes and OP is rmdir’d; the backup, T and the manifest are unchanged', async () => {
    const fx = file()
    const st = await postKeepS2prime(fx)
    const backup = destOf(st, 'backup')
    const before = {
      backup: hashOf(backup),
      sidecar: fs.readFileSync(`${backup}.json`, 'utf8'),
      t: hashOf(fx.realDir),
      tId: idOf(fx.realDir),
      entry: entryOf(fx),
    }
    const a = await done(st, 'abandon')
    // Nothing was left to keep: the old folder was already in the backup area.
    expect(a.result.kept).toEqual([])
    expect({
      backup: hashOf(backup),
      sidecar: fs.readFileSync(`${backup}.json`, 'utf8'),
      t: hashOf(fx.realDir),
      tId: idOf(fx.realDir),
      entry: entryOf(fx),
    }).toEqual(before)
    expect(removedBy(a.trace)).toEqual([at(st, 'owner.json'), at(st, 'record.json'), st.opDir])
    // No tree moved: nothing was renamed.
    expect(a.trace.filter((t) => t.op === 'rename')).toEqual([])
    expect(fs.existsSync(st.opDir)).toBe(false)
  })

  it('a started keep resumes with its own kind (backup at P1), never re-labelled; U is kept as abandoned-undone', async () => {
    const st = await twoSources()
    keepTree(st, 'old', 'backup', { move: false })
    const oHash = hashOf(at(st, 'old'))
    const cls = (await opReport(st)).cls
    expect(cls.kind).toBe('anything-else')
    const plan = planAction(cls, 'abandon')
    if (!plan.offered) throw new Error(plan.detail)
    expect(plan.steps.find((s) => s.tree === 'O')?.disposition).toEqual({
      kind: 'kept',
      as: 'backup',
    })
    const a = await done(st, 'abandon')
    const backup = destOf(st, 'backup')
    // The backup's sidecar has its tree: no sidecar is left without one.
    expect(hashOf(backup)).toBe(oHash)
    expect(sidecarAt(backup)).toMatchObject({ kind: 'backup' })
    expect(fs.existsSync(destOf(st, 'abandoned-old'))).toBe(false)
    expect(a.result.kept.map((k) => `${k.tree}:${k.kind}`)).toEqual([
      'O:backup',
      'U:abandoned-undone',
    ])
    expect(Object.keys(keptTrees(st.fx)).sort()).toEqual([OP_ID, `${OP_ID}.abandoned-undone`])
  })

  it('P4 whose source changed after the copy (PLAN:1559): the source is kept fresh; the copy stays and becomes P5', async () => {
    const st = await s2(file())
    keepTree(st, 'old', 'backup', { move: false })
    const backup = destOf(st, 'backup')
    copyTree(at(st, 'old'), backup)
    const copied = hashOf(backup)
    fs.writeFileSync(path.join(at(st, 'old'), 'SKILL.md'), '# changed after the copy\n')
    const changed = hashOf(at(st, 'old'))
    expect((await opReport(st)).cls.kind).toBe('anything-else')
    await done(st, 'abandon')
    expect(hashOf(backup)).toBe(copied)
    expect(hashOf(destOf(st, 'abandoned-old'))).toBe(changed)
    expect(sidecarAt(backup)).toMatchObject({ kind: 'backup', treeHash: copied })
  })

  it('an orphan copy temp of this op (no sidecar) is kept as partial-copy, never removed', async () => {
    const st = await s2(file())
    const area = areaOf(st.fx)
    fs.mkdirSync(area, { recursive: true })
    const temp = path.join(area, `.tmp-${OP_ID}`)
    fs.mkdirSync(temp)
    fs.writeFileSync(path.join(temp, 'SKILL.md'), '# half a copy\n')
    const tempHash = hashOf(temp)
    const tempId = idOf(temp)
    const cls = (await opReport(st)).cls
    expect(cls.kind).toBe('anything-else')
    const plan = planAction(cls, 'abandon')
    if (!plan.offered) throw new Error(plan.detail)
    expect(plan.remaining).toContain(`keep the copy temp ${temp} as partial-copy`)
    const a = await done(st, 'abandon')
    const kept = a.result.kept.find((k) => k.kind === 'partial-copy')
    expect(kept?.path).toBe(destOf(st, 'partial-copy'))
    expect(hashOf(kept!.path)).toBe(tempHash)
    expect(idOf(kept!.path)).toEqual(tempId)
    expect(sidecarAt(kept!.path)).toMatchObject({
      kind: 'partial-copy',
      sourceUnchanged: false,
      partialCause: 'copy-failed',
      treeHash: tempHash,
      identity: tempId,
    })
    // Every copy temp of this op was kept: none is left at its temp name.
    expect(areaNames(st.fx).filter((n) => n.startsWith('.tmp-'))).toEqual([])
    expect(fs.existsSync(destOf(st, 'abandoned-old'))).toBe(true)
  })

  it('an unhashable tree (a FIFO in N) is kept as abandoned-new with treeHash null and the error', async () => {
    const st = await abandonable(file())
    execFileSync('mkfifo', [path.join(at(st, 'new'), 'pipe')])
    const a = await done(st, 'abandon')
    const dest = destOf(st, 'abandoned-new')
    expect(a.result.kept).toEqual([{ tree: 'N', kind: 'abandoned-new', path: dest }])
    const side = sidecarAt(dest)
    expect(side.treeHash).toBeNull()
    expect(String(side.treeHashError)).toContain('pipe')
    expect(fs.lstatSync(path.join(dest, 'pipe')).isFIFO()).toBe(true)
    expect(fs.existsSync(st.opDir)).toBe(false)
  })
})

describe('the refused classes: zero mutation, naming what to do', () => {
  const cases: Array<[string, () => Promise<State>, string]> = [
    ['S1 (E34: abandoning it would leave the skill path empty)', () => s1(file()), '--apply'],
    [
      'ordinary S2′',
      async () => {
        const fx = file()
        const st = await s2(fx)
        writeEntry(fx, { version: '9.9.9' })
        return st
      },
      '--undo',
    ],
    ['S3', () => s3(file()), '--apply'],
  ]
  for (const [name, build, names] of cases) {
    it(`${name}: refused recovery-not-offered naming ${names}, nothing changed`, async () => {
      const st = await build()
      const before = world(st)
      const a = await act(st, 'abandon')
      expect(a.result).toMatchObject({ status: 'refused', reason: 'recovery-not-offered' })
      expect(a.result.status === 'refused' ? a.result.detail : '').toContain(names)
      expect(world(st)).toBe(before)
      expect(a.trace).toEqual([])
      expect(fs.existsSync(at(st, 'record.json'))).toBe(true)
    })
  }

  it('C4: anything else with no verified record (the op dir entry is not a directory) is refused', () => {
    const plan = planAction(
      {
        kind: 'anything-else',
        opId: OP_ID,
        opDir: `/st/${OP_ID}`,
        reason: 'the op dir entry is not a directory',
        facts: null,
      },
      'abandon'
    )
    expect(plan).toMatchObject({ offered: false, reason: 'recovery-not-offered' })
    expect(plan.offered ? '' : plan.detail).toContain('verified record')
  })

  it('O2: a tree in the area no sub-state names is refused, named, until it is resolved', async () => {
    const st = await twoSources()
    // A tree at the backup's name with no sidecar: not an orphan copy temp, not P4.
    const backup = destOf(st, 'backup')
    fs.mkdirSync(backup, { recursive: true })
    const before = world(st)
    const a = await act(st, 'abandon')
    expect(a.result).toMatchObject({ status: 'refused', reason: 'recovery-not-offered' })
    expect(a.result.status === 'refused' ? a.result.detail : '').toContain(backup)
    expect(world(st)).toBe(before)
    // The positive: resolved by hand, the same command acts.
    fs.rmdirSync(backup)
    expect((await done(st, 'abandon')).result.status).toBe('done')
  })
})
