/**
 * SMI-6531 (A1 step 4a): the types of the in-place update transaction
 * (`skill-swap.ts`; A1 plan §3.1, §3.3, §3.5, §3.6).
 *
 * @module @skillsmith/core/services/skill-swap.types
 */
import type { JournalRecordInput } from '../journal/types.js'
import type { BoundIdentity } from '../install/park-tree.identity.js'

/** One file of the approved write set (plan §3.7). `rel` is relative to the skill folder. */
export interface SwapWriteEntry {
  rel: string
  /** `modify`: a regular file with `nlink` 1 in the old folder. `create`: absent there. */
  kind: 'modify' | 'create'
  bytes: Buffer
}

/** What `ManifestPort.withManifestLock` hands its callback, under lock 3. */
export interface ManifestCommitHandle {
  /** The raw entry at `manifestKey` equals `preEntry` (§3.6 CAS). */
  casMatches(): Promise<boolean>
  /** SMI-6358's pre-commit lock check; throws to stop. */
  preCommitCheck(): Promise<void>
  /** The atomic manifest write of `postEntry`. */
  write(): Promise<void>
}

/** Step 7 implements this with lock 3 (`withFileLock` on the manifest) and §3.6's CAS. */
export interface ManifestPort {
  withManifestLock<T>(fn: (m: ManifestCommitHandle) => Promise<T>): Promise<T>
}

/** The planned update of one skill folder (plan §3.1's `UpdateTarget` plus the write set). */
export interface SwapInput {
  skillsDir: string
  client: string
  scope: string
  /** The directory holding `manifestPath`; backups live under it. */
  stateRoot: string
  manifestPath: string
  manifestKey: string
  /** The directory the plan diffed. */
  comparedPath: string
  /** Native `realpath(comparedPath)`. */
  realDir: string
  /** `basename(comparedPath)`. */
  dirName: string
  oldIdentity: BoundIdentity
  /** The §3.4 tree hash of `realDir` at plan time. */
  preTree: string
  writeSet: ReadonlyArray<SwapWriteEntry>
  /** Opaque here; recorded in `record.json`. */
  preEntry: unknown
  postEntry: unknown
  manifest: ManifestPort
}

/** Where a test hook runs; each name is the window it opens (see `skill-swap.ts`). */
export type SwapHookPoint =
  | 'afterCopy'
  | 'afterBuild'
  | 'afterStep4Hash'
  | 'afterRecord'
  | 'beforeRename1Check'
  | 'beforeRename1'
  | 'afterRename1'
  | 'afterRename1Syncs'
  | 'afterRename2'
  | 'beforeCommit'
  | 'beforeCommitRehash'
  | 'afterCommit'
  | 'beforePublish'
  | 'beforeUndoAside'
  | 'afterUndoAside'
  /** After the undo's aside and its syncs, before O goes back. */
  | 'beforeRestore'
  /** A non-directory O: after its type and link text are read, before the `check` guarding its recreate. */
  | 'beforeRecreate'
  /** In `publishTree`, after the name is chosen and the tree hashed, before the sidecar. */
  | 'beforeSidecar'

/** One traced mutation or sync, in the order it happened (T-P4). Recorded after it succeeds. */
export type TraceOp =
  | { op: 'mkdir'; path: string }
  /** A file created (`O_CREAT|O_EXCL`). */
  | { op: 'create'; path: string }
  /** A file `fsync`. */
  | { op: 'fsync'; path: string }
  /** A directory `fsync` (also recorded when the filesystem cannot sync one). */
  | { op: 'dirsync'; path: string }
  | { op: 'rename'; path: string; dest: string }
  /** A hard link made at `dest` (never replaces: `EEXIST` refuses). */
  | { op: 'link'; path: string; dest: string }
  | { op: 'unlink'; path: string }
  | { op: 'rmdir'; path: string }
  /** The no-follow copy of the live folder into `new/` (its own entries are not traced). */
  | { op: 'copy'; path: string; dest: string }
  /** `ManifestPort`'s `write()` returned. */
  | { op: 'manifest-write'; path: string }
  /** The journal append returned (it syncs the file itself). */
  | { op: 'journal-append'; path: string }

/** @internal Test seams; none is part of the contract. */
export interface SwapOptions {
  /** Default `randomBytes(16).toString('hex')`. */
  opId?: string
  hooks?: Partial<Record<SwapHookPoint, () => void | Promise<void>>>
  /** Called with each copied entry's relative path while step 1 copies (`afterEntry`). */
  duringCopy?: (rel: string) => void
  trace?: (op: TraceOp) => void
  lockTimeoutMs?: number
  /** Replaces `appendJournalRecord` (step 11). */
  appendJournal?: (input: JournalRecordInput) => Promise<unknown>
}

export type SwapWarning =
  /** O, the backup, no longer hashes to `preTree`: a foreign write landed before rename 1. */
  | { code: 'backup-holds-foreign-change'; backup: string }
  /** A foreign write landed in the live folder after rename 2; the paths stay there. */
  | { code: 'live-folder-changed'; paths: string[] }
  /** An undo kept a changed new folder as kind `conflict`. */
  | { code: 'conflict-kept'; path: string }
  /** A directory's bits differ from its parent's (`mkdirWithParentBits` warnings). */
  | { code: 'mode'; path: string; detail: string }

/** Why a transaction was refused before rename 1 (plan §3.3 words). */
export type SwapRefuseReason =
  | 'changed-since-plan'
  | 'target-changed'
  | 'write-failed'
  | 'staging-collision'
  | 'staging-unsafe'
  | 'root-changed'
  | 'backup-unsafe'
  | 'root-unsafe'
  | 'busy'

/**
 * Why a run stopped after rename 1 (`stopped`), or after the commit
 * (`incomplete`). Plan §3.3/§3.4 words: `target-changed`, `write-failed`
 * (also every unexpected failure, a failed rename 2 included), `staging-unsafe`,
 * `root-changed`, `backup-unsafe`, `unsupported-entry`. This module's own words
 * for steps the plan names without a reason word: `pre-commit-check-failed`
 * (step 10d), `manifest-write-failed` (10e), `journal-append-failed` (11: the
 * append rejected; its record may still be in the journal, since a failure
 * can follow the fsynced write),
 * `cross-device` (4c's seam), `op-not-empty` (13's park seam).
 */
export type SwapStopReason =
  | 'target-changed'
  | 'write-failed'
  | 'staging-unsafe'
  | 'root-changed'
  | 'backup-unsafe'
  | 'unsupported-entry'
  | 'pre-commit-check-failed'
  | 'manifest-write-failed'
  | 'journal-append-failed'
  | 'cross-device'
  | 'op-not-empty'

/** Left behind after a commit with the record kept (doctor finishes it). */
export interface SwapIncomplete {
  step: 'audit' | 'publish' | 'cleanup'
  reason: SwapStopReason
  detail: string
}

export type SwapResult =
  | {
      status: 'committed'
      opId: string
      /**
       * Always `<area>/<opId>`: the path `record.json` and the journal name too.
       * With `incomplete` `audit`, and with `incomplete` `publish` when the stop
       * came before the move, the old folder is still in OP and this is where it
       * is meant to go. A `publish` stop AFTER the move (a sync of the area or OP
       * failed once the rename succeeded) leaves the old folder already here.
       */
      backupDest: string
      warnings: SwapWarning[]
      incomplete?: SwapIncomplete
      /** Present when the record was kept: `incomplete`, and step 13 had not yet removed it. */
      recordPath?: string
      gitignoreHint?: string
    }
  | {
      status: 'refused'
      reason: SwapRefuseReason
      /**
       * `left`: OP exists and was left exactly as it was (4a's abort cleanup
       * removes nothing). `none`: no OP was made by this call.
       */
      staged: 'left' | 'none'
      opDir: string | null
      cleanStagingHint: string | null
      detail: string
      warnings: SwapWarning[]
      gitignoreHint?: string
    }
  | {
      status: 'undone'
      opId: string
      reason: 'target-changed' | 'changed-since-plan'
      keptAs: 'undone' | 'conflict'
      keptPath: string
      warnings: SwapWarning[]
      gitignoreHint?: string
    }
  | {
      /** After rename 1: the record is kept for doctor; nothing else is touched. */
      status: 'stopped'
      opId: string
      /** Absent only when an undo's step 13 had already removed the record. */
      recordPath?: string
      reason: SwapStopReason
      detail: string
      warnings: SwapWarning[]
      /** The staging `.gitignore` hint, for the run whose `mkdir` created ST. */
      gitignoreHint?: string
    }

/** `record.json`'s identity form: bigint fields as decimal strings. */
export interface RecordIdentity {
  dev: string
  ino: string
  birthtimeNs: string
  fmt: string
}

/** `record.json` (plan §3.3 step 5), in its fixed key order. */
export interface SwapRecord {
  schema: 1
  opId: string
  pid: number
  host: string
  uid: number
  target: {
    comparedPath: string
    realDir: string
    skillsDir: string
    manifestPath: string
    manifestKey: string
    client: string
  }
  rootIdentity: RecordIdentity
  opDirIdentity: RecordIdentity
  oldIdentity: RecordIdentity
  newIdentity: RecordIdentity
  preTree: string
  postTree: string
  preEntry: unknown
  postEntry: unknown
  backupDest: string
  recordSha256: string
}

export const RECORD_FILE = 'record.json'
export const OWNER_FILE = 'owner.json'
export const NEW_DIR = 'new'
export const OLD_DIR = 'old'
export const UNDONE_DIR = 'undone'
