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
 */
function isLockTimeoutError(err: unknown): boolean {
  return err instanceof StuckLockError
}

export async function withLockTimeoutMapping<T>(
  manifestPath: string,
  run: () => Promise<T>
): Promise<T> {
  try {
    return await run()
  } catch (err) {
    if (err instanceof ReconcileGuardError) throw err
    if (isLockTimeoutError(err)) {
      throw new ReconcileGuardError('manifest.reconcile.lock_timeout', {
        path: `${manifestPath}.lock`,
      })
    }
    throw err
  }
}
