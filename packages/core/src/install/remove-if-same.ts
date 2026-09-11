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
    try {
      await fsp.rename(parked, target)
    } catch (err) {
      return {
        removed: false,
        reason: `${what}; that entry is now at ${parked} and could not be put back (${errorCode(err)})`,
      }
    }
    return { removed: false, reason: `${what}, so it was left in place` }
  }
  try {
    if (now.isDirectory()) await fsp.rm(parked, { recursive: true, force: true })
    else await fsp.unlink(parked)
    return { removed: true }
  } catch (err) {
    return {
      removed: false,
      reason: `could not be removed (${errorCode(err)}); what is left of it is at ${parked}`,
    }
  }
}
