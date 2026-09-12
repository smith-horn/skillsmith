/**
 * SMI-6529: what a crashed or interrupted fan-out refresh leaves next to a
 * destination, and what may be done about it — the hidden backup, staging and
 * parked folders, the one case where a stranded backup is restored, and the
 * warnings the user sees. Split out of fan-out.overwrite.ts in round 16 to
 * stay under the 500-line gate; it holds the naming helpers both halves share.
 *
 * Nothing here deletes anything with content: `rmdir` refuses a folder that
 * holds anything, and neither a folder's name nor its contents proves who owns
 * it now (round 14), so everything else is reported and left alone.
 *
 * @module @skillsmith/core/install/fan-out.leftovers
 */
import * as path from 'node:path'
import * as fsp from 'node:fs/promises'
import type { Stats } from 'node:fs'
import type { LinkManifest } from './fan-out.manifest.js'
import { PARK_TAG, parkedPattern } from './remove-if-same.js'

/** What a leftover scan found, and whether it could look at all. */
export interface LeftoverScan {
  /** Hidden folders beside the destination that an interrupted operation left. */
  folders: string[]
  /**
   * Set when the parent folder could not be listed. Round 24 (cross-model
   * review): returning an empty list then reports "could not look" as "nothing
   * is there", and the accepted residual's promise is that a displaced entry
   * gets reported.
   */
  unreadable?: string
}

function errorCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code
  return code ?? (err instanceof Error ? err.message : String(err))
}

export const BACKUP_TAG = '.skillsmith-backup-'
export const STAGING_TAG = '.skillsmith-staging-'

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Hidden sibling name prefix for `dest`, e.g. `.foo.skillsmith-backup-`. */
export function siblingPrefix(dest: string, tag: string): string {
  return '.' + path.basename(dest) + tag
}

/** Exact match for a `mkdtemp` folder made from `siblingPrefix(dest, tag)` (6-char suffix). */
export function siblingPattern(dest: string, tag: string): RegExp {
  return new RegExp('^' + escapeRegExp(siblingPrefix(dest, tag)) + '[A-Za-z0-9]{6}$')
}

/**
 * Names `removeIfSame` parks `dest`, or one of its backup or staging folders,
 * under while removing it (`.<name>.skillsmith-removing-<32 hex>`). Exact, so
 * a sibling skill's names (`foo.bar` for `foo`) never match.
 */
function parkedPatterns(dest: string): RegExp[] {
  const park = escapeRegExp(PARK_TAG) + '[0-9a-f]{32}$'
  return [
    parkedPattern(dest),
    ...[BACKUP_TAG, STAGING_TAG].map(
      (tag) => new RegExp('^\\.' + escapeRegExp(siblingPrefix(dest, tag)) + '[A-Za-z0-9]{6}' + park)
    ),
  ]
}

export async function lstatOrNull(p: string): Promise<Stats | null> {
  try {
    return await fsp.lstat(p)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/** Whether the link manifest records `dest` as a copy Skillsmith made. */
export function isRecordedCopy(dest: string, manifest: LinkManifest): boolean {
  const resolved = path.resolve(dest)
  return manifest.links.some((link) => link.kind === 'copy' && path.resolve(link.to) === resolved)
}

/**
 * Remove `folder` if it is empty, and say whether it was. `rmdir` refuses a
 * folder with anything in it, so this can never delete content. Call only
 * under the destination lock: our own backup folder is briefly empty mid-swap.
 */
async function removeIfEmpty(folder: string): Promise<boolean> {
  try {
    await fsp.rmdir(folder)
    return true
  } catch {
    return false
  }
}

/**
 * Housekeeping under the destination lock, before any write:
 *  - remove an empty backup folder (a crash before anything was moved in);
 *  - restore a backup stranded by a crash between the rename-aside and the
 *    swap: the destination is missing, this is the only backup whose
 *    `original` is a real directory, and the manifest still records the
 *    destination as a copy. Backups are only ever made of recorded copies,
 *    so an unrecorded one has been uninstalled since, and restoring it would
 *    bring back a stale, untracked copy. With two or more, nothing says which
 *    is newest (a name can sort anywhere), so none is restored (round 9).
 *
 * Any other backup is left in place for `listLeftoverBackups` to report, and
 * so is a staging folder left by a crashed write: round 14 (cross-model
 * review) stopped deleting those here, since neither a folder's name nor its
 * contents proves who owns it now. Returns the backup folders restored from.
 */
export async function recoverDestination(
  dest: string,
  manifest: LinkManifest
): Promise<{ restored: string[]; unreadable?: string }> {
  const parent = path.dirname(dest)
  let entries: string[]
  try {
    entries = await fsp.readdir(parent)
  } catch (err) {
    return {
      restored: [],
      unreadable:
        `${parent} could not be listed (${errorCode(err)}), so anything an interrupted refresh ` +
        `left beside ${dest} was neither recovered nor reported.`,
    }
  }
  const backup = siblingPattern(dest, BACKUP_TAG)
  const candidates: string[] = []
  for (const name of entries) {
    const folder = path.join(parent, name)
    if (!backup.test(name)) continue
    if (await removeIfEmpty(folder)) continue
    const originalStat = await lstatOrNull(path.join(folder, 'original')).catch(() => null)
    if (originalStat?.isDirectory()) candidates.push(folder)
  }
  const folder = candidates.length === 1 ? candidates[0] : undefined
  if (folder === undefined || !isRecordedCopy(dest, manifest)) return { restored: [] }
  // Round 19 (Opus): this check sits immediately before the rename below,
  // which is as narrow as Node allows — there is no atomic no-clobber rename
  // for a directory — so an entry created inside that window would be
  // replaced (measured: an empty directory). Not restoring at all would lose
  // the crash recovery this exists for, so the window is accepted and stated.
  if ((await lstatOrNull(dest)) !== null) return { restored: [] }
  await fsp.rename(path.join(folder, 'original'), dest)
  await fsp.rmdir(folder).catch(() => {})
  return { restored: [folder] }
}

/**
 * Backup folders for `dest` that are still present: copies an interrupted
 * refresh left behind (after the swap, or unrestorable). Round 7: these are
 * reported to the user rather than kept silently or deleted. Round 8: an
 * empty one holds nothing to report and is removed. Round 9: on a volume
 * that ignores case, a backup made under another spelling of the name
 * (`.Foo.` for `foo`) belongs to this destination too, so it is reported;
 * it is never removed or restored, since on a case-sensitive volume the
 * same name belongs to a different destination. Round 14: a staging folder
 * left by a crashed write is reported the same way. Round 15: so is what a
 * crashed or failed removal left under a parked name. Call under the lock.
 */
export async function listLeftoverBackups(dest: string): Promise<LeftoverScan> {
  const parent = path.dirname(dest)
  let entries: string[]
  try {
    entries = await fsp.readdir(parent)
  } catch (err) {
    return {
      folders: [],
      unreadable:
        `${parent} could not be listed (${errorCode(err)}), so anything an interrupted refresh ` +
        `or removal left beside ${dest} is not reported here.`,
    }
  }
  const exact = siblingPattern(dest, BACKUP_TAG)
  const staging = siblingPattern(dest, STAGING_TAG)
  const parked = parkedPatterns(dest)
  const anyCase = new RegExp(exact.source, 'i')
  const leftovers: string[] = []
  for (const name of entries) {
    const folder = path.join(parent, name)
    if (exact.test(name) || staging.test(name) || parked.some((p) => p.test(name))) {
      if (!(await removeIfEmpty(folder))) leftovers.push(folder)
    } else if (anyCase.test(name) && (await isCaseVariantOf(folder, dest))) {
      leftovers.push(folder)
    }
  }
  return { folders: leftovers }
}

/**
 * Whether backup `folder` (named for another spelling of `dest`) is, on this
 * volume, the same entry as the name spelled for `dest`, and holds content.
 * On a case-sensitive volume that name doesn't exist, or is a different entry.
 */
async function isCaseVariantOf(folder: string, dest: string): Promise<boolean> {
  const suffix = path.basename(folder).slice(-6)
  const ownName = path.join(path.dirname(dest), siblingPrefix(dest, BACKUP_TAG) + suffix)
  const [a, b] = await Promise.all([
    lstatOrNull(folder).catch(() => null),
    lstatOrNull(ownName).catch(() => null),
  ])
  if (a === null || b === null || a.dev !== b.dev || a.ino !== b.ino) return false
  const contents = await fsp.readdir(folder).catch(() => [])
  return contents.length > 0
}

/** User-facing warning for a leftover backup, staging folder or parked entry. */
export function leftoverBackupWarning(folder: string): string {
  const name = path.basename(folder)
  if (name.includes(PARK_TAG)) {
    // Round 18: who owns a parked entry is not known — see parkedLeftoverWarning.
    return (
      `an interrupted removal moved something aside to the hidden path ${folder} and did not ` +
      `finish. It may be part of this skill's copy, or something another program put there. ` +
      `Check it, then restore or delete it yourself.`
    )
  }
  // Round 23 (Opus): this used to call the contents "an earlier copy" of the
  // skill. That is an ownership claim it cannot make — the move-aside window
  // can displace another program's entry into this folder — and it is the same
  // claim the parked wording above dropped.
  const what = name.includes(STAGING_TAG) ? 'a partial copy' : 'a copy'
  return (
    `an interrupted refresh left ${what} in the hidden folder ${folder}. It is either what this ` +
    `skill replaced, or something another program put at the path while the refresh was moving ` +
    `the old copy aside. Check it, then restore or delete it yourself.`
  )
}
