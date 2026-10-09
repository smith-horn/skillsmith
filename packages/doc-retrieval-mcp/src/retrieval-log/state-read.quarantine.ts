/**
 * SMI-6995 — corrupt-state preservation (copy aside, NEVER move) + the
 * coordinated recovery writer.
 *
 * Split out of `state-read.ts` purely to stay under CLAUDE.md's 500-line
 * pre-commit gate — `state-read.ts` re-exports everything below, so every
 * caller still imports from one path (`./state-read.js`).
 *
 * ## Invariants this file holds
 *
 * **(C) `path` is never absent and never half-written.** The writer builds
 * the new state in a fsynced temp file, copies (never moves) any corrupt
 * prior bytes aside, and only then atomically renames the temp file over
 * `path`. Every failure before that rename leaves `path` exactly as it was.
 *
 * **(E) No committed state is lost or mislabelled by a concurrent writer
 * that commits between this writer's read and its rename** (PR #3020
 * cross-family review, finding 1). The writer records the identity of what
 * it read (`dev`, `ino`, `size`, `mtimeNs`, `ctimeNs`, taken before AND
 * after the read so the bytes provably belong to that identity), and:
 *
 * - the corrupt-bytes copy is made from a descriptor whose `fstat` must
 *   match that identity, so a valid state committed after the read can
 *   never be copied aside and labelled corrupt; and
 * - immediately before the rename, `path` is re-stat'd and must still match
 *   that identity. Any mismatch discards this attempt (temp file removed,
 *   `path` untouched) and re-runs the whole read-merge-write from the new
 *   state, up to {@link RECOVERY_WRITE_MAX_ATTEMPTS} times, then throws.
 *
 * Why a compare-before-rename and not a lock: no lock exists that every
 * writer of these files honours. The plain producers (autoheal, liveness,
 * reindex) write with temp+rename and no lock at all, so a lock taken only
 * here would exclude nobody but other callers of this function. The two
 * module-specific locks (`mcp-disconnect-state.ts`'s `withLock`,
 * `ruflo-bridge-state.ts`'s) are mkdir directories at `${path}.lock`, the
 * same name `@skillsmith/core`'s `acquireOwnedLock` uses for a lock FILE —
 * taking that lock here would collide with, not cooperate with, a caller
 * already inside `withLock`. An identity compare detects a change by any
 * writer, cooperating or not, and composes with a caller's own lock.
 *
 * **What this does NOT close — the residual window.** The re-stat and the
 * `renameSync` are two syscalls; a writer that commits between them is
 * still overwritten. Only a lock every writer honours closes that. A caller
 * that holds such a lock (e.g. inside `withLock`) and calls this from
 * inside it gets full serialization against the writers that share it.
 *
 * Also not closed: an in-place same-size rewrite of `path` that lands inside
 * one timestamp tick of the filesystem. `dev`, `ino`, `size`, `mtimeNs` and
 * `ctimeNs` all stay equal, so the identity compare sees no change. A writer
 * that replaces the file (new inode, as every producer here does via
 * temp+rename) is caught; an in-place rewrite is caught only if it changes
 * the size or crosses a timestamp tick.
 *
 * **(F) The temp file never outlives a failed call** (finding 2): it is
 * removed in a `finally` unless the final rename succeeded.
 *
 * **(G) The corrupt-bytes copy cannot be redirected through a symlink**
 * (finding 3). The source is opened ONCE with `O_NOFOLLOW`, validated with
 * `fstat` on that descriptor, and copied FROM that descriptor — there is no
 * second name resolution for a swap to race. A platform without
 * `O_NOFOLLOW` refuses the copy rather than copying unguarded.
 *
 * `copyCorruptStateAside` never throws; every refusal and failure is `null`
 * (including an Invalid Date `now`).
 */

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  type BigIntStats,
} from 'node:fs'
import { dirname } from 'node:path'

import { errMessage, readRawState } from './state-read.js'

/**
 * Destination candidates {@link copyCorruptStateAside} tries before giving
 * up (the base `.corrupt-<iso>` name, then `-2`, `-3`, ...). A hard bound so
 * a pathological case fails closed in bounded time.
 */
export const QUARANTINE_DEST_MAX_ATTEMPTS = 50

/**
 * How many times {@link writeEntryWithRecovery} re-runs its read-merge-write
 * after detecting that `path` changed under it before giving up (invariant
 * E). These files are written at most a few times per session, so needing
 * more than a couple of retries means something is rewriting the file in a
 * loop; failing closed then is better than spinning.
 */
export const RECOVERY_WRITE_MAX_ATTEMPTS = 5

/**
 * Test-only interleaving points. Each hook runs synchronously at the named
 * point so a test can commit a competing write exactly where a concurrent
 * process could. Production callers never pass these.
 */
export interface RecoveryTestHooks {
  /** copy-aside: after the source descriptor is opened and validated, before any byte is copied from it. */
  afterSourceOpened?: () => void
  /** writer: after the identity-bracketed read of `path`, before the temp write, copy-aside and commit check. */
  afterRead?: (attempt: number) => void
  /** writer: after the pre-rename identity check passed, before the rename — the residual window. */
  afterCommitCheck?: (attempt: number) => void
}

/** What `path` named at one instant. `null` = nothing there; a string = stat failed with that code. */
type Identity =
  | { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }
  | null
  | string

function identityOf(st: BigIntStats): Identity {
  return { dev: st.dev, ino: st.ino, size: st.size, mtimeNs: st.mtimeNs, ctimeNs: st.ctimeNs }
}

/** `stat` (following symlinks, as `readRawState`'s open does). Never throws. */
function statIdentity(path: string): Identity {
  try {
    const st = statSync(path, { bigint: true, throwIfNoEntry: false })
    return st === undefined ? null : identityOf(st)
  } catch (err) {
    return `stat-error:${(err as NodeJS.ErrnoException)?.code ?? errMessage(err)}`
  }
}

function sameIdentity(a: Identity, b: Identity): boolean {
  if (a === null || b === null || typeof a === 'string' || typeof b === 'string') return a === b
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  )
}

/**
 * Reserves an exclusive destination with `openSync(dest, 'wx')` — atomically
 * `EEXIST` if taken, so two concurrent callers never land on one slot — and
 * returns the reservation's OWN descriptor for the copy to write through, so
 * the bytes go into the exact file reserved, never a later incarnation of
 * that name. The caller owns `fd` and must close it. `null` (never throws)
 * when every candidate is taken or on any other failure.
 */
function allocateQuarantineDest(path: string, now: Date): { dest: string; fd: number } | null {
  let base: string
  try {
    // An Invalid Date makes toISOString throw RangeError; that must collapse
    // to `null` like every other refusal, never escape a never-throws path.
    base = `${path}.corrupt-${now.toISOString().replace(/[:.]/g, '-')}`
  } catch {
    return null
  }
  for (let attempt = 0; attempt < QUARANTINE_DEST_MAX_ATTEMPTS; attempt++) {
    const dest = attempt === 0 ? base : `${base}-${attempt + 1}`
    try {
      return { dest, fd: openSync(dest, 'wx') }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') continue
      return null
    }
  }
  return null
}

/** Copies every byte from `src` (read from offset 0) to `dst`, handling short reads and writes. Throws on I/O failure. */
function copyDescriptor(src: number, dst: number): void {
  const buf = Buffer.alloc(64 * 1024)
  let pos = 0
  for (;;) {
    const n = readSync(src, buf, 0, buf.length, pos)
    if (n === 0) return
    let off = 0
    while (off < n) off += writeSync(dst, buf, off, n - off)
    pos += n
  }
}

function closeQuietly(fd: number): void {
  try {
    closeSync(fd)
  } catch {
    // never let a close failure escape a never-throws path
  }
}

type CopyOutcome = { kind: 'copied'; dest: string } | { kind: 'changed' } | { kind: 'failed' }

/**
 * The shared copy-aside. Order: reserve the destination, open the source
 * once (`O_NOFOLLOW` refuses a symlink — finding 8, round 2; `O_NONBLOCK`
 * keeps a FIFO from blocking the open), `fstat` that descriptor and refuse
 * anything but a regular file (a directory — finding 7, round 2 — socket,
 * FIFO or device), and — when `expected` is given — refuse with `changed` if
 * the opened file is not the one the caller read (invariant E). Then copy
 * from the descriptor and fsync. A reservation never filled is unlinked
 * (finding 3, round 4); both descriptors are closed on every path.
 */
function copyAside(
  path: string,
  now: Date,
  expected: Identity | undefined,
  hooks: RecoveryTestHooks | undefined
): CopyOutcome {
  const O_NOFOLLOW = fsConstants.O_NOFOLLOW
  if (typeof O_NOFOLLOW !== 'number') return { kind: 'failed' } // invariant G: no unguarded copy
  const reserved = allocateQuarantineDest(path, now)
  if (reserved === null) return { kind: 'failed' }
  let src: number | null = null
  let filled = false
  try {
    src = openSync(path, fsConstants.O_RDONLY | O_NOFOLLOW | (fsConstants.O_NONBLOCK ?? 0))
    const st = fstatSync(src, { bigint: true })
    if (!st.isFile()) return { kind: 'failed' }
    if (expected !== undefined && !sameIdentity(identityOf(st), expected)) {
      return { kind: 'changed' }
    }
    hooks?.afterSourceOpened?.()
    copyDescriptor(src, reserved.fd)
    fsyncSync(reserved.fd)
    filled = true
    return { kind: 'copied', dest: reserved.dest }
  } catch {
    return { kind: 'failed' }
  } finally {
    if (src !== null) closeQuietly(src)
    closeQuietly(reserved.fd)
    if (!filled) {
      try {
        unlinkSync(reserved.dest)
      } catch {
        // best-effort — never let cleanup itself throw
      }
    }
  }
}

/**
 * Copies the bytes at `path` to a fresh sibling `${path}.corrupt-<ISO>` and
 * returns that path, leaving `path` untouched whether this succeeds or not.
 * Returns `null` — never throws — for a missing path, a symlink, a directory
 * or other non-regular file, an exhausted destination range, or any I/O
 * failure. See this file's top comment, invariants C and G. `hooks` is a
 * test-only seam ({@link RecoveryTestHooks}).
 */
export function copyCorruptStateAside(
  path: string,
  now: Date = new Date(),
  hooks?: Pick<RecoveryTestHooks, 'afterSourceOpened'>
): string | null {
  const outcome = copyAside(path, now, undefined, hooks)
  return outcome.kind === 'copied' ? outcome.dest : null
}

/**
 * Thrown by {@link writeEntryWithRecovery} when it did not write. Either the
 * corrupt prior state could not be preserved (`quarantinedTo: null`, `path`
 * untouched), `path` kept changing under the write (`quarantinedTo: null`,
 * `path` holds whatever the other writer committed), or preservation
 * succeeded and the final rename failed (`quarantinedTo` names where the
 * corrupt bytes are). A caller can always find the preserved bytes.
 */
export class RecoveryWriteError extends Error {
  readonly quarantinedTo: string | null

  constructor(message: string, quarantinedTo: string | null) {
    super(message)
    this.name = 'RecoveryWriteError'
    this.quarantinedTo = quarantinedTo
  }
}

/**
 * The last step of {@link writeEntryWithRecovery}: atomically replace `path`
 * with the already-written-and-fsynced `tmp`. Exported so its failure branch
 * is directly reachable in tests with a real `ENOENT` (`node:fs` cannot be
 * mocked under this project's ESM/vitest setup).
 */
export function finalizeAtomicWrite(tmp: string, path: string, quarantinedTo: string | null): void {
  try {
    renameSync(tmp, path)
  } catch (err) {
    throw new RecoveryWriteError(
      `wrote the new state to ${tmp} but the final atomic rename to ${path} failed${
        quarantinedTo ? ` (the prior corrupt state is safely preserved at ${quarantinedTo})` : ''
      }: ${errMessage(err)}`,
      quarantinedTo
    )
  }
}

/**
 * Creates `tmp` with exclusive-create (`'wx'`) so a symlink planted at the
 * predictable `${path}.tmp.<pid>` name is never followed (and its target never
 * truncated). A leftover entry at that name is unlinked first (a symlink is
 * unlinked itself, never its target); `unlink(2)` refuses a directory on every
 * platform, which surfaces as the failure below. The retry is again
 * exclusive, so a re-plant in between fails closed. Any failure surfaces as {@link RecoveryWriteError}, `path` untouched.
 */
function openExclusiveTemp(tmp: string): number {
  try {
    try {
      return openSync(tmp, 'wx')
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err
    }
    unlinkSync(tmp)
    return openSync(tmp, 'wx')
  } catch (err) {
    throw new RecoveryWriteError(
      `refusing to write: could not create the temp file ${tmp} exclusively: ${errMessage(err)}`,
      null
    )
  }
}

type RecoveryResult = { quarantinedTo: string | null; priorWasCorrupt: boolean }

/**
 * One read-merge-write attempt. Returns `'changed'` when `path` moved under
 * it (invariant E) — nothing was written to `path` and the temp file is
 * gone — so the caller re-runs it.
 */
function attemptRecoveryWrite<S extends object, T>(
  path: string,
  key: string,
  entry: T,
  now: Date,
  attempt: number,
  hooks: RecoveryTestHooks | undefined
): RecoveryResult | 'changed' {
  // Identity before AND after the read: equal means the bytes classified
  // below belong to `snapshot` and no other incarnation of `path`.
  const snapshot = statIdentity(path)
  const raw = readRawState<S>(path)
  if (!sameIdentity(snapshot, statIdentity(path))) return 'changed'
  hooks?.afterRead?.(attempt)

  const priorWasCorrupt = !raw.ok && raw.kind !== 'missing'
  const state: S = raw.ok ? raw.state : ({} as S)
  ;(state as Record<string, unknown>)[key] = entry

  const tmp = `${path}.tmp.${process.pid}`
  let tmpCreated = false
  let committed = false
  try {
    const fd = openExclusiveTemp(tmp)
    tmpCreated = true
    try {
      writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }

    let quarantinedTo: string | null = null
    if (priorWasCorrupt) {
      const copy = copyAside(path, now, snapshot, hooks)
      if (copy.kind === 'changed') return 'changed'
      if (copy.kind === 'failed') {
        throw new RecoveryWriteError(
          `refusing to overwrite the corrupt state at ${path}: could not preserve its existing bytes first (SMI-6995 design decision C — losing the ability to recover is better than losing the data)`,
          null
        )
      }
      quarantinedTo = copy.dest
    }

    // A copy made above is kept even if this check fails: its bytes were
    // verified to be the corrupt bytes that sat at `path` (never relabelled
    // valid state), and quarantine files are never auto-deleted.
    if (!sameIdentity(snapshot, statIdentity(path))) return 'changed'
    hooks?.afterCommitCheck?.(attempt)

    finalizeAtomicWrite(tmp, path, quarantinedTo)
    committed = true
    return { quarantinedTo, priorWasCorrupt }
  } finally {
    if (tmpCreated && !committed) {
      try {
        unlinkSync(tmp)
      } catch {
        // best-effort; invariant F is asserted by tests on every failure path
      }
    }
  }
}

/**
 * The producer's whole-file read-modify-write, coordinated into one call.
 * Each attempt: identity-bracketed `readRawState(path)`; build the new
 * state (the parsed state when `ok`, else `{}`) with `state[key] = entry`;
 * write and fsync it to `${path}.tmp.<pid>`; if the prior state was
 * `malformed`/`unreadable`, copy those exact bytes aside (throwing
 * {@link RecoveryWriteError} with `quarantinedTo: null`, `path` untouched,
 * when that is impossible); re-check `path`'s identity; rename.
 *
 * Returns `priorWasCorrupt` (the committed attempt read `malformed` or
 * `unreadable`) and `quarantinedTo` (where that attempt preserved the
 * corrupt bytes, or `null` when nothing needed preserving — never `null`
 * alongside `priorWasCorrupt: true`, which throws instead).
 *
 * Concurrency: invariant E in this file's top comment — a writer committing
 * between read and rename forces a retry rather than being overwritten,
 * except in the residual two-syscall window that comment names.
 */
export function writeEntryWithRecovery<S extends object, T>(
  path: string,
  key: string,
  entry: T,
  opts?: { now?: Date; testHooks?: RecoveryTestHooks }
): RecoveryResult {
  const now = opts?.now ?? new Date()
  mkdirSync(dirname(path), { recursive: true })
  for (let attempt = 1; attempt <= RECOVERY_WRITE_MAX_ATTEMPTS; attempt++) {
    const outcome = attemptRecoveryWrite<S, T>(path, key, entry, now, attempt, opts?.testHooks)
    if (outcome !== 'changed') return outcome
  }
  throw new RecoveryWriteError(
    `refusing to write ${path}: it changed under this write on each of ${RECOVERY_WRITE_MAX_ATTEMPTS} attempts, and writing anyway would overwrite another writer's committed state`,
    null
  )
}
