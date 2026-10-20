/**
 * SMI-6531 (A1 step 2): the directory `fsync`, extracted from the manifest's
 * private helper so the staging protocol (`services/skill-write-lock.ts`) and
 * the manifest write share one implementation (A1 plan §3.3: "A created entry is
 * followed by a sync of its parent directory").
 *
 * This helper REPORTS what happened instead of deciding what it means. The
 * manifest treats `unsupported` as a silent no-op and `failed` as a warning
 * (its save has already happened); the staging protocol records `unsupported`
 * and refuses on `failed`.
 *
 * @module @skillsmith/core/install/dir-sync
 */
// The `fs/promises` specifier is deliberate: `skill-manifest.atomic.test.ts`
// wraps that module with vi.mock, and the manifest's directory sync must stay
// reachable by it.
import { open } from 'fs/promises'

/** Codes a filesystem returns when it cannot fsync a directory at all. */
const DIR_SYNC_UNSUPPORTED = new Set(['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR', 'ENOSYS'])

export type DirSyncOutcome =
  /** The directory was opened and `fsync` returned. */
  | { outcome: 'synced' }
  /** The platform or filesystem cannot sync a directory (Windows included). */
  | { outcome: 'unsupported'; code: string }
  /** Any other failure: the entry the sync was meant to make durable may not be. */
  | { outcome: 'failed'; code: string; error: unknown }

/** `fsync` the directory `dir`. Never throws. */
export async function syncDirectory(dir: string): Promise<DirSyncOutcome> {
  if (process.platform === 'win32') return { outcome: 'unsupported', code: 'win32' }
  try {
    const dirHandle = await open(dir, 'r')
    try {
      await dirHandle.sync()
    } finally {
      await dirHandle.close()
    }
    return { outcome: 'synced' }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? ''
    if (DIR_SYNC_UNSUPPORTED.has(code)) return { outcome: 'unsupported', code }
    return { outcome: 'failed', code: code || String(err), error: err }
  }
}
