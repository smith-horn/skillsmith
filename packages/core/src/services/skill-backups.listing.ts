/**
 * SMI-6531 (A1 step 6c-ii-a): `listBackups`, the read-only listing behind
 * `skillsmith doctor backups` (PLAN 2046; UD22, UD58, UD61, UD66).
 *
 * Discovery, then each store through the `src/install` listers (parked areas
 * and the update backup store), classify and measure every copy once, merge
 * the parked index, list legacy `.skillsmith-removing-` leftovers and the old
 * MCP store, and gather the UD61 record facts. It returns data and the space
 * warning's verdict; rendering is the CLI's.
 *
 * Accounting is one ledger (`skill-backups.ledger.ts`): every path the listing
 * reads, every store or area root, and every path the parked index names gets
 * exactly one row: measured, unmeasured with a reason, or exempt for a reason
 * in a closed set. The space warning reads the ledger and nothing else, and
 * `--root` / `--client` count what they hide from the same rows.
 *
 * It reads and never writes: no delete, rename, mkdir, create or lock, and it
 * never creates a skills root or a state root (a missing one is simply not
 * there). The zero-mutation test in the CLI spies every write-family fs member
 * over a full run.
 *
 * `scope` restricts which areas are SHOWN (a later re-plan lists one lock
 * group). Everything that is a fact about the whole machine is computed over
 * every discovered area and root: the record scan and the parked unreadable
 * records UD61 rule (c) reads, the ledger and so the space warning, and the
 * index's stale lines.
 *
 * @module @skillsmith/core/services/skill-backups.listing
 */
import fs from 'node:fs'
import path from 'node:path'
import { classifyCopy } from '../install/prune.classify.js'
import type { Classification } from '../install/prune.classify.js'
import { measure } from '../install/prune.measure.js'
import type { Measured } from '../install/prune.measure.js'
import { listBackupStore } from '../install/prune.list.backups.js'
import { listParkedArea } from '../install/prune.list.parked.js'
import { policyFor } from '../install/prune.kinds.js'
import { evaluateParkedUsage } from '../install/parked-usage.js'
import type { ParkedUsageOptions } from '../install/parked-usage.js'
import { listRemovingLeftovers } from '../install/remove-if-same.js'
import type { Leftover } from '../install/prune.leftovers.js'
import type { BackupAreaListing, ListedCopy } from '../install/prune.list.types.js'
import { discoverRoots } from './skill-recovery.discover.js'
import type { Discovery, DiscoverOptions } from './skill-recovery.discover.js'
import { indexOnlyAreas, readIndexes, scannedAreas, staleLines } from './skill-backups.areas.js'
import { collectRecordFacts, protectionOf } from './skill-backups.records.js'
import type { RecordFacts } from './skill-backups.records.js'
import { narrowToClient, narrowToRoots } from './skill-backups.narrow.js'
import { Ledger, usageFromLedger } from './skill-backups.ledger.js'
import type { LedgerRow } from './skill-backups.ledger.js'
import {
  ledgerBackupStore,
  ledgerIndex,
  ledgerLegacy,
  ledgerMcpStore,
  ledgerParkedArea,
} from './skill-backups.ledger.stores.js'
import type { LedgerCtx } from './skill-backups.ledger.stores.js'
import type {
  BackupAreaView,
  BackupRow,
  BackupsListing,
  LeftoverView,
  LegacyLeftovers,
  ListScope,
  McpStoreView,
  ParkedAreaView,
  ParkedRow,
} from './skill-backups.listing.types.js'

export type * from './skill-backups.listing.types.js'

export interface ListBackupsOptions {
  /** `--state-root`: replaces the discovered state roots. */
  stateRoot?: string
  /** `--root`: extra skills roots. */
  roots?: readonly string[]
  /** `--client`: narrows the rows (the warning still counts everything). */
  client?: string
  scope?: ListScope
  /** The clock, ms since the epoch (default `Date.now()`). */
  now?: number
  /** Passed to the space warning (a test injects `statfs`). */
  usage?: ParkedUsageOptions
  /** A discovery the caller already made (a doctor action reuses the roots it just acted on). */
  discovered?: Discovery
  /** @internal Test seam: discovery overrides (home, cwd, the nine client roots). */
  discovery?: Partial<DiscoverOptions>
  /** @internal Test seam: replaces the size walk (a test injects an unmeasured entry). */
  measure?: (abs: string) => Measured
}

const DAY_MS = 86_400_000

type Classify = (copy: ListedCopy, store: 'parked' | 'backup') => Classification

const str = (o: Record<string, unknown> | null, k: string): string | null =>
  o !== null && typeof o[k] === 'string' ? (o[k] as string) : null

/** The text of `originPath` from a sidecar that failed its schema, as the spike's `readOrigin`. */
function looseOrigin(c: Classification): string | null {
  if (c.sidecarRead === null) return null
  try {
    const o = (JSON.parse(c.sidecarRead.bytes.toString('utf8')) as { originPath?: unknown })
      .originPath
    return typeof o === 'string' ? o : null
  } catch {
    return null
  }
}

/** Creation time: the sidecar's `createdAt`, else the copy's mtime; null when neither is known. */
function createdOf(c: Classification, copyPath: string, useMtime: boolean): number | null {
  const iso = str(c.sidecar, 'createdAt')
  if (iso !== null) {
    const t = Date.parse(iso)
    if (!Number.isNaN(t)) return t
  }
  if (!useMtime) return null
  try {
    return fs.lstatSync(copyPath).mtimeMs
  } catch {
    return null
  }
}

const sizesOf = (
  m: Measured
): { allocatedBytes: number; apparentBytes: number; unmeasured: number } => ({
  allocatedBytes: m.allocatedBytes,
  apparentBytes: m.apparentBytes,
  unmeasured: m.unmeasured,
})

const ageOf = (ms: number | null, now: number): number | null =>
  ms === null ? null : Math.max(0, Math.floor((now - ms) / DAY_MS))

const leftoverView = (l: Leftover): LeftoverView => ({
  leftover: l,
  resumeOffered: l.state === 'interrupted-delete' && l.item !== undefined,
})

function parkedRow(
  copy: ListedCopy,
  now: number,
  indexed: ReadonlySet<string>,
  classify: Classify
): ParkedRow {
  const classification = classify(copy, 'parked')
  const createdMs = createdOf(classification, copy.copyPath, true)
  return {
    copy,
    classification,
    kind: classification.kind,
    origin: str(classification.sidecar, 'originPath') ?? looseOrigin(classification),
    createdMs,
    ageDays: ageOf(createdMs, now),
    index: indexed.has(copy.copyPath) ? 'present' : 'missing',
    ...sizesOf(classification.measured),
  }
}

/** A kept tree, classified. Its protection is filled in once the whole ledger is known. */
function backupRow(copy: ListedCopy, a: BackupAreaListing, now: number, classify: Classify) {
  const classification = classify(copy, 'backup')
  const createdMs = createdOf(classification, copy.copyPath, false)
  const row: BackupRow = {
    copy,
    classification,
    kind: classification.kind,
    createdMs,
    ageDays: ageOf(createdMs, now),
    client: a.client,
    skillsDir: str(classification.sidecar, 'skillsDir'),
    dirName: a.dirName,
    opId: str(classification.sidecar, 'opId') ?? copy.opId,
    hashStillEquals:
      classification.klass === 'clean' ? true : classification.klass === 'changed' ? false : null,
    protection: { status: 'unprotected' },
    newestOfGroup: false,
    ...sizesOf(classification.measured),
  }
  return row
}

/** The group key `--keep` counts by (UD65, E43b): the sidecar's own fields, not the path's. */
function groupKey(row: BackupRow): string | null {
  const sc = row.classification.sidecar
  // Only a tree whose sidecar verified and whose area agrees with it (clean or changed) is
  // grouped: an unverified or held tree must not be grouped by a sidecar it may not own (E43b).
  const klass = row.classification.klass
  if (sc === null || (klass !== 'clean' && klass !== 'changed')) return null
  const client = str(sc, 'client')
  const dir = str(sc, 'skillsDir')
  const name = str(sc, 'dirName')
  if (client === null || dir === null || name === null || row.createdMs === null) return null
  const counted = row.kind !== null && policyFor('backup', row.kind)?.countedByKeep === true
  return counted ? [client, dir, name].join('\0') : null
}

/** Marks the newest counted tree of each group. A tie goes to the later tree name. */
function markNewest(rows: BackupRow[]): void {
  const best = new Map<string, BackupRow>()
  for (const r of rows) {
    const k = groupKey(r)
    if (k === null) continue
    const cur = best.get(k)
    const newer =
      cur === undefined ||
      (r.createdMs as number) > (cur.createdMs as number) ||
      (r.createdMs === cur.createdMs && r.copy.name > cur.copy.name)
    if (newer) best.set(k, r)
  }
  for (const r of best.values()) r.newestOfGroup = true
}

/** The old MCP backup store of each discovered Claude Code root: reported, never selected (D7). */
function mcpStores(
  ctx: LedgerCtx,
  roots: readonly { root: string; sources: string[] }[]
): McpStoreView[] {
  const out: McpStoreView[] = []
  for (const r of roots) {
    if (!r.sources.includes('client:claude-code')) continue
    const p = path.join(r.root, '.backups')
    const m = ledgerMcpStore(ctx, r.root, p)
    if (m !== null) out.push({ root: r.root, path: p, ...sizesOf(m) })
  }
  return out
}

async function legacyLeftovers(ctx: LedgerCtx, roots: readonly string[]) {
  const out: LegacyLeftovers[] = []
  for (const root of roots) {
    const scan = await listRemovingLeftovers(root)
    const unreadable = scan.unreadable ?? null
    ledgerLegacy(ctx, root, scan.parked, unreadable)
    if (scan.parked.length > 0 || unreadable !== null) {
      out.push({ root, paths: scan.parked, unreadable })
    }
  }
  return out
}

/** UD61 (a), (b) and (c) for every kept tree, once the ledger says what could not be seen. */
function protect(
  rows: readonly BackupRow[],
  records: RecordFacts,
  parkedUnreadable: ReadonlyMap<string, string>,
  ledger: readonly LedgerRow[],
  maybe: ReadonlyMap<string, string>
): void {
  // Rule (c) cannot be ruled out for what the parked scan or the index could not see.
  const hidden = ledger
    .filter((r) => r.mayHideCopies && (r.where.store === 'parked' || r.where.store === 'index'))
    .map((r) => r.path)
  for (const r of rows) {
    const s = r.classification.sidecar?.['sourceUnchanged']
    r.protection = protectionOf(
      records,
      parkedUnreadable,
      {
        copyPath: r.copy.copyPath,
        opId: r.opId,
        kind: r.kind,
        sourceUnchanged: typeof s === 'boolean' ? s : null,
      },
      { hidden, maybe }
    )
  }
}

/** Lists everything `doctor backups` reports. Reads only. */
export async function listBackups(options: ListBackupsOptions = {}): Promise<BackupsListing> {
  const now = options.now ?? Date.now()
  const inScope = (p: string): boolean =>
    options.scope?.areaPaths === undefined || options.scope.areaPaths.includes(p)
  const discovery =
    options.discovered ??
    (await discoverRoots({
      ...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
      ...(options.roots === undefined || options.roots.length === 0
        ? {}
        : { roots: options.roots }),
      ...options.discovery,
    }))
  const rootPaths = discovery.roots.map((r) => r.root)
  const measureOf = options.measure ?? measure
  const classify: Classify = (copy, store) => {
    const c = classifyCopy(copy, store)
    return options.measure === undefined ? c : { ...c, measured: options.measure(copy.copyPath) }
  }
  const records = await collectRecordFacts(rootPaths)
  const facts = readIndexes(discovery.stateRoots)
  const scanned = scannedAreas(rootPaths)
  const areas = [...scanned, ...indexOnlyAreas(facts, scanned)]
  const indexed = new Set(facts.lines.map((l) => l.copyPath))
  const ctx: LedgerCtx = { ledger: new Ledger(), measureOf }
  const found = new Set<string>()
  const listedAreas = new Set<string>()

  const parked: ParkedAreaView[] = []
  const parkedUnreadable = new Map<string, string>()
  // A parked copy whose kind could not be read may be an unreadable record (rule (c)).
  const maybe = new Map<string, string>()
  for (const ref of areas) {
    if (ref.skipped !== undefined) {
      ledgerParkedArea(ctx, ref, null, [])
      if (inScope(ref.areaDir)) {
        const anomalies = [{ path: ref.root, detail: ref.skipped }]
        parked.push({
          ref,
          absent: false,
          refused: null,
          rows: [],
          leftovers: [],
          orphanSidecars: [],
          anomalies,
        })
      }
      continue
    }
    const l = listParkedArea(ref.root)
    if (!l.absent && l.refused === null) listedAreas.add(ref.areaDir)
    const rows = l.copies.map((c) => parkedRow(c, now, indexed, classify))
    for (const r of rows) {
      found.add(r.copy.copyPath)
      if (r.kind === 'unreadable-record') parkedUnreadable.set(r.copy.opId, r.copy.copyPath)
      else if (r.kind === null) maybe.set(r.copy.opId, r.copy.copyPath)
    }
    ledgerParkedArea(ctx, ref, l, rows)
    if (!inScope(ref.areaDir)) continue
    parked.push({
      ref,
      absent: l.absent,
      refused: l.refused,
      rows,
      leftovers: l.leftovers.map(leftoverView),
      orphanSidecars: l.orphanSidecars,
      anomalies: l.anomalies,
    })
  }

  const backupRows: BackupRow[] = []
  const backups = discovery.stateRoots.map((stateRoot) => {
    const updateDir = path.join(stateRoot, 'backups', 'update')
    const store = listBackupStore(updateDir)
    const byArea = new Map<string, BackupRow[]>()
    const views: BackupAreaView[] = []
    for (const a of store.areas) {
      const rows = a.copies.map((copy) => backupRow(copy, a, now, classify))
      byArea.set(a.areaPath, rows)
      backupRows.push(...rows)
      const temps = a.temps.map((t) => ({
        ...t,
        ownedBy: records.live.get(t.base.split('.')[0] as string) ?? null,
      }))
      listedAreas.add(a.areaPath)
      if (!inScope(a.areaPath)) continue
      views.push({
        areaPath: a.areaPath,
        client: a.client,
        rootKey: a.rootKey,
        dirName: a.dirName,
        rows,
        temps,
        leftovers: a.leftovers.map(leftoverView),
        orphanSidecars: a.orphanSidecars,
        anomalies: a.anomalies,
      })
    }
    ledgerBackupStore(ctx, store, byArea)
    return {
      stateRoot,
      updateDir,
      absent: store.absent,
      refused: store.refused,
      anomalies: store.anomalies,
      areas: views,
    }
  })
  // One newest per (client, skillsDir, dirName) across every state root and regardless of
  // scope (PLAN:2046): the views hold these same row objects, so the mark shows through.
  markNewest(backupRows)

  const mcp = mcpStores(ctx, discovery.roots)
  const legacy = await legacyLeftovers(ctx, rootPaths)
  // Last, so a path the index names that a store already accounts for is not counted twice.
  ledgerIndex(ctx, facts)
  const ledgerRows = ctx.ledger.rows()
  protect(backupRows, records, parkedUnreadable, ledgerRows, maybe)
  const usageEntries = usageFromLedger(ledgerRows)
  const warning = evaluateParkedUsage(usageEntries, options.usage)
  const stale = staleLines(
    facts,
    found,
    new Set(areas.filter((a) => listedAreas.has(a.areaDir)).map((a) => a.areaDir))
  )
  const listing: BackupsListing = {
    discovery,
    parked,
    backups,
    legacy,
    mcpStores: mcp,
    index: { facts, stale },
    records,
    accounting: { rows: ledgerRows, duplicates: [...ctx.ledger.duplicates] },
    usageEntries,
    warning,
    unmeasured: usageEntries.reduce((n, e) => n + e.unmeasured, 0),
    client: options.client ?? null,
    narrowedTo: null,
    excludedByRoot: null,
    excludedByClient: null,
  }
  const byClient = options.client === undefined ? listing : narrowToClient(listing, options.client)
  // `--root` narrows as well as adds (PLAN 2046, UD22): only when the caller gave roots itself.
  const given = options.discovered === undefined && (options.roots ?? []).length > 0
  if (!given) return byClient
  const wanted = discovery.roots.filter((r) => r.sources.includes('--root')).map((r) => r.root)
  return narrowToRoots(byClient, wanted)
}
