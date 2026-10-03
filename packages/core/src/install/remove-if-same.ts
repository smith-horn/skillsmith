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
import type { BigIntStats } from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'

/** Tag in a parked entry's name: `.<name>.skillsmith-removing-<32 hex>`. */
export const PARK_TAG = '.skillsmith-removing-'

/**
 * An entry's device and inode, to tell it apart from anything later put at
 * its path.
 *
 * Round 8 (SMI-6732 C1): widened to accept `bigint` alongside the original
 * `number`. The uninstall path now reads `dev`/`ino` as `bigint` (see
 * `skill-installation.removal-identity.ts`'s `DirIdentity`), since a
 * `number`-typed `st_ino` has already lost precision above 2^53 on some
 * filesystems. Every OTHER caller of {@link removeIfSame} still passes a
 * plain `fs.Stats` (`number`-typed) and is unaffected -- see
 * {@link removeIfSame}'s own `sameIdentity` comparison for how the two
 * domains are reconciled without changing what a `number`-typed caller has
 * always compared.
 *
 * Round 10 (SMI-6732 R4): a plain `{dev: number | bigint; ino: number | bigint}`
 * permitted a MIXED pair -- `{dev: number, ino: bigint}` -- that no producer
 * writes today but that the type nonetheless allowed. A mixed pair falls to
 * the `Number` branch below and silently discards the `ino` half's precision,
 * which is exactly the hazard `bigint` was added to close. A union of the two
 * legitimate shapes makes the mixed pair unrepresentable, so `sameIdentity`
 * can branch on one field and the type system guarantees the other agrees.
 *
 * Round 10 (SMI-6732 R3): the bigint arm also carries an OPTIONAL
 * `birthtimeNs`, for the same reason `DirIdentity` does -- see
 * {@link sameIdentity}'s own comparison. Optional, not required: a caller
 * that only has `dev`/`ino` (there is none today, but nothing here should
 * require inventing a birthtime to satisfy the type) still type-checks, and
 * the comparison simply skips the check it cannot make.
 */
export type EntryIdentity =
  | { dev: number; ino: number }
  | { dev: bigint; ino: bigint; birthtimeNs?: bigint }

/**
 * Result of {@link removeIfSame}. `reason` reads after the path, e.g.
 * `${target} ${reason}`.
 */
export type CheckedRemoval = { removed: true } | { removed: false; reason: string }

function errorCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException)?.code
  return code ?? (err instanceof Error ? err.message : String(err))
}

/** What a parked-leftover scan found, and whether it could look at all. */
export interface ParkedScan {
  /** Entries a crashed or failed removal left parked beside the target. */
  parked: string[]
  /** Set when the folder holding them could not be listed. */
  unreadable?: string
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
export async function listParkedLeftovers(target: string): Promise<ParkedScan> {
  const pattern = parkedPattern(target)
  const parent = path.dirname(target)
  let entries: string[]
  try {
    entries = await fsp.readdir(parent)
  } catch (err) {
    // Round 25 (cross-model review): an empty list here said "nothing is
    // parked" when the truth was "this folder could not be listed", hiding
    // the very thing this scan exists to surface.
    return {
      parked: [],
      unreadable:
        `${parent} could not be listed (${errorCode(err)}), so anything an interrupted removal ` +
        `left parked beside ${target} is not reported here.`,
    }
  }
  return {
    parked: entries.filter((name) => pattern.test(name)).map((name) => path.join(parent, name)),
  }
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
 * Compares `expected` and `actual` in the domain of `expected`. `actual` is
 * always read `bigint` (every caller here reads via `{bigint: true}`), but
 * `expected` may still be a plain `fs.Stats`-derived `number`, from one of
 * {@link removeIfSame}'s six other, unmodified call sites (fan-out cleanup x2,
 * fan-out overwrite x3, install rollback).
 *
 * A caller that captured its identity as a `number` has already lost any
 * bits above 2^53 -- widening it to `BigInt` cannot recover them, so
 * comparing in the `bigint` domain would report a spurious DIFFERENCE for
 * those callers on a filesystem where it matters. Narrowing `actual` to
 * `number` instead reproduces EXACTLY the comparison those callers have
 * always made; only a caller that itself captured a `bigint` identity (the
 * uninstall path) gets the wider, precision-preserving comparison.
 *
 * Round 10 (SMI-6732 R2): both branches were previously unpinned -- reverting
 * the bigint branch to a `Number()` comparison, or reverting the number
 * branch to widen `expected` to `BigInt` instead of narrowing `actual` to
 * `Number`, left the whole suite green. The bigint-branch mutant is caught
 * only by two inodes that are DISTINCT as `bigint` but collapse to the SAME
 * `Number` -- see `skill-installation.uninstall.guard.test.ts`'s CASE U. The
 * number-branch mutant is caught only when `expected` is a LOSSY `Number()`
 * capture of an inode past 2^53 -- every existing regression test used a
 * small, real inode, where `BigInt(Number(x)) === x` holds trivially and
 * cannot discriminate the two rules -- see CASE L2.
 *
 * Round 10 (SMI-6732 R3): the bigint branch also compares `birthtimeNs`, by
 * the SAME both-non-zero rule `identityChanged`
 * (`skill-installation.removal-identity.ts`) uses, closing a gap that rule
 * does not reach. `identityChanged` only covers the window from the removal
 * guard's own read to `performUninstall`'s `seen` read; `removeIfSame` opens
 * TWO MORE windows after that -- `seen` to this function's own `before`
 * lstat, and `before` to the re-check after the park rename -- and a
 * filesystem that reuses a freed inode immediately (ext4) can be swapped
 * through either one. The number branch is deliberately left alone: every
 * caller there passes a plain `fs.Stats`, which has no `birthtimeNs` at all.
 */
function isBigintIdentity(
  id: EntryIdentity
): id is { dev: bigint; ino: bigint; birthtimeNs?: bigint } {
  return typeof id.dev === 'bigint' && typeof id.ino === 'bigint'
}

function sameIdentity(
  expected: EntryIdentity,
  actual: { dev: bigint; ino: bigint; birthtimeNs: bigint }
): boolean {
  if (isBigintIdentity(expected)) {
    if (expected.dev !== actual.dev || expected.ino !== actual.ino) return false
    if (
      expected.birthtimeNs !== undefined &&
      expected.birthtimeNs !== 0n &&
      actual.birthtimeNs !== 0n &&
      expected.birthtimeNs !== actual.birthtimeNs
    ) {
      return false
    }
    return true
  }
  return Number(expected.dev) === Number(actual.dev) && Number(expected.ino) === Number(actual.ino)
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
 *
 * Round 8 (SMI-6732 C1): both `lstat`s below read `{bigint: true}` — see
 * {@link sameIdentity} for how that stays behaviour-identical for the six
 * other callers, which still pass a `number`-typed identity.
 */
export async function removeIfSame(
  target: string,
  expected: EntryIdentity
): Promise<CheckedRemoval> {
  let before: BigIntStats
  try {
    before = await fsp.lstat(target, { bigint: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { removed: true }
    return {
      removed: false,
      reason: `could not be checked (${errorCode(err)}), so it was left in place`,
    }
  }
  if (!sameIdentity(expected, before)) {
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
  let now: BigIntStats | undefined
  let checkError: unknown
  try {
    now = await fsp.lstat(parked, { bigint: true })
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
  if (!sameIdentity(expected, now)) {
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
async function linkFileBack(
  parked: string,
  target: string,
  entry: BigIntStats
): Promise<FileRestore> {
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
