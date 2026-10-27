/**
 * SMI-6531 (A1 step 7b): the types of the in-place update of an existing
 * tracked folder (A1 plan §3.1, §3.6, §3.7): the target, the plan the user
 * approves, a refusal before anything is written, and the result.
 *
 * The flow is `buildUpdateTarget` (`skill-update.target.ts`), then
 * `planSkillUpdate` (`skill-update.plan.ts`), then `updateInPlace`
 * (`skill-update.ts`), which runs `swapInPlace` through the real manifest
 * port. No production caller exists until A1 step 9.
 *
 * @module @skillsmith/core/services/skill-update.types
 */
import type { BoundIdentity } from '../install/park-tree.identity.js'
import type { ClientId } from '../install/paths.js'
import type { ScanReport } from '../security/index.js'
import type { TrustTier } from '../types/skill.js'
import type { JsonObject } from './skill-manifest.canonical.js'
import type { InstallResult, ProgressCallback } from './skill-installation.types.js'
import type { ManifestPort, SwapOptions, SwapResult } from './skill-swap.types.js'
import type { PlannedWrite } from './update-target-gate.types.js'
import type { UpdateTargetReason } from './update-target-reason.js'

/** Plan §3.1's `UpdateTarget`: the folder `update` diffed, bound at plan time. */
export interface UpdateTarget {
  /** The skills root as the scope resolved it (the swap binds its real path itself). */
  skillsDir: string
  /** Native `realpath(skillsDir)`: R. */
  realSkillsDir: string
  client: ClientId
  /** The install scope (`global` or `workspace`). */
  scope: string
  /** The directory holding `manifestPath`. */
  stateRoot: string
  manifestPath: string
  /** `manifestKeyFor(dirName, client)`: never the upstream name. */
  manifestKey: string
  /** The directory the plan diffed. */
  comparedPath: string
  /** Native `realpath(comparedPath)`: a direct child of R, a directory on R's device. */
  realDir: string
  /** `basename(comparedPath)`: names the key, the companion path and the backup area. */
  dirName: string
  /** `{ dev, ino, birthtimeNs, fmt }` of `realDir` from a bigint `lstat`. */
  identity: BoundIdentity
  /** The §3.4 tree hash of `realDir`. */
  preTree: string
  /**
   * The companion-agent path derived from `dirName` (§3.1), `null` when the
   * client's companion directory is relative and no base directory was given.
   * An in-place update never writes it (§3.7 item 1).
   */
  companionPath: string | null
  /** The canonical form (§3.6) of the raw entry at `manifestKey`; never null (Q8: `untracked`). */
  preEntry: JsonObject
}

/** One file of the approved write set (§3.7 items 3-4). */
export interface PlannedFile {
  /** Relative to the skill folder, `/`-separated (the same `rel` as `ProbedFile.rel`). */
  rel: string
  /** `modify`: a regular file with one link now. `create`: absent now (parents made in `new/`). */
  kind: 'modify' | 'create'
  /** The fetched bytes, written as-is (no optimizer). */
  bytes: Buffer
  /** sha256 of the current bytes for `modify`; `null` for `create`. */
  preSha256: string | null
}

/** What A2 classifies and the user approves (§3.7 item 5). Executed by `updateInPlace`. */
export interface UpdatePlan {
  ok: true
  target: UpdateTarget
  skillId: string
  trustTier: TrustTier
  /** The write set: SKILL.md and the fetched optional files whose bytes differ. Never a removal. */
  files: readonly PlannedFile[]
  /** A2's projection of `files` (`create` → `'add'`; never `'remove'`, Q12). */
  writes: readonly PlannedWrite[]
  /** `buildPostEntry(target.preEntry, writable)`, computed once, here (Q7). */
  postEntry: JsonObject
  securityReport?: ScanReport
  /** The fetched SKILL.md differs from the registry's indexed hash (SMI-3510). */
  contentHashMismatch: boolean
  configWarnings: readonly string[]
}

/**
 * Why no plan was made. A2's words (`update-target-reason.ts`) where one
 * applies; `confirmation-required` is install's own gate (SMI-3863), which
 * A2's table has no row for. `manifest-key-conflict` is used for a recorded
 * skill ID that does not parse (A2 has no row for that either; its remedy
 * re-verifies the entry's identity, which is what fixing the ID needs).
 *
 * Every member but `confirmation-required` must be an `UpdateTargetReason`:
 * `A2Reason` fails typecheck if A2 renames or drops one (a bare `Extract`
 * would silently shrink the union instead). A2's `remediationFor` has no
 * entry for `confirmation-required`, so step 9's command must render it
 * itself (re-run with confirmation).
 */
type A2Reason<R extends UpdateTargetReason> = R

export type UpdateRefusalReason =
  | A2Reason<
      | 'manifest-unreadable'
      | 'untracked'
      | 'manifest-key-conflict'
      | 'identity-mismatch'
      | 'probe-failed'
      | 'unreadable'
      | 'unsupported-entry'
      | 'fetch-failed'
      | 'scan-rejected'
    >
  | 'confirmation-required'

/** Nothing was written: no target or no plan. */
export interface UpdateRefusal {
  ok: false
  reason: UpdateRefusalReason
  detail: string
  /** For `identity-mismatch` from UD22's rule: the key that owns the real path. */
  owningManifestKey?: string
  /** The path the refusal is about, when there is one. */
  path?: string
  /** The fetch-and-scan failure, as `install()` would have returned it. */
  install?: InstallResult
}

export type UpdateTargetResult = { ok: true; target: UpdateTarget } | UpdateRefusal

/**
 * `swapInPlace`'s result. `next` is set only for a commit whose backup
 * publish stopped on a full state root (`incomplete.reason ===
 * 'state-root-full'`): the new tree is installed and the record kept, so a
 * rerun is refused `recovery-pending`; `next` names the command that finishes.
 */
export type UpdateResult = SwapResult & { next?: string }

export interface UpdateInPlaceOptions {
  onProgress?: ProgressCallback
  /** Called once per lock-3 acquisition that waits on an older version's bare-PID claim. */
  onLegacyWait?: (pid: number | null) => void
  /** @internal `swapInPlace`'s test seams. */
  swap?: SwapOptions
  /** @internal Wraps the real manifest port (a counting proxy in tests). */
  wrapPort?: (port: ManifestPort) => ManifestPort
}
