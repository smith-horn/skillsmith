/**
 * SMI-6995 — corrupt-state quarantine + the coordinated recovery writer.
 *
 * Split out of `state-read.ts` purely to stay under CLAUDE.md's 500-line
 * pre-commit gate (`scripts/check-file-length.mjs`) — `state-read.ts`
 * re-exports both functions below, so every caller still imports from one
 * path (`./state-read.js`); this file is an implementation detail, not a
 * second public surface.
 *
 * ## {@link quarantineCorruptState} — findings 2, 7, 8
 *
 * Quarantines corrupt state before a producer overwrites it: renames `path`
 * to a sibling `${path}.corrupt-<ISO>` path (colons/dots replaced with
 * dashes) and returns the new path, so the bytes survive instead of being
 * silently replaced by the producer's own recovery write.
 *
 * - **Finding 2 — exclusive destination allocation.** A plain `existsSync`
 *   check before `renameSync` is itself a TOCTOU (another process can
 *   create the same destination between the check and the rename), and
 *   `renameSync` REPLACES an existing destination on POSIX — two
 *   quarantines landing in the same millisecond (or a clock that repeats)
 *   would silently lose the first corrupt payload. This module proves
 *   exclusivity instead of assuming it: {@link allocateQuarantineDest}
 *   reserves a name with `openSync(dest, 'wx')`, which atomically fails
 *   with `EEXIST` if the name is taken, BEFORE anything is renamed onto it.
 * - **Finding 7 — refuses a directory.** A directory holds no single
 *   corrupt payload to preserve; renaming a whole tree aside is not what
 *   "preserve the corrupt bytes" means. Quarantine files are NEVER
 *   auto-deleted by this module — the entire point is that a human can
 *   inspect them later — so they accumulate deliberately and grow without
 *   bound; a directory-rename mistake here would compound that growth with
 *   whole trees instead of single files, on top of being the wrong
 *   operation in the first place. Refuses (returns `null`) instead.
 * - **Finding 8 — refuses a symlink.** `readRawState` FOLLOWS a symlink
 *   when reading (ordinary `readFileSync` behavior), but `renameSync`
 *   moves the LINK, not the bytes it points at — quarantining a symlink
 *   would leave the real corrupt target sitting untouched wherever it
 *   actually lives, while this module reports the quarantine as handled.
 *   Detected via `lstatSync`, which — unlike `statSync` — does not follow
 *   the link; refuses (returns `null`) rather than create that false
 *   confidence.
 *
 * Both refusals, plus the "nothing to quarantine" (missing path) and "the
 * rename itself failed" cases, all collapse to the same `null` return —
 * **this function must never throw**, because it runs on a recovery path
 * inside a hook: an exception here would turn "repair a corrupt file" into
 * "crash the write that was trying to repair it." A caller that gets `null`
 * proceeds with its own recovery write regardless, exactly as it would if
 * this function didn't exist — quarantine is a best-effort improvement on
 * that path, never a precondition for it.
 *
 * ## {@link writeEntryWithRecovery} — finding 4
 *
 * The coordinated single-call writer: read, quarantine, merge, and atomic
 * write happen inside ONE function call so another process cannot
 * interleave between "we decided this needs quarantining" and "we actually
 * quarantined it" — the exact gap a caller doing a fail-soft whole-state
 * read and a separate `quarantineCorruptState` call back to back would
 * leave open. See its own doc comment for the ordering contract and for
 * exactly what this guarantees versus what it does not.
 */

import { closeSync, mkdirSync, lstatSync, openSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { readRawState } from './state-read.js'

/**
 * Number of destination candidates {@link quarantineCorruptState} will try
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
 * Reserves an exclusive destination name for quarantining `path` — see this
 * module's top doc comment (finding 2) for why a bare `existsSync` check is
 * not enough. `openSync(dest, 'wx')` atomically fails with `EEXIST` if the
 * name already exists, so the first successful create-and-close call HOLDS
 * that exact name until THIS process renames over it; no concurrent caller
 * doing the same enumeration can land on the same slot. Returns `null`
 * (never throws) once {@link QUARANTINE_DEST_MAX_ATTEMPTS} candidates are
 * all taken, or on any other failure (permissions, `ENOSPC`, ...).
 */
function allocateQuarantineDest(path: string, now: Date): string | null {
  const base = `${path}.corrupt-${now.toISOString().replace(/[:.]/g, '-')}`
  for (let attempt = 0; attempt < QUARANTINE_DEST_MAX_ATTEMPTS; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`
    try {
      closeSync(openSync(candidate, 'wx'))
      return candidate
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') continue
      return null // any other failure — never throw; caller proceeds without quarantine
    }
  }
  return null // every candidate taken — see QUARANTINE_DEST_MAX_ATTEMPTS
}

/** See this file's top doc comment — findings 2, 7, 8. */
export function quarantineCorruptState(path: string, now: Date = new Date()): string | null {
  let info
  try {
    // lstat, NOT stat — finding 8 needs to see the symlink itself, not what
    // it points at.
    info = lstatSync(path)
  } catch {
    return null // ENOENT (nothing to quarantine) or any other stat failure
  }
  if (info.isDirectory()) return null // finding 7
  if (info.isSymbolicLink()) return null // finding 8

  const dest = allocateQuarantineDest(path, now)
  if (dest === null) return null
  try {
    renameSync(path, dest)
    return dest
  } catch {
    return null
  }
}

/**
 * The producer's read-modify-write counterpart to `readEntryForUpdate`, but
 * at the WHOLE-FILE level and coordinated into one call (SMI-6995 finding
 * 4). Order, every call, no exceptions:
 *
 *   1. `readRawState(path)`.
 *   2. If that read was `malformed`/`unreadable`, quarantine the bytes
 *      (best-effort — see {@link quarantineCorruptState}) and start the new
 *      state from `{}`. A genuinely `missing` file also starts from `{}`,
 *      without attempting a quarantine — nothing was ever there to lose.
 *   3. Otherwise ('ok') start from the parsed state.
 *   4. Set `state[key] = entry`.
 *   5. `mkdir -p` the parent, write to a `.tmp.<pid>` sibling, `renameSync`
 *      over the target — the same atomic-write shape every sibling writer
 *      (`reindex-state.ts`'s `writeEntry`, etc.) already uses.
 *
 * `priorWasCorrupt` is `true` exactly when step 2 applied (the file read as
 * `malformed` or `unreadable`) — a missing file is not a loss, there was
 * nothing there. `quarantinedTo` names where the corrupt bytes landed, or
 * `null` when there was nothing to quarantine, OR quarantine itself could
 * not allocate a destination or rename ({@link quarantineCorruptState} is
 * best-effort — this function still proceeds with its own recovery write
 * either way, same as before this function existed).
 *
 * **What this guarantees, and what it does not.** Doing all five steps
 * inside one synchronous function body closes the gap a caller would
 * otherwise leave open by calling a fail-soft whole-state read and a
 * separate quarantine call back to back — another process can interleave
 * between two separate calls, but cannot interleave between lines of code
 * inside this one. It does **NOT** add any new locking on its own:
 * **a caller that already holds its own lock (e.g.
 * `mcp-disconnect-state.ts`'s `withLock`) MUST call this function from
 * inside that lock** — otherwise two concurrent writers can still race
 * across steps 1-5 exactly as the four existing simple writers do today
 * (read-modify-write, no lock, last writer wins). This function does not
 * invent a new locking scheme to close that gap; it only guarantees that
 * ITS OWN read+quarantine+merge+write cannot be split apart from the
 * outside. And unlike the read half (which never throws, matching
 * `readStateWithClassification`), the final mkdir/write/rename in step 5
 * CAN still fail and throw — same as `writeFileSync`/`renameSync` always
 * could in the writers this is meant to replace; that failure mode is
 * deliberately NOT swallowed here, so a genuine disk-full or permissions
 * fault surfaces instead of looking like success. (One concrete case: if
 * `path` itself is a directory, quarantine refuses it per finding 7, and
 * the final `renameSync` then fails because a file cannot be renamed over
 * an existing directory — this function lets that exception propagate
 * rather than deleting the directory to "fix" it.)
 */
export function writeEntryWithRecovery<S extends object, T>(
  path: string,
  key: string,
  entry: T,
  opts?: { now?: Date }
): { quarantinedTo: string | null; priorWasCorrupt: boolean } {
  const now = opts?.now ?? new Date()
  const raw = readRawState<S>(path)

  let state: S
  let quarantinedTo: string | null = null
  const priorWasCorrupt = !raw.ok && raw.kind !== 'missing'

  if (raw.ok) {
    state = raw.state
  } else if (raw.kind === 'missing') {
    state = {} as S
  } else {
    quarantinedTo = quarantineCorruptState(path, now)
    state = {} as S
  }

  const mutableState = state as Record<string, unknown>
  mutableState[key] = entry

  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp.${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(tmp, path)

  return { quarantinedTo, priorWasCorrupt }
}
