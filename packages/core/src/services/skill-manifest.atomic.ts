/**
 * SMI-7143 (A1 step 0): `writeManifestAtomic`, the manifest's one durable
 * write (A1 plan "Prerequisite: SMI-6358, redefined", E6).
 *
 * A temp file in the manifest's own directory, opened
 * `O_CREAT|O_EXCL|O_NOFOLLOW` so nothing already at that name (a planted
 * symlink included) is written through; the full content written and
 * `fsync`ed; an optional `beforeRename` check; `rename(2)` onto the manifest;
 * then the directory `fsync`ed so the rename itself survives a crash. The
 * previous `save` renamed an unsynced temp, so a crash could leave a
 * zero-length or stale manifest behind a rename that had already happened.
 *
 * A failure after the temp file is created and before the rename removes
 * only that file and rethrows; the manifest is untouched. After the rename
 * the new manifest is in place, so nothing after it throws: a throw would tell
 * the caller "not saved" when it was. The directory sync is skipped on
 * Windows, which cannot fsync a directory handle; a filesystem that does not
 * support it (EINVAL, ENOTSUP, EPERM, EISDIR, ENOSYS: some FUSE and network
 * mounts) is a no-op; any other failure is a warning that the rename may not
 * survive a crash.
 *
 * @module @skillsmith/core/services/skill-manifest.atomic
 */
import { constants } from 'node:fs'
// Named imports from 'fs/promises', the specifier skill-manifest.ts uses, so
// tests that wrap these exports with vi.mock reach this module too.
import { open, rename, unlink } from 'fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export interface WriteManifestAtomicOptions {
  /**
   * Runs after the temp file is written and synced, immediately before the
   * rename, with the temp file's path (the manifest lock's pre-commit check
   * reads its mtime as the filesystem's "now"). A throw aborts the write: the
   * temp file is removed and the manifest is left as it was.
   */
  beforeRename?: (tempPath: string) => void | Promise<void>
}

/** Writes `content` to `manifestPath` durably and atomically (see the module comment). */
export async function writeManifestAtomic(
  manifestPath: string,
  content: string,
  options: WriteManifestAtomicOptions = {}
): Promise<void> {
  const dir = path.dirname(manifestPath)
  const tempPath = `${manifestPath}.tmp.${process.pid}.${randomUUID()}`
  const buf = Buffer.from(content, 'utf8')
  let created = false
  let renamed = false
  try {
    const handle = await open(
      tempPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o666
    )
    created = true
    try {
      let off = 0
      while (off < buf.length) {
        const { bytesWritten } = await handle.write(buf, off, buf.length - off)
        if (bytesWritten === 0) throw new Error(`writeManifestAtomic: write made no progress`)
        off += bytesWritten
      }
      await handle.sync()
    } finally {
      await handle.close()
    }
    await options.beforeRename?.(tempPath)
    await rename(tempPath, manifestPath)
    renamed = true
  } catch (err) {
    // An open that failed (EEXIST included) created nothing of ours: whatever
    // is at that name is someone else's and is left alone.
    if (created && !renamed) {
      try {
        await unlink(tempPath)
      } catch (cleanupErr) {
        // Only this call's own temp file. The original error is still the one
        // rethrown; the leftover is named so it is not silent.
        warnSafely(
          `[skillsmith] Could not remove the temporary manifest ${tempPath} ` +
            `(${(cleanupErr as NodeJS.ErrnoException).code ?? String(cleanupErr)}); it is safe to delete.`
        )
      }
    }
    throw err
  }
  await syncDirectory(dir)
}

/** Codes a filesystem returns when it cannot fsync a directory at all. */
const DIR_SYNC_UNSUPPORTED = new Set(['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR', 'ENOSYS'])

/**
 * A warning that cannot itself throw: a replaced or throwing `console.warn`
 * (an embedding application's logger) must not turn a saved manifest into a
 * reported failure, or replace the error a failed save is reporting.
 */
function warnSafely(message: string): void {
  try {
    console.warn(message)
  } catch {
    // Nothing else can report it; the save's outcome stands either way.
  }
}

/** Best-effort directory fsync after the rename; never throws, its warning included. */
async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') return
  try {
    const dirHandle = await open(dir, 'r')
    try {
      await dirHandle.sync()
    } finally {
      await dirHandle.close()
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? ''
    if (DIR_SYNC_UNSUPPORTED.has(code)) return
    warnSafely(
      `[skillsmith] The manifest was saved, but its directory could not be synced (${code || String(err)}); ` +
        `the save may not survive a crash.`
    )
  }
}
