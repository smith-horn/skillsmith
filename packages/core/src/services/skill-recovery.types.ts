/**
 * SMI-6531 (A1 step 6a-i): the types of `doctor recovery`'s read-only core
 * (A1 plan §3.3 "Doctor classification", §3.9; design `step6a-design.md`).
 *
 * Three layers share these types:
 *  - the reader (`skill-recovery.reader.ts`), the only module of the classifier
 *    that touches the filesystem, which records every read as a `ReadFact`;
 *  - the classifier (`skill-recovery.{opdir,trees,pstate,classify}.ts`), which
 *    turns facts into a `RecoveryClass`;
 *  - the pure table (`skill-recovery.plan.ts`), which says what each action
 *    would do to a class (`ActionPlan`).
 *
 * Nothing here removes a tree: a disposition is `installed`, `kept` or
 * `untouched` (UD13), and the type has no fourth case.
 *
 * @module @skillsmith/core/services/skill-recovery.types
 */
import type { EntryState } from './skill-manifest.entry.js'
import type { NoRecordObservation } from './skill-recovery.clean.types.js'
import type { RecordParseWhy } from './skill-swap.record-schema.js'
import type { FullDeviceMarker, RecordIdentity, SwapRecord } from './skill-swap.types.js'

// ---------------------------------------------------------------------------
// The reader's facts
// ---------------------------------------------------------------------------

/** What a no-follow `lstat` says an entry is. */
export type FileType = 'dir' | 'file' | 'symlink' | 'other'

export type StatFact =
  | { ok: true; type: FileType; identity: RecordIdentity; uid: number; nlink: number }
  | { ok: false; errno: string }

/** A bounded no-follow read: the bytes themselves stay with the caller, the digest keeps their hash. */
export type ReadFact =
  | { ok: true; identity: RecordIdentity; size: number; sha256: string; truncated: boolean }
  | { ok: false; errno: string; type?: FileType }

/** The named filters a listing goes through; the rule's name is part of what the transcript records. */
export type ListRule =
  /** Every entry of the directory (an op dir; emptiness). */
  | { name: 'all' }
  /** An op dir's candidates and probes in ST: names not starting with `.`, and `.skillsmith-probe-*`. */
  | { name: 'stagingEntries' }
  /** The entries of a backup area that one operation made (`isFullDeviceLeftover`). */
  | { name: 'areaForOp'; opId: string }

export type ListFact =
  | { ok: true; dirIdentity: RecordIdentity; rule: string; names: string[] }
  | { ok: false; errno: string }

export type TreeHashFact =
  /** `bytes`: the sum of the regular files' sizes the walk hashed (6b-i: what `--park` moves). */
  | { ok: true; hash: string; identity: RecordIdentity; bytes: number }
  | { ok: false; reason: string; path: string; errno: string | null }

export type RealpathFact = { ok: true; path: string } | { ok: false; errno: string }

/** The entry's state from the manifest: a derived fact, since a manifest is a shared, multi-writer file. */
export type EntryFact = { ok: true; state: EntryState } | { ok: false; refusal: string }

/** Whether the journal holds an `update` line for an op: derived, the journal being multi-writer. */
export type JournalFact =
  | { ok: true; present: boolean; torn: boolean; file: string }
  | { ok: false; errno: string; file: string }

export type PortFact = { ok: boolean }

export type ReaderMethod =
  | 'stat'
  | 'readFile'
  | 'list'
  | 'treeHash'
  | 'realpath'
  | 'manifestEntry'
  | 'journalHasUpdate'
  | 'portAccepts'

/**
 * The reader's declared shared reads: a manifest and the journal are
 * multi-writer files whose bytes change with unrelated work, so the transcript
 * holds the derived fact, not the bytes. The exception lives here, in the
 * reader's types, not in a list a caller maintains.
 */
export const SHARED_METHODS: ReadonlySet<ReaderMethod> = new Set<ReaderMethod>([
  'manifestEntry',
  'journalHasUpdate',
])

export type ReadFactOf = {
  stat: StatFact
  readFile: ReadFact
  list: ListFact
  treeHash: TreeHashFact
  realpath: RealpathFact
  manifestEntry: EntryFact
  journalHasUpdate: JournalFact
  portAccepts: PortFact
}

/** One recorded read: the method, what it was asked (`key`), and what it found. */
export interface TranscriptEntry {
  method: ReaderMethod
  /** The path (or, for a derived fact, the arguments that name it). */
  key: string
  /** True for a shared read: the fact is derived, not the bytes. */
  derived: boolean
  fact: ReadFactOf[ReaderMethod]
}

export type ReadTranscript = readonly TranscriptEntry[]

// ---------------------------------------------------------------------------
// Roles, keeps, publish sub-states
// ---------------------------------------------------------------------------

/** The three trees an update holds in its op dir: `old/`, `new/`, `undone/`. */
export type Role = 'O' | 'N' | 'U'
/** `OP` (6b-i): the whole op dir, which `--park` sets aside as one tree. */
export type TreePosition = 'T' | Role | 'OP'

/** What a tree observed at a path is (T or a role's source). */
export type TreeObs =
  /** Nothing there (`errno` null for `ENOENT`/`ENOTDIR`), or it could not be inspected (the errno). */
  | { present: false; errno: string | null }
  | {
      present: true
      type: FileType
      identity: RecordIdentity
      /** A directory with no entries. */
      empty: boolean
      /** The §3.4 hash; null for a non-directory or one that could not be hashed. */
      hash: string | null
      hashError: string | null
    }

/** How T (the skill path) stands against the record's identities and hashes. */
export type TState =
  | 'absent'
  /** An empty directory with neither identity: a claim (UN1, an S1 resume). */
  | 'claim'
  | 'old'
  | 'new'
  /** A directory with neither identity and neither hash. */
  | 'foreign'
  /** A directory whose identity is neither, but whose hash is a role's: `identity-changed`. */
  | 'identity-changed'
  /** Not a directory. */
  | 'not-directory'

/** Publish sub-states of `publishTree` (P0-P5) and the one-device sidecar rewrite (R1-R3). */
export type PState = 'P0' | 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'R1' | 'R2' | 'R3'

/** What a tree is kept as: the producers' kinds, plus the ones 6a-ii and 6b add. */
export type KeptKind = string

export interface SidecarFacts {
  path: string
  /** Parsed strictly and naming this op, this kind, and this record's skill and root. */
  validForOp: boolean
  /** Why it is not valid (names a field); null when it is. */
  invalid: string | null
  kind: string | null
  identity: RecordIdentity | null
  treeHash: string | null
}

/** One backup-area entry group (`<base>` with its sidecar, sidecar temp and copy temp) of this op. */
export interface KeepGroup {
  /** `<opId>` (the backup) or `<opId>.<kind>` with an optional `.<k>`. */
  base: string
  /** `<area>/<base>`: where the kept tree is (or will be). */
  destPath: string
  /** From the name: `backup` for `<opId>`, else the part after `<opId>.`. */
  kind: string
  /** The role this kind keeps, when it keeps one. */
  role: Role | null
  sidecar: SidecarFacts | null
  sidecarTmp: {
    path: string
    /** Parses as this op's sidecar for `dest`. */
    thisOps: boolean
    treeHash: string | null
    /** The identity the temp names for its tree (Q10: a provable temp names the source's). */
    identity: RecordIdentity | null
    sameInodeAsSidecar: boolean
    /** An empty regular file with one link (Q10's other provable case). */
    emptySingleLink: boolean
  } | null
  dest: TreeObs
  copyTmp: TreeObs
  /** The source this group's tree comes from, when it has one in OP. */
  src: TreeObs
  state: PState | null
  /** Why no sub-state names this group (a leftover none classifies); null when one does. */
  unclassified: string | null
  /** The sidecar's identity equals the one the tree has (or hash only on another device). */
  verified: boolean
  /** P1: `src`'s hash is not the sidecar's, so resume rewrites the sidecar. */
  hashChanged: boolean
  /** P2-P4, or a sidecar-rewrite state beside a copy temp: a keep across devices. */
  crossDevice: boolean
}

export type RoleRes =
  | { kind: 'source'; obs: Extract<TreeObs, { present: true }>; started: KeepGroup | null }
  | { kind: 'kept'; keep: KeepGroup }
  | { kind: 'absent' }

// ---------------------------------------------------------------------------
// What the classifier returns
// ---------------------------------------------------------------------------

export type RowState = 'S0' | 'S1' | 'S2' | 'S2prime' | 'S2x' | 'S3' | 'UN1' | 'UN2'

/** What was observed once a record verified; shared by every class that carries one. */
export interface OpFacts {
  opId: string
  opDir: string
  record: SwapRecord
  /** `record.target.realDir`. */
  tPath: string
  tState: TState
  t: TreeObs
  /** The entry's state; null when the manifest refused to be read (`manifestRefusal` says why). */
  manifest: EntryState | null
  manifestRefusal: string | null
  roles: { O: RoleRes; N: RoleRes; U: RoleRes }
  /** Every keep group of this op in its area, in name order. */
  groups: KeepGroup[]
  /** The area (`dirname(record.backupDest)`). */
  area: string
  journal: Extract<JournalFact, { ok: true }> | null
  /** The record's `uid` is not the effective uid: `--apply`/`--undo` refuse (Q8). */
  otherUid: number | null
  /** The record has a `fullDevice` marker (its own, or the temp's). */
  fullDevice: FullDeviceMarker | null
  /** A `record.json.tmp` beside the record, if any. */
  recordTmp: {
    path: string
    sameInode: boolean
    hasMarker: boolean
    bodyMatches: boolean
    emptySingleLink: boolean
  } | null
  /** N hashes to `postTree`: S1 `--apply` installs it only then. */
  nHashesToPost: boolean | null
  /**
   * 6a-iii: a `park-intent.json` beside the record (a cross-device finish that
   * stopped after its intent): `valid` when it is this op's `move-source`
   * intent for OP's recorded identity, which the resumed finish reuses.
   */
  parkIntent: { path: string; valid: boolean } | null
  /** Its temp: `provable` when it parses as that same intent, or is an empty file with one link. */
  parkIntentTmp: { path: string; provable: boolean } | null
}

/**
 * 6a-iii: the park intent of an op dir with no record (a finish that had
 * written its move-source intent: an update after it unlinked its record, or
 * doctor's own cross-device `--apply`, `--undo` (each unlinks `record.json` after
 * the intent) or `--clean-staging` (which never had one)). `--apply`/`--undo`
 * finish its park when `blocked` is null.
 */
export interface NoRecordIntent {
  path: string
  /** `isParkIntentFor` for this opId and OP's current identity. */
  valid: boolean
  kind: string | null
  backupPath: string | null
  ownerUid: number | null
  /** OP's identity as the verifying intent names it (equal to OP's current one); null if invalid. */
  opIdentity: RecordIdentity | null
  /** From `backupPath`: the state root (the parked index), the client and the folder. */
  target: { stateRoot: string; client: string; dirName: string } | null
  /** The op dir's tree entries (`old`, `new`, `undone`), as the plan saw them. */
  sources: Array<{ name: string; identity: RecordIdentity }>
  /** Why `--apply`/`--undo` cannot finish the park from it; null when they can. */
  blocked: string | null
  /** 6b-ii: the verifying intent's parsed object (its O1 attribution, if any); null when invalid. */
  raw: Record<string, unknown> | null
}

export type UnreadableWhy = RecordParseWhy | 'open-failed' | 'not-a-file' | 'inconsistent-record'

/**
 * 6b-i: what the classifier read of an op dir whose record file failed (OP
 * itself was `lstat`ed as a directory and listed), so `--park`'s plan states
 * what it moves and the digest covers it (design § 1.1).
 */
export interface UnreadableObservation {
  /** OP's identity and owner, from its `lstat`. */
  identity: RecordIdentity
  uid: number
  /** OP's uid when it is not the effective uid: `--park` refuses `recovery-other-user` (O3b). */
  otherUid: number | null
  /** Every entry of OP, each with its no-follow `lstat`. */
  entries: Array<{ name: string; stat: StatFact }>
  /**
   * `treeHash(OP)`: the walk and hash function the park's guard uses
   * (`pathTreeRecord` + `computeTreeHash`). OP is guardable exactly when this
   * is `ok`; `--park` is offered only then (bf-1k0 Major 1).
   */
  hash: TreeHashFact
  /**
   * `owner.json`'s parsed object (read through the reader), or null when it is
   * absent, unreadable or not a JSON object: the source of O1's attribution,
   * which `skill-recovery.attribution.ts` validates (all or nothing).
   */
  owner: Record<string, unknown> | null
}

export type MovedWhy = 'foreign-root' | 'foreign-op-dir' | 'root-identity' | 'op-dir-identity'

export type RecoveryClass =
  | { kind: 'empty-op-dir'; opId: string; opDir: string }
  | {
      kind: 'no-record'
      opId: string
      opDir: string
      owner: { pid: number | null; host: string | null; uid: number | null } | null
      entries: string[]
      hasParkIntent: boolean
      recordTmp: string | null
      /**
       * The uid of whoever started it, when it is not the effective uid:
       * `owner.json`'s, else (6a-iii) the verifying park intent's.
       */
      otherUid: number | null
      /** 6a-iii: its `park-intent.json`, when it has one. */
      intent: NoRecordIntent | null
      /** 6b-ii: the owner verdict, the attribution and what `--clean-staging` keeps (`skill-recovery.clean.types.ts`). */
      clean: NoRecordObservation
    }
  | {
      kind: 'unreadable'
      opId: string
      opDir: string
      why: UnreadableWhy
      errno?: string
      detail?: string
      /**
       * 6b-i: set when the record file failed and OP was listed; null when OP's
       * own `lstat` or listing failed (C3: then there is nothing to guard).
       */
      observed: UnreadableObservation | null
    }
  | { kind: 'other-user'; opId: string; opDir: string; ownerUid: number | null; errno: string }
  | {
      kind: 'moved'
      opId: string
      opDir: string
      why: MovedWhy
      detail: string
      /** The record's uid when it is not the effective uid: another user started this. */
      otherUid: number | null
    }
  | {
      kind: 'identity-changed'
      opId: string
      opDir: string
      positions: TreePosition[]
      facts: OpFacts
    }
  | {
      kind: 'state'
      opId: string
      opDir: string
      state: RowState
      postKeep: boolean
      facts: OpFacts
    }
  | { kind: 'ab'; opId: string; opDir: string; facts: OpFacts; abandoned: string[] }
  | { kind: 'anything-else'; opId: string; opDir: string; reason: string; facts: OpFacts | null }

// ---------------------------------------------------------------------------
// What an action would do (the pure table)
// ---------------------------------------------------------------------------

export type RecoveryAction = 'apply' | 'undo' | 'abandon' | 'clean-staging' | 'park'

/** Separate from `SwapRefuseReason`: these are doctor's words (§3.9). */
export type RecoveryRefuseReason =
  | 'recovery-moved'
  | 'recovery-ambiguous'
  | 'recovery-identity-changed'
  | 'recovery-conflict'
  | 'recovery-not-offered'
  | 'recovery-record-unreadable'
  | 'recovery-other-user'
  | 'plan-changed'
  /**
   * 6a-iii (report only): no op dir has the opId, but its parked area exists:
   * it was already set aside. Doctor takes no action: it neither verifies nor
   * syncs that copy (the CLI exits 0).
   */
  | 'already-parked'

/** Every tree ends installed, kept or untouched. There is no removal case (UD13). */
export type Disposition =
  | { kind: 'installed' }
  | { kind: 'kept'; as: KeptKind }
  | { kind: 'untouched' }

export interface PlanStep {
  tree: TreePosition
  disposition: Disposition
  /** Words for the plan: what happens and under what condition. */
  note: string
}

export type ManifestEffect = 'untouched' | 'committed-to-post'

export type ActionPlan =
  | {
      offered: true
      action: RecoveryAction
      steps: PlanStep[]
      manifest: ManifestEffect
      /** What `--apply`/`--undo` still has to do, in order (a post-keep row's remainder). */
      remaining: string[]
      /** Additional lines the plan states (journal, `live-folder-changed`, backup path). */
      notes: string[]
    }
  | { offered: false; action: RecoveryAction; reason: RecoveryRefuseReason; detail: string }
