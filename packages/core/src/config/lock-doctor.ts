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
 * - `inspectLock` reads a lock once, without following a symlink, and says
 *   what it can and cannot know: the claim's kind, pid and host, whether that
 *   host is this one, whether the pid is alive on THIS host, and its age.
 * - `releaseLock` frees, without the unsafe flag, only a v1 claim from this
 *   host whose pid is dead (`kill(pid, 0)` gives `ESRCH`). A pid alive here
 *   may be a reused pid; a pid from a container may name the host's pid 1
 *   (plan E17). Every other claim needs `unsafeUnverifiedOwner`. A claim it
 *   cannot read (another user's `0600` claim, plan E31) is never released.
 * - Before unlinking, `releaseLock` takes `<path>.reclaim` by exclusive
 *   create, the file owned-lock's own reclaimers serialize on, then re-reads
 *   the lock: the inode and bytes must equal what it inspected.
 *
 * Residual (not closed): an older Skillsmith's manifest lock steals by
 * unlinking without `.reclaim`, so one acting between the final re-read and
 * the unlink would lose its new lock. Its steal needs a lock over 30 s old,
 * the same window owned-lock's own release has.
 *
 * @module @skillsmith/core/config/lock-doctor
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, unlinkSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { createLockExclusive, parseClaim, randomHex, releaseOwned } from './owned-lock.claim.js'
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

/** Whether `pid` is alive on this host: `ESRCH` is dead; success and `EPERM` are alive. */
function pidAliveHere(pid: number): boolean | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null // kill(0, 0) signals the group
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

type ReadResult = { bytes: Buffer; ino: bigint } | { error: string; code: string | undefined }

/** One bounded read of the file at `path`, never through a symlink. */
function readLockBytes(path: string): ReadResult {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
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
      pidAliveHere: sameHost ? pidAliveHere(claim.pid) : null,
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
      pidAliveHere: pidAliveHere(claim.pid),
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
  /** @internal Test seam (T-M2): runs after `.reclaim` is taken, before the final re-read. */
  beforeFinalCheck?: () => void
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
        `${reclaimPath} exists: another process is deciding about this lock, or an earlier one ` +
        'stopped mid-way. Run `skillsmith doctor locks` to inspect it.',
      inspection: insp,
    }
  }
  try {
    opts.beforeFinalCheck?.()
    const now = inspectLock(path)
    if (now === null) {
      return {
        outcome: 'refused',
        refusal: 'gone',
        message: `${path} was removed meanwhile`,
        inspection: insp,
      }
    }
    if (now.ino !== insp.ino || now.bytes === null || !now.bytes.equals(insp.bytes)) {
      return {
        outcome: 'refused',
        refusal: 'changed',
        message: `${path} changed after it was inspected (another inode or other bytes); nothing was removed`,
        inspection: insp,
      }
    }
    try {
      unlinkSync(path)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      return {
        outcome: 'refused',
        refusal: 'gone',
        message: `${path} was removed meanwhile`,
        inspection: insp,
      }
    }
    return { outcome: 'released', inspection: insp, unverifiedReason: unverified }
  } finally {
    releaseOwned(reclaimPath, token)
  }
}

/**
 * The lock files `doctor locks` lists for a state root: the manifest lock and
 * its reclaim lock. The skills-root write lock joins them when A1 adds it
 * (plan §3.9, step 2), with the skills-root discovery of step 6.
 */
export function stateRootLockPaths(stateRoot: string): string[] {
  const manifestLock = join(stateRoot, 'manifest.json.lock')
  return [manifestLock, `${manifestLock}.reclaim`]
}
