/**
 * SMI-7143: the manifest lock protocol of older Skillsmith versions, copied
 * from `ManifestManager.acquireLock` / `releaseLock` as at `a6b69c932`, so the
 * pre-commit check is tested against the stealer it exists to survive.
 *
 * The protocol: create `<manifest>.lock` with flag `wx` holding the bare pid;
 * on EEXIST, if the lock's mtime is more than 30 s old, unlink it and try
 * again; otherwise wait 100 ms. Release unlinks the lock without checking who
 * owns it.
 *
 * Differences from the original, none of which changes the protocol: the pid
 * written is a parameter (a test plays a different process), the timeout is
 * a parameter, and `assertNotRealUserHome` is left out (tests run in temp
 * directories).
 */
import fs from 'node:fs/promises'

/** The legacy staleness threshold and poll interval (`a6b69c932`). */
export const LEGACY_LOCK_TIMEOUT_MS = 30000
const LEGACY_LOCK_RETRY_MS = 100

/** Acquires the lock as an older version would; resolves when it holds it. */
export async function legacyAcquire(
  manifestPath: string,
  { pid = 424242, timeoutMs = LEGACY_LOCK_TIMEOUT_MS } = {}
): Promise<void> {
  const lockPath = manifestPath + '.lock'
  const startTime = Date.now()
  while (Date.now() - startTime < timeoutMs) {
    try {
      await fs.writeFile(lockPath, String(pid), { flag: 'wx' })
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        try {
          const stats = await fs.stat(lockPath)
          if (Date.now() - stats.mtimeMs > LEGACY_LOCK_TIMEOUT_MS) {
            await fs.unlink(lockPath).catch(() => {})
            continue
          }
        } catch {
          continue
        }
        await new Promise((resolve) => setTimeout(resolve, LEGACY_LOCK_RETRY_MS))
      } else {
        throw error
      }
    }
  }
  throw new Error('Failed to acquire manifest lock after ' + timeoutMs + 'ms')
}

/** Releases as an older version would: unlink, whoever owns it. */
export async function legacyRelease(manifestPath: string): Promise<void> {
  try {
    await fs.unlink(manifestPath + '.lock')
  } catch {
    // Ignore, as the original did.
  }
}
