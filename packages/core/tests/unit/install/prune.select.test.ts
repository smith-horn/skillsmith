/**
 * SMI-6531 (A1 step 6c-ii-b): `planPrune`'s selection rules on hand-built
 * listings (design note section 5.1). The planner is pure, so each rule is
 * driven by exactly the row facts it reads; `prune.select.fs.test.ts` repeats
 * the rows that depend on the listing's own facts (records, the classifier)
 * on real fixtures.
 */
import { describe, expect, it } from 'vitest'
import { planPrune } from '../../../src/install/prune.select.js'
import { BACKUP_KIND_POLICY } from '../../../src/install/prune.kinds.js'
import {
  groupDigest,
  rootKeyOf as planRootKeyOf,
} from '../../../src/install/prune.select.digest.js'
import { rootKeyOf } from '../../../src/services/skill-swap.area.js'
import type { Classification, CopyClass } from '../../../src/install/prune.classify.js'
import type {
  ExcludeReason,
  LockAssignment,
  LockMap,
  PlanItem,
  PrunePlan,
  PruneRequest,
} from '../../../src/install/prune.plan.types.js'
import type {
  BackupRow,
  BackupsListing,
  ParkedRow,
} from '../../../src/services/skill-backups.listing.types.js'
import { protectionOf } from '../../../src/services/skill-backups.records.js'
import type { Protection, RecordFacts } from '../../../src/services/skill-backups.records.js'

const NOW = Date.UTC(2026, 10, 15)
const DAY = 86_400_000
const H_REC = 'a'.repeat(64)
const H_FRESH = 'f'.repeat(64)
let nextIno = 100n

function classification(
  klass: CopyClass,
  kind: string | null,
  over: Partial<Classification> = {}
): Classification {
  return {
    klass,
    reason: klass === 'clean' ? null : 'planted',
    detail: null,
    freshHash: H_FRESH,
    recordedHash: H_REC,
    rootIdentity: { dev: 1n, ino: nextIno++, birthtimeNs: 3n, fmt: 0o040000n },
    sidecarRead: { bytes: Buffer.from('{"k":1}'), ino: 9n, size: 7n, mtimeNs: 1n, ctimeNs: 1n },
    sidecar: kind === null ? null : { kind },
    kind,
    measured: { allocatedBytes: 4096, apparentBytes: 10, unmeasured: 0, units: new Map() },
    ...over,
  }
}

interface BSpec {
  client?: string
  rootKey?: string
  dirName?: string
  state?: string
  opId?: string
  /** The sidecar kind; null for a sidecar that did not parse. */
  kind?: string | null
  /** The tree name; default `<opId>` or `<opId>.<kind>`. */
  name?: string
  klass?: CopyClass
  /** Days old at NOW; null for an unknown age. */
  age?: number | null
  protection?: Protection
  sidecar?: Record<string, unknown> | null
  cls?: Partial<Classification>
}

interface BuiltBackup {
  row: BackupRow
  state: string
  area: { areaPath: string; client: string; rootKey: string; dirName: string }
}

function backup(s: BSpec = {}): BuiltBackup {
  const client = s.client ?? 'claude-code'
  const rootKey = s.rootKey ?? '0123456789abcdef'
  const dirName = s.dirName ?? 'foo'
  const opId = s.opId ?? `op-${nextIno}`
  const kind = s.kind === undefined ? 'backup' : s.kind
  const name = s.name ?? (kind === 'backup' || kind === null ? opId : `${opId}.${kind}`)
  const state = `/s/${s.state ?? 'st'}`
  const areaPath = `${state}/backups/update/${client}/${rootKey}/${dirName}`
  const copyPath = `${areaPath}/${name}`
  const cls = classification(s.klass ?? 'clean', kind, s.cls)
  if (s.sidecar !== undefined) cls.sidecar = s.sidecar
  const age = s.age === undefined ? 5 : s.age
  const createdMs = age === null ? null : NOW - age * DAY
  const row: BackupRow = {
    copy: {
      copyPath,
      name,
      opId,
      parentDir: areaPath,
      sidecarPath: `${copyPath}.json`,
      stagingRoot: areaPath,
      opDir: areaPath,
      area: { client, rootKey, dirName },
    },
    classification: cls,
    kind,
    createdMs,
    ageDays: age === null ? null : Math.floor(age),
    allocatedBytes: 4096,
    apparentBytes: 10,
    unmeasured: 0,
    client,
    skillsDir: `/roots/${rootKey}`,
    dirName,
    opId,
    hashStillEquals: true,
    protection: s.protection ?? { status: 'unprotected' },
    newestOfGroup: false,
  }
  return { row, state, area: { areaPath, client, rootKey, dirName } }
}

interface PSpec {
  root?: string
  opId?: string
  kind?: string | null
  klass?: CopyClass
  origin?: string
  client?: string
  protection?: Protection
}

interface BuiltParked {
  row: ParkedRow
  areaDir: string
  root: string
}

function parked(s: PSpec = {}): BuiltParked {
  const root = `/r/${s.root ?? 'one'}`
  const areaDir = `${root}/.skillsmith-parked`
  const opId = s.opId ?? `op-${nextIno}`
  const opDir = `${areaDir}/${opId}`
  const name = `${s.origin ?? 'skill'}-1234abcd`
  const copyPath = `${opDir}/${name}`
  const kind = s.kind === undefined ? 'uninstall' : s.kind
  const cls = classification(s.klass ?? 'clean', kind)
  cls.sidecar = kind === null ? null : { kind, client: s.client ?? 'claude-code' }
  const row: ParkedRow = {
    copy: {
      copyPath,
      name,
      opId,
      parentDir: opDir,
      sidecarPath: `${copyPath}.json`,
      stagingRoot: areaDir,
      opDir,
    },
    classification: cls,
    kind,
    createdMs: NOW - 3 * DAY,
    ageDays: 3,
    allocatedBytes: 4096,
    apparentBytes: 10,
    unmeasured: 0,
    origin: `${root}/${s.origin ?? 'skill'}`,
    index: 'present',
    protection: s.protection ?? { status: 'unprotected' },
  }
  return { row, areaDir, root }
}

/** A listing holding exactly these rows, areas and stores in the order given. */
function listing(
  backups: readonly BuiltBackup[],
  parks: readonly BuiltParked[] = [],
  over: Partial<BackupsListing> = {}
): BackupsListing {
  const stores = new Map<string, Map<string, BuiltBackup[]>>()
  for (const b of backups) {
    const areas = stores.get(b.state) ?? new Map<string, BuiltBackup[]>()
    stores.set(b.state, areas)
    const rows = areas.get(b.area.areaPath) ?? []
    areas.set(b.area.areaPath, rows)
    rows.push(b)
  }
  const parkedAreas = new Map<string, BuiltParked[]>()
  for (const p of parks) {
    const rows = parkedAreas.get(p.areaDir) ?? []
    parkedAreas.set(p.areaDir, rows)
    rows.push(p)
  }
  const none = { temps: [], leftovers: [], orphanSidecars: [], anomalies: [] }
  return {
    discovery: { stateRoots: [...stores.keys()], roots: [], skipped: [] },
    parked: [...parkedAreas.values()].map((rows) => ({
      ref: {
        root: rows[0]!.root,
        areaDir: rows[0]!.areaDir,
        origin: 'root' as const,
        skillsRoot: rows[0]!.root,
      },
      absent: false,
      refused: null,
      rows: rows.map((r) => r.row),
      leftovers: [],
      orphanSidecars: [],
      anomalies: [],
    })),
    backups: [...stores].map(([state, areas]) => ({
      stateRoot: state,
      updateDir: `${state}/backups/update`,
      absent: false,
      refused: null,
      anomalies: [],
      areas: [...areas.values()].map((rows) => ({
        ...rows[0]!.area,
        rows: rows.map((r) => r.row),
        ...none,
      })),
    })),
    legacy: [],
    mcpStores: [],
    index: { facts: { reads: [], lines: [], rejected: [], unreadable: [] }, stale: [] },
    records: { live: new Map(), unreadable: [], scanFailures: [] },
    accounting: { rows: [], duplicates: [] },
    usageEntries: [],
    warning: { warn: false, perVolume: [], message: null },
    unmeasured: 0,
    client: null,
    narrowedTo: null,
    excludedByRoot: null,
    excludedByClient: null,
    ...over,
  }
}

const ONE_LOCK: LockAssignment = { kind: 'lock1', path: '/L/one.lock', root: '/roots/one' }

/** Every copy under one lock, unless `f` says otherwise. */
function locksFor(
  l: BackupsListing,
  f: (copyPath: string) => LockAssignment = () => ONE_LOCK
): LockMap {
  const m = new Map<string, LockAssignment>()
  for (const v of l.parked) for (const r of v.rows) m.set(r.copy.copyPath, f(r.copy.copyPath))
  for (const s of l.backups) {
    for (const a of s.areas) for (const r of a.rows) m.set(r.copy.copyPath, f(r.copy.copyPath))
  }
  return m
}

const req = (over: Partial<PruneRequest> = {}): PruneRequest => ({
  now: NOW,
  includeKept: false,
  allowChanged: [],
  ...over,
})

const items = (p: PrunePlan): PlanItem[] => p.groups.flatMap((g) => g.items)
const selected = (p: PrunePlan): string[] => items(p).map((i) => i.copyPath)
const reasonOf = (p: PrunePlan, copyPath: string): ExcludeReason | undefined =>
  p.excluded.find((e) => e.copyPath === copyPath)?.reason
const plan = (l: BackupsListing, r: PruneRequest, locks: LockMap = locksFor(l)): PrunePlan =>
  planPrune(l, r, locks)

describe('M-KEEP1: no selector selects nothing; the default --keep only guards', () => {
  const trees = [1, 2, 3].map((age) => backup({ age }))
  const l = listing(trees)

  it('--prune alone: noSelector, nothing selected, nothing excluded', () => {
    const p = plan(l, req())
    expect(p.noSelector).toBe(true)
    expect(p.groups).toEqual([])
    expect(p.excluded).toEqual([])
  })

  it('--prune --older-than 0: every tree but the newest; the newest is excluded newest-kept', () => {
    const p = plan(l, req({ olderThanDays: 0 }))
    expect(p.noSelector).toBe(false)
    expect(selected(p).sort()).toEqual(
      [trees[1]!.row.copy.copyPath, trees[2]!.row.copy.copyPath].sort()
    )
    expect(reasonOf(p, trees[0]!.row.copy.copyPath)).toEqual({ code: 'newest-kept' })
  })
})

describe('--keep (UD65, E43b, D5)', () => {
  it('M-K1: --keep 1 given: the newest backup is kept, the older ones selected', () => {
    const [newest, mid, old] = [1, 20, 40].map((age) => backup({ age }))
    const p = plan(listing([old!, newest!, mid!]), req({ keep: 1 }))
    expect(reasonOf(p, newest!.row.copy.copyPath)).toEqual({ code: 'newest-kept' })
    expect(selected(p).sort()).toEqual([mid!.row.copy.copyPath, old!.row.copy.copyPath].sort())
  })

  it('M-K2: the group includes client and root: each client keeps its own newest', () => {
    const claude = backup({ client: 'claude-code', age: 30 })
    const cursor = backup({ client: 'cursor', age: 2 })
    const p = plan(listing([claude, cursor]), req({ skill: 'foo' }))
    expect(reasonOf(p, claude.row.copy.copyPath)).toEqual({ code: 'newest-kept' })
    expect(reasonOf(p, cursor.row.copy.copyPath)).toEqual({ code: 'newest-kept' })
    expect(selected(p)).toEqual([])
  })

  it('M-K2: a group spans state roots: one newest across both', () => {
    const a = backup({ state: 'a', age: 1 })
    const b = backup({ state: 'b', age: 9 })
    const p = plan(listing([a, b]), req({ olderThanDays: 0 }))
    expect(reasonOf(p, a.row.copy.copyPath)).toEqual({ code: 'newest-kept' })
    expect(selected(p)).toEqual([b.row.copy.copyPath])
  })

  it('M-K3: an explicit --keep intersects with --older-than', () => {
    const t = [1, 5, 10, 40, 50, 60].map((age) => backup({ age }))
    const p = plan(listing(t), req({ olderThanDays: 30, keep: 2 }))
    expect(selected(p).sort()).toEqual(
      t
        .slice(3)
        .map((b) => b.row.copy.copyPath)
        .sort()
    )
    // The young non-newest tree (10 days) matches --keep but not --older-than: not even excluded.
    expect(reasonOf(p, t[2]!.row.copy.copyPath)).toBeUndefined()
  })

  it('M-K3: an explicit --keep selects only the kinds it counts', () => {
    const b = [1, 9].map((age) => backup({ age, opId: `op-b${age}` }))
    const undone = backup({ kind: 'undone', age: 50 })
    const p = plan(listing([...b, undone]), req({ keep: 1 }))
    expect(selected(p)).toEqual([b[1]!.row.copy.copyPath])
    expect(reasonOf(p, undone.row.copy.copyPath)).toBeUndefined()
  })

  it('M-K4: an unknown age is newer than every dated tree, always kept, and never --older-than', () => {
    const corrupt = backup({ kind: null, klass: 'unverified', age: null, opId: 'op-corrupt' })
    const [newest, mid, old] = [1, 20, 40].map((age) => backup({ age }))
    const all = listing([old!, corrupt, mid!, newest!])
    const allow = [corrupt.row.copy.copyPath]
    const p = plan(all, req({ keep: 1, includeKept: true, allowChanged: allow }))
    expect(reasonOf(p, corrupt.row.copy.copyPath)).toEqual({ code: 'unknown-age' })
    expect(reasonOf(p, newest!.row.copy.copyPath)).toEqual({ code: 'newest-kept' })
    expect(selected(p).sort()).toEqual([mid!.row.copy.copyPath, old!.row.copy.copyPath].sort())
    const older = plan(all, req({ olderThanDays: 0, includeKept: true, allowChanged: allow }))
    expect(reasonOf(older, corrupt.row.copy.copyPath)).toBeUndefined()
    expect(selected(older)).not.toContain(corrupt.row.copy.copyPath)
  })

  it('M-K5: merge-base is never-newest in the table, and its newest per group is kept', () => {
    expect(BACKUP_KIND_POLICY['merge-base'].neverNewest).toBe(true)
    const [newer, older] = [2, 30].map((age) => backup({ kind: 'merge-base', age }))
    const p = plan(listing([newer!, older!]), req({ olderThanDays: 0, includeKept: true }))
    expect(reasonOf(p, newer!.row.copy.copyPath)).toEqual({ code: 'newest-kept' })
    expect(selected(p)).toEqual([older!.row.copy.copyPath])
  })

  it('rejects a --keep that is not an integer, or is negative, rather than guarding nothing', () => {
    const l = listing([backup({ age: 1 }), backup({ age: 2 })])
    for (const keep of [Number.NaN, -1, 1.5]) {
      expect(() => plan(l, req({ keep }))).toThrow(TypeError)
    }
  })

  it("rejects --keep 0: it would select every group's newest tree (owner decision, keep >= 1)", () => {
    const l = listing([backup({ age: 1 }), backup({ age: 2 })])
    // Control: the smallest allowed value plans normally.
    expect(selected(plan(l, req({ keep: 1 })))).toHaveLength(1)
    expect(() => plan(l, req({ keep: 0 }))).toThrow(TypeError)
  })
})

describe('the kind table (UD64)', () => {
  it('an --include-kept kind needs the flag; with it, selected', () => {
    const c = backup({ kind: 'conflict', age: 9 })
    const l = listing([c])
    expect(reasonOf(plan(l, req({ olderThanDays: 0 })), c.row.copy.copyPath)).toEqual({
      code: 'needs-include-kept',
      kind: 'conflict',
    })
    expect(selected(plan(l, req({ olderThanDays: 0, includeKept: true })))).toEqual([
      c.row.copy.copyPath,
    ])
  })

  it('partial-copy is default only with sourceUnchanged: true', () => {
    const yes = backup({
      kind: 'partial-copy',
      sidecar: { kind: 'partial-copy', sourceUnchanged: true },
    })
    const no = backup({
      kind: 'partial-copy',
      sidecar: { kind: 'partial-copy', sourceUnchanged: false },
    })
    const p = plan(listing([yes, no]), req({ olderThanDays: 0 }))
    expect(selected(p)).toEqual([yes.row.copy.copyPath])
    expect(reasonOf(p, no.row.copy.copyPath)).toEqual({
      code: 'needs-include-kept',
      kind: 'partial-copy',
    })
  })

  it('an unknown kind (no parsed sidecar) needs --include-kept', () => {
    const odd = backup({ kind: null, opId: 'op-x', name: 'op-x.weird', klass: 'held' })
    const p = plan(listing([odd]), req({ op: 'op-x' }))
    expect(reasonOf(p, odd.row.copy.copyPath)).toEqual({ code: 'needs-include-kept', kind: null })
  })
})

describe('M-T1, M-T2: the tier follows the class, and the plan holds no authorization', () => {
  const newest = backup({ age: 0 })
  const byClass = (['held', 'changed', 'unverified'] as const).map((klass) =>
    backup({ klass, age: 10 })
  )
  const clean = backup({ age: 20 })
  const l = listing([newest, ...byClass, clean])

  it('without --allow-changed: needs-allow-changed with the class; clean is batch', () => {
    const p = plan(l, req({ olderThanDays: 0 }))
    for (const b of byClass) {
      expect(reasonOf(p, b.row.copy.copyPath)).toEqual({
        code: 'needs-allow-changed',
        klass: b.row.classification.klass,
      })
    }
    expect(items(p).map((i) => [i.copyPath, i.tier])).toEqual([[clean.row.copy.copyPath, 'batch']])
  })

  it('with --allow-changed naming each: per-item, never batch', () => {
    const allow = byClass.map((b) => b.row.copy.copyPath)
    const p = plan(l, req({ olderThanDays: 0, allowChanged: allow }))
    for (const b of byClass) {
      const it2 = items(p).find((i) => i.copyPath === b.row.copy.copyPath)
      expect(it2?.tier).toBe('per-item')
      expect(it2?.approvedHash).toBe(H_FRESH)
    }
    expect(items(p).find((i) => i.copyPath === clean.row.copy.copyPath)?.approvedHash).toBe(H_REC)
  })

  it('no item carries an authorization key (runtime)', () => {
    const p = plan(
      l,
      req({ olderThanDays: 0, allowChanged: byClass.map((b) => b.row.copy.copyPath) })
    )
    expect(items(p).length).toBe(4)
    for (const i of items(p)) expect(Object.keys(i)).not.toContain('authorization')
  })

  it('M-T2: the PlanItem type has no authorization key (type level)', () => {
    const i = items(plan(l, req({ olderThanDays: 0 })))[0]!
    // @ts-expect-error -- PlanItem omits `authorization`: the planner cannot pre-authorize (M-T2).
    const bad: PlanItem = { ...i, authorization: 'batch' }
    expect(bad.copyPath).toBe(i.copyPath)
  })

  it('a mounted copy is never offered, even with --allow-changed and --include-kept', () => {
    const m = backup({ klass: 'mounted', age: 30 })
    const p = plan(
      listing([newest, m]),
      req({ olderThanDays: 0, includeKept: true, allowChanged: [m.row.copy.copyPath] })
    )
    expect(reasonOf(p, m.row.copy.copyPath)).toEqual({ code: 'mounted' })
  })
})

describe('UD61 in the planner: protected and unknown are never selected', () => {
  it('a protected tree is excluded, naming the rule and path the listing found', () => {
    const p1 = backup({
      age: 9,
      protection: { status: 'protected', rule: 'backup-dest', path: '/st/op/record.json' },
    })
    const p = plan(listing([backup({ age: 0 }), p1]), req({ olderThanDays: 0 }))
    expect(reasonOf(p, p1.row.copy.copyPath)).toEqual({
      code: 'protected',
      rule: 'backup-dest',
      path: '/st/op/record.json',
    })
  })

  it('protection: unknown is never selected (protection-unknown)', () => {
    const u = backup({
      age: 9,
      protection: { status: 'unknown', reason: 'records under /r could not be read (EACCES)' },
    })
    const p = plan(listing([backup({ age: 0 }), u]), req({ olderThanDays: 0 }))
    expect(selected(p)).toEqual([])
    expect(reasonOf(p, u.row.copy.copyPath)).toEqual({
      code: 'protection-unknown',
      reason: 'records under /r could not be read (EACCES)',
    })
  })

  /** A record fact set with one unreadable record for `opId` in root `/r`. */
  const unreadableFor = (opId: string): RecordFacts => ({
    live: new Map<string, string>(),
    unreadable: [
      {
        root: '/r',
        record: { opId, path: `/r/st/${opId}/record.json`, why: 'not-json' as const },
      },
    ],
    scanFailures: [],
  })

  it("D17: a live unreadable record with the opId is named (the listing's rule, read by the planner)", () => {
    const records = unreadableFor('op-u')
    const protection = protectionOf(records, new Map(), {
      opId: 'op-u',
      kind: 'undone',
      sourceUnchanged: null,
    })
    const t = backup({ opId: 'op-u', kind: 'undone', protection })
    const p = plan(listing([t], [], { records }), req({ op: 'op-u' }))
    expect(reasonOf(p, t.row.copy.copyPath)).toEqual({
      code: 'protection-unknown',
      reason: 'the unreadable update record /r/st/op-u/record.json has this operation id',
    })
    expect(p.preconditions).toEqual([
      { code: 'unreadable-record', root: '/r', recordPath: '/r/st/op-u/record.json' },
    ])
  })

  it('M5: D17 for a parked copy: the unreadable record with its opId is named, and it is never selected', () => {
    const records = unreadableFor('op-u')
    const pk = parked({ opId: 'op-u' })
    const protection = protectionOf(records, new Map(), {
      copyPath: pk.row.copy.copyPath,
      opId: 'op-u',
      kind: 'uninstall',
      sourceUnchanged: null,
      store: 'parked',
    })
    expect(protection).toEqual({
      status: 'unknown',
      reason: 'the unreadable update record /r/st/op-u/record.json has this operation id',
    })
    const withIt = parked({ opId: 'op-u', protection })
    const p = plan(listing([], [withIt], { records }), req({ op: 'op-u' }))
    expect(selected(p)).toEqual([])
    expect(reasonOf(p, withIt.row.copy.copyPath)).toEqual({
      code: 'protection-unknown',
      reason: 'the unreadable update record /r/st/op-u/record.json has this operation id',
    })
  })

  it('the planner has no protection rule of its own: a parked row is judged by its protection alone', () => {
    // Every other fact equal, including a sibling unreadable-record copy with the same opId and
    // an unreadable live record with it: only the row's own protection decides.
    const records = unreadableFor('op-P')
    const rec = parked({ root: 'z', opId: 'op-P', kind: 'unreadable-record' })
    const free = parked({ root: 'a', opId: 'op-P', origin: 'free' })
    const unknownRow = parked({
      root: 'b',
      opId: 'op-P',
      origin: 'unk',
      protection: { status: 'unknown', reason: 'planted unknown' },
    })
    const prot = parked({
      root: 'c',
      opId: 'op-P',
      origin: 'prot',
      protection: { status: 'protected', rule: 'parked-unreadable-record', path: '/x/rec' },
    })
    const l = listing([], [rec, free, unknownRow, prot], { records })
    const p = plan(l, req({ op: 'op-P' }))
    expect(selected(p)).toEqual([free.row.copy.copyPath])
    expect(reasonOf(p, unknownRow.row.copy.copyPath)).toEqual({
      code: 'protection-unknown',
      reason: 'planted unknown',
    })
    expect(reasonOf(p, prot.row.copy.copyPath)).toEqual({
      code: 'protected',
      rule: 'parked-unreadable-record',
      path: '/x/rec',
    })
  })

  it('M6: an explicit --keep never selects a parked copy', () => {
    const [newest, old] = [1, 9].map((age) => backup({ age, opId: `op-k${age}` }))
    const pk = parked({ root: 'one', opId: 'op-pk' })
    const p = plan(listing([newest!, old!], [pk]), req({ keep: 1 }))
    expect(selected(p)).toEqual([old!.row.copy.copyPath])
    expect(selected(p)).not.toContain(pk.row.copy.copyPath)
    expect(reasonOf(p, pk.row.copy.copyPath)).toBeUndefined()
  })
})

describe('locks (UD62, UD63): unknown or missing is never selected', () => {
  it('lock-unknown with its reason, and a copy missing from the map', () => {
    const a = backup({ age: 9, opId: 'op-a' })
    const b = backup({ age: 8, opId: 'op-b' })
    const l = listing([backup({ age: 0 }), a, b])
    const locks = new Map(locksFor(l))
    locks.set(a.row.copy.copyPath, { kind: 'unknown', reason: 'staging-unsafe root' })
    locks.delete(b.row.copy.copyPath)
    const p = plan(l, req({ olderThanDays: 0 }), locks)
    expect(reasonOf(p, a.row.copy.copyPath)).toEqual({
      code: 'lock-unknown',
      reason: 'staging-unsafe root',
    })
    expect(reasonOf(p, b.row.copy.copyPath)).toEqual({
      code: 'lock-unknown',
      reason: 'no lock was assigned',
    })
    expect(p.groups).toEqual([])
  })
})

describe('unidentified: no deletion job can name the copy', () => {
  it('a copy root with no identity, or a clean copy with no recorded hash, is excluded unidentified', () => {
    const noId = backup({ age: 9, opId: 'op-noid', cls: { rootIdentity: null } })
    const noHash = backup({ age: 8, opId: 'op-nohash', cls: { recordedHash: null } })
    const p = plan(listing([backup({ age: 0 }), noId, noHash]), req({ olderThanDays: 0 }))
    expect(reasonOf(p, noId.row.copy.copyPath)).toEqual({
      code: 'unidentified',
      reason: 'the copy root could not be identified, so no deletion job can name it',
    })
    expect(reasonOf(p, noHash.row.copy.copyPath)).toEqual({
      code: 'unidentified',
      reason: 'the tree could not be hashed, so there is no hash to approve',
    })
    expect(selected(p)).not.toContain(noId.row.copy.copyPath)
    expect(selected(p)).not.toContain(noHash.row.copy.copyPath)
  })
})

describe('M-ORD: groups in ascending bytewise order of the lock path (UD60)', () => {
  it('U+FF5A sorts before U+1F600 by bytes, whatever order the listing gave', () => {
    const emoji = parked({ root: 'e', origin: 'e' })
    const fullwidth = parked({ root: 'f', origin: 'f' })
    const l = listing([], [emoji, fullwidth])
    const lockOf = (cp: string): LockAssignment =>
      cp === emoji.row.copy.copyPath
        ? { kind: 'lock1', path: '/L/\u{1F600}.lock', root: emoji.root }
        : { kind: 'lock1', path: '/L/\u{FF5A}.lock', root: fullwidth.root }
    const p = plan(l, req({ olderThanDays: 0 }), locksFor(l, lockOf))
    expect(p.groups.map((g) => g.lock.path)).toEqual(['/L/\u{FF5A}.lock', '/L/\u{1F600}.lock'])
    // The control: UTF-16 order is the reverse, so a default sort would flip it.
    expect(['/L/\u{FF5A}.lock', '/L/\u{1F600}.lock'].sort()).toEqual([
      '/L/\u{1F600}.lock',
      '/L/\u{FF5A}.lock',
    ])
  })

  it('a group carries its lock, its items in bytewise order, and the areas they are listed in', () => {
    const x = parked({ root: 'one', origin: 'z' })
    const y = parked({ root: 'one', origin: 'a' })
    const p = plan(listing([], [x, y]), req({ olderThanDays: 0 }))
    expect(p.groups).toHaveLength(1)
    expect(p.groups[0]!.lock).toEqual(ONE_LOCK)
    expect(p.groups[0]!.items.map((i) => i.copyPath)).toEqual(
      [y.row.copy.copyPath, x.row.copy.copyPath].sort()
    )
    expect(p.groups[0]!.scope.areaPaths).toEqual([x.areaDir])
  })
})

describe('the job fields (D14) and the digest (M-D2)', () => {
  it('a backup stages in its area; a parked copy in .skillsmith-parked with its op dir', () => {
    const b = backup({ age: 9 })
    const pk = parked({ root: 'one' })
    const p = plan(listing([backup({ age: 0 }), b], [pk]), req({ olderThanDays: 0 }))
    const bi = items(p).find((i) => i.copyPath === b.row.copy.copyPath)!
    expect([bi.stagingRoot, bi.opDir, bi.leaf]).toEqual([
      b.area.areaPath,
      b.area.areaPath,
      b.row.copy.name,
    ])
    const pi = items(p).find((i) => i.copyPath === pk.row.copy.copyPath)!
    expect([pi.stagingRoot, pi.opDir]).toEqual([pk.areaDir, `${pk.areaDir}/${pk.row.copy.opId}`])
    expect(pi.sidecarPath).toBe(`${pk.row.copy.copyPath}.json`)
  })

  const digestWith = (
    mutate: (c: Classification) => void,
    tier: 'clean' | 'changed' = 'clean'
  ): string => {
    nextIno = 500n
    // `undone` is not counted by --keep, so the lone tree is selectable.
    const b = backup({ age: 9, opId: 'op-d', kind: 'undone', klass: tier })
    mutate(b.row.classification)
    const l = listing([b])
    return plan(l, req({ op: 'op-d', allowChanged: [b.row.copy.copyPath] })).groups[0]!.digest
  }

  it('the digest moves with the sidecar bytes, the approved hash, the identity, the class and the tier', () => {
    const base = digestWith(() => undefined)
    expect(digestWith(() => undefined)).toBe(base)
    expect(digestWith((c) => (c.sidecarRead!.bytes = Buffer.from('{"k":2}')))).not.toBe(base)
    expect(digestWith((c) => (c.recordedHash = 'b'.repeat(64)))).not.toBe(base)
    expect(digestWith((c) => (c.rootIdentity = { ...c.rootIdentity!, ino: 999n }))).not.toBe(base)
    expect(digestWith((c) => (c.rootIdentity = { ...c.rootIdentity!, fmt: 0o100000n }))).not.toBe(
      base
    )
    expect(digestWith(() => undefined, 'changed')).not.toBe(base)
  })
})

describe('D18 and D10: unmatched paths and preconditions', () => {
  it('each --path naming no listed copy is reported with why; a listed one is not', () => {
    const b = backup({ age: 9 })
    const l = listing([b], [], {
      legacy: [
        { root: '/r', paths: ['/r/.foo.skillsmith-removing-' + '0'.repeat(32)], unreadable: null },
      ],
      mcpStores: [
        { root: '/r', path: '/r/.backups', allocatedBytes: 0, apparentBytes: 0, unmeasured: 0 },
      ],
      index: {
        facts: {
          reads: [{ stateRoot: '/s/st', indexPath: '/s/st/parked-index.jsonl', present: true }],
          lines: [],
          rejected: [],
          unreadable: [],
        },
        stale: [],
      },
    })
    l.backups[0]!.areas[0]!.temps.push({
      path: `${b.area.areaPath}/.tmp-op-9`,
      kind: 'copy-temp',
      base: 'op-9',
      ownedBy: null,
    })
    const paths = [
      b.row.copy.copyPath,
      `${b.area.areaPath}/.prune-0123456789abcdef`,
      `${b.area.areaPath}/.tmp-op-9`,
      '/s/st/parked-index.jsonl',
      '/r/.foo.skillsmith-removing-' + '0'.repeat(32),
      '/r/.backups/x',
      `${b.row.copy.copyPath}.json`,
      `${b.area.areaPath}/gone`,
      '/elsewhere/tree',
    ]
    const p = plan(l, req({ paths }))
    expect(p.unmatchedPaths.map((u) => [u.path, u.why.split(':')[0]])).toEqual([
      [paths[1], 'a .prune-* directory'],
      [paths[2], 'an unfinished temp'],
      [paths[3], 'the parked index'],
      [paths[4], 'a legacy removal leftover'],
      [paths[5], 'the older MCP backup store'],
      [paths[6], 'a sidecar, not a tree'],
      [paths[7], 'not found'],
      [paths[8], 'outside every store prune lists'],
    ])
  })

  it('refused areas, an unreadable index and a record scan failure are preconditions, even with no selector', () => {
    const pk = parked({ root: 'one' })
    const l = listing([backup()], [pk], {
      records: {
        live: new Map(),
        unreadable: [],
        scanFailures: [{ root: '/r', path: '/r/.skillsmith-staging', errno: 'EACCES' }],
      },
      index: {
        facts: {
          reads: [],
          lines: [],
          rejected: [],
          unreadable: [{ stateRoot: '/s', indexPath: '/s/parked-index.jsonl', errno: 'EISDIR' }],
        },
        stale: [],
      },
    })
    l.parked[0]!.refused = 'not our uid'
    l.backups[0]!.refused = 'a symlink'
    const p = plan(l, req())
    expect(p.preconditions).toEqual([
      { code: 'unreadable-record', root: '/r', recordPath: '/r/.skillsmith-staging' },
      { code: 'area-refused', path: pk.areaDir, reason: 'not our uid' },
      { code: 'area-refused', path: '/s/st/backups/update', reason: 'a symlink' },
      {
        code: 'area-refused',
        path: '/s/parked-index.jsonl',
        reason: 'the parked index could not be read (EISDIR)',
      },
    ])
  })
})

describe('the digest covers copyPath and kind (M1, M2)', () => {
  const item = (): PlanItem => {
    nextIno = 700n
    const b = backup({ age: 9, opId: 'op-dg', kind: 'undone' })
    const p = plan(listing([b]), req({ op: 'op-dg' }))
    return p.groups[0]!.items[0]!
  }

  it('M1: a changed copyPath alone changes the digest', () => {
    const i = item()
    const base = groupDigest('/L/one.lock', [i])
    expect(groupDigest('/L/one.lock', [{ ...i }])).toBe(base)
    expect(groupDigest('/L/one.lock', [{ ...i, copyPath: `${i.copyPath}-other` }])).not.toBe(base)
  })

  it('M2: a changed kind alone changes the digest', () => {
    const i = item()
    const base = groupDigest('/L/one.lock', [i])
    expect(groupDigest('/L/one.lock', [{ ...i, kind: 'conflict' }])).not.toBe(base)
  })
})

describe("M3: a group's scope holds every area of its keep group, across state roots", () => {
  /** The listing as `listBackups({ scope })` shows it: only the scoped areas. */
  const scoped = (l: BackupsListing, areaPaths: readonly string[]): BackupsListing => ({
    ...l,
    parked: l.parked.filter((v) => areaPaths.includes(v.ref.areaDir)),
    backups: l.backups.map((s) => ({
      ...s,
      areas: s.areas.filter((a) => areaPaths.includes(a.areaPath)),
    })),
  })

  it('the newest tree is in another state root with no item: its area is in scope, and the re-plan agrees', () => {
    const newest = backup({ state: 'b', age: 1, opId: 'op-n' })
    const older = [10, 20].map((age) => backup({ state: 'a', age, opId: `op-o${age}` }))
    const l = listing([older[0]!, older[1]!, newest])
    const r = req({ olderThanDays: 0 })
    const p = plan(l, r)
    expect(p.groups).toHaveLength(1)
    const g = p.groups[0]!
    expect(g.items.map((i) => i.copyPath).sort()).toEqual(
      older.map((o) => o.row.copy.copyPath).sort()
    )
    expect(g.scope.areaPaths).toEqual([older[0]!.area.areaPath, newest.area.areaPath])
    const again = plan(scoped(l, g.scope.areaPaths), r).groups[0]
    expect(again?.items.map((i) => i.copyPath)).toEqual(g.items.map((i) => i.copyPath))
    expect(again?.digest).toBe(g.digest)
  })
})

describe('the planner root key', () => {
  // The planner keeps its own copy (src/install imports nothing from services); --root matching
  // for a backup with no parsed sidecar compares it with the area's key, so the two must agree.
  it('equals the services rootKeyOf, which names the backup area', () => {
    for (const r of ['/a', '/Users/x/.claude/skills', '/tmp/s p/ace', '/é/\u{1F600}']) {
      expect(planRootKeyOf(r)).toBe(rootKeyOf(r))
    }
  })

  it('agrees on inputs a normalising, trimming or lossy copy would get wrong', () => {
    // Composed and decomposed forms are different paths on disk and must key differently,
    // as they do in the writer; so must lone surrogates, NUL, and trailing whitespace.
    const cp = (...points: number[]): string => String.fromCodePoint(...points)
    const composed = `/${cp(0xe9)}/skills`
    const decomposed = `/${cp(0x65, 0x301)}/skills`
    const angstromSign = `/${cp(0x212b)}`
    const ringA = `/${cp(0xc5)}`
    // The pairs really are distinct strings, so an editor that normalises cannot hollow this out.
    expect(composed).not.toBe(decomposed)
    expect(angstromSign).not.toBe(ringA)
    const edge = [
      composed,
      decomposed,
      angstromSign,
      ringA,
      `/${String.fromCharCode(0xd800)}`,
      `/${String.fromCharCode(0xdfff)}/x`,
      `/a${String.fromCharCode(0)}b`,
      '/skills ',
      ' /skills',
      '',
    ]
    for (const r of edge) expect(planRootKeyOf(r)).toBe(rootKeyOf(r))
    expect(planRootKeyOf(composed)).not.toBe(planRootKeyOf(decomposed))
    expect(planRootKeyOf(angstromSign)).not.toBe(planRootKeyOf(ringA))
    // A fixed-seed sweep over arbitrary UTF-16 code units, surrogates included.
    let seed = 0x6531
    const next = (): number => (seed = (seed * 1103515245 + 12345) >>> 0)
    for (let i = 0; i < 500; i++) {
      const len = next() % 24
      let s = '/'
      for (let j = 0; j < len; j++) s += String.fromCharCode(next() % 0x10000)
      expect(planRootKeyOf(s)).toBe(rootKeyOf(s))
    }
  })
})
