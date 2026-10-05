/**
 * SMI-6995 — corrupt-state preservation (copy aside, NEVER move) + the
 * coordinated recovery writer.
 *
 * Split out of `state-read.ts` purely to stay under CLAUDE.md's 500-line
 * pre-commit gate (`scripts/check-file-length.mjs`) — `state-read.ts`
 * re-exports everything below, so every caller still imports from one path
 * (`./state-read.js`); this file is an implementation detail, not a second
 * public surface.
 *
 * ## Round-4 adversarial review — design decisions this file implements
 *
 * Round 4 found 9 issues in the round-2 fix below; two of them were
 * mistakes in the design SPEC itself (not the implementation), corrected
 * here as design decisions (C) and (D) rather than ordinary bug fixes:
 *
 * **(C) Quarantine COPIES, it does not move.** The round-2 implementation
 * did `renameSync(path -> quarantineDest)` FIRST, then built the new state,
 * then wrote a temp file, then `renameSync(temp -> path)` LAST — which
 * meant `path` did not exist at all from the moment the first rename
 * succeeded until the second one completed. Any failure in between (the
 * temp write, the final rename) left `path` simply absent, and the thrown
 * exception escaped before the caller ever learned where the quarantined
 * bytes had gone (finding 2) — the recovery mechanism destroyed the thing
 * it was recovering, which is strictly worse than the corrupt file it was
 * trying to fix. The new order in {@link writeEntryWithRecovery} never lets
 * `path` be absent: it writes and fsyncs the NEW state to a temp file
 * first, COPIES (not moves) the prior corrupt bytes aside only after that
 * succeeds, and only then atomically renames the temp file over `path` —
 * so `path` holds either its original content or its final content at
 * every instant, never neither. {@link copyCorruptStateAside} — renamed
 * from `quarantineCorruptState`, specifically because that name reads as
 * "move," which is exactly the behaviour this decision removes — copies
 * `path`'s bytes to the reserved destination and leaves `path` completely
 * untouched, in both success and failure.
 *
 * **(D) The TOCTOU is narrowed, not closed — round 2 overclaimed this.**
 * Round 2's spec said "read and quarantine cannot be separated by another
 * process." That is false: JS's single-threaded synchronous execution
 * prevents OTHER CODE IN THIS PROCESS from interleaving between any two
 * lines here, but it says nothing about a different OS process — the
 * kernel can still schedule an unrelated process's own syscalls in between
 * any two of ours, since nothing here takes a lock. What single-call
 * sequencing in {@link writeEntryWithRecovery} actually buys is narrower:
 * it removes the window a CALLER would otherwise leave open by doing a
 * fail-soft read and a separate quarantine call as two JS-level calls. What
 * actually limits the damage from a genuine cross-process race is design
 * decision (C) above — copy-then-atomic-rename means a losing writer in
 * such a race overwrites the other's result rather than destroying
 * anything, because neither side's sequence ever passes through a state
 * where `path` is simply gone. This module does NOT invent a locking
 * scheme to close the remaining gap, and should not grow one here: a
 * caller that already holds its own lock (e.g. `mcp-disconnect-state.ts`'s
 * `withLock`) MUST still call {@link writeEntryWithRecovery} from inside
 * that lock to get the usual last-writer-wins behaviour instead of a true
 * interleaving — exactly as the four existing simple writers require today
 * (read-modify-write, no lock, last writer wins; that race pre-exists this
 * module and is out of scope for it).
 *
 * ## {@link copyCorruptStateAside} — findings 2, 7, 8 (round 2); 3, 6 (round 4)
 *
 * Copies the bytes at `path` to a sibling `${path}.corrupt-<ISO>`
 * destination and returns the new path, so the bytes survive instead of
 * being silently replaced by a producer's own recovery write. `path` is
 * left exactly as it was, whether this call succeeds or fails.
 *
 * - **Finding 2 (round 2) — exclusive destination allocation.** A plain
 *   `existsSync` check before writing into a destination is itself a
 *   TOCTOU (another process can create the same destination in between),
 *   and a plain overwrite would silently lose whichever payload lost that
 *   race. {@link allocateQuarantineDest} reserves a name with
 *   `openSync(dest, 'wx')`, which atomically fails with `EEXIST` if the
 *   name is already taken, BEFORE any bytes are written into it.
 * - **Finding 3 (round 4) — a reservation that is never successfully
 *   filled is cleaned up, not left as a permanent dead slot.** The round-2
 *   code reserved a destination and then, if the subsequent move failed,
 *   returned `null` WITHOUT removing the now-permanently-empty reservation
 *   file — the next quarantine attempt would see that slot as taken (the
 *   same `openSync(dest, 'wx')` exclusivity check) and move on to the next
 *   numbered candidate, and after {@link QUARANTINE_DEST_MAX_ATTEMPTS}
 *   failures in a row every slot was a dead empty file, with quarantine
 *   then silently returning `null` forever. Fixed: if the copy into an
 *   already-reserved destination fails for any reason, this function
 *   `unlinkSync`s that destination (swallowing any unlink error itself —
 *   cleanup is best-effort, never a reason to throw) before returning
 *   `null`.
 * - **Finding 6 (round 4) — the reservation's own file descriptor cannot
 *   leak.** The round-2 code reserved a slot with the single expression
 *   `closeSync(openSync(candidate, 'wx'))`. Changing that line to just
 *   `openSync(candidate, 'wx')` — dropping the close outright — passed
 *   every existing assertion, because nothing checked descriptor counts;
 *   it would leak one fd per quarantine call forever. Fixed in
 *   {@link allocateQuarantineDest}: the fd is stored in its own variable
 *   and closed from a `finally`, so a `return` from inside the `try` still
 *   runs the close before control leaves the function, and the close is
 *   now a statement a mutation has to visibly delete rather than an
 *   expression it can silently flatten.
 * - **Finding 7 (round 2) — refuses a directory.** A directory holds no
 *   single corrupt payload to preserve; copying a whole tree aside is not
 *   what "preserve the corrupt bytes" means, and quarantine files are
 *   never auto-deleted (the entire point is that a human can inspect them
 *   later), so a directory-copy mistake here would compound unbounded
 *   growth with whole trees instead of single files, on top of being the
 *   wrong operation outright. Refuses (returns `null`) instead.
 * - **Finding 8 (round 2) — refuses a symlink.** `readRawState` FOLLOWS a
 *   symlink when reading (ordinary file-read behavior), but copying the
 *   LINK itself (what a naive copy of `path` would do if `path` is a
 *   symlink and the copy doesn't dereference, or copying whatever it
 *   points at if it does) is not "preserve the corrupt bytes found at
 *   `path`" either — either way the true corrupt target is left sitting
 *   untouched somewhere else, while this module reports quarantine as
 *   handled. Detected via `lstatSync`, which — unlike `statSync` — does
 *   not follow the link; refuses (returns `null`) rather than create that
 *   false confidence.
 *
 * Every refusal and every failure collapses to the same `null` return —
 * **this function must never throw**, because it runs on a recovery path
 * inside a hook: an exception here would turn "repair a corrupt file" into
 * "crash the write that was trying to repair it." A caller that gets `null`
 * when it did not actually need a copy proceeds exactly as if this
 * function did not exist. A caller that gets `null` when it DID need one
 * must NOT proceed with its own overwrite regardless — see
 * {@link writeEntryWithRecovery}'s own doc comment for why.
 *
 * ## {@link writeEntryWithRecovery} — finding 4 (round 2); 1, 2 (round 4)
 *
 * The coordinated single-call writer: read, copy-aside, merge, and atomic
 * write happen inside ONE function call, in the order design decision (C)
 * above describes. See its own doc comment for the full step list and for
 * exactly what single-call sequencing does and does not guarantee against
 * a concurrent OS process (design decision (D) above).
 */

import {
  closeSync,
  copyFileSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

import { errMessage, readRawState } from './state-read.js'

/**
 * Number of destination candidates {@link copyCorruptStateAside} will try
 * before giving up (the base `.corrupt-<iso>` name, then `-2`, `-3`, ...).
 * Collisions only happen when two quarantines land in the same millisecond
 * (or a clock that repeats, SMI-6995 finding 2) — 50 is generous enough to
 * absorb a realistic burst (several sibling worktrees hitting the same
 * shared state file at once) while still being a hard bound, so a
 * pathological case (every slot somehow already taken) fails closed in
 * bounded time instead of looping forever.
 */
export const QUARANTINE_DEST_MAX_ATTEMPTS = 50

/**
 * Reserves an exclusive destination name for copying `path` aside — see
 * this module's top doc comment (finding 2) for why a bare `existsSync`
 * check is not enough. `openSync(dest, 'wx')` atomically fails with
 * `EEXIST` if the name already exists, so the first successful
 * create-then-close call HOLDS that exact name until some later write
 * fills it; no concurrent caller doing the same enumeration can land on
 * the same slot. Returns `null` (never throws) once
 * {@link QUARANTINE_DEST_MAX_ATTEMPTS} candidates are all taken, or on any
 * other failure (permissions, `ENOSPC`, ...).
 *
 * **Finding 6 (round 4).** `fd` is stored in its own variable and closed
 * from a `finally` rather than the collapsed `closeSync(openSync(...))`
 * expression this replaced — see this module's top doc comment for why
 * that expression was a provable fd leak, not just a theoretical one.
 * Returning `candidate` from inside the `try` still runs the `finally`
 * before control actually leaves this function, so the close cannot be
 * skipped by any of this function's own return paths; a `closeSync`
 * failure (vanishingly rare for an fd we just opened successfully) is
 * swallowed rather than allowed to turn a successful reservation into a
 * thrown exception from a function that must never throw.
 */
function allocateQuarantineDest(path: string, now: Date): string | null {
  const base = `${path}.corrupt-${now.toISOString().replace(/[:.]/g, '-')}`
  for (let attempt = 0; attempt < QUARANTINE_DEST_MAX_ATTEMPTS; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`
    let fd: number
    try {
      fd = openSync(candidate, 'wx')
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') continue
      return null // any other failure — never throw; caller proceeds without quarantine
    }
    try {
      return candidate
    } finally {
      try {
        closeSync(fd)
      } catch {
        // `candidate` was already successfully created and reserved
        // regardless of whether we keep our own handle to it open.
      }
    }
  }
  return null // every candidate taken — see QUARANTINE_DEST_MAX_ATTEMPTS
}

/** See this file's top doc comment — design decision (C); findings 2, 3, 6, 7, 8. */
export function copyCorruptStateAside(path: string, now: Date = new Date()): string | null {
  let info
  try {
    // lstat, NOT stat — finding 8 needs to see the symlink itself, not what
    // it points at.
    info = lstatSync(path)
  } catch {
    return null // ENOENT (nothing to preserve) or any other stat failure
  }
  if (info.isDirectory()) return null // finding 7
  if (info.isSymbolicLink()) return null // finding 8

  const dest = allocateQuarantineDest(path, now)
  if (dest === null) return null

  try {
    // COPY, never move (design decision C) — `path` is untouched whether
    // this succeeds or throws below.
    copyFileSync(path, dest)
    return dest
  } catch {
    try {
      unlinkSync(dest)
    } catch {
      // best-effort — finding 3: never let cleanup itself throw, but try
      // not to leave a permanently-empty reservation behind either.
    }
    return null
  }
}

/**
 * Thrown by {@link writeEntryWithRecovery} when it cannot complete the
 * write it was asked to do: either the prior corrupt state needed
 * preserving and {@link copyCorruptStateAside} itself failed
 * (`quarantinedTo: null` — nothing was preserved, but `path` is untouched
 * and still holds exactly what it held before the call), or preserving it
 * succeeded but the final atomic rename still failed afterward
 * (`quarantinedTo` names where the corrupt bytes landed either way).
 * SMI-6995 round-4 finding 2: a caller must be able to find out where the
 * bytes went even when the overall write did not succeed — collapsing this
 * into a generic failure would lose that information for good.
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
 * The last step of {@link writeEntryWithRecovery}: atomically replace
 * `path` with the already-written-and-fsynced `tmp` file. Pulled out as
 * its own (exported) function so the "rename still fails even though
 * quarantine already succeeded" branch is directly reachable in tests —
 * measured, rather than assumed, that forcing an OS-level failure
 * specifically AFTER a real same-directory rename between two regular
 * files (both owned by the test process, running as root) is not
 * achievable here without mocking `node:fs` (`vi.spyOn` cannot redefine a
 * `node:fs` named export under this project's ESM/vitest setup — confirmed
 * live, not assumed) or extra privilege this container does not have (no
 * `mount`, `chattr +i` refused with `EPERM`) — both of which would also
 * break this module's own stated no-mocking test convention. Calling this
 * function directly with a `tmp` that does not exist exercises the exact
 * same error-construction code via a completely real `ENOENT`, without
 * needing to contrive that moment inside a live
 * {@link writeEntryWithRecovery} call.
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
 * Writes `contents` to `tmp` and `fsync`s it before returning (design
 * decision C, step 3) — a crash between the write and the final rename in
 * {@link writeEntryWithRecovery} must not leave `tmp` holding data the
 * kernel never actually made durable; without the fsync, a rename
 * immediately after a write can expose a file that looks complete to this
 * process but was never flushed to disk. The fd is closed in a `finally`
 * for the same reason {@link allocateQuarantineDest}'s is (finding 6):
 * every return/throw path must still close it exactly once.
 */
function writeTempFileSynced(tmp: string, contents: string): void {
  const fd = openSync(tmp, 'w')
  try {
    writeFileSync(fd, contents)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/**
 * The producer's read-modify-write counterpart to `readEntryForUpdate`, but
 * at the WHOLE-FILE level and coordinated into one call (SMI-6995 finding
 * 4, round 2). Order, every call (SMI-6995 round-4 design decision C — see
 * this module's top doc comment for the full rationale; this REPLACES a
 * rename-first ordering that had a window where `path` did not exist at
 * all):
 *
 *   1. `readRawState(path)` and classify.
 *   2. Build the new state object: the parsed state when the read was
 *      `ok`, or `{}` when it was `malformed` / `unreadable` / `missing`.
 *   3. Set `state[key] = entry`, write it to a `.tmp.<pid>` sibling, and
 *      `fsync` that temp file before using it
 *      ({@link writeTempFileSynced}). `path` has not been touched yet.
 *   4. If step 1 found a `malformed`/`unreadable` prior state, COPY (never
 *      move) its bytes aside via {@link copyCorruptStateAside} — `path` is
 *      STILL untouched; the corrupt bytes now also exist at the returned
 *      destination. **If this copy fails, stop here**: throw a
 *      {@link RecoveryWriteError} with `quarantinedTo: null` and do not
 *      touch `path` at all. Refusing to overwrite corrupt bytes this call
 *      failed to preserve is strictly better than losing them outright —
 *      `path` still holds exactly what it held before this call started.
 *   5. {@link finalizeAtomicWrite}: `renameSync(tmp, path)`. This is the
 *      ONLY step that touches `path`, and it is atomic — at no point
 *      before this line does `path` stop existing or stop holding its
 *      original content. If this rename itself fails, the thrown
 *      {@link RecoveryWriteError} still carries `quarantinedTo` (from step
 *      4, or `null` if there was nothing to preserve), so a caller can
 *      always tell where the prior bytes are even when the new write did
 *      not complete.
 *
 * `priorWasCorrupt` is `true` exactly when step 1 read as `malformed` or
 * `unreadable` — a missing file is not a loss, there was nothing there.
 * `quarantinedTo` names where the corrupt bytes were copied, or `null`
 * when there was nothing to copy. A `null` `quarantinedTo` is never
 * returned (as opposed to thrown) when `priorWasCorrupt` was `true` —
 * step 4 throws instead of returning in that combination — so a caller
 * reading the RETURNED value never needs to re-derive that distinction
 * itself.
 */
export function writeEntryWithRecovery<S extends object, T>(
  path: string,
  key: string,
  entry: T,
  opts?: { now?: Date }
): { quarantinedTo: string | null; priorWasCorrupt: boolean } {
  const now = opts?.now ?? new Date()
  const raw = readRawState<S>(path)

  const priorWasCorrupt = !raw.ok && raw.kind !== 'missing'
  const state: S = raw.ok ? raw.state : ({} as S)
  ;(state as Record<string, unknown>)[key] = entry

  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp.${process.pid}`
  writeTempFileSynced(tmp, `${JSON.stringify(state, null, 2)}\n`)

  let quarantinedTo: string | null = null
  if (priorWasCorrupt) {
    quarantinedTo = copyCorruptStateAside(path, now)
    if (quarantinedTo === null) {
      throw new RecoveryWriteError(
        `refusing to overwrite the corrupt state at ${path}: could not preserve its existing bytes first (SMI-6995 design decision C — losing the ability to recover is better than losing the data)`,
        null
      )
    }
  }

  finalizeAtomicWrite(tmp, path, quarantinedTo)

  return { quarantinedTo, priorWasCorrupt }
}
