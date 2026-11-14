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
 * It reads and never writes: no delete, rename, mkdir, create or lock, and it
 * never creates a skills root or a state root (a missing one is simply not
 * there). The zero-mutation test in the CLI spies every write-family fs member
 * over a full run.
 *
 * `scope` restricts which areas are listed (a later re-plan lists one lock
 * group); the record scan still covers every discovered root, because UD61
 * protection depends on records in all of them.
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
import type { ParkedUsageEntry, ParkedUsageOptions } from '../install/parked-usage.js'
import { listRemovingLeftovers } from '../install/remove-if-same.js'
import type { Leftover } from '../install/prune.leftovers.js'
import type { ListedCopy } from '../install/prune.list.types.js'
import { discoverRoots } from './skill-recovery.discover.js'
import type { Discovery, DiscoverOptions } from './skill-recovery.discover.js'
import { indexOnlyAreas, readIndexes, scannedAreas, staleLines } from './skill-backups.areas.js'
import { collectRecordFacts, protectionOf } from './skill-backups.records.js'
import { narrowToRoots } from './skill-backups.narrow.js'
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

function usageOf(
  p: string,
  storeDir: string,
  m: Measured,
  originPath: string | null,
  label: string
): ParkedUsageEntry {
  return { path: p, storeDir, units: m.units, unmeasured: m.unmeasured, originPath, opId: label }
}

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
  roots: readonly { root: string; sources: string[] }[],
  entries: ParkedUsageEntry[],
  measureOf: (abs: string) => Measured
): McpStoreView[] {
  const out: McpStoreView[] = []
  for (const r of roots) {
    if (!r.sources.includes('client:claude-code')) continue
    const p = path.join(r.root, '.backups')
    try {
      const st = fs.lstatSync(p)
      if (st.isSymbolicLink() || !st.isDirectory()) continue
    } catch {
      continue
    }
    const m = measureOf(p)
    out.push({ root: r.root, path: p, ...sizesOf(m) })
    entries.push(usageOf(p, r.root, m, null, '.backups'))
  }
  return out
}

async function legacyLeftovers(roots: readonly string[]): Promise<LegacyLeftovers[]> {
  const out: LegacyLeftovers[] = []
  for (const root of roots) {
    const scan = await listRemovingLeftovers(root)
    const unreadable = scan.unreadable ?? null
    if (scan.parked.length > 0 || unreadable !== null) {
      out.push({ root, paths: scan.parked, unreadable })
    }
  }
  return out
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
  const usageEntries: ParkedUsageEntry[] = []
  const found = new Set<string>()
  const listedAreas = new Set<string>()

  const parked: ParkedAreaView[] = []
  const parkedUnreadable = new Map<string, string>()
  for (const ref of areas) {
    if (!inScope(ref.areaDir)) continue
    const l = listParkedArea(ref.root)
    if (!l.absent && l.refused === null) listedAreas.add(ref.areaDir)
    const rows = l.copies.map((c) => parkedRow(c, now, indexed, classify))
    for (const r of rows) {
      found.add(r.copy.copyPath)
      if (r.kind === 'unreadable-record') parkedUnreadable.set(r.copy.opId, r.copy.copyPath)
      usageEntries.push(
        usageOf(r.copy.copyPath, r.copy.parentDir, r.classification.measured, r.origin, r.copy.opId)
      )
    }
    for (const lo of l.leftovers) {
      usageEntries.push(
        usageOf(lo.S, path.dirname(lo.S), measureOf(lo.S), null, path.basename(lo.S))
      )
    }
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

  const backups = discovery.stateRoots.map((stateRoot) => {
    const updateDir = path.join(stateRoot, 'backups', 'update')
    const store = listBackupStore(updateDir)
    const views: BackupAreaView[] = []
    for (const a of store.areas) {
      if (!inScope(a.areaPath)) continue
      const rows: BackupRow[] = a.copies.map((copy) => {
        const classification = classify(copy, 'backup')
        const createdMs = createdOf(classification, copy.copyPath, false)
        const kind = classification.kind
        const opId = str(classification.sidecar, 'opId') ?? copy.opId
        usageEntries.push(
          usageOf(
            copy.copyPath,
            copy.parentDir,
            classification.measured,
            null,
            `${a.dirName}/${copy.name}`
          )
        )
        return {
          copy,
          classification,
          kind,
          createdMs,
          ageDays: ageOf(createdMs, now),
          client: a.client,
          skillsDir: str(classification.sidecar, 'skillsDir'),
          dirName: a.dirName,
          opId,
          hashStillEquals:
            classification.klass === 'clean'
              ? true
              : classification.klass === 'changed'
                ? false
                : null,
          protectedBy: protectionOf(records, parkedUnreadable, {
            opId,
            kind,
            sourceUnchanged:
              typeof classification.sidecar?.['sourceUnchanged'] === 'boolean'
                ? (classification.sidecar['sourceUnchanged'] as boolean)
                : null,
          }),
          newestOfGroup: false,
          ...sizesOf(classification.measured),
        }
      })
      for (const lo of a.leftovers) {
        usageEntries.push(
          usageOf(lo.S, path.dirname(lo.S), measureOf(lo.S), null, path.basename(lo.S))
        )
      }
      const temps = a.temps.map((t) => {
        usageEntries.push(
          usageOf(t.path, a.areaPath, measureOf(t.path), null, path.basename(t.path))
        )
        return { ...t, ownedBy: records.live.get(t.base.split('.')[0] as string) ?? null }
      })
      markNewest(rows)
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
      listedAreas.add(a.areaPath)
    }
    return {
      stateRoot,
      updateDir,
      absent: store.absent,
      refused: store.refused,
      anomalies: store.anomalies,
      areas: views,
    }
  })

  const mcp = mcpStores(discovery.roots, usageEntries, measureOf)
  const legacy = await legacyLeftovers(rootPaths)
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
    usageEntries,
    warning,
    unmeasured: usageEntries.reduce((n, e) => n + e.unmeasured, 0),
    client: options.client ?? null,
    narrowedTo: null,
    excludedByRoot: null,
  }
  const byClient = options.client === undefined ? listing : narrowToClient(listing, options.client)
  // `--root` narrows as well as adds (PLAN 2046, UD22): only when the caller gave roots itself.
  const given = options.discovered === undefined && (options.roots ?? []).length > 0
  if (!given) return byClient
  const wanted = discovery.roots.filter((r) => r.sources.includes('--root')).map((r) => r.root)
  return narrowToRoots(byClient, wanted)
}

/** `--client`: keep a backup row whose `<client>` segment matches, and a parked row whose sidecar client does or is unknown. */
function narrowToClient(l: BackupsListing, client: string): BackupsListing {
  return {
    ...l,
    parked: l.parked.map((a) => ({
      ...a,
      rows: a.rows.filter((r) => {
        const c = str(r.classification.sidecar, 'client')
        return c === null || c === client
      }),
    })),
    backups: l.backups.map((s) => ({
      ...s,
      areas: s.areas.filter((a) => a.client === client),
    })),
  }
}
