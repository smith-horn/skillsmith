/**
 * SMI-6531 (A1 step 6a-iii): doctor finishes a cross-device keep from every
 * state the update's own step 12 can stop in (T-J9's cross-device states,
 * T-X8's doctor half, T-J13's cross-device half, T-R1's cross-device
 * `--apply`).
 *
 * Each state is a real update with the state root on another device, stopped
 * at one `publishTree` boundary after the commit and the audit (S3 with O's
 * keep started). Every case asserts: the plan names the expected sub-state;
 * `--apply` finishes with the old folder at `<area>/<opId>` with its sidecar
 * (tree hash equal to the copy), the new folder and `postEntry` in place, any
 * copy temp that was not the source kept as `partial-copy`, the op dir parked
 * whole holding the verified source and a `move-source` intent, no file
 * content lost, and no `unlink` or `rmdir` of a tree entry (the delete spy,
 * beside a presence assertion that it recorded metadata deletes).
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { bindIdentity } from '../../../../src/install/park-tree.identity.js'
import { isParkIntentFor } from '../../../../src/services/skill-swap.intent.js'
import { recordIdentity } from '../../../../src/services/skill-swap.staging.js'
import { deletesOf } from '../skill-swap.abort.helpers.js'
import { areaOf, hashOf, OP_ID, useTmpCleanup } from '../skill-swap.helpers.js'
import { useOtherDeviceCleanup, useStubs, errnoError } from '../skill-swap.xdev.helpers.js'
import { opReport, POST, PRE, s1, s2 } from './recovery.helpers.js'
import type { State } from './recovery.helpers.js'
import { act, auditLines, entryOf } from './recovery.act.helpers.js'
import {
  actSpied,
  backupOf,
  contentSet,
  copyTemp,
  killed,
  nothingLost,
  partialTrees,
  theParkedCopy,
  treeDeletesDoctor,
  xfile,
  xs3,
} from './recovery.xdev.helpers.js'

useTmpCleanup()
useOtherDeviceCleanup()
const stub = useStubs()

/** A mid-copy ENOSPC: the update marks its record and leaves the temp at its name (P2). */
function throwNoSpace(): never {
  throw errnoError('ENOSPC')
}

/** The sub-state the listing names for O's keep. */
async function oState(st: State): Promise<string | null> {
  const op = await opReport(st)
  if (op.cls.kind !== 'state') throw new Error(`not a row: ${op.label}`)
  const g = op.cls.facts.groups.find((x) => x.base === st.opId)
  return g?.state ?? null
}

/** Everything a finished cross-device `--apply` must leave (the module comment). */
function assertFinished(st: State, oldHash: string, a: Awaited<ReturnType<typeof actSpied>>) {
  expect(a.result.status, JSON.stringify(a.result).slice(0, 400)).toBe('done')
  if (a.result.status !== 'done') return
  const fx = st.fx
  const dest = backupOf(fx)
  expect(hashOf(dest)).toBe(oldHash)
  const sidecar = JSON.parse(fs.readFileSync(`${dest}.json`, 'utf8')) as Record<string, unknown>
  expect(sidecar).toMatchObject({ kind: 'backup', opId: OP_ID, treeHash: oldHash })
  expect(fs.existsSync(`${dest}.json.tmp`)).toBe(false)
  expect(fs.existsSync(copyTemp(fx))).toBe(false)
  expect(fs.readFileSync(path.join(fx.realDir, 'SKILL.md'), 'utf8')).toBe('# v2\n')
  expect(entryOf(fx)).toEqual(POST)
  // The update's own audit line went to its in-memory journal, so doctor appended one.
  expect(auditLines(fx, OP_ID)).toBe(1)
  // The op dir is parked whole: the verified source and a verifying move-source intent.
  expect(fs.existsSync(st.opDir)).toBe(false)
  const parked = theParkedCopy(fx)
  expect(a.result.extraCopy).toBe(parked)
  expect(fs.readdirSync(parked).sort()).toEqual(['old', 'park-intent.json'])
  expect(hashOf(path.join(parked, 'old'))).toBe(oldHash)
  const intent = JSON.parse(fs.readFileSync(path.join(parked, 'park-intent.json'), 'utf8'))
  const id = bindIdentity(parked)
  expect(id.ok && isParkIntentFor(intent, OP_ID, recordIdentity(id))).toBe(true)
  expect(intent.kind).toBe('move-source')
  // No tree entry deleted, and the spy did see the metadata deletes.
  expect(deletesOf(a.events).map((e) => e.path)).toContain(path.join(st.opDir, 'record.json'))
  expect(treeDeletesDoctor(fx, a.events)).toEqual([])
  expect(a.result.warnings.filter((w) => w.code === 'removal-not-done')).toEqual([])
}

type Options = Parameters<typeof xs3>[0]
const at = (point: string): Options => ({ hooks: { [point]: () => killed(point) } })

/** [label, the sub-state the plan names, how step 12 stopped, partial-copies afterwards] */
const STATES: Array<[string, string, Options, number]> = [
  // The sidecar's temp is complete and this op's, so the plan names the rewrite's R2 shape.
  ['sidecar temp written, not yet linked', 'R2', at('afterSidecarTemp'), 0],
  ['sidecar published', 'P1', at('afterSidecar'), 0],
  [
    'mid-copy (the temp holds part of the tree)',
    'P2',
    { duringBackupCopy: () => killed('mid-copy') },
    1,
  ],
  ['copy complete, not yet compared', 'P3', at('afterBackupCopy'), 0],
  ['copy verified, not yet renamed', 'P3', at('afterBackupVerify'), 0],
  ['temp renamed to dest and the area synced', 'P4', at('afterBackupMove'), 0],
]

describe('T-J9 / T-X8: --apply finishes every cross-device step-12 state', () => {
  for (const [label, sub, options, partials] of STATES) {
    it(`${label}: classified ${sub}, then finished, the op dir parked`, async () => {
      const st = await xs3(options)
      const oldHash = st.p.input.preTree
      expect(await oState(st)).toBe(sub)
      const before = contentSet(st.fx.skillsDir, st.fx.stateRoot)
      const a = await actSpied(st, 'apply')
      assertFinished(st, oldHash, a)
      expect(partialTrees(st.fx)).toHaveLength(partials)
      nothingLost(before, contentSet(st.fx.skillsDir, st.fx.stateRoot))
    })
  }
})

describe('the cross-device sidecar-rewrite pair (the source changed after its sidecar)', () => {
  /** O edited after its sidecar was hashed: the copy verifies against the edit, so step 12 rewrites the sidecar. */
  const editO = (opDir: string) => () =>
    fs.writeFileSync(path.join(opDir, 'old', 'a.txt'), 'O edited after its sidecar\n')

  /** Finishes a rewrite-pair state: the sidecar names the edited O, the copy is renamed into place. */
  async function finishPair(st: State, sub: string) {
    expect(fs.existsSync(copyTemp(st.fx))).toBe(true)
    const oHash = hashOf(path.join(st.opDir, 'old'))
    expect(oHash).not.toBe(st.p.input.preTree)
    expect(hashOf(copyTemp(st.fx))).toBe(oHash)
    expect(await oState(st)).toBe(sub)
    const a = await actSpied(st, 'apply')
    assertFinished(st, oHash, a)
    expect(partialTrees(st.fx)).toEqual([])
    if (a.result.status === 'done') {
      expect(a.result.warnings.map((w) => w.code)).toContain('backup-holds-foreign-change')
    }
  }

  it('R2: killed with the old sidecar unlinked (only <dest>.json.tmp and the verified copy temp)', async () => {
    const fx = xfile()
    const st = await xs3(
      { hooks: { afterSidecar: editO(fx.opDir), afterSidecarUnlink: () => killed('unlinked') } },
      fx
    )
    expect(fs.existsSync(`${backupOf(fx)}.json`)).toBe(false)
    expect(fs.existsSync(`${backupOf(fx)}.json.tmp`)).toBe(true)
    await finishPair(st, 'R2')
  })

  /** The `nth` unlink `match` accepts fails EIO, until `stop`. */
  function failUnlink(match: (p: string) => boolean, nth = 1): { stop: () => void } {
    let blocking = true
    let seen = 0
    stub(fs.promises, 'unlink', (orig) => async (...a: unknown[]) => {
      if (blocking && match(String(a[0])) && ++seen === nth) throw errnoError('EIO')
      return orig(...a)
    })
    return { stop: () => void (blocking = false) }
  }

  it('R1: the old sidecar could not be unlinked (both sidecars and the verified copy temp)', async () => {
    const fx = xfile()
    const dest = backupOf(fx)
    const f = failUnlink((p) => p === `${dest}.json` && fs.existsSync(`${dest}.json.tmp`))
    const st = await xs3({ hooks: { afterSidecar: editO(fx.opDir) } }, fx)
    f.stop()
    expect(fs.existsSync(`${dest}.json`)).toBe(true)
    expect(fs.existsSync(`${dest}.json.tmp`)).toBe(true)
    await finishPair(st, 'R1')
  })

  it('R3: the new sidecar linked, its temp not unlinked (one inode at both names)', async () => {
    const fx = xfile()
    const dest = backupOf(fx)
    // The first unlink of the temp is the first publish's; the second is the rewrite's.
    const f = failUnlink((p) => p === `${dest}.json.tmp`, 2)
    const st = await xs3({ hooks: { afterSidecar: editO(fx.opDir) } }, fx)
    f.stop()
    expect(fs.lstatSync(`${dest}.json`).ino).toBe(fs.lstatSync(`${dest}.json.tmp`).ino)
    await finishPair(st, 'R3')
  })
})

describe('T-X8 (Sol): a copy temp edited after its copy is P2, kept as partial-copy, never parked as the backup', () => {
  it('the edited temp is kept whole, the copy is redone, dest equals the source', async () => {
    const st = await xs3({ hooks: { afterBackupVerify: () => killed('afterBackupVerify') } })
    const temp = copyTemp(st.fx)
    fs.writeFileSync(path.join(temp, 'a.txt'), 'edited in the copy temp\n')
    expect(await oState(st)).toBe('P2')
    const before = contentSet(st.fx.skillsDir, st.fx.stateRoot)
    const a = await actSpied(st, 'apply')
    assertFinished(st, st.p.input.preTree, a)
    const kept = partialTrees(st.fx)
    expect(kept).toHaveLength(1)
    expect(fs.readFileSync(path.join(kept[0]!, 'a.txt'), 'utf8')).toBe('edited in the copy temp\n')
    const ps = JSON.parse(fs.readFileSync(`${kept[0]}.json`, 'utf8')) as Record<string, unknown>
    // Governance S3 (plan §3.5): the temp holds bytes the source never had, so it is not
    // unchanged. This assertion pinned true before the subset rule; it now pins false.
    expect(ps).toMatchObject({
      kind: 'partial-copy',
      sourceUnchanged: false,
      partialCause: 'mismatch',
    })
    if (a.result.status === 'done') {
      expect(a.result.kept).toContainEqual({ tree: 'O', kind: 'partial-copy', path: kept[0] })
    }
    nothingLost(before, contentSet(st.fx.skillsDir, st.fx.stateRoot))
  })
})

describe("T5: a P2 temp's sourceUnchanged and partialCause (governance S3, plan §3.5)", () => {
  /** The kept partial's sidecar after --apply on a P2 made by `options`, with `edit` run first. */
  async function keptPartial(options: Options, edit?: (st: State) => void) {
    const st = await xs3(options)
    expect(await oState(st)).toBe('P2')
    edit?.(st)
    const a = await actSpied(st, 'apply')
    expect(a.result.status).toBe('done')
    const kept = partialTrees(st.fx)
    expect(kept).toHaveLength(1)
    return JSON.parse(fs.readFileSync(`${kept[0]}.json`, 'utf8')) as Record<string, unknown>
  }

  it('a mid-copy kill: the temp is a subset of an unchanged source, so true', async () => {
    const ps = await keptPartial({ duringBackupCopy: () => killed('mid-copy') })
    expect(ps).toMatchObject({ sourceUnchanged: true, partialCause: 'mismatch' })
  })

  it('the source edited after its sidecar: false (the pair of the case above)', async () => {
    const ps = await keptPartial({ duringBackupCopy: () => killed('mid-copy') }, (st) =>
      fs.writeFileSync(path.join(st.opDir, 'old', 'a.txt'), 'O edited after the copy began\n')
    )
    expect(ps).toMatchObject({ sourceUnchanged: false, partialCause: 'mismatch' })
  })

  it("a copy stopped by ENOSPC: the record's marker names this dest, so partialCause enospc", async () => {
    const ps = await keptPartial({ duringBackupCopy: () => throwNoSpace() })
    expect(ps).toMatchObject({ sourceUnchanged: true, partialCause: 'enospc' })
  })
})

describe('P4 with the source changed after the copy is anything else (plan §3.3 P4)', () => {
  it('--apply is not offered and nothing changes; the unchanged P4 is offered (the pair)', async () => {
    const st = await xs3({ hooks: { afterBackupMove: () => killed('afterBackupMove') } })
    expect(await oState(st)).toBe('P4')
    fs.writeFileSync(path.join(st.opDir, 'old', 'a.txt'), 'edited after the copy\n')
    const op = await opReport(st)
    expect(op.cls.kind).toBe('anything-else')
    const area = fs.readdirSync(areaOf(st.fx)).sort()
    const a = await act(st, 'apply')
    expect(a.result).toMatchObject({ status: 'refused', reason: 'recovery-not-offered' })
    expect(fs.readdirSync(areaOf(st.fx)).sort()).toEqual(area)
    expect(fs.existsSync(path.join(st.opDir, 'record.json'))).toBe(true)
  })
})

describe('T-J13 (cross-device): another operation in the same area is untouched', () => {
  it("every new name carries this opId; the other op's entries stay byte-identical", async () => {
    const st = await xs3({ hooks: { afterSidecar: () => killed('afterSidecar') } })
    const area = areaOf(st.fx)
    const other = 'b'.repeat(32)
    fs.mkdirSync(path.join(area, other))
    fs.writeFileSync(path.join(area, other, 'x.txt'), 'other op\n')
    fs.writeFileSync(path.join(area, `${other}.json`), '{"opId":"other"}\n')
    fs.mkdirSync(path.join(area, `.tmp-${other}`))
    const snap = (): string =>
      [other, `${other}.json`, `.tmp-${other}`, path.join(other, 'x.txt')]
        .map((n) => {
          const p = path.join(area, n)
          const s = fs.lstatSync(p)
          return `${n} ${s.ino} ${s.isFile() ? fs.readFileSync(p, 'utf8') : 'dir'}`
        })
        .join('\n')
    const before = snap()
    const names0 = new Set(fs.readdirSync(area))
    const a = await actSpied(st, 'apply')
    assertFinished(st, st.p.input.preTree, a)
    expect(snap()).toBe(before)
    const added = fs.readdirSync(area).filter((n) => !names0.has(n))
    for (const n of added) expect(n.startsWith(OP_ID) || n.startsWith(`.tmp-${OP_ID}`)).toBe(true)
  })
})

describe('T-R1 (cross-device): the committed entry is the canonical postEntry', () => {
  it('S2 across devices --apply commits postEntry, keeps O across devices and parks the op dir', async () => {
    const st = await s2(xfile())
    const a = await actSpied(st, 'apply')
    expect(a.result.status).toBe('done')
    expect(entryOf(st.fx)).toEqual(POST)
    expect(hashOf(backupOf(st.fx))).toBe(st.p.input.preTree)
    expect(theParkedCopy(st.fx)).toBeTruthy()
    expect(treeDeletesDoctor(st.fx, a.events)).toEqual([])
    expect(auditLines(st.fx, OP_ID)).toBe(1)
  })
})

describe('T8: S1 across devices, --apply and --undo', () => {
  it('--apply: N installed, postEntry committed, O kept across devices, the op dir parked', async () => {
    const st = await s1(xfile())
    const a = await actSpied(st, 'apply')
    expect(a.result.status).toBe('done')
    expect(fs.readFileSync(path.join(st.fx.realDir, 'SKILL.md'), 'utf8')).toBe('# staged\n')
    expect(entryOf(st.fx)).toEqual(POST)
    expect(hashOf(backupOf(st.fx))).toBe(st.p.input.preTree)
    expect(fs.readdirSync(theParkedCopy(st.fx)).sort()).toEqual(['old', 'park-intent.json'])
    expect(treeDeletesDoctor(st.fx, a.events)).toEqual([])
  })

  it('--undo: O installed, preEntry kept, N kept as unused-new across devices, the op dir parked', async () => {
    const st = await s1(xfile())
    const nHash = hashOf(path.join(st.opDir, 'new'))
    const a = await actSpied(st, 'undo')
    expect(a.result.status).toBe('done')
    expect(hashOf(st.fx.realDir)).toBe(st.p.input.preTree)
    expect(entryOf(st.fx)).toEqual(PRE)
    expect(hashOf(path.join(areaOf(st.fx), `${OP_ID}.unused-new`))).toBe(nHash)
    expect(fs.readdirSync(theParkedCopy(st.fx)).sort()).toEqual(['new', 'park-intent.json'])
    expect(treeDeletesDoctor(st.fx, a.events)).toEqual([])
  })
})
