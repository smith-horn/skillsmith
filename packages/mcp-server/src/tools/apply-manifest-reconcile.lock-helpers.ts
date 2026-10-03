/**
 * @fileoverview Shared lock-timeout mapping for `apply_manifest_reconcile`'s
 *               action implementations (SMI-6343 Wave 4).
 * @module @skillsmith/mcp-server/tools/apply-manifest-reconcile.lock-helpers
 *
 * Split out so both `apply-manifest-reconcile.actions.ts` and
 * `apply-manifest-reconcile.verify.ts` share one implementation rather than
 * two copies drifting apart.
 */

import { StuckLockError } from '@skillsmith/core'
import { ReconcileGuardError } from './apply-manifest-reconcile.helpers.js'

/**
 * SMI-6735: both manifest write paths now lock via `withFileLock`, which
 * throws the typed `StuckLockError` on timeout — no more string-matching a
 * message that "has no typed shape" (that was true of the old hand-rolled
 * `ManifestManager.acquireLock()`/`acquireManifestLock()` protocols this
 * replaced; `StuckLockError` carries `reason`, `lockPath`, and `reclaimPath`,
 * and its message does not contain the old literal this used to match).
 *
 * A type guard (not a plain boolean predicate) so the caller below can read
 * `err.lockPath`/`err.reclaimPath`/`err.reason` off the narrowed type instead
 * of re-deriving the lock path from `manifestPath` — that re-derivation was
 * itself a second, independently-drifting copy of the path `owned-lock.ts`
 * already computes (SMI-6735 adversarial-review finding 1), and it silently
 * dropped `reclaimPath`, defeating `StuckLockError`'s own documented
 * mitigation for its R1 residual risk (an orphaned reclaim lock is only
 * diagnosable if BOTH file paths reach the user — see owned-lock.ts's module
 * docstring).
 */
function isLockTimeoutError(err: unknown): err is StuckLockError {
  return err instanceof StuckLockError
}

/**
 * Only `reclaim_unavailable` names a SECOND file (owned-lock.ts's R1
 * mitigation) — `held`/`reclaim_disabled`/the two `unreclaimable_*` reasons
 * never touch the reclaim lock at all, so surfacing a `reclaimPath` for them
 * would point at a file that was never implicated.
 */
function reclaimPathFor(err: StuckLockError): string | undefined {
  return err.reason === 'reclaim_unavailable' ? err.reclaimPath : undefined
}

export async function withLockTimeoutMapping<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    if (err instanceof ReconcileGuardError) throw err
    if (isLockTimeoutError(err)) {
      throw new ReconcileGuardError('manifest.reconcile.lock_timeout', {
        path: err.lockPath,
        lockReason: err.reason,
        reclaimPath: reclaimPathFor(err),
      })
    }
    throw err
  }
}
