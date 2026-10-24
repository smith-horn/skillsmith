/**
 * SMI-6531 (A1 step 4c): T-P5, the power-loss model (#4, E27). The syscall
 * trace of a real one-device update, an undo, and a cross-device update (the
 * state root on `/dev/shm`, a real `EXDEV`) is recorded through the trace
 * seam and replayed through `skill-swap.powerloss.ts`: at no crash point may
 * the old tree be reachable nowhere, the new tree vanish after it was durably
 * at the path, the manifest be at `postEntry` while the path lacks the new
 * tree, or a changed folder or uncommitted backup lack a durable record.
 *
 * Controls (each must fail the same model): the staging sync after `mkdir OP`
 * dropped, the syncs between the renames dropped, and the destination parent
 * synced after the source parent.
 */
import { describe, expect, it } from 'vitest'
import type { TraceOp } from '../../../src/services/skill-swap.js'
import fs from 'node:fs'
import path from 'node:path'
import {
  areaOf,
  makeFixture,
  modify,
  OP_ID,
  plan,
  run,
  useTmpCleanup,
} from './skill-swap.helpers.js'
import type { Fixture } from './skill-swap.helpers.js'
import {
  destinationAfterSource,
  dropStagingSync,
  dropSyncsBetweenRenames,
  parkSyncs,
  replay,
} from './skill-swap.powerloss.js'
import type { ModelPaths } from './skill-swap.powerloss.js'
import { useOtherDeviceCleanup, xdevFixture } from './skill-swap.xdev.helpers.js'

useTmpCleanup()
useOtherDeviceCleanup()

const FILES = { 'SKILL.md': '# v1\n', 'a.txt': 'a\n', 'sub/b.txt': 'b\n' }

const pathsOf = (fx: Fixture): ModelPaths => ({
  realDir: fx.realDir,
  staging: fx.staging,
  opDir: fx.opDir,
  backupDest: path.join(areaOf(fx), OP_ID),
})

async function traced(kind: 'update' | 'undo' | 'cross-device' | 'cross-device rewrite') {
  const fx = kind.startsWith('cross-device') ? xdevFixture(FILES) : makeFixture(FILES)
  const p = plan(fx, [modify('SKILL.md', '# v2\n')])
  if (kind === 'undo') p.manifest.failCasOnCall = 2
  const edit = () => fs.appendFileSync(path.join(fx.opDir, 'old', 'a.txt'), 'late\n')
  const { result, trace } = await run(
    p,
    kind === 'cross-device rewrite' ? { hooks: { afterSidecar: edit } } : {}
  )
  expect(result.status).toBe(kind === 'undo' ? 'undone' : 'committed')
  if (result.status === 'committed') expect(result.incomplete).toBeUndefined()
  return { fx, trace }
}

const ops = (trace: TraceOp[], op: TraceOp['op']) => trace.filter((t) => t.op === op).length

describe('T-P5: the recorded traces survive every crash point', () => {
  for (const kind of ['update', 'undo', 'cross-device', 'cross-device rewrite'] as const) {
    it(`${kind}: no crash point loses a tree or leaves a change without a durable record`, async () => {
      const { fx, trace } = await traced(kind)
      // The trace is the real one: it has the renames and syncs the model reads.
      expect(ops(trace, 'rename')).toBeGreaterThanOrEqual(3)
      expect(ops(trace, 'dirsync')).toBeGreaterThan(5)
      if (kind.startsWith('cross-device')) {
        expect(ops(trace, 'copy')).toBe(2)
        expect(ops(trace, 'park')).toBe(1)
      }
      const v = replay(trace, pathsOf(fx))
      expect(v).toEqual({ ok: true, points: trace.length + 1 })
    })
  }
})

describe('T-P5 controls: each dropped or reordered sync fails the model', () => {
  const CONTROLS = [
    ['the staging sync after mkdir OP dropped', dropStagingSync],
    ['the syncs between the renames dropped', dropSyncsBetweenRenames],
    ['destination after source', destinationAfterSource],
  ] as const
  for (const kind of ['update', 'cross-device'] as const) {
    for (const [label, mutate] of CONTROLS) {
      it(`${kind}: ${label}`, async () => {
        const { fx, trace } = await traced(kind)
        const v = replay(mutate(trace, pathsOf(fx)), pathsOf(fx))
        expect(v.ok).toBe(false)
        if (v.ok) return
        expect(v.why).toBe('the old tree is reachable nowhere')
      })
    }
  }
})

/**
 * Known-positive controls for the model's other three checks, so none of them
 * is decorative: each mutation breaks exactly the property that check guards.
 */
describe('T-P5 model controls: every check can fail', () => {
  const without = (trace: TraceOp[], pred: (t: TraceOp) => boolean): TraceOp[] => {
    const i = trace.findIndex(pred)
    expect(i).toBeGreaterThan(-1)
    return [...trace.slice(0, i), ...trace.slice(i + 1)]
  }
  /** Moves the first event matching `what` to just before the first matching `before`. */
  const moveBefore = (
    trace: TraceOp[],
    what: (t: TraceOp) => boolean,
    before: (t: TraceOp) => boolean
  ): TraceOp[] => {
    const i = trace.findIndex(what)
    expect(i).toBeGreaterThan(-1)
    const rest = [...trace.slice(0, i), ...trace.slice(i + 1)]
    const j = rest.findIndex(before)
    expect(j).toBeGreaterThan(-1)
    return [...rest.slice(0, j), trace[i]!, ...rest.slice(j)]
  }

  it("the record's fsync dropped: a changed folder with no durable record.json", async () => {
    const { fx, trace } = await traced('update')
    const rec = `${fx.opDir}/record.json.tmp`
    const v = replay(
      without(trace, (t) => t.op === 'fsync' && t.path === rec),
      pathsOf(fx)
    )
    expect(v).toMatchObject({
      ok: false,
      why: 'the path holds nothing with no durable record.json',
    })
  })

  it('the manifest written before rename 2: the manifest at postEntry without the new tree', async () => {
    const { fx, trace } = await traced('update')
    const v = replay(
      moveBefore(
        trace,
        (t) => t.op === 'manifest-write',
        (t) => t.op === 'rename' && t.dest === fx.realDir
      ),
      pathsOf(fx)
    )
    expect(v).toMatchObject({
      ok: false,
      why: "the manifest is at postEntry while the path doesn't hold the new tree",
    })
  })

  it('cross-device: the record unlinked (and OP synced) before the copy reaches dest, an uncommitted backup without a record', async () => {
    const { fx, trace } = await traced('cross-device')
    const rec = `${fx.opDir}/record.json`
    // An unlink is durable only once its directory is synced: move the pair.
    const i = trace.findIndex((t) => t.op === 'unlink' && t.path === rec)
    expect(trace[i + 1]).toEqual({ op: 'dirsync', path: fx.opDir })
    const pair = trace.slice(i, i + 2)
    const rest = [...trace.slice(0, i), ...trace.slice(i + 2)]
    const j = rest.findIndex((t) => t.op === 'copy' && t.path === `${fx.opDir}/old`)
    expect(j).toBeGreaterThan(-1)
    const v = replay([...rest.slice(0, j), ...pair, ...rest.slice(j)], pathsOf(fx))
    expect(v).toMatchObject({ ok: false, why: 'the path holds NEW with no durable record.json' })
  })

  it("undo: the aside's sync of OP dropped, the new tree lost after it was durably at the path", async () => {
    const { fx, trace } = await traced('undo')
    const aside = trace.findIndex((t) => t.op === 'rename' && t.dest === `${fx.opDir}/undone`)
    expect(trace[aside + 1]).toEqual({ op: 'dirsync', path: fx.opDir })
    const v = replay([...trace.slice(0, aside + 1), ...trace.slice(aside + 2)], pathsOf(fx))
    expect(v).toMatchObject({
      ok: false,
      why: 'the new tree was durably at the path and is now reachable nowhere',
    })
  })
})

/**
 * Round 1 controls: the review findings the earlier model could not see. Each
 * mutation is the defect a finding named, and each must fail the model.
 */
describe('T-P5 round 1 controls', () => {
  it('(a) cross-device: the record unlinked right after the copy, before the compare and the rename to dest', async () => {
    const { fx, trace } = await traced('cross-device')
    const rec = `${fx.opDir}/record.json`
    const i = trace.findIndex((t) => t.op === 'unlink' && t.path === rec)
    const rest = [...trace.slice(0, i), ...trace.slice(i + 1)]
    const j = rest.findIndex((t) => t.op === 'copy' && t.path === `${fx.opDir}/old`)
    expect(i).toBeGreaterThan(-1)
    expect(j).toBeGreaterThan(-1)
    const v = replay([...rest.slice(0, j + 1), trace[i]!, ...rest.slice(j + 1)], pathsOf(fx))
    expect(v).toMatchObject({ ok: false, why: 'the path holds NEW with no durable record.json' })
  })

  // Round 2 (owner decision): the port syncs .skillsmith-parked and ST before
  // its rename, and the caller syncs <opId> and ST after it.
  it("(b) cross-device: the port's two pre-rename syncs dropped, then ST synced by a later writer", async () => {
    const { fx, trace } = await traced('cross-device')
    const i = parkSyncs(trace, pathsOf(fx))
    const mutated = [
      ...trace.slice(0, i - 2),
      ...trace.slice(i),
      { op: 'dirsync' as const, path: fx.staging },
    ]
    expect(replay(mutated, pathsOf(fx))).toMatchObject({
      ok: false,
      why: 'the old tree is reachable nowhere',
    })
  })

  it("(b') cross-device: only the port's sync of .skillsmith-parked dropped (<opId> itself never durable)", async () => {
    const { fx, trace } = await traced('cross-device')
    const i = parkSyncs(trace, pathsOf(fx))
    const mutated = [...trace.slice(0, i - 2), ...trace.slice(i - 1)]
    expect(replay(mutated, pathsOf(fx))).toMatchObject({
      ok: false,
      why: 'the old tree is reachable nowhere',
    })
  })

  it("(b'') cross-device: the caller's two post-rename syncs dropped, so the reported park is not durable", async () => {
    const { fx, trace } = await traced('cross-device')
    const i = parkSyncs(trace, pathsOf(fx))
    const mutated = [...trace.slice(0, i + 1), ...trace.slice(i + 3)]
    expect(replay(mutated, pathsOf(fx))).toMatchObject({
      ok: false,
      why: 'the park the run reported is not at its parked path',
    })
  })

  it('residual: a failed landing sync, then ST synced by another writer, loses OP under the strict model only', async () => {
    const { fx, trace } = await traced('cross-device')
    const i = parkSyncs(trace, pathsOf(fx))
    // Our run stops at the failed landing sync (no sync of ST); then another writer syncs ST.
    const mutated = [...trace.slice(0, i + 1), { op: 'dirsync' as const, path: fx.staging }]
    expect(replay(mutated, pathsOf(fx))).toMatchObject({
      ok: false,
      why: 'the old tree is reachable nowhere',
    })
    // A filesystem that commits a rename's halves together (one journal transaction) keeps it.
    expect(replay(mutated, pathsOf(fx), { atomicRename: true })).toMatchObject({ ok: true })
  })

  it("(c) cross-device rewrite: the area sync before the old sidecar's unlink dropped", async () => {
    const { fx, trace } = await traced('cross-device rewrite')
    const side = `${path.join(areaOf(fx), OP_ID)}.json`
    const u = trace.findIndex((t) => t.op === 'unlink' && t.path === side)
    expect(u).toBeGreaterThan(0)
    expect(trace[u - 1]).toEqual({ op: 'dirsync', path: areaOf(fx) })
    expect(trace[u - 2]).toEqual({ op: 'fsync', path: `${side}.tmp` })
    const mutated = [...trace.slice(0, u - 1), ...trace.slice(u)]
    expect(replay(mutated, pathsOf(fx))).toMatchObject({
      ok: false,
      why: 'the copy temp or the backup is reachable without a durable sidecar',
    })
  })

  it("(c') cross-device rewrite: the area sync between the new sidecar's link and its temp's unlink dropped", async () => {
    const { fx, trace } = await traced('cross-device rewrite')
    const side = `${path.join(areaOf(fx), OP_ID)}.json`
    // The rewrite's temp unlink: the last one (the first publish unlinked its own temp too).
    const isTmpUnlink = (t: TraceOp) => t.op === 'unlink' && t.path === `${side}.tmp`
    const u = trace.length - 1 - [...trace].reverse().findIndex(isTmpUnlink)
    expect(trace[u - 1]).toEqual({ op: 'dirsync', path: areaOf(fx) })
    expect(trace[u - 2]).toMatchObject({ op: 'link', dest: side })
    const mutated = [...trace.slice(0, u - 1), ...trace.slice(u)]
    expect(replay(mutated, pathsOf(fx))).toMatchObject({
      ok: false,
      why: 'the copy temp or the backup is reachable without a durable sidecar',
    })
  })
})
