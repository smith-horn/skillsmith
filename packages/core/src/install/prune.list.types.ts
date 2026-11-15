/**
 * SMI-6531 (A1 step 6c-ii-a): the shapes the two read-only listers
 * (`prune.list.parked.ts`, `prune.list.backups.ts`) return and the classifier
 * (`prune.classify.ts`) reads. Types only: no fs import, no runtime code.
 *
 * @module @skillsmith/core/install/prune.list.types
 */
import type { Leftover } from './prune.leftovers.js'

/** Which store a copy was found in. It decides the sidecar schema the copy must pass. */
export type CopyStore = 'parked' | 'backup'

/** The area a backup tree must sit in, read from its path, to cross-check its sidecar (D4). */
export interface BackupAreaFacts {
  /** The `<client>` path segment. */
  client: string
  /** The `<rootKey>` path segment. */
  rootKey: string
  /** The `<dirName>` path segment. */
  dirName: string
}

/** One copy a lister found, before it is classified. */
export interface ListedCopy {
  /** The copy root: `<opDir>/<name>-<8 hex>` for a parked copy, `<area>/<opId>[.<kind>[.<k>]]` for a backup. */
  copyPath: string
  /** The copy's own name. */
  name: string
  /**
   * The operation id. A parked copy's is its op directory's name. A backup's is
   * read from the tree NAME alone (the text before the first dot), so it is a
   * hint: the sidecar's `opId` is the one to trust, and the strict parse
   * refuses a sidecar whose `opId` and `kind` do not spell the tree name.
   */
  opId: string
  /** The directory holding the copy: the op directory, or the backup area directory. */
  parentDir: string
  /** `<copyPath>.json`. It may not exist; that is what `held/sidecar-absent` says. */
  sidecarPath: string
  /** The directory a prune job stages in (`FreshJob.stagingRoot`). */
  stagingRoot: string
  /** The copy's own directory (`FreshJob.opDir`). */
  opDir: string
  /** Backup trees only: what the path says its sidecar must agree with. */
  area?: BackupAreaFacts
}

/** What `classifyCopy` reads: a listed copy, plus the two facts only a staged copy has. */
export interface ClassifyInput extends ListedCopy {
  /** The copy is a staged copy whose delete stopped part-way (`interrupted-delete`). */
  interruptedDelete?: boolean
  /** For a staged copy: the path and parent its sidecar names, which are no longer where it sits. */
  schema?: { copyPath: string; parentName: string }
}

/** An entry a lister could not read or does not recognise. Never touched. */
export interface Anomaly {
  path: string
  detail: string
}

/** A temp a crashed publish left in a backup area (UD42). Listed as unfinished, never selected. */
export interface UnfinishedTemp {
  path: string
  kind: 'copy-temp' | 'sidecar-temp'
  /** The tree base the temp belongs to: `<opId>[.<kind>[.<k>]]`. */
  base: string
}

/** One `.skillsmith-parked` directory. */
export interface ParkedAreaListing {
  /** The directory holding `.skillsmith-parked`. */
  root: string
  /** `<root>/.skillsmith-parked`. */
  areaDir: string
  /** The area does not exist: nothing parked here. */
  absent: boolean
  /** Why the area is refused whole (nothing in it is listed), or null. */
  refused: string | null
  copies: ListedCopy[]
  /** `.prune-*` staging directories, inspected read-only. */
  leftovers: Leftover[]
  /** `<copy>.json` files whose copy is gone. */
  orphanSidecars: string[]
  anomalies: Anomaly[]
}

/** One `<client>/<rootKey>/<dirName>` backup area. */
export interface BackupAreaListing {
  areaPath: string
  client: string
  rootKey: string
  dirName: string
  copies: ListedCopy[]
  temps: UnfinishedTemp[]
  leftovers: Leftover[]
  orphanSidecars: string[]
  anomalies: Anomaly[]
}

/** `<stateRoot>/backups/update/`, every area under it. */
export interface BackupStoreListing {
  updateDir: string
  absent: boolean
  refused: string | null
  areas: BackupAreaListing[]
  /** Entries at the client, rootKey or dirName levels that are not real directories. */
  anomalies: Anomaly[]
}
