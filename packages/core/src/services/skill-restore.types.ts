/**
 * SMI-6531 (A1 step 6d-ii): the shapes `skillsmith restore <id>` plans with
 * and returns (design note §4, §5). Types only.
 *
 * @module @skillsmith/core/services/skill-restore.types
 */
import type { ListBackupsOptions } from './skill-backups.listing.js'
import type { ListedCopy } from '../install/prune.list.types.js'
import type { RootIdentity } from '../install/prune.job.js'
import type { StrandedClaim, WithParkedAreaLockResult } from '../config/file-lock.parked.js'
import type { LockAssignment } from '../install/prune.plan.types.js'

export type RestoreRefusalReason =
  | 'restore-bad-id'
  | 'restore-not-found'
  | 'restore-ambiguous'
  | 'origin-unknown'
  | 'nothing-to-restore-into'
  | 'restore-kind-unknown'
  | 'restore-mounted'
  | 'restore-unreadable'
  | 'restore-unsupported-type'
  | 'origin-parent-missing'
  | 'origin-mismatch'
  | 'origin-root-unbindable'
  | 'origin-root-undiscovered'
  | 'origin-root-unknown'
  | 'origin-occupied'
  | 'restore-busy'
  | 'plan-changed'
  | 'restore-failed'
  | 'locks-dir-changed'

export type RestoreType = 'directory' | 'file' | 'symlink'

/** §4.1a: the lock restore takes. */
export type RestoreLock =
  | { kind: 'lock1'; root: string; path: string }
  | { kind: 'lock1prime'; path: string; stateRoot: string; areaReal: string }

export type RestoreContents =
  | { state: 'unchanged' }
  | { state: 'changed' }
  | { state: 'not-checked'; why: string }

export interface RestorePlan {
  copyPath: string
  opId: string
  kind: string
  held: boolean
  type: RestoreType
  origin: string
  /** Where restore writes: the bound real path of the origin's parent, then its name (§5, no symlinked component is followed). */
  target: string
  lock: RestoreLock
  bytes: number
  contents: RestoreContents
  /** The §4.1a / `assignLocks` disagreement note (not part of the digest). */
  lockNote: string | null
  /** The same disagreement as data: what prune would lock with, and what restore locks. Null when they agree. */
  lockDisagreement: { prune: LockAssignment | null; restore: RestoreLock } | null
  /** sha256 over everything the confirmation covered (§4.4). */
  digest: string
  /** What execution needs to re-check the copy. */
  copy: ListedCopy
  rootIdentity: RootIdentity
  sidecarBytes: Buffer
  sidecarIno: bigint
  /** The options the plan was made with, so the re-plan under the lock is the same question. */
  options: RestorePlanOptions
}

export interface RestorePlanOptions {
  stateRoot?: string
  roots?: readonly string[]
  discovered?: ListBackupsOptions['discovered']
  /** @internal Test seam: discovery overrides. */
  discovery?: ListBackupsOptions['discovery']
  /** @internal Test seam. */
  measure?: ListBackupsOptions['measure']
}

export interface RestoreCandidate {
  copyPath: string
  kind: string | null
  origin: string | null
}

export type PlanRestoreResult =
  | { status: 'planned'; plan: RestorePlan }
  | {
      status: 'refused'
      reason: RestoreRefusalReason
      message: string
      candidates?: RestoreCandidate[]
    }

export type RestoreResult =
  | {
      status: 'restored'
      origin: string
      copyPath: string
      /** Result sentences (§5.5) and non-fatal warnings. */
      notes: string[]
      warnings: string[]
      strandedLockClaim?: StrandedClaim
    }
  | {
      status: 'refused' | 'stopped'
      reason: RestoreRefusalReason | 'sync-failed' | 'claim-left' | 'link-stopped' | 'unlink-failed'
      message: string
      /** True when the stop left something behind (exit 4); false means nothing changed (exit 1). */
      changed: boolean
      warnings: string[]
      strandedLockClaim?: StrandedClaim
    }

/** @internal Test seams for `executeRestoreWith`; not exported from the package. */
export interface RestoreHooks {
  beforeClaim?: () => void
  afterLink?: () => void
  beforeUnlink?: () => void
  /** Replaces the lock timeout. */
  lockTimeoutMs?: number
  /** @internal Test seam: wraps the lock's own check (`ctx.check()` / `ctx.recheck()`) so a test can force it to throw. */
  wrapCheck?: (real: () => void) => () => void
  /** Replaces the lock 1′ runner (default `withParkedAreaLock`): a test passes one with the wrapper's own seams. */
  runLock?: (
    lockPath: string,
    label: string,
    fn: Parameters<typeof import('../config/file-lock.parked.js').withParkedAreaLock>[2],
    options?: { timeoutMs?: number }
  ) => Promise<WithParkedAreaLockResult<RestoreResult>>
}
