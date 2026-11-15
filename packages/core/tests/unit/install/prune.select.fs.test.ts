/**
 * SMI-6531 (A1 step 6c-ii-b): `planPrune` over REAL listings (design note
 * section 5.1): the rows whose facts come from the record scan, the
 * classifier and the listers, plus the scoped re-plan (M-D1) and the digest
 * over real bytes (M-D2). Lock input is a hand-built `LockMap` (lock 1 of the
 * tree's root), so these rows do not depend on the lock assigner.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { planPrune } from '../../../src/install/prune.select.js'
import type {
  ExcludeReason,
  LockAssignment,
  PrunePlan,
  PruneRequest,
} from '../../../src/install/prune.plan.types.js'
import { listBackups } from '../../../src/services/skill-backups.listing.js'
import type { BackupsListing } from '../../../src/services/skill-backups.listing.types.js'
import { computeRecordSha256 } from '../../../src/services/skill-swap.js'
import type { SwapRecord } from '../../../src/services/skill-swap.js'
import { hermetic, indexLine, mkBase, parkAt } from '../services/skill-backups.helpers.js'
import { injectMountinfo, makeBackup, mountinfoLine } from './prune.list.helpers.js'

const bases: string[] = []
const base = (): string => {
  const b = mkBase('prune-select-')
  bases.push(b)
  return b
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const b of bases.splice(0)) fs.rmSync(b, { recursive: true, force: true })
})

const client = (b: string, id = 'claude-code'): string => path.join(b, 'clients', id)
const DAY = 86_400_000
const ident = { dev: '1', ino: '2', birthtimeNs: '3', fmt: '4' }

/** A live, verified record of `root` for `opId` (the scan's own verifier accepts it). */
function putRecord(root: string, opId: string, backupDest: string, dirName = 'foo'): string {
  const realDir = path.join(root, dirName)
  const body: Omit<SwapRecord, 'recordSha256'> = {
    schema: 1,
    op: 'update',
    opId,
    pid: 1,
    host: 'h',
    uid: 1,
    target: {
      comparedPath: realDir,
      realDir,
      skillsDir: root,
      manifestPath: path.join(root, 'manifest.json'),
      manifestKey: dirName,
      client: 'claude-code',
      scope: 'global',
      dirName,
    },
    rootIdentity: { ...ident },
    opDirIdentity: { ...ident },
    oldIdentity: { ...ident },
    newIdentity: { ...ident },
    preTree: 'pre',
    postTree: 'post',
    preEntry: { version: '1.0.0' },
    postEntry: { version: '2.0.0' },
    backupDest,
  } as Omit<SwapRecord, 'recordSha256'>
  const dir = path.join(root, '.skillsmith-staging', opId)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'record.json')
  fs.writeFileSync(file, JSON.stringify({ ...body, recordSha256: computeRecordSha256(body) }))
  return file
}

/** Lock 1 of the tree's own root: a backup's sidecar `skillsDir`, a parked copy's area root. */
function locksOf(l: BackupsListing): Map<string, LockAssignment> {
  const m = new Map<string, LockAssignment>()
  for (const v of l.parked) {
    for (const r of v.rows) {
      m.set(r.copy.copyPath, { kind: 'lock1', path: `${v.ref.root}/.lock`, root: v.ref.root })
    }
  }
  for (const s of l.backups) {
    for (const a of s.areas) {
      for (const r of a.rows) {
        const root = r.skillsDir ?? a.rootKey
        m.set(r.copy.copyPath, { kind: 'lock1', path: `${root}/.lock`, root })
      }
    }
  }
  return m
}

const req = (over: Partial<PruneRequest> = {}): PruneRequest => ({
  now: Date.now() + 60_000,
  includeKept: false,
  allowChanged: [],
  ...over,
})
const run = async (b: string, r: PruneRequest): Promise<{ l: BackupsListing; p: PrunePlan }> => {
  const l = await listBackups({ stateRoot: path.join(b, '.skillsmith'), discovery: hermetic(b) })
  return { l, p: planPrune(l, r, locksOf(l)) }
}
const selected = (p: PrunePlan): string[] => p.groups.flatMap((g) => g.items.map((i) => i.copyPath))
const reasonOf = (p: PrunePlan, cp: string): ExcludeReason | undefined =>
  p.excluded.find((e) => e.copyPath === cp)?.reason
const state = (b: string): string => path.join(b, '.skillsmith')

describe('UD61 on real records and parked copies', () => {
  it('M-P1: a live record in root A protects its opId in an area keyed by root B', async () => {
    const b = base()
    hermetic(b)
    const t = makeBackup({
      state: state(b),
      skillsDir: client(b, 'cursor'),
      opId: 'op-p1',
      kind: 'conflict',
    })
    const rec = putRecord(client(b), 'op-p1', path.join(t.areaPath, 'op-p1'))
    const { p } = await run(b, req({ op: 'op-p1', includeKept: true }))
    expect(selected(p)).toEqual([])
    expect(reasonOf(p, t.copyPath)).toEqual({ code: 'protected', rule: 'live-record', path: rec })
  })

  it('M-P2: the exception is exactly partial-copy with sourceUnchanged: true', async () => {
    const b = base()
    hermetic(b)
    const s = state(b)
    const no = makeBackup({
      state: s,
      skillsDir: client(b),
      opId: 'op-p2',
      kind: 'partial-copy',
      sidecar: { sourceUnchanged: false },
    })
    const two = `${no.copyPath}.2`
    fs.renameSync(no.copyPath, two)
    fs.renameSync(no.sidecarPath, `${two}.json`)
    const yes = makeBackup({
      state: s,
      skillsDir: client(b),
      opId: 'op-p2',
      kind: 'partial-copy',
      sidecar: { sourceUnchanged: true },
    })
    const rec = putRecord(client(b), 'op-p2', path.join(yes.areaPath, 'op-p2'))
    const { p } = await run(b, req({ op: 'op-p2', includeKept: true }))
    expect(selected(p)).toEqual([yes.copyPath])
    expect(p.groups[0]!.items[0]!.tier).toBe('batch')
    expect(reasonOf(p, two)).toEqual({ code: 'protected', rule: 'live-record', path: rec })
  })

  it('M-P4: a parked unreadable record protects a backup with its opId; the parked copy needs --include-kept', async () => {
    const b = base()
    hermetic(b)
    const pk = parkAt(client(b), 'rec', { caller: 'doctor-park', opId: 'op-X' })
    const undone = makeBackup({
      state: state(b),
      skillsDir: client(b),
      opId: 'op-X',
      kind: 'undone',
    })
    const { p } = await run(b, req({ op: 'op-X' }))
    expect(reasonOf(p, undone.copyPath)).toEqual({
      code: 'protected',
      rule: 'parked-unreadable-record',
      path: pk.copyPath,
    })
    expect(reasonOf(p, pk.copyPath)).toEqual({
      code: 'needs-include-kept',
      kind: 'unreadable-record',
    })
    const kept = (await run(b, req({ op: 'op-X', includeKept: true }))).p
    expect(selected(kept)).toEqual([pk.copyPath])
    expect(reasonOf(kept, undone.copyPath)).toMatchObject({ code: 'protected' })
  })
})

describe('M-M1, M-M2: mounted is never offered, and an unreadable mount table fails closed', () => {
  it('control: a sidecar-less parked copy is held and offered per-item with --allow-changed', async () => {
    const b = base()
    hermetic(b)
    const pk = parkAt(client(b), 'mnt')
    fs.rmSync(pk.sidecarPath)
    const { p } = await run(
      b,
      req({ paths: [pk.copyPath], includeKept: true, allowChanged: [pk.copyPath] })
    )
    expect(p.groups[0]!.items.map((i) => [i.copyPath, i.klass, i.tier])).toEqual([
      [pk.copyPath, 'held', 'per-item'],
    ])
  })

  it('M-M1: the same copy with a mount under it is excluded mounted, despite --allow-changed', async () => {
    const b = base()
    hermetic(b)
    const pk = parkAt(client(b), 'mnt')
    fs.rmSync(pk.sidecarPath)
    injectMountinfo(mountinfoLine(path.join(fs.realpathSync(pk.copyPath), 'sub')))
    const { p } = await run(
      b,
      req({ paths: [pk.copyPath], includeKept: true, allowChanged: [pk.copyPath] })
    )
    expect(selected(p)).toEqual([])
    expect(reasonOf(p, pk.copyPath)).toEqual({ code: 'mounted' })
  })

  it('M-M2: control: a clean backup is batch; with mountinfo unreadable (EACCES) its store is refused and nothing is selected', async () => {
    const b = base()
    hermetic(b)
    const t = makeBackup({ state: state(b), skillsDir: client(b), opId: 'op-m2', kind: 'undone' })
    const clean = (await run(b, req({ paths: [t.copyPath] }))).p
    expect(clean.groups[0]!.items.map((i) => [i.klass, i.tier])).toEqual([['clean', 'batch']])
    injectMountinfo({ throws: 'EACCES' })
    const { p } = await run(b, req({ paths: [t.copyPath], allowChanged: [t.copyPath] }))
    expect(selected(p)).toEqual([])
    expect(p.preconditions).toContainEqual({
      code: 'area-refused',
      path: t.updateDir,
      reason: 'a mount point is at the backup store',
    })
    expect(p.unmatchedPaths.map((u) => u.path)).toEqual([t.copyPath])
  })

  it('M-M2: a parked area is refused whole when mountinfo is unreadable; --path says so', async () => {
    const b = base()
    hermetic(b)
    const pk = parkAt(client(b), 'plain')
    injectMountinfo({ throws: 'EACCES' })
    const { p } = await run(b, req({ paths: [pk.copyPath], allowChanged: [pk.copyPath] }))
    const area = path.dirname(pk.opDir)
    expect(selected(p)).toEqual([])
    expect(p.preconditions).toContainEqual({
      code: 'area-refused',
      path: area,
      reason: 'a mount point is at the set-aside area',
    })
    expect(p.unmatchedPaths).toEqual([
      {
        path: pk.copyPath,
        why: 'in an area the listing refused, so nothing in it can be selected (a mount point is at the set-aside area)',
      },
    ])
  })
})

describe('M-S1..S3: what is never a candidate, and --path says why (D18)', () => {
  it('M-S1: .prune-* directories in a parked and a backup area', async () => {
    const b = base()
    hermetic(b)
    const pk = parkAt(client(b), 'x')
    const t = makeBackup({ state: state(b), skillsDir: client(b), opId: 'op-s1', kind: 'undone' })
    const inParked = path.join(path.dirname(pk.opDir), '.prune-0123456789abcdef')
    const inBackup = path.join(t.areaPath, '.prune-0123456789abcdef')
    fs.mkdirSync(inParked)
    fs.mkdirSync(inBackup)
    const { p } = await run(b, req({ paths: [inParked, inBackup, t.copyPath] }))
    expect(selected(p)).toEqual([t.copyPath])
    expect(p.unmatchedPaths.map((u) => [u.path, u.why.split(':')[0]])).toEqual([
      [inParked, 'a .prune-* directory'],
      [inBackup, 'a .prune-* directory'],
    ])
  })

  it('M-S2: temps are never selected, even by their opId with --include-kept', async () => {
    const b = base()
    hermetic(b)
    const t = makeBackup({ state: state(b), skillsDir: client(b), opId: 'op-s2', kind: 'undone' })
    const copyTemp = path.join(t.areaPath, '.tmp-op-s2.conflict')
    const sidecarTemp = path.join(t.areaPath, 'op-s2.conflict.json.tmp')
    fs.mkdirSync(copyTemp)
    fs.writeFileSync(sidecarTemp, '{}')
    const { l, p } = await run(b, req({ op: 'op-s2', includeKept: true }))
    expect(l.backups[0]!.areas[0]!.temps.map((x) => x.path).sort()).toEqual(
      [copyTemp, sidecarTemp].sort()
    )
    expect(selected(p)).toEqual([t.copyPath])
    const byPath = (await run(b, req({ paths: [copyTemp, sidecarTemp] }))).p
    expect(byPath.groups).toEqual([])
    expect(byPath.unmatchedPaths.map((u) => u.why.split(':')[0])).toEqual([
      'an unfinished temp',
      'an unfinished temp',
    ])
  })

  it('M-S3: a legacy leftover and the parked index are never selected', async () => {
    const b = base()
    hermetic(b)
    const pk = parkAt(client(b), 'y')
    const index = indexLine(state(b), pk.copyPath, 'op-y')
    const legacy = path.join(client(b), `.foo.skillsmith-removing-${'0123456789abcdef'.repeat(2)}`)
    fs.mkdirSync(legacy)
    const { l, p } = await run(b, req({ paths: [legacy, index] }))
    expect(l.legacy[0]!.paths).toEqual([legacy])
    expect(p.groups).toEqual([])
    expect(p.unmatchedPaths.map((u) => [u.path, u.why.split(':')[0]])).toEqual([
      [legacy, 'a legacy removal leftover'],
      [index, 'the parked index'],
    ])
  })
})

describe('M-D1, M-D2: the scoped re-plan and the digest', () => {
  /** Two backups of `dirName` in `root`, the older one `days` old. */
  const pair = (b: string, root: string, dirName: string, op: string): void => {
    for (const [k, days] of [
      ['new', 1],
      ['old', 9],
    ] as const) {
      makeBackup({
        state: state(b),
        skillsDir: root,
        dirName,
        opId: `${op}-${k}`,
        sidecar: { createdAt: new Date(Date.now() - days * DAY).toISOString() },
      })
    }
  }

  it('M-D1: each group re-planned from listBackups({ scope }) has the same items and digest', async () => {
    const b = base()
    hermetic(b)
    pair(b, client(b), 'foo', 'op-a')
    pair(b, client(b), 'bar', 'op-b')
    pair(b, client(b, 'cursor'), 'foo', 'op-c')
    pair(b, client(b, 'copilot'), 'baz', 'op-d')
    const r = req({ olderThanDays: 0 })
    const { p } = await run(b, r)
    expect(p.groups).toHaveLength(3)
    for (const g of p.groups) {
      const scoped = await listBackups({
        stateRoot: state(b),
        discovery: hermetic(b),
        scope: g.scope,
      })
      const again = planPrune(scoped, r, locksOf(scoped)).groups.find(
        (x) => x.lock.path === g.lock.path
      )
      expect(again?.items.map((i) => i.copyPath)).toEqual(g.items.map((i) => i.copyPath))
      expect(again?.digest).toBe(g.digest)
    }
    // Each pair's older tree, and only it: the newest of every group is kept.
    expect(p.groups.flatMap((g) => g.items).length).toBe(4)
  })

  it('M-D2: one sidecar byte or one tree byte changes the digest', async () => {
    const b = base()
    hermetic(b)
    const t = makeBackup({ state: state(b), skillsDir: client(b), opId: 'op-d2', kind: 'undone' })
    const r = req({ op: 'op-d2', allowChanged: [t.copyPath] })
    const d0 = (await run(b, r)).p.groups[0]!.digest
    expect((await run(b, r)).p.groups[0]!.digest).toBe(d0)
    fs.writeFileSync(t.sidecarPath, JSON.stringify(t.sidecar) + '\n')
    const d1 = (await run(b, r)).p.groups[0]!
    expect(d1.items[0]!.klass).toBe('clean')
    expect(d1.digest).not.toBe(d0)
    fs.writeFileSync(path.join(t.copyPath, 'SKILL.md'), 'skill foo!\n')
    const d2 = (await run(b, r)).p.groups[0]!
    expect(d2.items[0]!.klass).toBe('changed')
    expect(d2.digest).not.toBe(d1.digest)
  })
})
