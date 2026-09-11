/**
 * SMI-6529: the two fan-out deletes of a destination that isn't a folder the
 * current call just staged: uninstall's removal of a recorded fan-out, and
 * addLink's undo of a write whose record couldn't be saved. Split out of
 * fan-out.ts to stay under the 500-line gate.
 *
 * Round 14 (cross-model and Opus confirmation reviews): each checks, right
 * before removing, that the path still holds the entry it means to remove
 * (same device and inode). The destination lock keeps other Skillsmith calls
 * out, not other programs. The check and the removal are two syscalls apart;
 * that residual window is accepted, since Node has no descriptor-relative
 * recursive removal.
 *
 * @module @skillsmith/core/install/fan-out.cleanup
 */
import type { Stats } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { checkGitAtRoot, gitRefusal } from './fan-out.overwrite.js'

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
 * and `{ removed: false, reason }` on a refusal, so the caller keeps the
 * manifest entry and reports it.
 */
export async function removeRecordedLink(p: string): Promise<RecordedLinkRemoval> {
  let stat: Stats
  try {
    stat = await fsp.lstat(p)
  } catch {
    // Already gone — races with an external editor/uninstall are expected;
    // treat as successfully removed (nothing left to report).
    return { removed: true }
  }
  try {
    if (!stat.isSymbolicLink() && !stat.isFile()) {
      const refusal = gitRefusal(p, await checkGitAtRoot(p), 'delete')
      if (refusal) return { removed: false, reason: refusal }
    }
    // Round 14: remove only the entry the first check saw.
    let now: Stats
    try {
      now = await fsp.lstat(p)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { removed: true }
      throw err
    }
    if (now.dev !== stat.dev || now.ino !== stat.ino) {
      return {
        removed: false,
        reason: `${p} was replaced by something else while it was being removed; left in place.`,
      }
    }
    if (now.isSymbolicLink() || now.isFile()) await fsp.unlink(p)
    else await fsp.rm(p, { recursive: true, force: true })
    return { removed: true }
  } catch (err) {
    // Uninstall should not fail because cleanup races with an external
    // editor. Report it as a refusal rather than pretending success, so
    // `removeLinks` keeps the manifest entry for a future retry.
    return { removed: false, reason: `${p} could not be removed: ${errorText(err)}` }
  }
}

/**
 * SMI-6529 rounds 10–11: undo addLink's write when its record couldn't be
 * saved. A fresh destination is removed. A refreshed symlink is put back,
 * since its existing record still describes it (it was replaced with no
 * backup). Left as is, either would be a destination the manifest doesn't
 * describe: uninstall would miss it, and a force refresh would refuse it.
 *
 * The caller holds the destination's lock, so no other Skillsmith call has
 * touched it. Round 14: another program may have, so only the entry this call
 * placed (`placed`, same device and inode) is removed; anything else found
 * there is left, and the error says so.
 */
export async function undoUnrecordedWrite(
  toDir: string,
  cause: unknown,
  oldLinkTarget: string | undefined,
  placed: Stats | null
): Promise<void> {
  const fail = (what: string, err?: unknown): Error =>
    new Error(
      `addLink: ${errorText(cause)}; ${toDir} ${what}` +
        (err === undefined ? '.' : ` (${errorText(err)}).`),
      { cause }
    )
  let current: Stats | null = null
  try {
    current = await fsp.lstat(toDir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw fail('could not be checked, so this unrecorded write was left in place', err)
    }
  }
  if (current !== null) {
    if (placed === null || current.dev !== placed.dev || current.ino !== placed.ino) {
      throw fail('was replaced by something else after this call wrote it, so it was left in place')
    }
    try {
      await fsp.rm(toDir, { recursive: true, force: true })
    } catch (err) {
      throw fail('holds an unrecorded write that could not be undone', err)
    }
  }
  if (oldLinkTarget !== undefined) {
    try {
      await fsp.symlink(oldLinkTarget, toDir, 'dir')
    } catch (err) {
      throw fail('could not be put back as the symlink it was', err)
    }
  }
}
