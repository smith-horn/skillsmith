/**
 * SMI-6531 (A1 step 4a): the types of the in-place update transaction
 * (`skill-swap.ts`; A1 plan §3.1, §3.3, §3.5, §3.6).
 *
 * @module @skillsmith/core/services/skill-swap.types
 */
import type { JournalRecordInput } from '../journal/types.js'
import type { ParkOptions, ParkResult } from '../install/park-result.js'
import type { BoundIdentity } from '../install/park-tree.identity.js'
import type { EntryState } from './skill-manifest.entry.js'

/** One file of the approved write set (plan §3.7). `rel` is relative to the skill folder. */
export interface SwapWriteEntry {
  rel: string
  /** `modify`: a regular file with `nlink` 1 in the old folder. `create`: absent there. */
  kind: 'modify' | 'create'
  bytes: Buffer
}

/** What `ManifestPort.withManifestLock` hands its callback, under lock 3 (A1 step 7a). */
export interface ManifestCommitHandle {
  /** A strict load of the raw manifest under this hold; the entry at `manifestKey` is pre, post or other. */
  classify(): Promise<EntryState>
  /** `classify() === 'pre'` (§3.6 CAS); the swap's step 4 and step 10 (a) branch on it. */
  casMatches(): Promise<boolean>
  /**
   * Reloads and requires the entry to be `pre` (else `ManifestEntryChanged`),
   * replaces only that key with `postEntry`, and saves with SMI-6358's
   * pre-commit lock check inside the atomic write (else `ManifestLockLost`).
   */
  write(): Promise<void>
}

/** Implemented by `createManifestPort` (`skill-manifest.port.ts`): lock 3 and §3.6's CAS. */
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
  /** Opaque here; recorded in `record.json`. A JSON value (`null` for no entry): never undefined, a function or a symbol. */
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
  /** In `publishTree`, after the sidecar's temp is written and synced, before its link. */
  | 'afterSidecarTemp'
  /** In `publishTree`, after the sidecar is published and the area synced, before the move. */
  | 'afterSidecar'
  /** Cross-device (4c): after the copy temp is complete and synced, before either hash. */
  | 'afterBackupCopy'
  /** Cross-device: after the temp and the source hashed equal, before any sidecar rewrite. */
  | 'afterBackupVerify'
  /** Cross-device: after the verified temp is renamed to `dest` and the area synced. */
  | 'afterBackupMove'
  /** A sidecar rewrite: after the old sidecar's unlink, before the replacement's link. */
  | 'afterSidecarUnlink'
  /** Abort cleanup (4b): after its first `check` under lock 1. */
  | 'abortAfterCheck'
  /** Abort cleanup: after N is hashed and compared with `postTree`, before a keep or any unlink. */
  | 'abortAfterCompare'
  /** Abort cleanup and step 13: after `record.json` is unlinked and OP synced. */
  | 'afterRecordUnlink'
  /** Abort cleanup and step 13: after the park intent's temp is written and synced, before its link. */
  | 'afterIntentTemp'
  /** Abort cleanup and step 13: after `park-intent.json` is durable (linked, temp unlinked, OP synced). */
  | 'afterIntent'
  /** Abort cleanup and step 13: after `owner.json` is unlinked. */
  | 'afterOwnerUnlink'
  /** The park of OP: after its guard hash and identity are bound, before the last `check` and the park. */
  | 'beforePark'
  /** The park of OP: after the park call returned (its index line appended), before lock 1 is released. */
  | 'afterPark'
  /** The park of OP: after the moved tree's landing directory (`<opId>`) and then ST were synced. */
  | 'afterParkSync'
  /** After a step-2 `busy`: the second wait has announced itself and is about to poll. */
  | 'secondWaitStart'

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
  /**
   * A no-follow copy that completed (its own entries are not traced): the live
   * folder into `new/`, or a cross-device source into its copy temp (4c), which
   * copyTreeNoFollow has synced file by file and directory by directory.
   */
  | { op: 'copy'; path: string; dest: string }
  /** `ManifestPort`'s `write()` returned. */
  | { op: 'manifest-write'; path: string }
  /** The journal append returned (it syncs the file itself). */
  | { op: 'journal-append'; path: string }
  /** Abort cleanup (4b) holds lock 1: its own wait got it, or the abort came from under it. */
  | { op: 'abort-lock' }
  /** One of abort cleanup's explicit `check`s (the mutations' own `check`s are not traced). */
  | { op: 'check' }
  /** Abort cleanup step 3: N is the directory the build made (`buildIdentity`). */
  | { op: 'identity'; path: string }
  /**
   * Abort cleanup step 5 (N hashed against `postTree`), or a cross-device copy
   * temp hashed against its source (4c). `equal` is null when a hash failed.
   */
  | { op: 'compare'; path: string; equal: boolean | null }
  /** Abort cleanup step 6: the clock gate ran and OP's guard hash and identity were bound. */
  | { op: 'guard'; path: string; hash: string }
  /** The park call returned. */
  | { op: 'park'; path: string; status: string; dest: string | null }
  /** Step 3 listed ST and judged every record in it (read-only). */
  | { op: 'record-scan'; path: string }

/** @internal Test seams; none is part of the contract. */
export interface SwapOptions {
  /** Default `randomBytes(16).toString('hex')`. */
  opId?: string
  hooks?: Partial<Record<SwapHookPoint, () => void | Promise<void>>>
  /** Called with each copied entry's relative path while step 1 copies (`afterEntry`). */
  duringCopy?: (rel: string) => void
  /** Called with each copied entry's relative path while a cross-device publish copies (4c). */
  duringBackupCopy?: (rel: string) => void
  trace?: (op: TraceOp) => void
  /** Lock 1's normal wait (default 30 s): step 2's, and a step-1 abort's (plan §3.2). */
  lockTimeoutMs?: number
  /** The second wait after a step-2 `busy` (UD16; default 30 s, the plan's bound). */
  secondWaitMs?: number
  /** The second wait's poll interval (default 50 ms, §3.2's). */
  secondWaitPollMs?: number
  /** Where the second wait's one line and a not-done park's one line go (default `process.stderr`). */
  stderr?: (line: string) => void
  /** Replaces `parkTreeIndexed` for every park of OP (abort cleanup step 6, step 13 across devices). */
  park?: (parentAbs: string, name: string, options: ParkOptions) => Promise<ParkResult>
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
  /**
   * UD32: a removal of OP that is not done. Three sources: abort cleanup did
   * not set the staged copy aside; step 13 across devices did not set aside a
   * cross-device move's source (4c); or step 13 on one device stopped after
   * `record.json` was unlinked (a sync, the owner unlink or the `rmdir` failed,
   * or OP gained an entry), leaving OP for doctor (4c round 1). `path` is OP,
   * where the op dir was; `status` is the park's (`kept`, `held`, `stopped`,
   * with `held` also for a moved park whose post-rename sync failed,
   * `park-not-durable`), or `kept`/`stopped` for a run that stopped before
   * any park (then `reason` is the stop's word, `busy` included). `parkedPath`
   * only for `held`. Never names `skillsmith restore`: the origin is an op dir.
   */
  | {
      code: 'removal-not-done'
      path: string
      status: 'kept' | 'held' | 'stopped'
      reason: string
      parkedPath?: string
      errno?: string
      detail?: string
    }
  /** The park moved OP, but its sidecar or its index line was not written; the status stands. */
  | { code: 'park-metadata-failed'; path: string; sidecarError?: string; indexError?: string }

/** Why abort cleanup kept a staged tree through `publishTree` (plan §3.5). */
export type AbortKeptKind = 'failed-build' | 'edited-new' | 'unrecorded-new'

/**
 * What abort cleanup did with OP (plan §3.3 "Abort cleanup" step 7):
 * `parked` (OP moved to `ST/.skillsmith-parked/<opId>/<opId>-<rnd>`),
 * `kept` (the tree kept through `publishTree`, OP emptied and removed),
 * `held` (OP parked, then found changed or mounted-into at its parked path),
 * `left` (OP stays for `doctor recovery --clean-staging`; with `keptAs` when
 * the tree's keep finished and a later step of cleanup stopped), `none` (this
 * call made no OP, or OP held only its metadata and was removed).
 */
export type AbortStaged = 'parked' | 'kept' | 'held' | 'left' | 'none'

/** `park-intent.json` (plan §3.3 "Park intent"; review round 1 F3). */
export interface ParkIntent {
  schema: 1
  opId: string
  owner: { pid: number; host: string; uid: number }
  /** OP's identity as `createOp` bound it; decimal strings. */
  opIdentity: RecordIdentity
  /** `abort-new` (abort cleanup) or `move-source` (step 13 after a cross-device move). */
  kind: ParkIntentKind
}

export type ParkIntentKind = 'abort-new' | 'move-source'

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
  /** Step 3: a verified record of an unfinished update names this skill (R1). */
  | 'recovery-pending'
  /** Step 3: a record in this root's staging can't be verified; every write in the root refuses. */
  | 'recovery-record-unreadable'

/**
 * Why a run stopped after rename 1 (`stopped`), or after the commit
 * (`incomplete`). Plan §3.3/§3.4 words: `target-changed`, `write-failed`
 * (also every unexpected failure, a failed rename 2 included), `staging-unsafe`,
 * `root-changed`, `backup-unsafe`, `unsupported-entry`. This module's own words
 * for steps the plan names without a reason word: `pre-commit-check-failed`
 * (step 10d), `manifest-write-failed` (10e), `journal-append-failed` (11: the
 * append rejected; its record may still be in the journal, since a failure
 * can follow the fsynced write),
 * `state-root-full` (4c: the backup area lacks the space for a cross-device
 * copy; the detail names `skillsmith doctor backups --prune`), `op-not-empty`
 * (13: OP holds an entry this run did not write).
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
  | 'state-root-full'
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
      /**
       * Across devices (4c, UD29): the parked op dir holding the move's verified
       * source, a second copy of the old folder beside the backup. Absent when
       * the park did not finish (then a `removal-not-done` warning names OP).
       */
      extraCopy?: string
      gitignoreHint?: string
    }
  | {
      status: 'refused'
      /** `busy` stays the reason when the second wait got lock 1 (UD16). */
      reason: SwapRefuseReason
      /** What abort cleanup did with OP; see `AbortStaged`. It removes nothing. */
      staged: AbortStaged
      /** OP, for `left` only. */
      opDir: string | null
      /** `skillsmith doctor recovery --clean-staging <opId>`, for `left` only. */
      cleanStagingHint: string | null
      /** For `parked` and `held`: OP's path in the parked area. */
      parkedPath?: string
      /** When a tree went through `publishTree`: its kind and its path in the backup area. */
      keptAs?: { kind: AbortKeptKind; path: string }
      /** For the two `recovery-*` reasons: the opIds of the records that block this write. */
      blockedBy?: string[]
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
      /** Across devices: the parked op dir holding the kept trees' verified sources (4c). */
      extraCopy?: string
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
  /** The kind of operation; only the in-place update writes a record (A1 step 6a-i). */
  op: 'update'
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
    /** The install scope (`global` or `workspace`), as the sidecars of this op's keeps carry it. */
    scope: string
    /** `basename(comparedPath)`: the skill folder's name, the last component of the backup area. */
    dirName: string
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
  /**
   * Present only once a cross-device move stopped on a full device (UD42):
   * where, and why, for doctor's resume.
   */
  fullDevice?: FullDeviceMarker
  recordSha256: string
}

/** Where a cross-device move was when the full device stopped it. */
export type FullDeviceStage =
  | 'copy'
  | 'partial-keep'
  | 'sidecar-rewrite'
  | 'final-rename'
  | 'final-sync'

/**
 * `record.json`'s full-device marker (rounds 3-4, owner decisions): the cause,
 * the stage, and where. It lists no leftovers: they are every entry of `area`
 * that `isFullDeviceLeftover(name, opId)` matches (`skill-swap.fullmark.ts`),
 * read when the record is read. Written into this op's own record, which is on
 * the skills-root device, not the full one.
 */
export interface FullDeviceMarker {
  cause: 'ENOSPC' | 'EDQUOT'
  stage: FullDeviceStage
  /** The backup area on the full device. */
  area: string
  /** This operation's id, the key every leftover name carries. */
  opId: string
  /** The tree's own destination in `area` (the backup's fixed name, or `<opId>.<kind>`). */
  dest: string
}

export const RECORD_FILE = 'record.json'
export const OWNER_FILE = 'owner.json'
export const NEW_DIR = 'new'
export const OLD_DIR = 'old'
export const UNDONE_DIR = 'undone'
export const PARK_INTENT_FILE = 'park-intent.json'
