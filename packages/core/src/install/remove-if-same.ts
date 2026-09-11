/**
 * SMI-6529 round 15: remove a path only while it is still the entry the
 * caller saw (same device and inode). Every delete that follows a check uses
 * this: fan-out cleanup, staging and backup folders, install rollback and
 * uninstall.
 *
 * Checking the path and then removing it left a window in which another
 * program could swap in its own entry and have it deleted (Opus round 14).
 * So the entry is first renamed to a random hidden sibling name, one atomic
 * rename in the same folder, and checked under that name. Only then is it
 * removed. To have its entry deleted, a program would have to guess the name.
 *
 * A crash, or a failed removal, can leave an entry under that parked name.
 * Every skill enumerator skips dot-prefixed names, so it is never mistaken
 * for a skill, and fan-out's `listLeftoverBackups` reports one next to a
 * fan-out destination.
 *
 * @module @skillsmith/core/install/remove-if-same
 */
import { randomBytes } from 'node:crypto'
import type { Stats } from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'

/** Tag in a parked entry's name: `.<name>.skillsmith-removing-<12 hex>`. */
export const PARK_TAG = '.skillsmith-removing-'

/** An entry's device and inode, to tell it apart from anything later put at its path. */
export interface EntryIdentity {
  dev: number
  ino: number
}

/**
 * Result of {@link removeIfSame}. `reason` reads after the path, e.g.
 * `${target} ${reason}`.
 */
export type CheckedRemoval = { removed: true } | { removed: false; reason: string }

function errorCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code
  return code ?? (err instanceof Error ? err.message : String(err))
}

/** A random hidden sibling name to park `target` under. */
function parkedName(target: string): string {
  const name = '.' + path.basename(target) + PARK_TAG + randomBytes(6).toString('hex')
  return path.join(path.dirname(target), name)
}

/** Matches exactly the names {@link removeIfSame} parks `target` under. */
export function parkedPattern(target: string): RegExp {
  const escaped = ('.' + path.basename(target) + PARK_TAG).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp('^' + escaped + '[0-9a-f]{12}$')
}

/**
 * Entries a crashed or failed removal left parked next to `target`, so a
 * caller can report them. Round 16 (both reviewers): away from a fan-out
 * destination nothing swept these, so a failed removal's leftover was named
 * once, in one error, and never again.
 */
export async function listParkedLeftovers(target: string): Promise<string[]> {
  const pattern = parkedPattern(target)
  let entries: string[]
  try {
    entries = await fsp.readdir(path.dirname(target))
  } catch {
    return []
  }
  return entries
    .filter((name) => pattern.test(name))
    .map((name) => path.join(path.dirname(target), name))
}

/** User-facing warning for what {@link listParkedLeftovers} found. */
export function parkedLeftoverWarning(parked: string): string {
  return (
    `an interrupted removal left part of what it was removing at the hidden path ${parked}; ` +
    `check it, then delete it yourself if you don't need it.`
  )
}

/**
 * Put a parked entry back where it came from, but only while nothing is at
 * that path. Round 16 (both reviewers): `rename` REPLACES the destination —
 * measured on macOS and Linux, a parked directory replaces an empty
 * directory, and a parked file or symlink replaces a file or symlink (other
 * combinations the kernel refuses). So an unguarded put-back could destroy
 * what another program created while the entry was parked. Something at the
 * path now owns it: the entry stays parked, and the caller says where it is.
 *
 * The check and the rename are still two syscalls; what that window can now
 * cost is one entry created inside it, rather than the recursive delete this
 * primitive exists to prevent.
 */
async function putBack(parked: string, target: string): Promise<{ why: string } | null> {
  try {
    await fsp.lstat(target)
    return { why: `something else is at ${target} now` }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { why: `${target} could not be checked (${errorCode(err)})` }
    }
  }
  try {
    await fsp.rename(parked, target)
    return null
  } catch (err) {
    return { why: `the move back failed (${errorCode(err)})` }
  }
}

/**
 * Remove `target` (a folder recursively, anything else with `unlink`) only if
 * it is still the entry `expected` describes. An entry that is already gone
 * counts as removed. Anything else found there is put back and left in place.
 */
export async function removeIfSame(
  target: string,
  expected: EntryIdentity
): Promise<CheckedRemoval> {
  const parked = parkedName(target)
  try {
    await fsp.rename(target, parked)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { removed: true }
    return {
      removed: false,
      reason: `could not be moved aside to be removed (${errorCode(err)}), so it was left in place`,
    }
  }
  let now: Stats | undefined
  let checkError: unknown
  try {
    now = await fsp.lstat(parked)
  } catch (err) {
    checkError = err
  }
  if (now === undefined || now.dev !== expected.dev || now.ino !== expected.ino) {
    const what =
      now === undefined
        ? `could not be checked (${errorCode(checkError)})`
        : 'was replaced by something else'
    // What was parked is not ours, so it goes back where it was.
    const stranded = await putBack(parked, target)
    return {
      removed: false,
      reason:
        stranded === null
          ? `${what}, so it was left in place`
          : `${what}; that entry is now at ${parked} (${stranded.why})`,
    }
  }
  try {
    if (now.isDirectory()) await fsp.rm(parked, { recursive: true, force: true })
    else await fsp.unlink(parked)
    return { removed: true }
  } catch (err) {
    // Put back whatever is left, so the caller's record still describes where
    // it is and a retry finds it there (round 16, cross-model review).
    const stranded = await putBack(parked, target)
    const why = `could not be removed (${errorCode(err)})`
    return {
      removed: false,
      reason:
        stranded === null
          ? `${why}, so what is left of it stayed in place`
          : `${why}; what is left of it is at ${parked} (${stranded.why})`,
    }
  }
}
