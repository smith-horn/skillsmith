/**
 * SMI-6531 (A1 step 6a-ii): T-P4 and T-P5 for doctor's one-device sequences
 * (design § 5). T-P4: each action's own trace holds its sequence in order.
 * T-P5: the crashed transaction's trace, then doctor's, replayed through the
 * power-loss model (`skill-swap.powerloss.ts`): no crash point, during the
 * crash or during the repair, loses a tree or leaves a change without a
 * durable record. Controls: the S1 `--apply` sync of R after the install
 * dropped, and the finish's record unlink moved before the keep, each fail.
 *
 * S0, UN1 and UN2 are made from a real crash plus the transaction's own moves
 * (as `recovery.helpers.ts` does); those moves are appended to the crashed
 * trace as the events the undo makes, with their syncs.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TraceOp } from '../../../../src/services/skill-swap.types.js'
import {
  areaOf,
  isSubsequence,
  makeFixture,
  modify,
  OP_ID,
  plan,
  run,
  useTmpCleanup,
} from '../skill-swap.helpers.js'
import type { Fixture } from '../skill-swap.helpers.js'
import { replay } from '../skill-swap.powerloss.js'
import type { ModelPaths } from '../skill-swap.powerloss.js'
import { keepTree, syncManifest } from './recovery.helpers.js'
import type { State } from './recovery.helpers.js'
import { act, done, killAt } from './recovery.act.helpers.js'

useTmpCleanup()

type Crash = 'S0' | 'S1' | 'S2' | 'S3' | 'UN1' | 'UN2'

/** A real crash in state `c`, with the crashed run's trace (plus the undo's own moves). */
async function crashed(c: Crash): Promise<{ st: State; trace: TraceOp[] }> {
  const fx = makeFixture({ 'SKILL.md': '# v1\n', 'docs/a.md': 'a\n' })
  const p = plan(fx, [modify('SKILL.md', '# v2\n')])
  const stop = (): never => {
    throw new Error('killed')
  }
  const options =
    c === 'S1' || c === 'S0'
      ? { hooks: { afterRename1Syncs: stop } }
      : c === 'S3'
        ? {
            appendJournal: async () => {
              throw new Error('ENOSPC')
            },
          }
        : {}
  if (c === 'S2' || c === 'UN1' || c === 'UN2') p.manifest.preCommitError = new Error('lost')
  const r = await run(p, options)
  const st: State = { fx, p, opId: OP_ID, opDir: fx.opDir }
  syncManifest(st)
  const trace = [...r.trace]
  const root = fs.realpathSync(fx.skillsDir)
  const old = path.join(fx.opDir, 'old')
  const move = (from: string, to: string, first: string, second: string): void => {
    fs.renameSync(from, to)
    trace.push({ op: 'rename', path: from, dest: to }, { op: 'dirsync', path: first })
    trace.push({ op: 'dirsync', path: second })
  }
  if (c === 'S0') move(old, fx.realDir, root, fx.opDir)
  if (c === 'UN1' || c === 'UN2') move(fx.realDir, path.join(fx.opDir, 'undone'), fx.opDir, root)
  if (c === 'UN2') move(old, fx.realDir, root, fx.opDir)
  return { st, trace }
}

const pathsOf = (fx: Fixture): ModelPaths => ({
  realDir: fx.realDir,
  staging: fx.staging,
  opDir: fx.opDir,
  backupDest: path.join(areaOf(fx), OP_ID),
})

/** The keep of `src` as `dest` (sidecar first, then the move), as T-P4 states it. */
function keepSeq(fx: Fixture, src: string, dest: string) {
  const area = areaOf(fx)
  return [
    { op: 'create' as const, path: `${dest}.json.tmp` },
    { op: 'fsync' as const, path: `${dest}.json.tmp` },
    { op: 'link' as const, path: `${dest}.json.tmp`, dest: `${dest}.json` },
    { op: 'unlink' as const, path: `${dest}.json.tmp` },
    { op: 'dirsync' as const, path: area },
    { op: 'rename' as const, path: src, dest },
    { op: 'dirsync' as const, path: area },
    { op: 'dirsync' as const, path: fx.opDir },
  ]
}

/** The one-device finish: owner, sync OP, then the record last, sync OP, rmdir OP, sync ST. */
function finishSeq(fx: Fixture) {
  return [
    { op: 'unlink' as const, path: path.join(fx.opDir, 'owner.json') },
    { op: 'dirsync' as const, path: fx.opDir },
    { op: 'unlink' as const, path: path.join(fx.opDir, 'record.json') },
    { op: 'dirsync' as const, path: fx.opDir },
    { op: 'rmdir' as const, path: fx.opDir },
    { op: 'dirsync' as const, path: fx.staging },
  ]
}

/** Claim T, sync R, rename `src` over it, sync R, sync OP. */
function installSeq(fx: Fixture, src: string) {
  const root = fs.realpathSync(fx.skillsDir)
  return [
    { op: 'mkdir' as const, path: fx.realDir },
    { op: 'dirsync' as const, path: root },
    { op: 'rename' as const, path: src, dest: fx.realDir },
    { op: 'dirsync' as const, path: root },
    { op: 'dirsync' as const, path: fx.opDir },
  ]
}

type Want = (fx: Fixture) => Array<Partial<TraceOp> & { op: TraceOp['op'] }>
const area = (fx: Fixture, base: string) => path.join(areaOf(fx), base)
const op = (fx: Fixture, n: string) => path.join(fx.opDir, n)
const manifestWrite = (fx: Fixture) => ({
  op: 'manifest-write' as const,
  path: path.join(fx.stateRoot, 'manifest.json'),
})
const journal = { op: 'journal-append' as const, path: OP_ID }

const SEQUENCES: Array<[Crash, 'apply' | 'undo', Want]> = [
  [
    'S1',
    'apply',
    (fx) => [
      ...installSeq(fx, op(fx, 'new')),
      manifestWrite(fx),
      journal,
      ...keepSeq(fx, op(fx, 'old'), area(fx, OP_ID)),
      ...finishSeq(fx),
    ],
  ],
  [
    'S2',
    'apply',
    (fx) => [
      manifestWrite(fx),
      journal,
      ...keepSeq(fx, op(fx, 'old'), area(fx, OP_ID)),
      ...finishSeq(fx),
    ],
  ],
  [
    'S3',
    'apply',
    (fx) => [journal, ...keepSeq(fx, op(fx, 'old'), area(fx, OP_ID)), ...finishSeq(fx)],
  ],
  [
    'S1',
    'undo',
    (fx) => [
      ...installSeq(fx, op(fx, 'old')),
      ...keepSeq(fx, op(fx, 'new'), area(fx, `${OP_ID}.unused-new`)),
      ...finishSeq(fx),
    ],
  ],
  [
    'S2',
    'undo',
    (fx) => [
      { op: 'rename', path: fx.realDir, dest: op(fx, 'undone') },
      { op: 'dirsync', path: fx.opDir },
      { op: 'dirsync', path: fs.realpathSync(fx.skillsDir) },
      ...installSeq(fx, op(fx, 'old')),
      ...keepSeq(fx, op(fx, 'undone'), area(fx, `${OP_ID}.undone`)),
      ...finishSeq(fx),
    ],
  ],
  [
    'UN1',
    'apply',
    (fx) => [
      ...installSeq(fx, op(fx, 'old')),
      ...keepSeq(fx, op(fx, 'undone'), area(fx, `${OP_ID}.undone`)),
      ...finishSeq(fx),
    ],
  ],
  [
    'UN2',
    'apply',
    (fx) => [...keepSeq(fx, op(fx, 'undone'), area(fx, `${OP_ID}.undone`)), ...finishSeq(fx)],
  ],
  [
    'S0',
    'apply',
    (fx) => [...keepSeq(fx, op(fx, 'new'), area(fx, `${OP_ID}.unused-new`)), ...finishSeq(fx)],
  ],
]

describe('T-P4: each doctor sequence is in its order', () => {
  for (const [c, action, want] of SEQUENCES) {
    it(`${c} --${action}`, async () => {
      const { st } = await crashed(c)
      const a = await done(st, action)
      expect(isSubsequence(a.trace, want(st.fx))).toEqual({ ok: true })
    })
  }
})

describe('T-P4: the finish syncs OP between the other metadata and the record', () => {
  it('the dirsync of OP falls between the owner.json unlink and the record.json unlink', async () => {
    const { st } = await crashed('S2')
    const a = await done(st, 'apply')
    const owner = a.trace.findIndex(
      (t) => t.op === 'unlink' && t.path === path.join(st.opDir, 'owner.json')
    )
    const rec = a.trace.findIndex(
      (t) => t.op === 'unlink' && t.path === path.join(st.opDir, 'record.json')
    )
    expect(owner).toBeGreaterThan(-1)
    expect(rec).toBeGreaterThan(owner)
    const between = a.trace.slice(owner + 1, rec)
    expect(between).toContainEqual({ op: 'dirsync', path: st.opDir })
  })
})

describe('T-P4: the publish resume sequences (P0, P1 with a rewrite, R1, R2, R3)', () => {
  /** S3 with O's keep at P1 and O edited, so the resume rewrites the sidecar. */
  async function p1(): Promise<State> {
    const { st } = await crashed('S3')
    keepTree(st, 'old', 'backup', { move: false })
    fs.writeFileSync(path.join(st.opDir, 'old', 'SKILL.md'), '# O edited\n')
    return st
  }
  const move = (fx: Fixture) => [
    { op: 'rename' as const, path: op(fx, 'old'), dest: area(fx, OP_ID) },
    { op: 'dirsync' as const, path: areaOf(fx) },
    { op: 'dirsync' as const, path: fx.opDir },
  ]
  const side = (fx: Fixture) => `${area(fx, OP_ID)}.json`

  it('P1 with a changed source: temp synced, area, old unlinked, link, area, temp unlinked, area, move', async () => {
    const st = await p1()
    const a = await done(st, 'apply')
    const fx = st.fx
    expect(
      isSubsequence(a.trace, [
        { op: 'create', path: `${side(fx)}.tmp` },
        { op: 'fsync', path: `${side(fx)}.tmp` },
        { op: 'dirsync', path: areaOf(fx) },
        { op: 'unlink', path: side(fx) },
        { op: 'link', path: `${side(fx)}.tmp`, dest: side(fx) },
        { op: 'dirsync', path: areaOf(fx) },
        { op: 'unlink', path: `${side(fx)}.tmp` },
        { op: 'dirsync', path: areaOf(fx) },
        ...move(fx),
      ])
    ).toEqual({ ok: true })
  })

  const RESUMES: Array<
    [
      string,
      'afterRewriteTempSync' | 'afterSidecarUnlink' | 'afterRewriteLink',
      (fx: Fixture) => Array<Partial<TraceOp> & { op: TraceOp['op'] }>,
    ]
  > = [
    [
      'R1: unlink old, link, area, unlink temp, area, then the move',
      'afterRewriteTempSync',
      (fx) => [
        { op: 'unlink', path: side(fx) },
        { op: 'link', path: `${side(fx)}.tmp`, dest: side(fx) },
        { op: 'dirsync', path: areaOf(fx) },
        { op: 'unlink', path: `${side(fx)}.tmp` },
        { op: 'dirsync', path: areaOf(fx) },
        ...move(fx),
      ],
    ],
    [
      'R2: link, area, unlink temp, area, then the move',
      'afterSidecarUnlink',
      (fx) => [
        { op: 'link', path: `${side(fx)}.tmp`, dest: side(fx) },
        { op: 'dirsync', path: areaOf(fx) },
        { op: 'unlink', path: `${side(fx)}.tmp` },
        { op: 'dirsync', path: areaOf(fx) },
        ...move(fx),
      ],
    ],
    [
      'R3: unlink temp, area, then the move',
      'afterRewriteLink',
      (fx) => [
        { op: 'unlink', path: `${side(fx)}.tmp` },
        { op: 'dirsync', path: areaOf(fx) },
        ...move(fx),
      ],
    ],
  ]
  for (const [name, kill, want] of RESUMES) {
    it(name, async () => {
      const st = await p1()
      const first = await act(st, 'apply', {}, killAt(kill))
      expect(first.result.status).toBe('stopped')
      const a = await done(st, 'apply')
      expect(isSubsequence(a.trace, want(st.fx))).toEqual({ ok: true })
      expect(a.trace.some((t) => t.op === 'create' && t.path === `${side(st.fx)}.tmp`)).toBe(false)
    })
  }

  it('P0: the provable temp unlinked and the area synced, then the keep from its start', async () => {
    const { st } = await crashed('S3')
    fs.mkdirSync(areaOf(st.fx), { recursive: true })
    fs.writeFileSync(`${side(st.fx)}.tmp`, '')
    const a = await done(st, 'apply')
    const fx = st.fx
    expect(
      isSubsequence(a.trace, [
        { op: 'unlink', path: `${side(fx)}.tmp` },
        { op: 'dirsync', path: areaOf(fx) },
        ...keepSeq(fx, op(fx, 'old'), area(fx, OP_ID)),
      ])
    ).toEqual({ ok: true })
  })
})

describe('T-P5: the crash and the repair, replayed, survive every crash point', () => {
  for (const [c, action] of SEQUENCES) {
    it(`${c} --${action}`, async () => {
      const { st, trace } = await crashed(c)
      const a = await done(st, action)
      expect(a.trace.filter((t) => t.op === 'dirsync').length).toBeGreaterThan(3)
      const all = [...trace, ...a.trace]
      expect(replay(all, pathsOf(st.fx))).toEqual({ ok: true, points: all.length + 1 })
    })
  }

  it('control: S1 --apply without the sync of R after the install fails the model', async () => {
    const { st, trace } = await crashed('S1')
    const a = await done(st, 'apply')
    const root = fs.realpathSync(st.fx.skillsDir)
    const i = a.trace.findIndex((t) => t.op === 'rename' && t.dest === st.fx.realDir)
    expect(a.trace[i + 1]).toEqual({ op: 'dirsync', path: root })
    const mutated = [...trace, ...a.trace.slice(0, i + 1), ...a.trace.slice(i + 2)]
    expect(replay(mutated, pathsOf(st.fx)).ok).toBe(false)
  })

  it('control: S2 --apply with the record unlinked (and OP synced) before the keep fails', async () => {
    const { st, trace } = await crashed('S2')
    const a = await done(st, 'apply')
    const rec = path.join(st.opDir, 'record.json')
    const u = a.trace.findIndex((t) => t.op === 'unlink' && t.path === rec)
    expect(a.trace[u + 1]).toEqual({ op: 'dirsync', path: st.opDir })
    const pair = a.trace.slice(u, u + 2)
    const rest = [...a.trace.slice(0, u), ...a.trace.slice(u + 2)]
    const k = rest.findIndex((t) => t.op === 'create')
    const mutated = [...trace, ...rest.slice(0, k), ...pair, ...rest.slice(k)]
    expect(replay(mutated, pathsOf(st.fx))).toMatchObject({ ok: false })
  })
})
