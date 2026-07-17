/**
 * Atomic config-file write primitives.
 * @module @skillsmith/core/config/config-atomic-write
 *
 * SMI-5531: `saveConfig` (./index.ts) previously did an unguarded
 * read-then-write (`loadConfig()` then a bare `writeFileSync()`), which has
 * two distinct failure modes under concurrent writers (two CLI/MCP-server
 * processes touching `~/.skillsmith/config.json` around the same time —
 * e.g. one setting `apiKey`, another calling `getOrCreateInstallId()`):
 *
 *  1. Lost update / dropped sibling key: process A and process B both read
 *     the same pre-write snapshot, each merges its OWN change on top, then
 *     writes; whichever writes last wins, and its snapshot does not include
 *     the other's change — that key is silently dropped.
 *  2. Torn write: a bare `writeFileSync` is not atomic with respect to a
 *     concurrent reader on every platform/filesystem; a reader could in
 *     principle observe a partially-written file.
 *
 * This module fixes both:
 *  - {@link acquireConfigLock} serializes ALL writers (cross-process, via a
 *    create-exclusive `.lock` sentinel file) so a caller's full
 *    read-modify-write sequence is one atomic critical section.
 *  - {@link atomicWriteFile} writes to a temp file in the same directory,
 *    then `renameSync`s it into place — POSIX guarantees `rename(2)` is
 *    atomic, so a concurrent reader (which never needs the lock — only
 *    writers do) always observes either the fully-old or fully-new file,
 *    never a torn write.
 */

import { randomBytes } from 'node:crypto'
import {
  openSync,
  closeSync,
  unlinkSync,
  writeFileSync,
  renameSync,
  statSync,
  chmodSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Max time to wait for a lock before giving up (ms). This guards a
 * user-facing CLI/MCP-server startup path, so it must fail loudly with a
 * clear error rather than hang indefinitely.
 */
const LOCK_ACQUIRE_TIMEOUT_MS = 5_000

/** Backoff between lock-acquisition retries (ms). */
const LOCK_RETRY_DELAY_MS = 20

/**
 * A lock file older than this is assumed to be left behind by a crashed
 * process (stale) and is force-removed. A healthy holder releases the lock
 * within milliseconds of a local JSON read+write, so this is a generous
 * margin, not a tight race.
 */
const STALE_LOCK_AGE_MS = 10_000

/**
 * Synchronously block the calling thread for `ms` milliseconds without
 * spinning the CPU. `Atomics.wait` on a throwaway `SharedArrayBuffer` is the
 * standard synchronous-sleep primitive in Node (unlike browsers, Node does
 * not forbid calling it on the main thread).
 */
function sleepSync(ms: number): void {
  const view = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(view, 0, 0, ms)
}

/**
 * Acquire an exclusive, cross-process lock guarding `configPath`.
 *
 * Uses atomic create-exclusive (the `wx` flag — fails with `EEXIST` if the
 * lock file already exists) as the mutual-exclusion primitive: portable
 * (identical behavior on macOS/Linux/Windows) and needs no extra
 * dependency. Retries with a short backoff until `LOCK_ACQUIRE_TIMEOUT_MS`
 * elapses. If the held lock is older than `STALE_LOCK_AGE_MS` it is assumed
 * abandoned by a crashed process and force-cleared once, then retried.
 *
 * @param configPath - Path to the config file being guarded (NOT the lock
 * file itself — the lock file is `${configPath}.lock`).
 * @param timeoutMs - Override the acquire timeout (test seam; production
 * callers should omit this and use the default).
 * @returns A release function. Callers MUST call it exactly once, in a
 * `finally` block, so the lock is released even if the guarded work throws.
 */
export function acquireConfigLock(
  configPath: string,
  timeoutMs: number = LOCK_ACQUIRE_TIMEOUT_MS
): () => void {
  const lockPath = `${configPath}.lock`
  const deadline = Date.now() + timeoutMs
  let staleClearAttempted = false

  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600)
      try {
        writeFileSync(fd, String(process.pid))
      } finally {
        closeSync(fd)
      }
      return () => {
        try {
          unlinkSync(lockPath)
        } catch {
          // Already gone. Releasing an already-released lock is a no-op,
          // not an error (defensive — should not happen in practice since
          // each acquire pairs with exactly one release).
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err

      if (!staleClearAttempted) {
        staleClearAttempted = true
        try {
          const age = Date.now() - statSync(lockPath).mtimeMs
          if (age > STALE_LOCK_AGE_MS) {
            unlinkSync(lockPath)
            continue // retry immediately — don't burn the backoff budget on this attempt
          }
        } catch {
          // Lock file vanished between the failed open and this stat (the
          // holder released it concurrently, or another waiter already
          // cleared it) — just retry the open below.
          continue
        }
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `[skillsmith] Timed out waiting for config lock at ${lockPath} after ` +
            `${timeoutMs}ms. If this persists, a crashed process may have left a ` +
            `stale lock — verify no other skillsmith process is running, then remove ${lockPath} manually.`
        )
      }
      sleepSync(LOCK_RETRY_DELAY_MS)
    }
  }
}

/**
 * Write `content` to `filePath` atomically: write to a temp file in the same
 * directory, then `renameSync` into place. A concurrent reader (which never
 * needs to hold the config lock — only writers do) always observes either
 * the fully-old or fully-new file content, never a torn write.
 *
 * The caller is responsible for holding {@link acquireConfigLock} for the
 * duration of the read-modify-write this write is part of; this function
 * alone only makes the WRITE step atomic, not the whole sequence around it.
 */
export function atomicWriteFile(filePath: string, content: string, mode: number): void {
  const dir = dirname(filePath)
  const tmpPath = join(dir, `.${randomBytes(6).toString('hex')}.tmp`)
  writeFileSync(tmpPath, content, { encoding: 'utf-8', mode })
  renameSync(tmpPath, filePath)
  // rename() preserves the temp file's mode bits on POSIX, but re-assert
  // explicitly — belt-and-braces, mirroring saveConfig's prior behavior, and
  // a no-op cost on the common path.
  try {
    chmodSync(filePath, mode)
  } catch {
    // Ignore chmod errors on Windows.
  }
}
