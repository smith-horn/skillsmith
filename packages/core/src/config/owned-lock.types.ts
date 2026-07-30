/**
 * Shared types + tuning constants for the two-level owned-lock primitive.
 * @module @skillsmith/core/config/owned-lock.types
 * @see owned-lock.ts for the full soundness argument and public API.
 */

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/** Max time to wait for the MAIN lock before giving up (ms). Unchanged from today's `acquireConfigLock` default. */
export const LOCK_ACQUIRE_TIMEOUT_MS = 5_000
/** Backoff between lock-acquisition retries (ms). */
export const LOCK_RETRY_DELAY_MS = 20
/** Delay before the FIRST reclaim probe -- keeps the reclaim lock off the hot path when the holder is alive. */
export const RECLAIM_PROBE_AFTER_MS = 250
/** Backoff between reclaim probe attempts once contention is established. */
export const RECLAIM_PROBE_INTERVAL_MS = 250
/** Max time to wait for the RECLAIM lock. Its critical section is 3 syscalls with no caller code -- a longer wait would itself indicate an orphan (R1). */
export const RECLAIM_LOCK_TIMEOUT_MS = 500
/** Bounded read cap for a lock claim file -- refuses (never crashes on) an oversized/garbage lock file. */
export const MAX_LOCK_BYTES = 4_096

export const HARDLINK_UNAVAILABLE_CODES = new Set([
  'EPERM',
  'EACCES',
  'ENOSYS',
  'EXDEV',
  'EMLINK',
  'EOPNOTSUPP',
  'ENOTSUP',
])

// ---------------------------------------------------------------------------
// Claim shapes
// ---------------------------------------------------------------------------

/** A live, current-format claim: `{"v":1,"pid":...,"token":"<16 hex>","host":"...","acquiredAt":...}`. */
export interface V1Claim {
  kind: 'v1'
  pid: number
  token: string
  host: string
  acquiredAt: number
}
/** A bare-decimal-PID claim (today's `acquireConfigLock` format). Carries no `host` -- NEVER auto-reclaimed (D-5). */
export interface LegacyClaim {
  kind: 'legacy'
  pid: number
}
/** Empty, garbage, truncated, or valid-JSON-but-wrong-shape/version. NEVER auto-reclaimed. */
export interface UnparseableClaim {
  kind: 'unparseable'
}
/** No lock file present at the path read. */
export interface AbsentClaim {
  kind: 'absent'
}
export type Claim = V1Claim | LegacyClaim | UnparseableClaim | AbsentClaim

/** Outcome of a single reclaim attempt (`tryReclaimUnderLock`). */
export type ReclaimOutcome = 'reclaimed' | 'not-stale' | 'gone' | 'unavailable'

/** Why the pre-filter (outside the reclaim critical section) declined to even attempt a reclaim. */
export type RefusalCategory = 'held' | 'legacy' | 'unparseable' | 'reclaim-disabled'

// ---------------------------------------------------------------------------
// Public error contract
// ---------------------------------------------------------------------------

export type StuckLockReason =
  | 'held'
  | 'unreclaimable_legacy'
  | 'unreclaimable_unparseable'
  | 'reclaim_unavailable'
  | 'reclaim_disabled'

/**
 * Public, SAFE option set for `acquireOwnedLock` (owned-lock.ts). Does NOT
 * include the two destructive test-only seams (`unsafeSkipReclaimRevalidation`,
 * `linkSyncOverride`) -- those live only on the internal
 * `AcquireOwnedLockCoreOptions` (owned-lock.acquire.ts, no public subpath
 * export), so a package consumer can never pass them through the public
 * `acquireOwnedLock()` entry point. See owned-lock.acquire.ts's module comment
 * for the full rationale.
 */
export interface AcquireOwnedLockOptions {
  /** Override the acquire timeout. Production callers should omit this and use the default. */
  timeoutMs?: number
  /** Human label used in the timeout message, e.g. `'config lock'` -> "Timed out waiting for config lock at ...". Defaults to `'lock'`. */
  label?: string
  /** Delay before the first reclaim probe (ms). Production callers should omit this; test-only override. */
  reclaimProbeAfterMs?: number
  /**
   * @internal Test seam (owned-lock-reclaim-race.test.ts §8b). Fires AFTER
   * the pre-filter has validated a dead claim and BEFORE any reclaim-lock
   * acquisition or removal is attempted. Never set in production code.
   * (Read-only observability -- unlike the two omitted options above, this
   * cannot affect the locking safety properties, so it's safe to leave on
   * the public type.)
   */
  onReclaimBoundary?: () => void
  /**
   * @internal Test seam (owned-lock-reclaim-race.test.ts §8b). Fires
   * immediately after `tryReclaimUnderLock` returns, with its outcome.
   * Never set in production code. Read-only, same rationale as above.
   */
  onReclaimOutcome?: (outcome: ReclaimOutcome) => void
}
