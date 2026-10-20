/**
 * SMI-6531 (A1 step 2): types and names for `skill-write-lock.ts` (A1 plan
 * §3.2, §3.3).
 *
 * @module @skillsmith/core/services/skill-write-lock.types
 */
import type { BoundIdentity } from '../install/park-tree.identity.js'
import type { DirSyncOutcome } from '../install/dir-sync.js'
import type { BitsApplied } from '../install/mkdir-parent-bits.js'
import type { StuckLockReason } from '../config/owned-lock.js'
import { SKILL_STAGING_DIR_NAME, SKILL_WRITE_LOCK_FILE_NAME } from './skill-write-lock.gitignore.js'

/**
 * Lock 1's target inside the skills root; `withFileLock` appends `.lock`. Derived
 * from the hint module's lock-file name so the two cannot name different files.
 */
export const SKILL_WRITE_LOCK_BASENAME = SKILL_WRITE_LOCK_FILE_NAME.replace(/\.lock$/, '')
/** The per-root staging directory (A1 plan §3.2). Never removed by Skillsmith. */
export const STAGING_DIR_NAME = SKILL_STAGING_DIR_NAME

/** Why a write stopped before or inside lock 1. */
export type SkillWriteStopCode =
  /** Lock 1's wait ran out, or the claim could not be waited on (see `reason`). */
  | 'busy'
  /** R, or the lock file, is not the one that was bound. */
  | 'root-changed'
  /** `.skillsmith-staging/` or an operation directory is not the one that was bound. */
  | 'staging-unsafe'
  /** A backup-area component is not the one that was bound. */
  | 'backup-unsafe'
  /** The skills root is missing or is not a directory. */
  | 'root-unsafe'

/** A refusal. `fn` never ran past it, or must not mutate after it. */
export class SkillWriteStop extends Error {
  readonly code: SkillWriteStopCode
  /** The path the refusal is about. */
  readonly path: string
  /** What differed, in words. */
  readonly detail: string
  /** `busy` only: owned-lock's reason, so a caller can tell a wait from a dead end. */
  readonly reason?: StuckLockReason

  constructor(a: {
    code: SkillWriteStopCode
    path: string
    detail: string
    reason?: StuckLockReason
    cause?: unknown
  }) {
    super(`${a.code}: ${a.detail} (${a.path})`, a.cause === undefined ? {} : { cause: a.cause })
    this.name = 'SkillWriteStop'
    this.code = a.code
    this.path = a.path
    this.detail = a.detail
    if (a.reason !== undefined) this.reason = a.reason
  }
}

/** What `bindSkillsRoot` bound before lock 1 (A1 plan §3.3, bound-paths table). */
export interface SkillsRootBinding {
  /** The caller's spelling; `check` re-resolves it. */
  readonly skillsDir: string
  /** R: the native `realpath` of `skillsDir`. */
  readonly root: string
  readonly rootIdentity: BoundIdentity
  /** ST: `<R>/.skillsmith-staging`. */
  readonly stagingDir: string
  readonly stagingIdentity: BoundIdentity
  /** True only when this call's `mkdir` made ST (not `EEXIST`). */
  readonly stagingCreated: boolean
  /** The sync of R after creating ST; `null` when this call did not create it. */
  readonly rootSync: DirSyncOutcome | null
  /**
   * What became of R's permission bits on ST. `exact` is the normal case;
   * `mismatch` and `not-applied` (a filesystem that refuses chmod, a platform
   * without a no-follow open) mean ST is narrower than R's bits and are recorded,
   * not refused: the bind still succeeds. A ST with a permission bit R lacks, or
   * without R's sticky bit, is refused (`staging-unsafe`).
   */
  readonly stagingBits: BitsApplied
  /**
   * One sentence per way ST is narrower than R's bits (setgid dropped, group or
   * other write missing, and why); empty when it is not. The caller shows them.
   */
  readonly warnings: readonly string[]
}

/** Extension points for step 4: the operation directory and backup-area components. */
export interface CheckScope {
  op?: { path: string; identity: BoundIdentity }
  backupArea?: ReadonlyArray<{ path: string; identity: BoundIdentity }>
}

/** What `fn` receives while lock 1 is held. */
export interface SkillWriteContext extends SkillsRootBinding {
  /** `<R>/.skillsmith-writes.lock`. */
  readonly lockPath: string
  /** Its identity, from the `lstat` made as the first step under the lock. */
  readonly lockIdentity: BoundIdentity
  /** Re-verify every bound identity; throws `SkillWriteStop`. Call before each mutation. */
  check(scope?: CheckScope): void
}

/** `warnings` is the binding's (`SkillsRootBinding.warnings`), present only when it is not empty. */
export type SkillWriteResult<T> =
  | { ok: true; value: T; gitignoreHint?: string; warnings?: readonly string[] }
  | { ok: false; stop: SkillWriteStop; gitignoreHint?: string; warnings?: readonly string[] }

export interface SkillWriteLockOptions {
  /** How long to wait for lock 1, in ms (default 30 s); a test seam. */
  timeoutMs?: number
  /**
   * @internal Test seam: runs after the pre-lock check and before lock 1 is
   * requested, the window the pre-lock check narrows but cannot close.
   */
  beforeLock?: () => void | Promise<void>
}
