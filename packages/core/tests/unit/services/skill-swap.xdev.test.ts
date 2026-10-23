/**
 * SMI-6531 (A1 step 4c): the cross-device `publishTree` and step 13's park of
 * the move source, with the state root on another filesystem (a real `EXDEV`:
 * `/dev/shm` against `os.tmpdir()`, `skill-swap.xdev.helpers.ts`).
 *
 *  - Q2: 10 runs end with `dest` complete with its sidecar, OP (holding the
 *    verified source) parked in ST's parked area, both copies printed, and no
 *    delete of a tree entry; 10 more with a source file edited after the copy
 *    and before the comparison keep the mismatching copy as `partial-copy`,
 *    redo the copy, and land the edit in `dest` before OP is parked.
 *  - T-P4 (cross-device half): the traced order.
 *  - T-X8 (swap half): writes through a descriptor opened in the old folder
 *    before the update, between the copy and the verification (partial-copy,
 *    redo) and after the verification (the write is in the parked copy, and
 *    the output names both copies); a source edit before the copy rewrites the
 *    sidecar.
 *
 * The control for Q2's edit hook (a port that skips the comparison leaves
 * `dest` without the edit) is `skill-swap.xdev.control.test.ts`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isParkIntentFor } from '../../../src/services/skill-swap.intent.js'
import { recordIdentity } from '../../../src/services/skill-swap.staging.js'
import { bindIdentity } from '../../../src/install/park-tree.identity.js'
import type { SwapOptions, SwapResult, TraceOp } from '../../../src/services/skill-swap.js'
import { ALL_DELETES, contentOf, indexLines, runSpied } from './skill-swap.abort.helpers.js'
import type { Event } from './skill-swap.abort.helpers.js'
import {
  areaOf,
  hashOf,
  isSubsequence,
  modify,
  OP_ID,
  plan,
  readRecord,
  useTmpCleanup,
} from './skill-swap.helpers.js'
import type { Fixture, Planned } from './skill-swap.helpers.js'
import {
  parkedCopies,
  partials,
  sidecarOf,
  treeDeletesX,
  useOtherDeviceCleanup,
  xdevFixture,
} from './skill-swap.xdev.helpers.js'

useTmpCleanup()
useOtherDeviceCleanup()

const FILES = { 'SKILL.md': '# v1\n', 'a.txt': 'a\n', 'sub/b.txt': 'b\n' }
const RUNS = 10

/** The traced steps of a spied run (its fs events left out). */
const traceOf = (events: Event[]): TraceOp[] => events.filter((e): e is TraceOp => !('fs' in e))

type Committed = Extract<SwapResult, { status: 'committed' }>
function committedOf(r: SwapResult): Committed {
  expect(r.status).toBe('committed')
  if (r.status !== 'committed') throw new Error('unreachable')
  return r
}

async function runXdev(options: SwapOptions = {}) {
  const fx = xdevFixture(FILES)
  const p = plan(fx, [modify('SKILL.md', '# v2\n')])
  const lines: string[] = []
  const run = await runSpied(p, ALL_DELETES, { stderr: (l) => lines.push(l), ...options })
  return { fx, p, lines, ...run }
}

/** The state Q2 and T-X8 require once a cross-device update finished. */
function assertMovedAndParked(fx: Fixture, p: Planned, r: Committed, lines: string[]) {
  const dest = path.join(areaOf(fx), OP_ID)
  expect(r.incomplete).toBeUndefined()
  expect(r.backupDest).toBe(dest)
  expect(fs.readFileSync(path.join(fx.realDir, 'SKILL.md'), 'utf8')).toBe('# v2\n')
  // dest complete with its sidecar, which names the tree's own hash.
  const side = sidecarOf(dest)
  expect(side).toMatchObject({ opId: OP_ID, kind: 'backup', treeHash: hashOf(dest) })
  expect(fs.existsSync(`${dest}.json.tmp`)).toBe(false)
  expect(fs.readdirSync(areaOf(fx)).filter((n) => n.startsWith('.tmp-'))).toEqual([])
  // OP is gone from staging, parked whole: the verified source and the intent.
  expect(fs.existsSync(fx.opDir)).toBe(false)
  const copies = parkedCopies(fx)
  expect(copies).toHaveLength(1)
  const copy = copies[0]!
  expect(r.extraCopy).toBe(copy)
  expect(fs.readdirSync(copy).sort()).toEqual(['old', 'park-intent.json'])
  const intent = JSON.parse(fs.readFileSync(path.join(copy, 'park-intent.json'), 'utf8'))
  const id = bindIdentity(copy)
  expect(id.ok && isParkIntentFor(intent, OP_ID, recordIdentity(id))).toBe(true)
  expect(intent.kind).toBe('move-source')
  expect(fs.existsSync(`${copy}.json`)).toBe(true)
  expect(indexLines(fx)).toEqual([expect.objectContaining({ kind: 'move-source', opId: OP_ID })])
  // Both copies printed, on one line (UD29).
  expect(lines).toEqual([
    `Update complete: backup at ${dest}; an extra copy of the old folder was moved aside at ${copy}.`,
  ])
  expect(r.warnings.filter((w) => w.code === 'removal-not-done')).toEqual([])
  return { dest, copy, pre: p.input.preTree }
}

describe('Q2: the cross-device move source parks', () => {
  it(`${RUNS} runs: dest complete with its sidecar, OP parked, both copies printed, nothing deleted`, async () => {
    for (let i = 0; i < RUNS; i++) {
      const { fx, p, result, lines, events } = await runXdev()
      const { dest, copy, pre } = assertMovedAndParked(fx, p, committedOf(result), lines)
      expect(hashOf(dest)).toBe(pre)
      expect(hashOf(path.join(copy, 'old'))).toBe(pre)
      expect(partials(areaOf(fx))).toEqual([])
      expect(treeDeletesX(fx, events)).toEqual([])
    }
  })

  it(`${RUNS} runs with a source file edited after the copy: partial-copy kept, copy redone, dest holds the edit before OP is parked`, async () => {
    for (let i = 0; i < RUNS; i++) {
      let fx: Fixture | null = null
      let edits = 0
      const edit = () => {
        if (edits++ > 0) return
        fs.appendFileSync(path.join(fx!.opDir, 'old', 'a.txt'), 'edited after the copy\n')
      }
      fx = xdevFixture(FILES)
      const p = plan(fx, [modify('SKILL.md', '# v2\n')])
      const lines: string[] = []
      const run = await runSpied(p, ALL_DELETES, {
        stderr: (l) => lines.push(l),
        hooks: { afterBackupCopy: edit },
      })
      const r = committedOf(run.result)
      const { dest, copy } = assertMovedAndParked(fx, p, r, lines)
      expect(contentOf(dest)['a.txt']).toBe('a\nedited after the copy\n')
      expect(contentOf(path.join(copy, 'old'))).toEqual(contentOf(dest))
      // The first copy, which missed the edit, is kept, never removed.
      const kept = partials(areaOf(fx))
      expect(kept).toHaveLength(1)
      expect(contentOf(kept[0]!)['a.txt']).toBe('a\n')
      expect(sidecarOf(kept[0]!)).toMatchObject({
        kind: 'partial-copy',
        sourceUnchanged: false,
        treeHash: hashOf(kept[0]!),
      })
      // dest was in place before the park ran.
      const at = (pred: (e: Event) => boolean) => run.events.findIndex(pred)
      const moved = at((e) => 'op' in e && e.op === 'rename' && e.dest === dest)
      const parked = at((e) => 'op' in e && e.op === 'park')
      expect(moved).toBeGreaterThan(-1)
      expect(parked).toBeGreaterThan(moved)
      expect(treeDeletesX(fx, run.events)).toEqual([])
    }
  })
})

describe('T-P4 (cross-device half): sync order', () => {
  it('temp made and synced, copied, verified, renamed, sync area; the intent; the record unlink, sync OP; then the park', async () => {
    const { fx, result, events } = await runXdev()
    const trace = traceOf(events)
    committedOf(result)
    const OP = fx.opDir
    const O = path.join(OP, 'old')
    const area = areaOf(fx)
    const dest = path.join(area, OP_ID)
    const temp = path.join(area, `.tmp-${OP_ID}`)
    const intent = path.join(OP, 'park-intent.json')
    const want = [
      { op: 'create', path: `${dest}.json.tmp` },
      { op: 'fsync', path: `${dest}.json.tmp` },
      { op: 'link', path: `${dest}.json.tmp`, dest: `${dest}.json` },
      { op: 'unlink', path: `${dest}.json.tmp` },
      { op: 'dirsync', path: area },
      { op: 'mkdir', path: temp },
      { op: 'dirsync', path: area },
      { op: 'copy', path: O, dest: temp },
      { op: 'compare', path: temp, equal: true },
      { op: 'rename', path: temp, dest },
      { op: 'dirsync', path: area },
      { op: 'create', path: `${intent}.tmp` },
      { op: 'fsync', path: `${intent}.tmp` },
      { op: 'link', path: `${intent}.tmp`, dest: intent },
      { op: 'unlink', path: `${intent}.tmp` },
      { op: 'dirsync', path: OP },
      { op: 'unlink', path: path.join(OP, 'record.json') },
      { op: 'dirsync', path: OP },
      { op: 'unlink', path: path.join(OP, 'owner.json') },
      { op: 'guard', path: OP },
      { op: 'park', path: OP, status: 'parked' },
    ] as const
    expect(isSubsequence(trace, [...want])).toEqual({ ok: true })
    // Nothing between the rename to dest and its area sync; O is never renamed out of OP.
    const r = trace.findIndex((t) => t.op === 'rename' && t.dest === dest)
    expect(trace[r + 1]).toEqual({ op: 'dirsync', path: area })
    expect(trace.filter((t) => t.op === 'rename' && t.path === O)).toEqual([])
    expect(trace.filter((t) => t.op === 'rmdir')).toEqual([])
  })
})

describe('T-X8 (swap half): writes through a descriptor opened before the update', () => {
  it('between the copy and the verification: the mismatching copy is kept as partial-copy and the copy redone', async () => {
    const fx0 = xdevFixture(FILES)
    const fd = fs.openSync(path.join(fx0.realDir, 'a.txt'), 'a')
    let n = 0
    const p = plan(fx0, [modify('SKILL.md', '# v2\n')])
    const lines: string[] = []
    try {
      const run = await runSpied(p, ALL_DELETES, {
        stderr: (l) => lines.push(l),
        hooks: { afterBackupCopy: () => void (n++ === 0 && fs.writeSync(fd, 'through the fd\n')) },
      })
      const r = committedOf(run.result)
      const { dest } = assertMovedAndParked(fx0, p, r, lines)
      expect(contentOf(dest)['a.txt']).toBe('a\nthrough the fd\n')
      expect(partials(areaOf(fx0))).toHaveLength(1)
      expect(treeDeletesX(fx0, run.events)).toEqual([])
    } finally {
      fs.closeSync(fd)
    }
  })

  it('after the verification: the write is in the parked copy, not in dest, and the output names both copies', async () => {
    const fx0 = xdevFixture(FILES)
    const fd = fs.openSync(path.join(fx0.realDir, 'a.txt'), 'a')
    const p = plan(fx0, [modify('SKILL.md', '# v2\n')])
    const lines: string[] = []
    try {
      const run = await runSpied(p, ALL_DELETES, {
        stderr: (l) => lines.push(l),
        hooks: { afterBackupVerify: () => void fs.writeSync(fd, 'after the verify\n') },
      })
      const r = committedOf(run.result)
      const { dest, copy } = assertMovedAndParked(fx0, p, r, lines)
      expect(contentOf(dest)['a.txt']).toBe('a\n')
      expect(fs.readFileSync(path.join(copy, 'old', 'a.txt'), 'utf8')).toBe('a\nafter the verify\n')
      expect(lines[0]).toContain(dest)
      expect(lines[0]).toContain(copy)
      expect(partials(areaOf(fx0))).toEqual([])
      expect(treeDeletesX(fx0, run.events)).toEqual([])
    } finally {
      fs.closeSync(fd)
    }
  })

  it('a source changed after its sidecar was hashed: the copy verifies and the sidecar is rewritten to its hash', async () => {
    const fx0 = xdevFixture(FILES)
    const p = plan(fx0, [modify('SKILL.md', '# v2\n')])
    const lines: string[] = []
    const run = await runSpied(p, ALL_DELETES, {
      stderr: (l) => lines.push(l),
      hooks: {
        afterSidecar: () => fs.appendFileSync(path.join(fx0.opDir, 'old', 'a.txt'), 'late\n'),
      },
    })
    const r = committedOf(run.result)
    const { dest } = assertMovedAndParked(fx0, p, r, lines)
    expect(contentOf(dest)['a.txt']).toBe('a\nlate\n')
    expect(hashOf(dest)).not.toBe(p.input.preTree)
    expect(r.warnings).toContainEqual({ code: 'backup-holds-foreign-change', backup: dest })
    expect(partials(areaOf(fx0))).toEqual([])
    // The rewrite: the old sidecar unlinked only after the new one's temp was synced.
    const sidecar = `${dest}.json`
    expect(
      isSubsequence(traceOf(run.events), [
        { op: 'link', dest: sidecar },
        { op: 'compare', equal: true },
        { op: 'create', path: `${sidecar}.tmp` },
        { op: 'fsync', path: `${sidecar}.tmp` },
        { op: 'unlink', path: sidecar },
        { op: 'link', path: `${sidecar}.tmp`, dest: sidecar },
        { op: 'unlink', path: `${sidecar}.tmp` },
        { op: 'rename', dest },
      ])
    ).toEqual({ ok: true })
    // Its one delete is that metadata unlink; no tree entry is deleted.
    expect(treeDeletesX(fx0, run.events)).toEqual([])
    expect(run.events.filter((e) => 'fs' in e && e.path === sidecar)).toHaveLength(1)
  })
})

describe('the record across devices', () => {
  it('is kept until the verified copy is at dest: a stop after the verification leaves it, O in OP', async () => {
    const fx0 = xdevFixture(FILES)
    const p = plan(fx0, [modify('SKILL.md', '# v2\n')])
    const dest = path.join(areaOf(fx0), OP_ID)
    const { result } = await runSpied(p, ALL_DELETES, {
      // Something takes the fixed name after the copy verified (UD38).
      hooks: { afterBackupVerify: () => fs.mkdirSync(dest) },
    })
    const r = committedOf(result)
    expect(r).toMatchObject({
      incomplete: { step: 'publish', reason: 'backup-unsafe' },
      recordPath: path.join(fx0.opDir, 'record.json'),
    })
    readRecord(path.join(fx0.opDir, 'record.json'))
    expect(hashOf(path.join(fx0.opDir, 'old'))).toBe(p.input.preTree)
    // The verified temp stays in the area (P3), and the planted entry is untouched.
    expect(hashOf(path.join(areaOf(fx0), `.tmp-${OP_ID}`))).toBe(p.input.preTree)
    expect(fs.readdirSync(dest)).toEqual([])
  })
})

describe('step 13 across devices: OP holds exactly what this run wrote (UD40)', () => {
  it('a stray entry before the intent stops with the record kept, nothing unlinked, no intent written', async () => {
    const fx0 = xdevFixture(FILES)
    const p = plan(fx0, [modify('SKILL.md', '# v2\n')])
    const { result, events } = await runSpied(p, ALL_DELETES, {
      hooks: { afterBackupMove: () => fs.writeFileSync(path.join(fx0.opDir, 'stray.txt'), 's') },
    })
    const r = committedOf(result)
    expect(r).toMatchObject({
      incomplete: { step: 'cleanup', reason: 'op-not-empty' },
      recordPath: path.join(fx0.opDir, 'record.json'),
    })
    expect(fs.readdirSync(fx0.opDir).sort()).toEqual([
      'old',
      'owner.json',
      'record.json',
      'stray.txt',
    ])
    readRecord(path.join(fx0.opDir, 'record.json'))
    // The move itself is complete: dest verified, the source still in OP.
    expect(hashOf(path.join(areaOf(fx0), OP_ID))).toBe(p.input.preTree)
    expect(hashOf(path.join(fx0.opDir, 'old'))).toBe(p.input.preTree)
    expect(parkedCopies(fx0)).toEqual([])
    expect(treeDeletesX(fx0, events)).toEqual([])
  })
})

describe('a source that changes during both copies', () => {
  it('keeps both copies as partial-copy and stops write-failed with the record kept, never a third copy', async () => {
    const fx0 = xdevFixture(FILES)
    const p = plan(fx0, [modify('SKILL.md', '# v2\n')])
    let copies = 0
    const { result, events } = await runSpied(p, ALL_DELETES, {
      hooks: {
        afterBackupCopy: () =>
          fs.appendFileSync(path.join(fx0.opDir, 'old', 'a.txt'), `edit ${++copies}\n`),
      },
    })
    expect(copies).toBe(2)
    const r = committedOf(result)
    expect(r).toMatchObject({
      incomplete: { step: 'publish', reason: 'write-failed' },
      recordPath: path.join(fx0.opDir, 'record.json'),
    })
    readRecord(path.join(fx0.opDir, 'record.json'))
    const kept = partials(areaOf(fx0))
    expect(kept).toHaveLength(2)
    expect(kept.map((k) => sidecarOf(k).sourceUnchanged)).toEqual([false, false])
    expect(contentOf(kept[1]!)['a.txt']).toBe('a\nedit 1\n')
    expect(fs.readFileSync(path.join(fx0.opDir, 'old', 'a.txt'), 'utf8')).toBe(
      'a\nedit 1\nedit 2\n'
    )
    expect(fs.existsSync(path.join(areaOf(fx0), OP_ID))).toBe(false)
    expect(parkedCopies(fx0)).toEqual([])
    expect(treeDeletesX(fx0, events)).toEqual([])
  })
})
