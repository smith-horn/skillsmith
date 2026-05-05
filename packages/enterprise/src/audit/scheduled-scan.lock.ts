// SPDX-License-Identifier: Elastic-2.0
// Copyright 2024-2025 Smith Horn Group Ltd

/**
 * @fileoverview Lock-file mutex for the Enterprise scheduled-scan runner.
 * @module @skillsmith/enterprise/audit/scheduled-scan.lock
 *
 * Plan: docs/internal/implementation/smi-4590-cli-mcp-framework-adapter.md §7
 * (SMI-4752 follow-up).
 *
 * Why a separate file: keeps `scheduled-scan.ts` under the project's
 * 500-line cap (`audit:standards` Check 12). The lock module is
 * self-contained and exercised independently by the concurrent-fire
 * regression tests.
 *
 * Contract:
 *   - `acquireScanLock(homeDir, onCacheCheck)` returns one of:
 *     - `{ kind: 'acquired', release }` — caller owns the lock; must
 *       call `release()` in a `finally` block.
 *     - `{ kind: 'cached', cached }` — a peer published a result while
 *       we were inspecting the lock; ride it.
 *     - `{ kind: 'inflight' }` — fresh, alive lock with no cache hit;
 *       caller should throw `scheduled_scan.in_flight`.
 *   - On EACCES/ENOSPC/etc this throws via the `onError` callback (so
 *     the caller can wrap it in a typed error).
 *
 * Cross-platform notes:
 *   - `O_EXCL` on `fs.open(..., 'wx')` is atomic on macOS APFS, Linux
 *     ext4/btrfs, and NFSv4. NFSv3 has known issues; not a target.
 *   - `process.kill(pid, 0)` returns `ESRCH` for dead pids and `EPERM`
 *     for live-but-foreign pids. Only ESRCH triggers reclaim.
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * Stale-lock reclaim window. Lock files older than this are assumed to
 * be orphaned (process killed before try/finally could unlink) and are
 * unlinked on the next acquire attempt. Env-overridable for tests.
 *
 * Default 5 minutes — long enough that a real audit (~tens of seconds)
 * never trips it, short enough that an orphan doesn't block the next
 * cron tick. Cap at 1h to defend against absurd overrides.
 */
const DEFAULT_LOCK_STALE_MS = 5 * 60 * 1000
const MAX_LOCK_STALE_MS = 60 * 60 * 1000

interface LockPayload {
  pid: number
  startedAt: number
  hostname: string
}

/**
 * Counts shape mirrored from the runner — we keep this local rather
 * than importing from `scheduled-scan.types.ts` so the lock module has
 * zero coupling to the runner's option/result types.
 */
export interface LockCachedResult {
  auditId: string
  reportPath: string
  counts: { exact: number; generic: number; semantic: number }
}

export type LockAcquireOutcome =
  | { kind: 'acquired'; release: () => Promise<void> }
  | { kind: 'cached'; cached: LockCachedResult }
  | { kind: 'inflight' }

/**
 * Callback used inside the EEXIST branch to ask the runner whether a
 * fresh result has materialised since we started inspecting the lock.
 * The runner's `findRecentAudit` is the canonical source.
 */
export type CacheProbe = () => Promise<LockCachedResult | null>

/**
 * Callback the runner provides to wrap fs errors (EACCES, ENOSPC, etc.)
 * in its typed `ScheduledScanError`. Keeping the throw out of this
 * module avoids a circular import.
 */
export type FsErrorThrower = (err: unknown) => never

/**
 * Atomically acquire `~/.skillsmith/audits/.scan.lock` via O_EXCL. On
 * EEXIST, reclaim the lock if it's stale (older than the configured
 * window OR the holding PID is dead on this host). If it's fresh and
 * alive, fall back to the cache or report in-flight.
 */
export async function acquireScanLock(
  homeDir: string,
  cacheProbe: CacheProbe,
  throwFsError: FsErrorThrower
): Promise<LockAcquireOutcome> {
  const auditsDir = path.join(homeDir, '.skillsmith', 'audits')
  const lockPath = path.join(auditsDir, '.scan.lock')

  // Ensure parent dir exists with restrictive perms.
  await fs.mkdir(auditsDir, { recursive: true, mode: 0o700 })

  // Up to 2 attempts: first try, then one retry after stale-lock reclaim.
  for (let attempt = 0; attempt < 2; attempt++) {
    const acquired = await tryCreateLock(lockPath)
    if (acquired.kind === 'created') {
      return {
        kind: 'acquired',
        release: async () => {
          try {
            await fs.unlink(lockPath)
          } catch {
            // Best-effort: another reclaim or filesystem quirk may have
            // unlinked it already. Not fatal.
          }
        },
      }
    }
    if (acquired.kind === 'fs_error') {
      // Permission/disk/readonly error — bubble up via the runner's
      // typed error so the caller doesn't loop or silently report
      // in-flight.
      throwFsError(acquired.err)
    }

    // EEXIST. Inspect the holder.
    const holder = await readLockPayload(lockPath)
    if (holder === null) {
      // Unparseable — treat as stale on first attempt only (prevents
      // infinite loop if a write race keeps producing junk).
      if (attempt === 0) {
        await tryUnlinkLock(lockPath)
        continue
      }
      return { kind: 'inflight' }
    }

    if (isStaleLock(holder)) {
      if (attempt === 0) {
        await tryUnlinkLock(lockPath)
        continue
      }
      // Already retried once — don't loop forever. Fall through to
      // cache check + in-flight handling.
    }

    // Fresh + alive lock. Re-check the cache: the in-flight peer may
    // have just published a result while we were inspecting the lock.
    const cached = await cacheProbe()
    if (cached !== null) {
      return { kind: 'cached', cached }
    }
    return { kind: 'inflight' }
  }

  return { kind: 'inflight' }
}

type CreateLockOutcome =
  | { kind: 'created' }
  | { kind: 'exists' }
  | { kind: 'fs_error'; err: unknown }

async function tryCreateLock(lockPath: string): Promise<CreateLockOutcome> {
  const payload: LockPayload = {
    pid: process.pid,
    startedAt: Date.now(),
    hostname: os.hostname(),
  }
  try {
    // 'wx' = write-exclusive, atomic O_EXCL create. Throws EEXIST if
    // the file already exists.
    const handle = await fs.open(lockPath, 'wx', 0o600)
    try {
      await handle.writeFile(JSON.stringify(payload), { encoding: 'utf-8' })
    } finally {
      await handle.close()
    }
    return { kind: 'created' }
  } catch (err) {
    if (isErrnoCode(err, 'EEXIST')) return { kind: 'exists' }
    // Any other fs error (EACCES, ENOSPC, EROFS) — surface so the caller
    // can throw an audit_failed instead of pretending the lock is held.
    return { kind: 'fs_error', err }
  }
}

async function readLockPayload(lockPath: string): Promise<LockPayload | null> {
  try {
    const raw = await fs.readFile(lockPath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<LockPayload>
    if (
      typeof parsed.pid !== 'number' ||
      typeof parsed.startedAt !== 'number' ||
      typeof parsed.hostname !== 'string'
    ) {
      return null
    }
    return { pid: parsed.pid, startedAt: parsed.startedAt, hostname: parsed.hostname }
  } catch {
    return null
  }
}

function isStaleLock(holder: LockPayload): boolean {
  const now = Date.now()
  const ageMs = now - holder.startedAt
  if (ageMs < 0) {
    // Clock skew or future-dated lock — treat as suspicious but not
    // stale. Don't reclaim; let the lock owner finish or expire.
    return false
  }
  if (ageMs > resolveLockStaleMs()) return true

  // Same-host PID liveness check. We only treat ESRCH as stale —
  // EPERM means the PID exists but we can't signal it (different uid),
  // which is NOT the same as dead.
  if (holder.hostname === os.hostname()) {
    if (!isPidAlive(holder.pid)) return true
  }
  return false
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    if (isErrnoCode(err, 'ESRCH')) return false
    // EPERM: PID exists, owned by another uid. Treat as alive (don't
    // reclaim — would be a no-op anyway since unlink+create might race
    // with the real owner's release).
    return true
  }
}

function resolveLockStaleMs(): number {
  const raw = process.env['SKILLSMITH_SCHEDULED_AUDIT_LOCK_STALE_MS']
  if (!raw) return DEFAULT_LOCK_STALE_MS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LOCK_STALE_MS
  return Math.min(parsed, MAX_LOCK_STALE_MS)
}

async function tryUnlinkLock(lockPath: string): Promise<void> {
  try {
    await fs.unlink(lockPath)
  } catch {
    // Best-effort.
  }
}

function isErrnoCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === code
}
