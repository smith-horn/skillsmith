/**
 * SMI-6531 (A1 step 6c-ii-a): the shapes `listBackups` returns. Types only.
 *
 * @module @skillsmith/core/services/skill-backups.listing.types
 */
import type { Classification } from '../install/prune.classify.js'
import type { Leftover } from '../install/prune.leftovers.js'
import type { ParkedUsageEntry, ParkedUsageWarning } from '../install/parked-usage.js'
import type { Anomaly, ListedCopy, UnfinishedTemp } from '../install/prune.list.types.js'
import type { Discovery } from './skill-recovery.discover.js'
import type { AreaRef, IndexFacts, StaleIndexLine } from './skill-backups.areas.js'
import type { Protection, RecordFacts } from './skill-backups.records.js'
import type { LedgerRow } from './skill-backups.ledger.js'

/** The size facts every row carries. Allocated bytes are what the warning counts (D6). */
export interface Sizes {
  /** Allocated bytes ("on disk"). A lower bound when `unmeasured > 0`. */
  allocatedBytes: number
  apparentBytes: number
  unmeasured: number
}

/** A copy a lister found, classified and measured. */
interface RowBase extends Sizes {
  copy: ListedCopy
  classification: Classification
  /** The sidecar's kind, when it parsed. */
  kind: string | null
  /** The sidecar's `createdAt` (or the parked copy's mtime), as ms since the epoch; null when unknown. */
  createdMs: number | null
  /** Whole days since `createdMs`, or null when unknown. */
  ageDays: number | null
}

/** One copy in a `.skillsmith-parked` area. */
export interface ParkedRow extends RowBase {
  /** Where it came from: the sidecar's `originPath`, or null when unreadable. */
  origin: string | null
  /** Whether the parked index has a line for it. */
  index: 'present' | 'missing'
  /**
   * UD61, decided by the listing from the whole machine's facts, as for a
   * backup (rule (c), D17, and unknown when records or parked areas could not
   * be read). The same in a scoped or narrowed listing; the planner reads it.
   */
  protection: Protection
}

/** One kept tree in the update backup area. */
export interface BackupRow extends RowBase {
  /** The `<client>` path segment. */
  client: string
  /** The sidecar's skills root (the restore target), or null when no sidecar parsed. */
  skillsDir: string | null
  dirName: string
  /** The sidecar's opId when it parsed, else the tree name's first segment. */
  opId: string
  /** True when the tree still hashes to the sidecar's hash, false when it does not, null when unknown. */
  hashStillEquals: boolean | null
  /** UD61: the record protecting it, none, or unknown (some records could not be read). Global, as for a parked row. */
  protection: Protection
  /** True when it is the newest `backup` (or `pre-rename`) of its `(client, skillsDir, dirName)`. */
  newestOfGroup: boolean
}

export interface LeftoverView {
  leftover: Leftover
  /** UD71: a resume is offered (the marker, intent and inventory agreed). */
  resumeOffered: boolean
}

export interface ParkedAreaView {
  ref: AreaRef
  absent: boolean
  refused: string | null
  rows: ParkedRow[]
  leftovers: LeftoverView[]
  orphanSidecars: string[]
  anomalies: Anomaly[]
}

export interface BackupAreaView {
  areaPath: string
  client: string
  rootKey: string
  dirName: string
  rows: BackupRow[]
  /** Unfinished temps, each with the live record that owns it (or null). */
  temps: (UnfinishedTemp & { ownedBy: string | null })[]
  leftovers: LeftoverView[]
  orphanSidecars: string[]
  anomalies: Anomaly[]
}

export interface BackupStoreView {
  stateRoot: string
  updateDir: string
  absent: boolean
  refused: string | null
  anomalies: Anomaly[]
  areas: BackupAreaView[]
}

/** `.<name>.skillsmith-removing-<32 hex>` entries in one skills root: listed, never selected. */
export interface LegacyLeftovers {
  root: string
  paths: string[]
  /** Why the root could not be listed, or null. */
  unreadable: string | null
}

/** The old MCP backup store (`<claude root>/.backups`), reported and never selected (owner decision D7). */
export interface McpStoreView extends Sizes {
  root: string
  path: string
}

export interface ListScope {
  /** Only these areas (a parked `.skillsmith-parked` directory, or a backup `<dirName>` area) are listed. */
  areaPaths?: readonly string[]
}

export interface BackupsListing {
  discovery: Discovery
  parked: ParkedAreaView[]
  backups: BackupStoreView[]
  legacy: LegacyLeftovers[]
  mcpStores: McpStoreView[]
  index: { facts: IndexFacts; stale: StaleIndexLine[] }
  records: RecordFacts
  /**
   * The ledger: one row per path the listing read, per store or area root, and
   * per path the parked index names, each measured, unmeasured or exempt. The
   * warning and the narrowing counts are derived from it. It always covers the
   * whole machine: `scope`, `--root` and `--client` never remove a row.
   */
  accounting: {
    rows: LedgerRow[]
    /** Paths offered a second row; always empty unless a ledger builder is wrong. */
    duplicates: string[]
  }
  /** Everything the space warning counts: the ledger's rows that are not exempt. */
  usageEntries: ParkedUsageEntry[]
  warning: ParkedUsageWarning
  /** Entries that could not be measured, across everything the warning counts. */
  unmeasured: number
  /** `--client`, when the rows were narrowed; the warning still counts everything. */
  client: string | null
  /** `--root`, when the listing was narrowed: the real paths of the roots it shows. */
  narrowedTo: string[] | null
  /** What `--root` hid, so nothing vanishes silently; null when not narrowed. */
  excludedByRoot: ExcludedByRoot | null
  /** What `--client` hid, so nothing vanishes silently; null when no client was given. */
  excludedByClient: ExcludedByClient | null
}

/** Counts of what a `--client` narrowing left out. The warning still counts all of it. */
export interface ExcludedByClient {
  /** Set-aside folders whose sidecar names another client. */
  parkedCopies: number
  /** Kept backup trees in another client's area. */
  backupTrees: number
  /** Temps, `.prune-*` leftovers, orphan sidecars, anomalies and refused areas left out. */
  otherEntries: number
}

/** Counts of what a `--root` narrowing left out. The warning still counts all of it. */
export interface ExcludedByRoot {
  /** Set-aside folders under other roots, or found only through the parked index. */
  parkedCopies: number
  /** Kept backup trees whose restore root (or area root key) is not one of the roots. */
  backupTrees: number
  /** Temps, `.prune-*` leftovers, orphan sidecars, anomalies and refused or skipped areas left out. */
  otherEntries: number
  /** Older MCP stores and legacy removal leftovers (each path) under other roots. */
  olderStores: number
}
