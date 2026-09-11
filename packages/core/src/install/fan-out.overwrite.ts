/**
 * SMI-6529: safe replacement of a fan-out destination, split out of
 * fan-out.ts to stay under the 500-line gate.
 *
 * Every write to a destination happens under a per-destination lock, and a
 * refresh never writes into the destination in place:
 *
 *  1. The new copy (or symlink) is written into a hidden staging folder next
 *     to the destination.
 *  2. The old destination is renamed aside into a hidden backup folder.
 *  3. The staged copy is renamed into place, and the backup is dropped.
 *
 * If step 3 fails, the old destination is renamed back. Nothing at the
 * destination is ever deleted to make room, and a half-written copy is never
 * visible there.
 *
 * Review history:
 *  - Round 5 (R2/R3): the first version used a fixed backup name it
 *    `rm -rf`'d first, and never restored a backup stranded by a crash.
 *  - Round 6: two concurrent force-refreshes of one destination could lose
 *    the original. Call B's recovery "restored" call A's in-flight backup,
 *    then A's failure path deleted it. The per-destination lock serializes
 *    recovery, write and swap; staging removes A's delete entirely. Round 6
 *    also found that a stranded `original` was restored whatever it was (a
 *    symlink to /etc included), that an EACCES on the `.git` check was
 *    reported as "contains a .git directory", and that the name prefix could
 *    match a sibling skill's folders.
 *  - Round 13 (cross-model review): the destination lock keeps other
 *    Skillsmith calls out, not other programs. So a staging or backup folder
 *    is deleted only while it is still the folder we made (same device and
 *    inode). Round 14: a crashed write's staging folder is never deleted
 *    (neither its name nor its contents proves who owns it), only reported,
 *    and a folder left in place is named with the reason. Round 15: each
 *    delete parks the folder under a random name and checks it there
 *    (`removeIfSame`), closing the gap between the check and the delete,
 *    and `replaceDestination` returns the new entry's identity, taken before
 *    it became visible at the destination.
 *  - Round 8: a lock released mid-attempt was reported as corrupt, so
 *    contending callers failed at once; waiting on an orphaned reclaim lock
 *    still blocked the event loop; a reinstall after an uninstall restored a
 *    stale backup; and an empty backup folder from a crash was reported
 *    forever.
 *
 * @module @skillsmith/core/install/fan-out.overwrite
 */
import * as path from 'node:path'
import * as fsp from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { acquireOwnedLock, StuckLockError, type StuckLockReason } from '../config/owned-lock.js'
import type { LinkManifest } from './fan-out.manifest.js'
import { PARK_TAG, removeIfSame } from './remove-if-same.js'

const BACKUP_TAG = '.skillsmith-backup-'
const STAGING_TAG = '.skillsmith-staging-'
const LOCK_TAG = '.skillsmith-fanout'
/** How long to wait for another process's lock on the same destination (ms). */
const DESTINATION_LOCK_TIMEOUT_MS = 30_000
/** Pause between attempts while another process holds the lock (ms). */
const DESTINATION_LOCK_POLL_MS = 50
/**
 * Refusals that end on their own, so they are waited out: a live holder, a
 * busy reclaim lock, and a holder we may not reclaim because auto-reclaim is
 * off (it still ends when that holder releases). An unparseable or legacy
 * claim never goes away by itself, so it fails at once.
 */
const RETRYABLE_REASONS: ReadonlySet<StuckLockReason> = new Set([
  'held',
  'reclaim_unavailable',
  'reclaim_disabled',
])

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Hidden sibling name prefix for `dest`, e.g. `.foo.skillsmith-backup-`. */
function siblingPrefix(dest: string, tag: string): string {
  return '.' + path.basename(dest) + tag
}

/** Exact match for a `mkdtemp` folder made from `siblingPrefix(dest, tag)` (6-char suffix). */
function siblingPattern(dest: string, tag: string): RegExp {
  return new RegExp('^' + escapeRegExp(siblingPrefix(dest, tag)) + '[A-Za-z0-9]{6}$')
}

/**
 * Names `removeIfSame` parks `dest`, or one of its backup or staging folders,
 * under while removing it (`.<name>.skillsmith-removing-<12 hex>`). Exact, so
 * a sibling skill's names (`foo.bar` for `foo`) never match.
 */
function parkedPatterns(dest: string): RegExp[] {
  const park = escapeRegExp(PARK_TAG) + '[0-9a-f]{12}$'
  return [
    new RegExp('^' + escapeRegExp('.' + path.basename(dest)) + park),
    ...[BACKUP_TAG, STAGING_TAG].map(
      (tag) => new RegExp('^\\.' + escapeRegExp(siblingPrefix(dest, tag)) + '[A-Za-z0-9]{6}' + park)
    ),
  ]
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function lstatOrNull(p: string): Promise<Stats | null> {
  try {
    return await fsp.lstat(p)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

// Same-process callers for one destination queue here, so only one of them
// holds the file lock at a time; the file lock arbitrates between processes.
const inProcessQueue = new Map<string, Promise<void>>()

/**
 * Queue key for `dest`: its parent's real path plus its name, so a symlinked
 * spelling of the same folder shares one queue (round 7). A case-only variant
 * on a case-insensitive volume still gets its own key, but it then only waits
 * asynchronously on the shared file lock below, never blocking.
 */
async function queueKey(dest: string): Promise<string> {
  const parent = path.dirname(path.resolve(dest))
  const realParent = await fsp.realpath(parent).catch(() => parent)
  return path.join(realParent, path.basename(dest))
}

/**
 * Take the cross-process file lock without ever blocking the event loop.
 * `acquireOwnedLock` normally waits with a synchronous sleep, which froze a
 * whole MCP server for up to 10 s (round 7). Here each attempt is one
 * non-waiting try (`timeoutMs: 0`) that still reclaims a dead holder's lock
 * at once (`reclaimProbeAfterMs: 0`) and never waits on the reclaim lock
 * either (`reclaimLockTimeoutMs: 0`, round 8). Between attempts we await.
 */
async function acquireFileLock(target: string, label: string): Promise<() => void> {
  const deadline = Date.now() + DESTINATION_LOCK_TIMEOUT_MS
  for (;;) {
    try {
      return acquireOwnedLock(target, {
        timeoutMs: 0,
        reclaimProbeAfterMs: 0,
        reclaimLockTimeoutMs: 0,
        label,
      })
    } catch (err) {
      const retryable = err instanceof StuckLockError && RETRYABLE_REASONS.has(err.reason)
      if (!retryable || Date.now() >= deadline) throw err
      await delay(DESTINATION_LOCK_POLL_MS)
    }
  }
}

/**
 * Run `fn` holding the cross-process file lock `<target>.lock`, waiting
 * without blocking the event loop. Callers in one process contend on it too.
 */
export async function withFileLock<T>(
  target: string,
  label: string,
  fn: () => Promise<T>
): Promise<T> {
  const release = await acquireFileLock(target, label)
  try {
    return await fn()
  } finally {
    release()
  }
}

/**
 * Run `fn` holding the lock for `dest`: first queue behind any other call
 * for the same destination in this process, then take the cross-process
 * file lock `.<name>.skillsmith-fanout.lock` next to it.
 */
export async function withDestinationLock<T>(dest: string, fn: () => Promise<T>): Promise<T> {
  const key = await queueKey(dest)
  const previous = inProcessQueue.get(key) ?? Promise.resolve()
  let releaseQueue: () => void = () => {}
  const mine = new Promise<void>((resolve) => {
    releaseQueue = resolve
  })
  const tail = previous.then(() => mine)
  inProcessQueue.set(key, tail)
  await previous
  try {
    const parent = path.dirname(dest)
    await fsp.mkdir(parent, { recursive: true })
    const lockTarget = path.join(parent, siblingPrefix(dest, LOCK_TAG))
    return await withFileLock(lockTarget, 'fan-out destination lock', fn)
  } finally {
    releaseQueue()
    if (inProcessQueue.get(key) === tail) inProcessQueue.delete(key)
  }
}

/** Result of looking for `.git` at a directory's root. */
export type GitAtRoot =
  | { kind: 'absent' }
  | { kind: 'present' }
  | { kind: 'unknown'; reason: string }

/**
 * Look for a `.git` entry at the root of `p` with `lstat` (never following a
 * symlink, so a dangling `.git` link still counts). Any error other than
 * ENOENT/ENOTDIR is `unknown`, which callers must treat as "refuse".
 */
export async function checkGitAtRoot(p: string): Promise<GitAtRoot> {
  try {
    await fsp.lstat(path.join(p, '.git'))
    return { kind: 'present' }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent' }
    return { kind: 'unknown', reason: code ?? errorMessage(err) }
  }
}

/** Refusal text for a git check that isn't `absent`, or `null` when it is. */
export function gitRefusal(
  p: string,
  check: GitAtRoot,
  verb: 'overwrite' | 'delete'
): string | null {
  if (check.kind === 'absent') return null
  if (check.kind === 'present') {
    return (
      `${p} is a recorded Skillsmith fan-out copy but now contains a .git directory ` +
      `(looks like a real git working tree) — refusing to ${verb} it. Remove it yourself, ` +
      `then retry.`
    )
  }
  return `could not check ${p} for a .git directory (${check.reason}) — refusing to ${verb} it.`
}

/** Whether the link manifest records `dest` as a copy Skillsmith made. */
function isRecordedCopy(dest: string, manifest: LinkManifest): boolean {
  const resolved = path.resolve(dest)
  return manifest.links.some((link) => link.kind === 'copy' && path.resolve(link.to) === resolved)
}

/**
 * Throw, changing nothing, unless the existing destination may be replaced:
 * a symlink (always disposable), or a copy recorded in the link manifest that
 * hasn't become a git working tree.
 */
export async function assertOverwritable(
  dest: string,
  existing: Stats,
  manifest: LinkManifest
): Promise<void> {
  if (existing.isSymbolicLink()) return
  if (!isRecordedCopy(dest, manifest)) {
    throw new Error(
      `addLink: ${dest} already exists and is not a fan-out destination Skillsmith recorded ` +
        `(no matching entry in the link manifest); remove it yourself, then retry with force.`
    )
  }
  const refusal = gitRefusal(dest, await checkGitAtRoot(dest), 'overwrite')
  if (refusal) throw new Error(`addLink: ${refusal}`)
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
export async function recoverDestination(dest: string, manifest: LinkManifest): Promise<string[]> {
  const parent = path.dirname(dest)
  let entries: string[]
  try {
    entries = await fsp.readdir(parent)
  } catch {
    return []
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
  if (folder === undefined || !isRecordedCopy(dest, manifest)) return []
  if ((await lstatOrNull(dest)) !== null) return []
  await fsp.rename(path.join(folder, 'original'), dest)
  await fsp.rmdir(folder).catch(() => {})
  return [folder]
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
export async function listLeftoverBackups(dest: string): Promise<string[]> {
  const parent = path.dirname(dest)
  let entries: string[]
  try {
    entries = await fsp.readdir(parent)
  } catch {
    return []
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
  return leftovers
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
    return (
      `an interrupted removal left part of what it was removing at the hidden path ${folder}; ` +
      `check it, then delete it yourself if you don't need it.`
    )
  }
  const what = name.includes(STAGING_TAG) ? 'a partial copy' : 'an earlier copy'
  return (
    `an interrupted refresh left ${what} in the hidden folder ${folder}; ` +
    `check it, then delete it yourself if you don't need it.`
  )
}

/**
 * Replace (or create) `dest` with what `write` produces. The caller must hold
 * `withDestinationLock(dest)` and have checked `assertOverwritable`. `write`
 * receives a staging path; if it throws, the destination is never touched.
 *
 * Returns the identity of the entry now at `dest`. Round 15 (Opus): it is
 * taken from the staged entry before the swap, since a rename keeps device
 * and inode. Taken after the swap, it could record a folder another program
 * had put there in between, and an undo would then delete that folder.
 */
export async function replaceDestination(
  dest: string,
  write: (stagedPath: string) => Promise<void>
): Promise<Stats> {
  const parent = path.dirname(dest)
  const stagingFolder = await fsp.mkdtemp(path.join(parent, siblingPrefix(dest, STAGING_TAG)))
  const made = await fsp.lstat(stagingFolder)
  const staged = path.join(stagingFolder, 'content')
  let placed: Stats
  try {
    await write(staged)
    placed = await fsp.lstat(staged)
    await swapIntoPlace(dest, staged)
  } catch (err) {
    // A partial copy made from the source skill: remove it, but only while
    // the folder is still the one we made (round 13), and say why when that
    // didn't happen (round 14).
    const removal = await removeIfSame(stagingFolder, made)
    if (removal.removed) throw err
    throw new Error(`${errorMessage(err)}; the staging folder ${stagingFolder} ${removal.reason}`, {
      cause: err,
    })
  }
  // Empty after a successful swap, so a non-recursive rmdir can't delete
  // anything else. If it fails, the folder stays, and listLeftoverBackups,
  // which the caller runs next, reports it.
  await fsp.rmdir(stagingFolder).catch(() => {})
  return placed
}

async function swapIntoPlace(dest: string, staged: string): Promise<void> {
  const existing = await lstatOrNull(dest)
  if (existing === null) {
    await fsp.rename(staged, dest)
    return
  }
  if (existing.isSymbolicLink()) {
    await fsp.unlink(dest)
    await fsp.rename(staged, dest)
    return
  }
  const backupFolder = await fsp.mkdtemp(
    path.join(path.dirname(dest), siblingPrefix(dest, BACKUP_TAG))
  )
  const backupMade = await fsp.lstat(backupFolder)
  const original = path.join(backupFolder, 'original')
  try {
    await fsp.rename(dest, original)
  } catch (err) {
    await fsp.rmdir(backupFolder).catch(() => {})
    throw err
  }
  try {
    await fsp.rename(staged, dest)
  } catch (err) {
    try {
      await fsp.rename(original, dest)
    } catch (restoreErr) {
      throw new Error(
        `addLink: ${errorMessage(err)}; the original could not be put back and is preserved ` +
          `at ${original} (${errorMessage(restoreErr)})`,
        { cause: err }
      )
    }
    await fsp.rmdir(backupFolder).catch(() => {})
    throw err
  }
  // The swap succeeded, so the superseded copy is no longer needed. Drop it
  // only while the backup folder and the copy in it are still what we put
  // there (round 13). A folder left for any reason (not ours, or the removal
  // failed) stays, and listLeftoverBackups, which the caller runs next,
  // reports it.
  const originalNow = await lstatOrNull(original).catch(() => null)
  if (
    originalNow !== null &&
    originalNow.dev === existing.dev &&
    originalNow.ino === existing.ino
  ) {
    await removeIfSame(backupFolder, backupMade)
  }
}
