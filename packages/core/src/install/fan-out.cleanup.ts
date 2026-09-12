/**
 * SMI-6529: the two fan-out deletes of a destination that isn't a folder the
 * current call just staged: uninstall's removal of a recorded fan-out, and
 * addLink's undo of a write whose record couldn't be saved. Split out of
 * fan-out.ts to stay under the 500-line gate.
 *
 * Round 14 (cross-model and Opus confirmation reviews): each removes only the
 * entry it means to remove (same device and inode). The destination lock
 * keeps other Skillsmith calls out, not other programs. Round 15: the check
 * runs after the entry is parked under a random name (`removeIfSame`), so a
 * program that swaps the path after the check no longer has its entry
 * deleted.
 *
 * @module @skillsmith/core/install/fan-out.cleanup
 */
import type { Stats } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { checkGitAtRoot, gitRefusal } from './fan-out.overwrite.js'
import { removeIfSame, type EntryIdentity } from './remove-if-same.js'

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Result of {@link removeRecordedLink}. */
export type RecordedLinkRemoval = { removed: true } | { removed: false; reason: string }

/**
 * SMI-6529 H3 (round 2) / N6 (round 4): uninstall's teardown of a copy-mode
 * fan-out (or symlink) Skillsmith created and recorded in the link manifest.
 *
 * A recorded copy can later become a real git working tree (the user
 * `git init`s or clones into that path), so a non-symlink recorded copy with
 * `.git` at its root is refused: reported and left in place. Symlinks are
 * just unlinked; what they point at is untouched.
 *
 * Returns `{ removed: true }` on a removal, or when the path is already gone,
 * and `{ removed: false, reason }` on a refusal or a failure, so the caller
 * keeps the manifest entry and reports it.
 */
export async function removeRecordedLink(p: string): Promise<RecordedLinkRemoval> {
  let stat: Stats
  try {
    stat = await fsp.lstat(p)
  } catch (err) {
    // Already gone: races with an external editor or uninstall are expected,
    // and there is nothing left to report. Round 15 (cross-model review): any
    // other error means we can't tell what is there, so the record is kept.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { removed: true }
    return { removed: false, reason: `${p} could not be checked: ${errorText(err)}` }
  }
  if (!stat.isSymbolicLink() && !stat.isFile()) {
    const refusal = gitRefusal(p, await checkGitAtRoot(p), 'delete')
    if (refusal) return { removed: false, reason: refusal }
  }
  // Remove only the entry checked above.
  const removal = await removeIfSame(p, stat)
  return removal.removed ? removal : { removed: false, reason: `${p} ${removal.reason}.` }
}

/**
 * SMI-6529 rounds 10–11: undo addLink's write when its record couldn't be
 * saved. A fresh destination is removed. A refreshed symlink is put back,
 * since its existing record still describes it (it was replaced with no
 * backup). Left as is, either would be a destination the manifest doesn't
 * describe: uninstall would miss it, and a force refresh would refuse it.
 *
 * The caller holds the destination's lock, so no other Skillsmith call has
 * touched it. Another program may have, so only the entry this call placed is
 * removed; anything else found there is left, and the error says so. Round
 * 15: `placed` is the staged entry's identity, taken before it was swapped
 * into place, so a swap after that moment can't pass as this call's write.
 */
export async function undoUnrecordedWrite(
  toDir: string,
  cause: unknown,
  oldLinkTarget: string | undefined,
  placed: EntryIdentity | null
): Promise<void> {
  const fail = (what: string): Error =>
    new Error(
      `addLink: ${errorText(cause)}; this call's unrecorded write could not be undone: ${what}.`,
      { cause }
    )
  if (placed === null) {
    // Round 21 (Opus): the write could not be identified — something replaced
    // it while it was being created — so nothing here is safe to remove.
    throw fail(
      `${toDir} holds a write this call could not identify, since something replaced it while ` +
        `it was being created, so nothing was removed`
    )
  }
  const removal = await removeIfSame(toDir, placed)
  if (!removal.removed) throw fail(`${toDir} ${removal.reason}`)
  if (oldLinkTarget !== undefined) {
    try {
      await fsp.symlink(oldLinkTarget, toDir, 'dir')
    } catch (err) {
      throw fail(`${toDir} could not be put back as the symlink it was (${errorText(err)})`)
    }
  }
}
