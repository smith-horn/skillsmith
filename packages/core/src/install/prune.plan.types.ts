/**
 * SMI-6531 (A1 step 6c-ii-b): the contract between the `--prune` dry run's
 * parts. Types only: no fs, no values.
 *
 * - `assignLocks` (services/skill-backups.locks.ts) produces a `LockAssignment`
 *   per listed copy (UD62, UD63, design note D12-D14).
 * - `planPrune` (install/prune.select.ts) turns a listing, a `PruneRequest` and
 *   those assignments into a `PrunePlan`, without touching the filesystem.
 * - The CLI renders the plan. 6c-iii confirms and executes exactly this shape.
 *
 * Design: docs/internal/implementation/smi-6531-6cii-backups-design-note.md,
 * sections 1.2, 2, 4.1, 4.2, 5.1 and 6.
 *
 * @module @skillsmith/core/install/prune.plan.types
 */
import type { FreshJob } from './prune.job.js'

/** Which lock a copy's deletion would hold (UD62, UD63, PLAN:915). */
export type LockAssignment =
  | {
      kind: 'lock1'
      /** The lock file's native path: lock 1 of the skills root. */
      path: string
      /** The skills root it locks (its native realpath). */
      root: string
    }
  | {
      kind: 'lock1prime'
      /** The lock file's native path: `<stateRoot>/locks/parked-<sha256(areaReal)[:16]>.lock`. */
      path: string
      /** The realpath the key was taken from: a parked area, or `<stateRoot>/backups/update/<client>/<rootKey>/`. */
      areaReal: string
    }
  | {
      /** No lock can be named: the copy is kept and named, never selected (D12, D13). */
      kind: 'unknown'
      reason: string
    }

/** Lock assignments keyed by the copy's `copyPath`. */
export type LockMap = ReadonlyMap<string, LockAssignment>

/** What the user asked for. Every selector is optional; with none, nothing is selected. */
export interface PruneRequest {
  /** Captured once and carried into any re-plan, so `--older-than` cannot flip between plan and re-plan. */
  now: number
  olderThanDays?: number
  /**
   * `--keep <n>`. `undefined` means not given: the default of 1 then only guards
   * the newest tree per group and selects nothing (UD65, M-KEEP1). A number means
   * given explicitly: it guards the newest n AND selects (alone, every older tree;
   * with other selectors, only within their intersection).
   */
  keep?: number
  client?: string
  /** Each as given; matched by native realpath where the plan says so (D15). */
  roots?: readonly string[]
  skill?: string
  op?: string
  /** One or more exact trees, compared by native realpath (D18). */
  paths?: readonly string[]
  includeKept: boolean
  /** Copies named for a per-item yes despite a held, changed or unverified class. Native realpaths. */
  allowChanged: readonly string[]
}

/** The confirmation 6c-iii would ask for. Never an authorization: the planner emits none (M-T2). */
export type PlanTier = 'batch' | 'per-item'

/** One selected copy: every `FreshJob` field except `authorization`, plus its tier. */
export type PlanItem = Omit<FreshJob, 'authorization'> & {
  store: 'parked' | 'backup'
  kind: string | null
  allocatedBytes: number
  tier: PlanTier
}

export interface PlanGroup {
  /** The lock this group's deletions would hold. Never `unknown`: such copies are excluded. */
  lock: Exclude<LockAssignment, { kind: 'unknown' }>
  /** What 6c-iii passes to `listBackups({ scope })` to re-plan this group under its lock. */
  scope: { areaPaths: string[] }
  items: PlanItem[]
  /** sha256 over the group's canonical serialization (design note section 2). */
  digest: string
}

/** Why a tree the selectors matched was not selected (D20). */
export type ExcludeReason =
  | {
      code: 'protected'
      rule: 'live-record' | 'backup-dest' | 'parked-unreadable-record'
      path: string
    }
  | { code: 'protection-unknown'; reason: string }
  | { code: 'newest-kept' }
  | { code: 'needs-include-kept'; kind: string | null }
  | { code: 'mounted' }
  | { code: 'needs-allow-changed'; klass: 'held' | 'changed' | 'unverified' }
  | { code: 'lock-unknown'; reason: string }
  | { code: 'unknown-age' }
  /** No deletion job can name it: its root identity, or the hash to approve, is unknown. */
  | { code: 'unidentified'; reason: string }

export interface ExcludedRow {
  copyPath: string
  store: 'parked' | 'backup'
  reason: ExcludeReason
}

/** A run-wide reason `--apply` would refuse, shown and not enforced by the dry run (D10). */
export type Precondition =
  | { code: 'unreadable-record'; root: string; recordPath: string }
  | { code: 'area-refused'; path: string; reason: string }

export interface PrunePlan {
  request: PruneRequest
  /** True when no selector was given: nothing is selected, and the output says so. */
  noSelector: boolean
  preconditions: Precondition[]
  /** In UD60 order: ascending bytewise order of the lock file's native path. */
  groups: PlanGroup[]
  excluded: ExcludedRow[]
  /**
   * D18: each `--path` that names no copy prune lists, and why (not found, a temp,
   * a `.prune-*` directory, the parked index, a legacy leftover, outside every
   * store). The CLI exits 1 when this is non-empty.
   */
  unmatchedPaths: { path: string; why: string }[]
}
