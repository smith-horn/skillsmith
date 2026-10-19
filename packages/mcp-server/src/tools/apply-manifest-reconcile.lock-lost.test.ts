/**
 * SMI-7143: a manifest update that loses its lock twice before saving throws
 * core's `ManifestLockLost`; apply_manifest_reconcile maps it to its own
 * `manifest.reconcile.lock_lost` code, so the user sees why nothing was saved
 * instead of a raw error. A lock timeout keeps its own code.
 */
import { describe, expect, it } from 'vitest'
import { ManifestLockLost } from '@skillsmith/core'
import { withLockTimeoutMapping } from './apply-manifest-reconcile.lock-helpers.js'
import { ReconcileGuardError } from './apply-manifest-reconcile.helpers.js'
import { describeReconcileError } from './apply-manifest-reconcile.errors.js'

describe('withLockTimeoutMapping and ManifestLockLost', () => {
  it('maps a lost lock to manifest.reconcile.lock_lost, naming the lock and why', async () => {
    const lost = new ManifestLockLost(
      '/sandbox/.skillsmith/manifest.json.lock',
      'the lock file was replaced (another inode)'
    )
    const err = await withLockTimeoutMapping(async () => {
      throw lost
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ReconcileGuardError)
    const guard = err as ReconcileGuardError
    expect(guard.code).toBe('manifest.reconcile.lock_lost')
    // The text the tool's dispatcher shows the user.
    const shown = describeReconcileError(guard.code, guard.ctx)
    expect(shown).toContain(
      "'/sandbox/.skillsmith/manifest.json.lock' was lost before saving, twice"
    )
    expect(shown).toContain('the lock file was replaced (another inode)')
    expect(shown).toContain('nothing was saved')
  })

  it('control: an error that is neither a lost lock nor a lock timeout passes through unchanged', async () => {
    const other = new Error('unrelated')
    await expect(
      withLockTimeoutMapping(async () => {
        throw other
      })
    ).rejects.toBe(other)
  })
})
