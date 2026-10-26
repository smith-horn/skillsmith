/**
 * SMI-6531 (A1 step 4a): the undo (A1 plan §3.3 "Undo", run from steps 8 and
 * 10a). It keeps every tree it moves off the skill path:
 *
 *  1. `check`; `rename(realDir, OP/undone)`; sync OP, then R.
 *  2. `check`; claim `realDir` with `mkdir`; sync R; `rename(O, realDir)`; sync
 *     R, then OP. `claimPublish` makes the claim, syncs R, renames, and syncs R
 *     again; this module adds the `check` before the rename (claimPublish's
 *     `afterClaim`), refuses a failed sync it reports, and adds the final sync
 *     of OP, the source parent, which `claimPublish` does not make.
 *  3. Hash `undone/`: `postTree` is kind `undone`, anything else `conflict`
 *     (warned, `conflict-kept`).
 *  4. `publishTree(undone/, kind)`; the caller then runs step 13.
 *
 * A non-directory O (the live folder was swapped for a symlink or file just
 * before rename 1, T-X4) cannot be restored through a claim: `rename` of a
 * non-directory over the empty claim fails `EISDIR` (measured on macOS and
 * Linux, 2026-10-21). It is recreated at the path with a call that never
 * replaces (owner decision 2026-10-21), so there is no check-then-rename
 * window:
 *
 *  - a symlink: `symlink(readlink(O), realDir)`. The restored link is a NEW
 *    inode with the same link text;
 *  - a regular file: `link(O, realDir)`, the same inode. Never `link()` for a
 *    symlink: macOS `link()` follows it (measured 2026-10-21);
 *  - anything else (FIFO, socket, device): not restored; the undo stops.
 *
 * `EEXIST` means something appeared at the path: it is left untouched and the
 * undo stops `target-changed`. After a recreate nothing is unlinked: O itself
 * stays in OP and is kept through `publishTree(O, 'conflict')` (warned,
 * `conflict-kept`), so OP still empties at step 13. A restored regular file
 * shares its inode with that conflict copy (a hard link).
 *
 * Any failure throws; the record stays in OP for doctor.
 *
 * @module @skillsmith/core/services/skill-swap.undo
 */
import fs from 'node:fs'
import { claimPublish } from './skill-tree.js'
import { treeHashOf } from './skill-tree.js'
import {
  check,
  codeOf,
  hook,
  opPaths,
  renameChecked,
  SwapFault,
  syncDir,
  trace,
} from './skill-swap.ops.js'
import type { SwapState } from './skill-swap.ops.js'
import { publishTree } from './skill-swap.publish.js'

export interface UndoOutcome {
  keptAs: 'undone' | 'conflict'
  keptPath: string
}

/**
 * Undo step 2 for a non-directory O: recreate it at `realDir` without ever
 * replacing an entry there, sync R, then keep O itself as `conflict`.
 */
async function recreateEntry(
  st: SwapState,
  oldDir: string,
  realDir: string,
  o: fs.BigIntStats
): Promise<void> {
  if (!o.isSymbolicLink() && !o.isFile()) {
    throw new SwapFault('unsupported-entry', `${oldDir} is neither a symlink nor a regular file`)
  }
  const text = o.isSymbolicLink() ? await fs.promises.readlink(oldDir) : null
  await hook(st, 'beforeRecreate')
  check(st)
  try {
    if (text !== null) await fs.promises.symlink(text, realDir)
    else await fs.promises.link(oldDir, realDir)
  } catch (err) {
    if (codeOf(err) === 'EEXIST') {
      throw new SwapFault('target-changed', `${realDir} was taken before the old entry went back`)
    }
    throw err
  }
  trace(
    st,
    text !== null ? { op: 'create', path: realDir } : { op: 'link', path: oldDir, dest: realDir }
  )
  await syncDir(st, st.binding.root)
  const kept = await publishTree(st, oldDir, 'conflict')
  st.warnings.push({ code: 'conflict-kept', path: kept })
}

/** Undo step 2: O back at the path (claim-publish; doctor's UN1 and S2x reuse it). */
export async function restoreOld(st: SwapState, oldDir: string, realDir: string): Promise<void> {
  const root = st.binding.root
  check(st)
  const o = await fs.promises.lstat(oldDir, { bigint: true })
  if (!o.isDirectory()) {
    await recreateEntry(st, oldDir, realDir, o)
    return
  }
  // `check` between the claim and the rename it guards. The claim's own mkdir,
  // sync, rename and sync are traced afterwards from what claimPublish
  // reports (it makes them in that order; its claim-sync handling is pinned
  // by skill-tree.claim.sync.test.ts), so the trace does not observe them.
  const r = await claimPublish(oldDir, realDir, { afterClaim: () => check(st) })
  if (!r.ok) {
    throw new SwapFault(
      r.reason === 'target-exists' ? 'target-changed' : 'write-failed',
      `the old folder could not be put back at ${realDir} (${r.reason})`
    )
  }
  if (r.syncs.publish.outcome === 'failed') {
    throw new SwapFault('write-failed', `${root} could not be synced (${r.syncs.publish.code})`)
  }
  trace(st, { op: 'mkdir', path: realDir })
  trace(st, { op: 'dirsync', path: root })
  trace(st, { op: 'rename', path: oldDir, dest: realDir })
  trace(st, { op: 'dirsync', path: root })
  await syncDir(st, st.opDir)
}

/** Undo step 1: the folder at the path set aside as `OP/undone`; sync OP, then R. */
export async function undoAside(st: SwapState): Promise<void> {
  await hook(st, 'beforeUndoAside')
  await renameChecked(st, st.input.realDir, opPaths(st).undoneDir)
  await hook(st, 'afterUndoAside')
  await syncDir(st, st.opDir)
  await syncDir(st, st.binding.root)
  await hook(st, 'beforeRestore')
}

/**
 * Runs undo steps 1-4. Throws on any failure (the caller reports `stopped`).
 * Doctor runs the same steps one at a time, from the state a kill left
 * (`undoAside`, `restoreOld` or its existing-claim form, then the keep).
 */
export async function undoSwap(st: SwapState): Promise<UndoOutcome> {
  const { oldDir, undoneDir } = opPaths(st)
  const { realDir } = st.input
  await undoAside(st)
  await restoreOld(st, oldDir, realDir)

  const h = treeHashOf(undoneDir)
  const keptAs = h.ok && h.hash === st.postTree ? 'undone' : 'conflict'
  const keptPath = await publishTree(st, undoneDir, keptAs)
  if (keptAs === 'conflict') st.warnings.push({ code: 'conflict-kept', path: keptPath })
  return { keptAs, keptPath }
}
