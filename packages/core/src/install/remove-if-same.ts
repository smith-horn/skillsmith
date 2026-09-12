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
 * A crash, or a failed removal, can leave an entry under that parked name —
 * and in a race it may be an entry another program put at the path, not ours,
 * so the warnings say so. Every skill enumerator skips dot-prefixed names, so
 * a parked entry is never mistaken for a skill; uninstall reports what is
 * parked next to a skill, and fan-out's `listLeftoverBackups` reports one next
 * to a fan-out destination.
 *
 * @module @skillsmith/core/install/remove-if-same
 */
import { randomBytes } from 'node:crypto'
import type { Stats } from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'

/** Tag in a parked entry's name: `.<name>.skillsmith-removing-<32 hex>`. */
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

/**
 * A random hidden sibling name to park `target` under. 128 random bits, so
 * the rename that parks an entry cannot realistically land on a name
 * something else already holds — that rename replaces its destination, and it
 * is the one step here that runs before any check (round 18, cross-model
 * review).
 */
function parkedName(target: string): string {
  const name = '.' + path.basename(target) + PARK_TAG + randomBytes(16).toString('hex')
  return path.join(path.dirname(target), name)
}

/** Matches exactly the names {@link removeIfSame} parks `target` under. */
export function parkedPattern(target: string): RegExp {
  const escaped = ('.' + path.basename(target) + PARK_TAG).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp('^' + escaped + '[0-9a-f]{32}$')
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

/**
 * User-facing warning for what {@link listParkedLeftovers} found. Round 18
 * (cross-model review): who owns a parked entry is not known. It is whatever
 * was at the path when a removal moved it aside, which in a race can belong
 * to another program, so the wording says that instead of calling it ours.
 */
export function parkedLeftoverWarning(parked: string): string {
  return (
    `an interrupted removal moved something aside to the hidden path ${parked} and did not ` +
    `finish. It may be part of the skill being removed, or something another program put ` +
    `there. Check it, then restore or delete it yourself.`
  )
}

/**
 * Remove `target` (a folder recursively, anything else with `unlink`) only if
 * it is still the entry `expected` describes. An entry that is already gone
 * counts as removed. Anything else is left alone, and whatever this call
 * moved aside is reported with its exact path.
 *
 * Round 17 (cross-model review): nothing is ever renamed back. `rename`
 * replaces what is at the destination — measured on macOS and Linux, a
 * directory replaces an empty directory and a file or symlink replaces a file
 * or symlink — so putting an entry back could destroy something created at
 * that path in the meantime, and a check first only narrows that window
 * rather than closing it. The two failure modes are not equal: a put-back can
 * destroy an entry, while leaving one parked merely moves it, recoverably,
 * and says where it went. The identity is also checked once BEFORE the entry
 * is parked, so the ordinary mismatch moves nothing at all.
 */
export async function removeIfSame(
  target: string,
  expected: EntryIdentity
): Promise<CheckedRemoval> {
  let before: Stats
  try {
    before = await fsp.lstat(target)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { removed: true }
    return {
      removed: false,
      reason: `could not be checked (${errorCode(err)}), so it was left in place`,
    }
  }
  if (before.dev !== expected.dev || before.ino !== expected.ino) {
    return { removed: false, reason: 'was replaced by something else, so it was left in place' }
  }
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
  if (now === undefined) {
    // Round 21 (Opus): the pre-check above already established this is a
    // regular file with the expected identity, so it can go back atomically
    // even though the parked entry itself could not be checked.
    const why = `could not be checked (${errorCode(checkError)})`
    const back = await linkFileBack(parked, target, before)
    if (back !== 'not-restored') {
      return {
        removed: false,
        reason:
          back === 'restored'
            ? `${why}, so it was left in place`
            : `${why}, so it was left in place; a link to it also remains at ${parked}`,
      }
    }
    return { removed: false, reason: `${why} and is now at ${parked}` }
  }
  if (now.dev !== expected.dev || now.ino !== expected.ino) {
    // Something took the path between the check above and this rename, so what
    // is parked belongs to whoever put it there. A regular file goes back
    // atomically; anything else is never renamed back over what is at the path
    // now, so it stays parked and its exact location is reported.
    const back = await linkFileBack(parked, target, now)
    if (back !== 'not-restored') {
      return {
        removed: false,
        reason:
          back === 'restored'
            ? 'was replaced by something else, so it was left in place'
            : `was replaced by something else, so it was left in place; a link to it also ` +
              `remains at ${parked}`,
      }
    }
    return {
      removed: false,
      reason: `was replaced by something else, and that entry is now at ${parked}`,
    }
  }
  try {
    if (now.isDirectory()) await fsp.rm(parked, { recursive: true, force: true })
    else await fsp.unlink(parked)
    return { removed: true }
  } catch (err) {
    const why = `could not be removed (${errorCode(err)})`
    const back = await linkFileBack(parked, target, now)
    if (back !== 'not-restored') {
      return {
        removed: false,
        reason:
          back === 'restored'
            ? `${why}, so it was left in place`
            : `${why}, so it was left in place; a link to it also remains at ${parked}`,
      }
    }
    return { removed: false, reason: `${why}; what is left of it is at ${parked}` }
  }
}

/** What {@link linkFileBack} managed to do. */
type FileRestore = 'restored' | 'restored-with-link' | 'not-restored'

/**
 * Put a parked regular file back where it came from, atomically. Round 19
 * (Opus): `link` fails with EEXIST rather than replacing, so unlike `rename`
 * it cannot destroy whatever took the path — which is why files can go back
 * while directories and symlinks stay parked. (Whether `link` follows a
 * symlink differs across platforms, so symlinks are not attempted.) Round 20:
 * says whether the link under the parked name was cleaned up, so a caller
 * that leaves two links says so rather than reporting a plain restore.
 */
async function linkFileBack(parked: string, target: string, entry: Stats): Promise<FileRestore> {
  if (!entry.isFile()) return 'not-restored'
  try {
    await fsp.link(parked, target)
  } catch {
    return 'not-restored'
  }
  try {
    await fsp.unlink(parked)
    return 'restored'
  } catch {
    // It is back at its path; the extra link under the parked name is named in
    // the reason and reported like any other leftover.
    return 'restored-with-link'
  }
}
