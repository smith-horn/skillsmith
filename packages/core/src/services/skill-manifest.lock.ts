/**
 * SMI-7143 (A1 step 0): the manifest lock's pre-commit check (B1) and the one
 * locked update every manifest writer runs (A1 plan "Prerequisite: SMI-6358,
 * redefined").
 *
 * The manifest lock is `withFileLock(manifestPath, …)`, so its file is the
 * unchanged `manifest.json.lock` that older Skillsmith versions also use.
 * Those versions steal a lock whose mtime is more than 30 s old (the legacy
 * `ManifestManager.acquireLock`, as at `a6b69c932`: unlink, then create
 * their own). A writer held up past that point (a stopped process, a slow
 * disk) would otherwise save over a legacy writer's change. So right after
 * acquiring, the lock file's inode and bytes are kept, and immediately before
 * the manifest rename the update saves only if the same file is still there,
 * byte for byte, and younger than 25 s. Otherwise it throws
 * `ManifestLockLost`, and the update retries once from the load.
 *
 * Age is measured on two clocks (owner decision, 2026-10-18). The wall clock
 * is what a legacy stealer uses. The filesystem's own clock, read as the
 * mtime of the manifest temp file just written in the same directory, is the
 * clock the lock's mtime came from. Either age reaching 25 s fails. A lock
 * newer than that temp file is a clock that moved backwards and fails closed.
 * A lock that only looks newer than the wall clock is skew between the two
 * clocks, not theft: measured on a Docker Desktop bind mount, the host-stamped
 * mtime ran up to 0.74 ms ahead of the container's clock, and a legacy
 * stealer computes a negative age there and never steals.
 *
 * Release never unlinks a lock this process no longer owns: owned-lock's
 * release checks the claim's token first (`owned-lock.claim.ts`, E8).
 *
 * Residual windows (mitigated, not closed):
 * - A stall between the check and rename(2) (a stopped process, a paused VM)
 *   of more than 30 s minus the lock's age at the check still lets a legacy
 *   stealer in; the 25 s limit leaves at least 5 s.
 * - Clocks of different hosts sharing the directory are compared through the
 *   lock's mtime; skew larger than that margin is not covered.
 * - Owned-lock's release reads the claim, then unlinks it: a stealer acting
 *   between the two loses its lock. This predates SMI-7143.
 *
 * @module @skillsmith/core/services/skill-manifest.lock
 */
import fs from 'node:fs'
import { withFileLock } from '../config/file-lock.js'
import { writeManifestAtomic } from './skill-manifest.atomic.js'

/** A save is refused once the lock is this old (a legacy stealer acts after 30 s). */
export const MAX_LOCK_AGE_NS = 25_000_000_000n

/** The lock file as one `lstat` and one read saw it. */
export interface LockSnapshot {
  ino: bigint
  mtimeNs: bigint
  bytes: Buffer
}

/** The two clocks the age is measured on, in nanoseconds. */
export interface LockClocks {
  /** The wall clock, rounded up to the end of its current millisecond. */
  wallNs: bigint
  /** The filesystem's clock: the mtime of a file just written beside the lock. */
  fsNs: bigint
}

/** The manifest lock was lost between acquiring it and the rename. Nothing was saved. */
export class ManifestLockLost extends Error {
  readonly why: string
  readonly lockPath: string
  constructor(lockPath: string, why: string) {
    super(
      `[skillsmith] The manifest lock at ${lockPath} was lost before saving (${why}); nothing was saved.`
    )
    this.name = 'ManifestLockLost'
    this.why = why
    this.lockPath = lockPath
  }
}

/** The lock file now, or null when it is gone. Never follows a link. */
export function snapshotLock(lockPath: string): LockSnapshot | null {
  let st: fs.BigIntStats
  try {
    st = fs.lstatSync(lockPath, { bigint: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  let bytes: Buffer
  try {
    bytes = fs.readFileSync(lockPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  return { ino: st.ino, mtimeNs: st.mtimeNs, bytes }
}

/**
 * Why the lock is no longer this writer's, or null when it still is. Pure, so
 * the age boundaries are tested with injected nanoseconds (T-M3).
 */
export function lockStillOurs(
  acquired: LockSnapshot,
  now: LockSnapshot | null,
  clocks: LockClocks
): string | null {
  if (now === null) return 'the lock file is gone'
  if (now.ino !== acquired.ino) return 'the lock file was replaced (another inode)'
  if (!now.bytes.equals(acquired.bytes)) return "the lock file's content changed"
  const fsAge = clocks.fsNs - now.mtimeNs
  if (fsAge < 0n) {
    return 'the lock is newer than a file just written beside it: the file clock moved backwards'
  }
  const wallAge = clocks.wallNs - now.mtimeNs
  if (fsAge >= MAX_LOCK_AGE_NS || wallAge >= MAX_LOCK_AGE_NS) {
    return 'the lock is 25 s old or older, and an older Skillsmith steals it at 30 s'
  }
  return null
}

/** The wall clock in nanoseconds, rounded up to the end of the current millisecond. */
function wallNowNs(): bigint {
  return BigInt(Date.now()) * 1_000_000n + 999_999n
}

/** The default warning, once per acquisition, when an older version's claim is waited on. */
function warnLegacyWait(pid: number | null): void {
  console.warn(
    `[skillsmith] The manifest lock is held by an older Skillsmith process` +
      `${pid === null ? '' : ` (pid ${pid})`}; waiting up to 30 s for it to finish.`
  )
}

export interface ManifestUpdateArgs<M> {
  manifestPath: string
  /** Loads the manifest under the lock. Throws on anything but a missing file. */
  load: () => Promise<M>
  /**
   * Synchronous (A1 plan §3.2): a promise is refused. It runs again if the
   * lock is lost before saving, so state it records outside itself must be
   * reset at its start (the run that was saved is the one that counts).
   */
  update: (manifest: M) => M
  /** Serializes the updated manifest; JSON with two-space indent by default. */
  serialize?: (manifest: M) => string
  /** Called once per lock acquisition that waits on an older version's bare-PID claim. */
  onLegacyWait?: (pid: number | null) => void
}

/**
 * Load, update and save the manifest under the manifest lock, with the
 * pre-commit check before the rename and one retry from the load if the lock
 * was lost. A second loss throws `ManifestLockLost`. A bare-PID claim from an
 * older version is waited on like any live holder (A1 plan §3.8, #8).
 */
export async function runManifestUpdate<M>(args: ManifestUpdateArgs<M>): Promise<void> {
  const lockPath = `${args.manifestPath}.lock`
  const serialize = args.serialize ?? ((m: M) => JSON.stringify(m, null, 2))
  for (let attempt = 1; ; attempt++) {
    try {
      await withFileLock(
        args.manifestPath,
        'manifest update',
        async () => {
          const acquired = snapshotLock(lockPath)
          if (acquired === null) throw new ManifestLockLost(lockPath, 'the lock file is gone')
          const manifest = await args.load()
          const updated = args.update(manifest)
          if (updated == null || typeof updated !== 'object') {
            throw new TypeError(
              'runManifestUpdate: update must return the manifest; it returned nothing'
            )
          }
          if (typeof (updated as { then?: unknown }).then === 'function') {
            throw new TypeError(
              'runManifestUpdate: update must be synchronous; it returned a promise'
            )
          }
          await writeManifestAtomic(args.manifestPath, serialize(updated), {
            beforeRename: (tempPath) => {
              const fsNs = fs.statSync(tempPath, { bigint: true }).mtimeNs
              const why = lockStillOurs(acquired, snapshotLock(lockPath), {
                wallNs: wallNowNs(),
                fsNs,
              })
              if (why !== null) throw new ManifestLockLost(lockPath, why)
            },
          })
        },
        { waitOnLegacy: true, onLegacyWait: args.onLegacyWait ?? warnLegacyWait }
      )
      return
    } catch (err) {
      if (err instanceof ManifestLockLost && attempt === 1) continue
      throw err
    }
  }
}
