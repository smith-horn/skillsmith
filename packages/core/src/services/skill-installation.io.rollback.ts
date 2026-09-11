/**
 * @fileoverview writeInstallFiles' file-level snapshot/restore rollback helpers.
 * @module @skillsmith/core/services/skill-installation.io.rollback
 * @see SMI-6529 Wave A0
 *
 * Split out of skill-installation.io.ts to stay under the 500-line CI gate
 * once the rollback fix landed (mirrors this module's existing sibling-split
 * convention, e.g. skill-installation.policy.ts).
 *
 * On a real user machine, a rollback in `writeInstallFiles` used to unlink
 * every file it had touched — including files that ALREADY EXISTED before
 * the install started (a real user's git-cloned skill directory, `.git`
 * included). These helpers make that rollback safe: classify a file BEFORE
 * writing into it, snapshot it if it's a pre-existing regular file, and
 * restore it if the install fails partway through.
 *
 * F1 (review round 1): `safeWriteFile` opens with O_TRUNC and writes in
 * place — not atomic. A write that fails mid-way (ENOSPC/EIO after
 * truncation) can leave a truncated original on disk. The snapshot MUST be
 * taken, and recorded as a rollback candidate, BEFORE `safeWriteFile` is
 * ever called — never after it "succeeds," since a failure can occur after
 * the file has already been truncated.
 */

import * as fs from 'fs/promises'
import { constants } from 'fs'
import { O_NOFOLLOW, writeFullBuffer } from '../utils/safe-fs.js'

export interface FileSnapshot {
  path: string
  content: Buffer
  mode: number
}

/**
 * SMI-6529 H2: thrown instead of a plain `Error` whenever a rollback restore
 * fails partway through a failed (or later-cancelled) install — i.e. some
 * pre-existing file could NOT be restored to its original content and the
 * user needs to recover it manually. Before this class existed, the
 * compound message ("Install failed (...) AND could not restore N
 * pre-existing file(s)...") was a plain `Error`, so `sanitizeInstallError()`
 * (skill-installation.helpers.ts) — which only passes through messages
 * matching a small known-prefix allowlist — silently replaced this exact,
 * actionable diagnostic with the generic "Installation failed due to an
 * internal error", hiding the one failure mode where telling the user
 * EXACTLY which files to recover manually matters most. `sanitizeInstallError`
 * special-cases `instanceof InstallRestoreError` to always pass the message
 * through verbatim, bypassing the allowlist entirely.
 */
export class InstallRestoreError extends Error {
  /** The paths that could not be restored (same list as `restoreSnapshots()`'s return). */
  public readonly restoreFailures: string[]

  constructor(innerMessage: string, restoreFailures: string[], options?: { cause?: unknown }) {
    super(
      'Install failed (' +
        innerMessage +
        ') AND could not restore ' +
        restoreFailures.length +
        ' pre-existing file(s) to their original content: ' +
        restoreFailures.join(', ') +
        '. Recover these manually before retrying.',
      options
    )
    this.name = 'InstallRestoreError'
    this.restoreFailures = restoreFailures
  }
}

export type PreWriteClassification =
  | { kind: 'absent' }
  | { kind: 'regular'; snapshot: FileSnapshot }
  /** Symlink, directory, or anything else `safeWriteFile` refuses BEFORE touching a byte. */
  | { kind: 'other' }

/**
 * Classify a write target BEFORE any write is attempted, so the caller can
 * record a rollback candidate (snapshot for an existing regular file, a
 * fresh-creation marker for an absent path) ahead of the write — never
 * after, since `safeWriteFile`'s O_TRUNC is not atomic and a failure can
 * land between truncation and the write completing.
 */
export async function classifyPreWrite(filePath: string): Promise<PreWriteClassification> {
  let stat
  try {
    stat = await fs.lstat(filePath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' }
    throw err
  }
  if (!stat.isFile()) return { kind: 'other' }
  const content = await fs.readFile(filePath)
  return { kind: 'regular', snapshot: { path: filePath, content, mode: stat.mode } }
}

/**
 * Restore every overwritten file's original bytes + mode. Returns the paths
 * that could NOT be restored rather than throwing — the caller must surface
 * these explicitly (a failed restore is data loss the user needs to recover
 * manually), never swallow them silently.
 *
 * F2 (review round 1):
 *  - Skips a no-op restore when the current bytes already equal the
 *    snapshot — avoids a false restore failure for a file `safeWriteFile`
 *    refused before ever touching it (e.g. a hardlinked file: snapshotted
 *    proactively per F1's "regular" classification, but never actually
 *    written, since `safeWriteFile`'s own hardlink check runs before any
 *    truncation).
 *  - Restores WITHOUT following symlinks: `open(O_WRONLY|O_TRUNC|O_NOFOLLOW)`
 *    + write + fd-level chmod — never a path-based `fs.writeFile`/`fs.chmod`,
 *    both of which follow symlinks and could write through one planted at
 *    the snapshot's path between snapshot-time and restore-time.
 *
 * SMI-6529 M4 (round 2): restores in REVERSE order (most-recently-taken
 * snapshot first). This is the correct undo-stack semantics whenever two
 * snapshots can legitimately describe the SAME real on-disk file at
 * different points in time — e.g. a case-insensitive filesystem alias
 * (`SKILL.md`/`skill.md` on default APFS) that this module's caller failed
 * to dedupe: snapshot A ("before write 1") and snapshot B ("before write 2",
 * captured AFTER write 1 already ran) both target the same inode. Restoring
 * forward (A then B) ends on B's value — the intermediate post-write-1 state,
 * not the true original. Restoring in reverse (B then A) always converges on
 * the earliest, TRUE original. A caller that also dedupes at snapshot-time
 * (as `writeInstallFiles` now does) never produces such a pair in the first
 * place — this ordering is defense-in-depth for any snapshot list this
 * function is ever handed, not a substitute for that dedupe.
 *
 * SMI-6529 N3 (round 4): writes via `writeFullBuffer()` (loops until every
 * byte is written — `FileHandle.write()` can short-write without throwing,
 * measured live under `RLIMIT_FSIZE`) and then verifies the ON-DISK size
 * matches the snapshot's exact length before trusting the restore. Either
 * check failing is treated as a restore FAILURE (pushed to `failures`, same
 * as any other error here) — a partially-restored file is exactly the data
 * loss this whole module exists to prevent, so it must never be reported as
 * a clean restore.
 */
export async function restoreSnapshots(snapshots: FileSnapshot[]): Promise<string[]> {
  const failures: string[] = []
  for (const snapshot of [...snapshots].reverse()) {
    try {
      let current: Buffer | null
      try {
        current = await fs.readFile(snapshot.path)
      } catch {
        current = null
      }
      if (current !== null && current.equals(snapshot.content)) {
        continue // already matches — nothing was actually written here
      }

      const handle = await fs.open(
        snapshot.path,
        constants.O_WRONLY | constants.O_TRUNC | O_NOFOLLOW
      )
      try {
        await writeFullBuffer(handle, snapshot.content, 0)
        const finalStat = await handle.stat()
        if (finalStat.size !== snapshot.content.length) {
          throw new Error(
            `Restore incomplete: wrote ${finalStat.size} of ${snapshot.content.length} bytes`
          )
        }
        await handle.chmod(snapshot.mode)
      } finally {
        await handle.close()
      }
    } catch {
      failures.push(snapshot.path)
    }
  }
  return failures
}
