/**
 * SMI-6531 (A1 step 4b): abort cleanup parks a completed, unchanged build
 * (A1 plan §3.3 "Abort cleanup", UD28). T-X13's completed-build rows, its
 * spy and order, its control; Q1; T-PI2's swap half.
 *
 * Doctor's half (finishing a park from a verifying intent, T-PI2's negative
 * cases) is SMI-6531 step 6's; these tests build and assert the state it reads.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parkTreeIndexed } from '../../../src/install/park-call.js'
import type { ParkOptions } from '../../../src/install/park-result.js'
import { isParkIntentFor } from '../../../src/services/skill-swap.intent.js'
import { recordIdentity } from '../../../src/services/skill-swap.staging.js'
import type { TraceOp } from '../../../src/services/skill-swap.js'
import {
  ALL_DELETES,
  contentOf,
  indexLines,
  isFs,
  parkedCopy,
  refusedOf,
  runSpied,
  treeDeletes,
} from './skill-swap.abort.helpers.js'
import type { Event } from './skill-swap.abort.helpers.js'
import { ABORT_KINDS, abortAt, PLANTED_OP_ID, REASON } from './skill-swap.abort.triggers.js'
import type { AbortKind } from './skill-swap.abort.triggers.js'
import { hashOf, makeFixture, modify, OP_ID, plan, useTmpCleanup } from './skill-swap.helpers.js'
import type { Fixture } from './skill-swap.helpers.js'

useTmpCleanup()

const FILES = { 'SKILL.md': '# v1\n', 'a.txt': 'a\n', 'sub/b.txt': 'b\n' }
const SPIED = [...ALL_DELETES, 'mkdirSync', 'lstatSync', 'rmdirSync', 'readdirSync', 'renameSync']

async function abortRun(kind: AbortKind, extraOpts = {}) {
  const fx = makeFixture(FILES)
  const p = plan(fx, [modify('SKILL.md', '# v2\n'), modify('sub/b.txt', 'b2\n')])
  const t = abortAt(fx, kind)
  try {
    const r = await runSpied(p, SPIED, { ...t.options, ...extraOpts })
    return { fx, p, built: t.built, ...r }
  } finally {
    t.restore()
  }
}

const guardOf = (events: Event[]): string | null => {
  const g = events.find((e): e is Extract<TraceOp, { op: 'guard' }> => !isFs(e) && e.op === 'guard')
  return g?.hash ?? null
}

/** Each predicate matched by a later event than the previous one; returns the first that was not. */
function inOrder(events: Event[], want: Array<[string, (e: Event) => boolean]>): string | null {
  let i = 0
  for (const [label, pred] of want) {
    while (i < events.length && !pred(events[i]!)) i++
    if (i === events.length) return label
    i++
  }
  return null
}

const traced =
  (op: string, extra: Record<string, unknown> = {}) =>
  (e: Event): boolean =>
    !isFs(e) &&
    e.op === op &&
    Object.entries(extra).every(([k, v]) => (e as Record<string, unknown>)[k] === v)
const fsCall =
  (name: string, p: (s: string) => boolean) =>
  (e: Event): boolean =>
    isFs(e) && e.fs === name && p(e.path)

function assertParked(fx: Fixture, kind: AbortKind, run: Awaited<ReturnType<typeof abortRun>>) {
  const r = refusedOf(run.result)
  expect(r.staged).toBe('parked')
  const copy = parkedCopy(fx)
  expect(r).toMatchObject({
    status: 'refused',
    reason: REASON[kind],
    staged: 'parked',
    parkedPath: copy,
    opDir: null,
    cleanStagingHint: null,
  })
  expect(r.warnings.filter((w) => w.code === 'removal-not-done')).toEqual([])
  // N, byte-identical and the same inode, plus the intent: nothing else.
  expect(fs.readdirSync(copy).sort()).toEqual(['new', 'park-intent.json'])
  expect(contentOf(path.join(copy, 'new'))).toEqual(run.built.content)
  expect(hashOf(path.join(copy, 'new'))).toBe(run.built.hash)
  expect(fs.lstatSync(path.join(copy, 'new'), { bigint: true }).ino).toBe(run.built.ino)
  // The op dir and any record are gone from staging; step 3's planted op dir is not ours to remove.
  expect(fs.existsSync(fx.opDir)).toBe(false)
  expect(fs.readdirSync(fx.staging).sort()).toEqual(
    kind === 'step3' ? [PLANTED_OP_ID, '.skillsmith-parked'].sort() : ['.skillsmith-parked']
  )
  if (kind === 'step3') {
    expect(fs.existsSync(path.join(fx.staging, PLANTED_OP_ID, 'record.json'))).toBe(true)
  }
  // The sidecar and the index line.
  const sidecar = JSON.parse(fs.readFileSync(`${copy}.json`, 'utf8'))
  expect(sidecar).toMatchObject({
    opId: OP_ID,
    kind: 'abort-new',
    client: 'claude-code',
    originPath: fx.opDir,
    postMoveVerified: true,
  })
  expect(sidecar.treeHash).toBe(guardOf(run.events))
  expect(sidecar.treeHash).toBe(hashOf(copy))
  expect(indexLines(fx)).toEqual([
    expect.objectContaining({ opId: OP_ID, path: copy, kind: 'abort-new', client: 'claude-code' }),
  ])
  // No unlink or rmdir of any tree entry: only metadata, probes and lock files.
  expect(treeDeletes(fx, run.events)).toEqual([])
  expect(run.p.manifest.writes).toBe(0)
}

describe('T-X13: a completed, unchanged build is parked with its op dir', () => {
  for (const kind of ABORT_KINDS) {
    it(`abort at ${kind} (${REASON[kind]}): OP parked whole, N byte-identical, nothing deleted`, async () => {
      const run = await abortRun(kind)
      assertParked(run.fx, kind, run)
    })
  }

  for (const kind of ['step4', 'step6'] as const) {
    it(`abort at ${kind}: the plan's order, lock 1 → check → identity → compare → unlinks → probes → OP hash → check → park`, async () => {
      const run = await abortRun(kind)
      const { fx } = run
      const OP = fx.opDir
      const probe = (n: 1 | 2) => (s: string) =>
        s === path.join(fx.staging, `.skillsmith-probe-${OP_ID}-${n}`)
      const want: Array<[string, (e: Event) => boolean]> = [
        ['lock 1 held', traced('abort-lock')],
        ['check', traced('check')],
        ["N's identity", traced('identity', { path: path.join(OP, 'new') })],
        [
          'N compared with postTree',
          traced('compare', { path: path.join(OP, 'new'), equal: true }),
        ],
      ]
      if (kind === 'step6') {
        want.push([
          'record.json unlinked',
          traced('unlink', { path: path.join(OP, 'record.json') }),
        ])
      }
      want.push(
        ['park-intent.json linked', traced('link', { dest: path.join(OP, 'park-intent.json') })],
        ['owner.json unlinked', traced('unlink', { path: path.join(OP, 'owner.json') })],
        ['check before the gate', traced('check')],
        ['probe 1 mkdir', fsCall('mkdirSync', probe(1))],
        ['probe 1 lstat', fsCall('lstatSync', probe(1))],
        ['probe 1 rmdir', fsCall('rmdirSync', probe(1))],
        ['probe 2 mkdir', fsCall('mkdirSync', probe(2))],
        ['probe 2 lstat', fsCall('lstatSync', probe(2))],
        ['probe 2 rmdir', fsCall('rmdirSync', probe(2))],
        ["OP's hash walk", fsCall('readdirSync', (s) => s === OP)],
        ['guard bound', traced('guard', { path: OP })],
        ['check before the park', traced('check')],
        ["the park's rename", fsCall('renameSync', (s) => s === OP)],
        ['park returned', traced('park', { path: OP, status: 'parked' })]
      )
      expect(inOrder(run.events, want)).toBeNull()
      // Nothing is unlinked after the gate starts but probes (no metadata unlink after the hash).
      const gate = run.events.findIndex(fsCall('mkdirSync', probe(1)))
      const lateUnlinks = run.events
        .slice(gate)
        .filter((e) => (isFs(e) ? e.fs.includes('unlink') && !/\.lock/.test(e.path) : false))
      expect(lateUnlinks).toEqual([])
    })
  }

  it('control (UD28): a port passing postTree as the guard ends kept/identity-changed, OP left', async () => {
    let postTree: string | null = null
    const run = await abortRun('step4', {
      park: (parent: string, name: string, o: ParkOptions) => {
        postTree = hashOf(path.join(parent, name, 'new'))
        return parkTreeIndexed(parent, name, { ...o, guardHash: postTree })
      },
    })
    const r = refusedOf(run.result)
    expect(postTree).toBe(run.built.hash)
    expect(r).toMatchObject({
      staged: 'left',
      opDir: run.fx.opDir,
      cleanStagingHint: `skillsmith doctor recovery --clean-staging ${OP_ID}`,
    })
    expect(r.warnings).toContainEqual({
      code: 'removal-not-done',
      path: run.fx.opDir,
      status: 'kept',
      reason: 'identity-changed',
    })
    expect(fs.readdirSync(run.fx.opDir).sort()).toEqual(['new', 'park-intent.json'])
    expect(treeDeletes(run.fx, run.events)).toEqual([])
  })

  it("the park call's inputs: ST, the opId, caller abort-cleanup, kind abort-new, the gate's threshold, OP's identity, the state root's index", async () => {
    const seen: Array<{ parent: string; name: string; o: ParkOptions }> = []
    const run = await abortRun('step4', {
      park: (parent: string, name: string, o: ParkOptions) => {
        seen.push({ parent, name, o })
        return parkTreeIndexed(parent, name, o)
      },
    })
    expect(refusedOf(run.result).staged).toBe('parked')
    expect(seen).toHaveLength(1)
    const { parent, name, o } = seen[0]!
    const op = run.built.op!
    expect(parent).toBe(run.fx.staging)
    expect(name).toBe(OP_ID)
    expect(o).toMatchObject({
      client: 'claude-code',
      caller: 'abort-cleanup',
      kind: 'abort-new',
      opId: OP_ID,
      guardHash: guardOf(run.events),
      expectIdentity: { dev: op.dev, ino: op.ino, birthtimeNs: op.birthtimeNs, fmt: op.fmt },
      indexPath: path.join(fs.realpathSync(run.fx.stateRoot), 'parked-index.jsonl'),
    })
    expect(typeof o.maxBirthtimeNs).toBe('bigint')
    // The gate's threshold is later than OP's birth, so the park accepts OP as older.
    expect(op.birthtimeNs < o.maxBirthtimeNs!).toBe(true)
    expect(o.rootKey).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('Q1: abort cleanup parks (10 runs each, step 4 and step 6)', () => {
  for (const kind of ['step4', 'step6'] as const) {
    it(`abort at ${kind}: the parked copy holds N and park-intent.json only; treeHash is OP's after the unlinks`, async () => {
      for (let i = 0; i < 10; i++) {
        const run = await abortRun(kind)
        const r = refusedOf(run.result)
        const copy = parkedCopy(run.fx)
        expect(r.parkedPath).toBe(copy)
        expect(fs.readdirSync(copy).sort()).toEqual(['new', 'park-intent.json'])
        const sidecar = JSON.parse(fs.readFileSync(`${copy}.json`, 'utf8'))
        expect(sidecar.kind).toBe('abort-new')
        expect(sidecar.treeHash).toBe(guardOf(run.events))
        expect(sidecar.treeHash).toBe(hashOf(copy))
        expect(fs.existsSync(path.join(run.fx.opDir, 'record.json'))).toBe(false)
        expect(fs.readdirSync(run.fx.staging)).toEqual(['.skillsmith-parked'])
        expect(indexLines(run.fx)).toHaveLength(1)
        expect(treeDeletes(run.fx, run.events)).toEqual([])
      }
    })
  }
})

describe('T-PI2 (swap half): the park intent', () => {
  for (const kind of ['step4', 'step6'] as const) {
    it(`abort at ${kind}: durable before owner.json goes, matches its schema, and travels with the parked op dir`, async () => {
      const run = await abortRun(kind)
      const OP = run.fx.opDir
      const idx = (pred: (e: Event) => boolean) => run.events.findIndex(pred)
      const linked = idx(traced('link', { dest: path.join(OP, 'park-intent.json') }))
      const tmpGone = idx(traced('unlink', { path: path.join(OP, 'park-intent.json.tmp') }))
      const synced = run.events.findIndex(
        (e, i) => i > tmpGone && traced('dirsync', { path: OP })(e)
      )
      const ownerGone = idx(traced('unlink', { path: path.join(OP, 'owner.json') }))
      expect(linked).toBeGreaterThan(-1)
      expect(tmpGone).toBeGreaterThan(linked)
      expect(synced).toBeGreaterThan(tmpGone)
      expect(ownerGone).toBeGreaterThan(synced)
      // The temp was synced before its link.
      expect(idx(traced('fsync', { path: path.join(OP, 'park-intent.json.tmp') }))).toBeLessThan(
        linked
      )

      const copy = parkedCopy(run.fx)
      const intent = JSON.parse(fs.readFileSync(path.join(copy, 'park-intent.json'), 'utf8'))
      const opId = recordIdentity(run.built.op!)
      expect(isParkIntentFor(intent, OP_ID, opId)).toBe(true)
      // 6b-ii (O1): schema 2, carrying owner.json's attribution so doctor can route the park.
      expect(intent).toEqual({
        schema: 2,
        opId: OP_ID,
        owner: { pid: process.pid, host: expect.any(String), uid: expect.any(Number) },
        opIdentity: opId,
        kind: 'abort-new',
        client: 'claude-code',
        scope: 'user',
        dirName: run.fx.dirName,
        manifestKey: run.fx.dirName,
        stateRoot: fs.realpathSync.native(run.fx.stateRoot),
      })
      // The schema check refuses another opId, another identity, an extra key.
      expect(isParkIntentFor(intent, 'b'.repeat(32), opId)).toBe(false)
      expect(isParkIntentFor(intent, OP_ID, { ...opId, ino: '1' })).toBe(false)
      expect(isParkIntentFor({ ...intent, extra: 1 }, OP_ID, opId)).toBe(false)
      // The guard hash covered it: the sidecar's hash is the copy's, intent included.
      const sidecar = JSON.parse(fs.readFileSync(`${copy}.json`, 'utf8'))
      expect(sidecar.treeHash).toBe(hashOf(copy))
    })
  }
})
