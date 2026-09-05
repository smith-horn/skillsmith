/**
 * @fileoverview Shared lock-timeout mapping for `apply_manifest_reconcile`'s
 *               action implementations (SMI-6343 Wave 4).
 * @module @skillsmith/mcp-server/tools/apply-manifest-reconcile.lock-helpers
 *
 * Split out so both `apply-manifest-reconcile.actions.ts` and
 * `apply-manifest-reconcile.verify.ts` share one implementation rather than
 * two copies drifting apart.
 */

import { ReconcileGuardError } from './apply-manifest-reconcile.helpers.js'

/** `ManifestManager.acquireLock()`'s 30s-timeout error has no typed shape — match its message. */
function isLockTimeoutError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('Failed to acquire manifest lock')
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
