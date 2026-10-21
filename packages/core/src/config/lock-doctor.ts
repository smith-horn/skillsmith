/**
 * SMI-7143 (A1 step 0, part 2): what `skillsmith doctor locks` inspects and
 * releases (A1 plan §3.9; review #2 and #6; test T-M2).
 *
 * Owned-lock never auto-reclaims a bare-PID or unparseable claim, or a claim
 * from another host, so a crashed older Skillsmith can wedge a lock until
 * someone removes it. Removing one by hand is safe only when its owner is
 * known to be gone, and only if the file removed is the one that was looked
 * at. So:
 *
 * - `inspectLock` reads a lock once, never following a symlink at the lock
 *   path itself, and says what it can and cannot know: the claim's kind, pid
 *   and host, whether that host is this one, whether the pid is alive on THIS
 *   host, and its age. The folders above it are the caller's to canonicalize
 *   (the CLI resolves the state root with `realpath`).
 * - `releaseLock` frees, without the unsafe flag, only a v1 claim from this
 *   host whose pid is dead (`kill(pid, 0)` gives `ESRCH`). A pid alive here
 *   may be a reused pid; a pid from a container may name the host's pid 1
 *   (plan E17). Every other claim needs `unsafeUnverifiedOwner`. A claim it
 *   cannot read (another user's `0600` claim, plan E31) is never released.
 * - `releaseLock` takes `<path>.reclaim` by exclusive create, the file
 *   owned-lock's own reclaimers and releases serialize on (SMI-7148). It then
 *   renames the lock to a unique name beside it, which moves whatever is at
 *   the path in one step, and removes the moved file only if its inode and
 *   bytes equal what it inspected. A removal by path name after a check would
 *   delete a newer lock that a fresh acquire put there in between. If the
 *   moved file is a newer lock, it is linked back (exclusive) and the release
 *   refused. A holder that releases while its lock is aside waits for this
 *   command to finish, then finds its lock back and removes it.
 *
 * Residuals (not closed; owner decision 2026-10-19 to keep the move aside):
 * - If yet another lock is created at the path before the link back, the
 *   moved one is left beside it, named in the refusal, and its holder no
 *   longer excludes the new one.
 * - A process of the same user that swaps a folder above the lock mid-run
 *   can redirect the rename; it could equally change the lock itself.
 * - A lock is identified by its inode and bytes. A fixed-content claim (a
 *   bare PID) removed and recreated with the same bytes, on a filesystem that
 *   reuses the inode, can't be told from the one inspected: its timestamps
 *   matched too when measured. A v1 claim's random token rules this out.
 *
 * @module @skillsmith/core/config/lock-doctor
 */
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  createLockExclusive,
  parseClaim,
  probePidAlive,
  randomHex,
  releaseClaimFile,
} from './owned-lock.claim.js'
import { MAX_LOCK_BYTES } from './owned-lock.types.js'

/** `v1` and `bare-pid` are owned-lock's claim formats; anything else it can read is `unparseable`. */
export type LockClaimKind = 'v1' | 'bare-pid' | 'unparseable' | 'cant-read'

export interface LockInspection {
  path: string
  kind: LockClaimKind
  /** Why the claim is unparseable or unreadable, in words; null otherwise. */
  note: string | null
  ino: bigint
  /** The lock file's owner uid (named when the claim can't be read). */
  uid: number
  mtimeNs: bigint
  /** Wall clock minus the lock's mtime, in nanoseconds. */
  ageNs: bigint
  /** The bytes read; null when the claim can't be read. */
  bytes: Buffer | null
  pid: number | null
  host: string | null
  /** Whether `host` is this host; null when the claim names none. */
  sameHost: boolean | null
  /** Whether `pid` is alive on THIS host; null when not probed (no pid, or another host's). */
  pidAliveHere: boolean | null
}

type ReadResult = { bytes: Buffer; ino: bigint } | { error: string; code: string | undefined }

/** One bounded read of the file at `path`, never through a symlink. */
function readLockBytes(path: string): ReadResult {
  let fd: number
  try {
    // O_NONBLOCK: a FIFO swapped in after lstat must not block the open.
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return { error: `could not open it (${code ?? String(err)})`, code }
  }
  try {
    const st = fstatSync(fd, { bigint: true })
    const buf = Buffer.alloc(MAX_LOCK_BYTES + 1)
    const n = readSync(fd, buf, 0, buf.length, 0)
    if (n > MAX_LOCK_BYTES) return { error: `it is over ${MAX_LOCK_BYTES} bytes`, code: undefined }
    return { bytes: Buffer.from(buf.subarray(0, n)), ino: st.ino }
  } catch (err) {
    // A directory or FIFO swapped in after lstat (EISDIR, ESPIPE): unreadable, not a crash.
    const code = (err as NodeJS.ErrnoException).code
    return { error: `could not read it (${code ?? String(err)})`, code }
  } finally {
    closeSync(fd)
  }
}

/** The lock at `path` as it is now, or null when nothing is there. Never follows a symlink. */
export function inspectLock(path: string): LockInspection | null {
  let st
  try {
    st = lstatSync(path, { bigint: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  const base = {
    path,
    ino: st.ino,
    uid: Number(st.uid),
    mtimeNs: st.mtimeNs,
    ageNs: BigInt(Date.now()) * 1_000_000n - st.mtimeNs,
    pid: null,
    host: null,
    sameHost: null,
    pidAliveHere: null,
  }
  if (!st.isFile()) {
    const what = st.isSymbolicLink() ? 'a symlink' : 'not a regular file'
    return { ...base, kind: 'unparseable', note: `it is ${what}`, bytes: null }
  }
  const read = readLockBytes(path)
  if ('error' in read) {
    const denied = read.code === 'EACCES' || read.code === 'EPERM'
    return { ...base, kind: denied ? 'cant-read' : 'unparseable', note: read.error, bytes: null }
  }
  if (read.ino !== st.ino) {
    return { ...base, kind: 'unparseable', note: 'it was replaced while being read', bytes: null }
  }
  const claim = parseClaim(read.bytes.toString('utf8'))
  if (claim.kind === 'v1') {
    const sameHost = claim.host === hostname()
    return {
      ...base,
      kind: 'v1',
      note: null,
      bytes: read.bytes,
      pid: claim.pid,
      host: claim.host,
      sameHost,
      pidAliveHere: sameHost ? probePidAlive(claim.pid) : null,
    }
  }
  if (claim.kind === 'legacy') {
    // A bare-PID claim records no host: the probe says only whether that pid
    // is alive HERE, which is not evidence about its owner.
    return {
      ...base,
      kind: 'bare-pid',
      note: null,
      bytes: read.bytes,
      pid: claim.pid,
      pidAliveHere: probePidAlive(claim.pid),
    }
  }
  return {
    ...base,
    kind: 'unparseable',
    note: 'its content is not a lock claim',
    bytes: read.bytes,
  }
}

/** Why the owner of a readable claim can't be shown to be gone, or null when it can. */
export function unverifiedOwnerReason(insp: LockInspection): string | null {
  if (insp.kind === 'bare-pid') {
    return `it is a bare-PID claim (pid ${insp.pid}) from an older Skillsmith, which records no host`
  }
  if (insp.kind === 'unparseable') return `its owner can't be read from it: ${insp.note}`
  if (insp.kind !== 'v1') return null
  if (!insp.sameHost)
    return `it was taken on another host (${insp.host}), whose pids can't be checked here`
  if (insp.pidAliveHere === null) return `its pid (${insp.pid}) is not a valid process id`
  if (insp.pidAliveHere) {
    return `its pid (${insp.pid}) is alive on this host: the owner, or another process reusing the pid`
  }
  return null
}

export type ReleaseRefusal =
  | 'absent'
  | 'cant-read'
  | 'unverified-owner'
  | 'not-comparable'
  | 'reclaim-held'
  | 'changed'
  | 'gone'

export type ReleaseResult =
  | { outcome: 'released'; inspection: LockInspection; unverifiedReason: string | null }
  | {
      outcome: 'refused'
      refusal: ReleaseRefusal
      message: string
      inspection: LockInspection | null
    }

export interface ReleaseLockOptions {
  /** Release a claim whose owner can't be shown to be gone (bare-PID, unparseable, other host, live pid). */
  unsafeUnverifiedOwner?: boolean
  /**
   * The lock as the caller showed it to the user: refuse unless the first
   * inspection still has this inode and these bytes, so what was shown is
   * what is released.
   */
  expected?: { ino: bigint; bytes: Buffer }
  /** @internal Test seam (T-M2): runs after `.reclaim` is taken, before the lock is moved. */
  beforeFinalCheck?: () => void
  /** @internal Test seam: runs after the lock is moved aside, before it is checked. */
  afterMoveAside?: () => void
}

/** Release the lock at `path` under the rules in the module comment. Never throws on a refusal. */
export function releaseLock(path: string, opts: ReleaseLockOptions = {}): ReleaseResult {
  const insp = inspectLock(path)
  if (insp === null) {
    return {
      outcome: 'refused',
      refusal: 'absent',
      message: `nothing is at ${path}`,
      inspection: null,
    }
  }
  if (insp.kind === 'cant-read') {
    return {
      outcome: 'refused',
      refusal: 'cant-read',
      message:
        `the claim at ${path} can't be read (${insp.note}); it belongs to uid ${insp.uid}. ` +
        'Run this as that user or an administrator. It is never released unread.',
      inspection: insp,
    }
  }
  if (insp.bytes === null) {
    // Without bytes, the final check can't show the file is the one inspected.
    return {
      outcome: 'refused',
      refusal: 'not-comparable',
      message:
        `${path}: ${insp.note}. Doctor compares a lock's bytes before removing it, so it won't ` +
        'remove this one; check that no Skillsmith process uses it, then remove it by hand.',
      inspection: insp,
    }
  }
  const unverified = unverifiedOwnerReason(insp)
  if (unverified !== null && !opts.unsafeUnverifiedOwner) {
    return {
      outcome: 'refused',
      refusal: 'unverified-owner',
      message:
        `its owner can't be verified: ${unverified}. If you know no Skillsmith process still uses it, ` +
        'add --unsafe-unverified-owner.',
      inspection: insp,
    }
  }
  if (
    opts.expected !== undefined &&
    (opts.expected.ino !== insp.ino || !opts.expected.bytes.equals(insp.bytes))
  ) {
    return {
      outcome: 'refused',
      refusal: 'changed',
      message: `${path} changed after it was shown; nothing was removed`,
      inspection: insp,
    }
  }
  const reclaimPath = `${path}.reclaim`
  const token = randomHex(8)
  const record =
    JSON.stringify({ v: 1, pid: process.pid, token, host: hostname(), acquiredAt: Date.now() }) +
    '\n'
  if (!createLockExclusive(reclaimPath, record)) {
    return {
      outcome: 'refused',
      refusal: 'reclaim-held',
      message:
        `${reclaimPath} exists: another process is deciding about this lock, or one stopped ` +
        `mid-way. If no Skillsmith process is running, remove ${reclaimPath} by hand.`,
      inspection: insp,
    }
  }
  try {
    opts.beforeFinalCheck?.()
    const aside = join(dirname(path), `.${basename(path)}.doctor-${token}`)
    try {
      renameSync(path, aside)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      return {
        outcome: 'refused',
        refusal: 'gone',
        message: `${path} was removed meanwhile`,
        inspection: insp,
      }
    }
    opts.afterMoveAside?.()
    const moved = inspectLock(aside)
    if (moved !== null && moved.ino === insp.ino && moved.bytes?.equals(insp.bytes) === true) {
      unlinkSync(aside)
      return { outcome: 'released', inspection: insp, unverifiedReason: unverified }
    }
    // The file moved is not the one inspected: a newer lock. Put it back.
    try {
      linkSync(aside, path)
    } catch (err) {
      return {
        outcome: 'refused',
        refusal: 'changed',
        message:
          `${path} changed after it was inspected. The newer lock was moved to ${aside} and ` +
          `could not be put back (${(err as NodeJS.ErrnoException).code ?? String(err)}); ` +
          'nothing was removed. Check which Skillsmith process holds it.',
        inspection: insp,
      }
    }
    try {
      unlinkSync(aside)
    } catch (err) {
      return {
        outcome: 'refused',
        refusal: 'changed',
        message:
          `${path} changed after it was inspected; the newer lock is back in place, but its ` +
          `extra name ${aside} could not be removed ` +
          `(${(err as NodeJS.ErrnoException).code ?? String(err)}). Remove ${aside} by hand; ` +
          'nothing else was changed.',
        inspection: insp,
      }
    }
    return {
      outcome: 'refused',
      refusal: 'changed',
      message: `${path} changed after it was inspected (another inode or other bytes); nothing was removed`,
      inspection: insp,
    }
  } finally {
    // The reclaim lock's own release is unguarded (SMI-7148): a guarded one
    // would take `<reclaimPath>.reclaim`.
    releaseClaimFile(reclaimPath, token)
  }
}

/**
 * The lock files `doctor locks` lists for a state root: the manifest lock and
 * its reclaim lock. The skills-root write lock's paths are
 * `skillsRootLockPaths` (`services/skill-write-lock.ts`, A1 step 2); listing
 * them here needs the skills-root discovery and the CLI wiring of step 6
 * (plan §3.9), so they are not part of this list yet.
 */
export function stateRootLockPaths(stateRoot: string): string[] {
  const manifestLock = join(stateRoot, 'manifest.json.lock')
  return [manifestLock, `${manifestLock}.reclaim`]
}
