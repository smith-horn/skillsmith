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
 *  - {@link acquireConfigLock} serializes ALL writers (cross-process) so a
 *    caller's full read-modify-write sequence is one atomic critical
 *    section. SMI-5883 Wave 2: this is now a thin wrapper over the shared
 *    two-level {@link acquireOwnedLock} primitive (`owned-lock.ts`) —
 *    staleness is determined by OWNER LIVENESS (not file age), and a stale
 *    lock is reclaimed only from inside a second, strict-no-auto-reclaim
 *    lock that serializes reclaim decisions. The prior age-based
 *    `STALE_LOCK_AGE_MS` force-clear is REMOVED, not tuned — a lock held
 *    legitimately longer than any timeout now correctly times out instead
 *    of being force-cleared out from under its live holder. See
 *    `owned-lock.ts`'s module docstring for the full soundness argument.
 *  - {@link atomicWriteFile} writes to a temp file in the same directory,
 *    then `renameSync`s it into place — POSIX guarantees `rename(2)` is
 *    atomic, so a concurrent reader (which never needs the lock — only
 *    writers do) always observes either the fully-old or fully-new file,
 *    never a torn write.
 */

import { randomBytes } from 'node:crypto'
import { writeFileSync, renameSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { acquireOwnedLock } from './owned-lock.js'

/**
 * Max time to wait for a lock before giving up (ms). This guards a
 * user-facing CLI/MCP-server startup path, so it must fail loudly with a
 * clear error rather than hang indefinitely.
 */
const LOCK_ACQUIRE_TIMEOUT_MS = 5_000

/**
 * Acquire an exclusive, cross-process lock guarding `configPath`. Thin
 * wrapper over {@link acquireOwnedLock} (SMI-5883 Wave 2) — preserves this
 * function's signature and its `${configPath}.lock` path so no caller needs
 * to change. Behaviour deltas vs the pre-SMI-5883 implementation (each
 * covered by a test in `config-atomic-write.test.ts`):
 *
 *  1. A stale lock is cleared on OWNER DEATH, not on AGE. A lock held by a
 *     live process for longer than the old 10s threshold is no longer
 *     force-cleared — it now correctly waits, then times out.
 *  2. A legacy bare-PID lock (this module's OWN pre-SMI-5883 on-disk format)
 *     is no longer cleared at all — `StuckLockError { reason:
 *     'unreclaimable_legacy' }` (D-5: a legacy claim carries no `host`, so
 *     "dead on this host" cannot establish "dead").
 *  3. The on-disk lock content changes from a bare PID to a v1 JSON record.
 *     No in-repo consumer parses it directly (only this module's own
 *     `acquireConfigLock`/release touch the file).
 *  4. The timeout message keeps the stable prefix "Timed out waiting for
 *     config lock" (via `label: 'config lock'`) so existing assertions
 *     still match, with the failure reason and the manual unstick procedure
 *     appended.
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
  return acquireOwnedLock(configPath, { timeoutMs, label: 'config lock' })
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
