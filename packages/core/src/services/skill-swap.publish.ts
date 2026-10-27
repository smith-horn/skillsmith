/**
 * SMI-6531 (A1 steps 4a, 4c): the backup area and `publishTree` (A1 plan §3.3
 * step 12, "`publishTree`"; §3.5).
 *
 * `publishTree(src, kind)` is the single keep path: the only way a tree
 * leaves OP. Its sidecar is published before the tree moves, so no crash
 * leaves a kept tree without one. On one device the move is a `rename`.
 * Across devices (`EXDEV`) it is the verified copy of `skill-swap.xdev.ts`:
 * the space check, a copy temp verified against the source, and a rename of
 * the temp to `dest`; the verified source stays in OP, which step 13 parks
 * whole (UD28, `skill-swap.finish.ts`).
 *
 * The backup's name is fixed, `<area>/<opId>` (owner decision 2026-10-22), so
 * `record.json`, the journal's `backup_ref` and the result name one path. A
 * name already taken stops the run (before rename 1 a refusal, at step 12 an
 * incomplete publish); nothing at that name is touched. Other kinds take
 * `<opId>.<kind>` with a `.<k>` suffix. The sidecar is linked into place (never
 * renamed over an entry), and its temp is unlinked only after verifying it is
 * the file this run wrote (`unlinkOwned`; `skill-swap.sidecar.ts`).
 *
 * Residual (the ADR-155 empty-directory class): the backup move itself is a
 * plain `rename(src, dest)` (across devices, `rename(temp, dest)`). An empty
 * directory another process creates at `dest` after the last check and
 * before that `rename` is replaced by it silently (`rename` over an empty
 * directory succeeds; over a non-empty one it fails `ENOTEMPTY`, which stops
 * the run). Nothing is lost but that empty directory. Node has no
 * `renameat2(RENAME_NOREPLACE)`. The same residual applies to a cross-device
 * copy temp kept as `partial-copy` (`skill-swap.xdev.ts`), whose rename within
 * the area targets a name `destFor` found free.
 *
 * The backup area is `<stateRoot>/backups/update/<client>/<rootKey>/<dirName>/`
 * under the native realpath of the state root, so a symlinked state root
 * (a HOME behind a link) is resolved once, and a symlink planted at any
 * component below it fails the area (`backup-unsafe`).
 *
 * @module @skillsmith/core/services/skill-swap.publish
 */
import fs from 'node:fs'
import path from 'node:path'
import { mkdirWithParentBits } from '../install/mkdir-parent-bits.js'
import { bindIdentity, identityOf, sameIdentity } from '../install/park-tree.identity.js'
import type { BoundIdentity } from '../install/park-tree.identity.js'
import { treeHashOf } from './skill-tree.js'
import {
  check,
  codeOf,
  hook,
  lstatOrNull,
  renameChecked,
  SwapFault,
  syncDir,
  trace,
} from './skill-swap.ops.js'
import type { SwapState } from './skill-swap.ops.js'
import { destFor, sidecarOf, taken, warnForeignChange, writeSidecar } from './skill-swap.sidecar.js'
import type { PublishKind } from './skill-swap.sidecar.js'
import { moveAcross } from './skill-swap.xdev.js'

const HASH_OPTIONAL: ReadonlySet<PublishKind> = new Set(['failed-build', 'unrecorded-new'])

/** One path component: not empty, not `.`/`..`, no separator or NUL. */
const oneComponent = (s: string): boolean =>
  s !== '' && s !== '.' && s !== '..' && !s.includes('/') && !s.includes('\\') && !s.includes('\0')

export { backupAreaPath } from './skill-swap.area.js'

const unsafe = (p: string, detail: string): SwapFault =>
  new SwapFault('backup-unsafe', `${detail} (${p})`)

/**
 * Plan §3.3 bound paths, backup area: create or verify each component with
 * its parent's bits (sync the parent of each created one), require a real
 * directory, require `realpath` of the last to be its path, and bind each
 * component so every later `check` covers it.
 */
export async function ensureBackupArea(st: SwapState): Promise<void> {
  const { client, dirName } = st.input
  if (!oneComponent(client) || !oneComponent(dirName)) {
    throw unsafe(st.areaPath, 'the client or folder name is not a single path component')
  }
  let parent = st.stateRootReal
  let parentStat = await lstatOrNull(parent).catch(() => null)
  if (parentStat === null || parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw unsafe(parent, 'the state root is not a directory')
  }
  const bound: Array<{ path: string; identity: BoundIdentity }> = []
  const rel = path.relative(st.stateRootReal, st.areaPath).split(path.sep)
  for (const part of rel) {
    const abs = path.join(parent, part)
    st.area = bound
    check(st)
    const made = mkdirWithParentBits(abs, Number(parentStat.mode))
    if (!made.ok) throw unsafe(abs, `a backup-area directory is not usable (${made.phase})`)
    if (made.created) {
      trace(st, { op: 'mkdir', path: abs })
      await syncDir(st, parent)
    }
    for (const w of made.warnings) st.warnings.push({ code: 'mode', path: abs, detail: w })
    const s = await lstatOrNull(abs).catch(() => null)
    if (s === null || !s.isDirectory() || !sameIdentity(made.identity, identityOf(s))) {
      throw unsafe(abs, 'a backup-area directory changed while it was bound')
    }
    bound.push({ path: abs, identity: made.identity })
    parent = abs
    parentStat = s
  }
  let real: string
  try {
    real = await fs.promises.realpath(st.areaPath)
  } catch (err) {
    throw unsafe(st.areaPath, `the backup area cannot be resolved (${codeOf(err)})`)
  }
  if (real !== st.areaPath) throw unsafe(st.areaPath, `the backup area resolves to ${real}`)
  st.area = bound
  check(st)
}

/**
 * The backup is always `<area>/<opId>` (owner decision 2026-10-22): the record,
 * the journal and the result all name that one path. If it, its sidecar or the
 * sidecar's temp exists, stop with `backup-unsafe` and touch nothing there.
 * Run before step 5 (a refusal) and again at step 12 (an incomplete publish).
 */
export async function assertBackupNameFree(st: SwapState): Promise<void> {
  if (await taken(st.backupDest)) {
    throw new SwapFault('backup-unsafe', `${st.backupDest} (or its sidecar) already exists`)
  }
}

/**
 * Moves `src` out of OP into the backup area as `kind` (across devices, copies
 * and verifies it, leaving the source in OP). Returns the tree's new path.
 * Throws `SwapFault` (`backup-unsafe`, `write-failed`, `state-root-full`) or
 * `SkillWriteStop` from a `check`.
 */
export async function publishTree(st: SwapState, src: string, kind: PublishKind): Promise<string> {
  if (st.area === null) await ensureBackupArea(st)
  await hook(st, 'beforePublish')
  let dest: string
  if (kind !== 'backup') {
    dest = await destFor(st, kind)
  } else {
    // The backup's name is fixed (owner decision 2026-10-22): taken now means
    // stop, with the record kept and the old folder still in OP.
    await assertBackupNameFree(st)
    dest = st.backupDest
  }
  const h = treeHashOf(src)
  const id = bindIdentity(src)
  if (!id.ok || (!h.ok && !HASH_OPTIONAL.has(kind))) {
    throw new SwapFault('write-failed', `${src} could not be hashed`)
  }
  await hook(st, 'beforeSidecar')
  if (kind === 'backup' && h.ok && h.hash !== st.input.preTree) warnForeignChange(st, dest)
  const sidecar = sidecarOf(st, kind, h, id)
  // A link, not a rename: a rename would silently replace a file that appeared
  // at the sidecar's name after the name was chosen.
  await writeSidecar(st, dest, sidecar, 'afterSidecarTemp')
  await hook(st, 'afterSidecar')
  try {
    await renameChecked(st, src, dest)
    st.published = { src, dest, kind }
  } catch (err) {
    // A failure reported after the rename itself ran (its trace, say) still
    // leaves the tree at `dest`: record that, by identity, so no report says
    // the tree is anywhere else.
    const there = bindIdentity(dest)
    if (there.ok && sameIdentity(id, there)) st.published = { src, dest, kind }
    if (codeOf(err) !== 'EXDEV') throw err
    // Nothing moved: copy, verify, and leave the source in OP (UD28).
    await moveAcross(st, { src, dest, kind, sidecar, srcId: id, record: h.ok ? h.record : null })
    return dest
  }
  await hook(st, 'afterPublishRename')
  await syncDir(st, st.areaPath)
  await hook(st, 'afterPublishAreaSync')
  await syncDir(st, st.opDir)
  await hook(st, 'afterPublishOpSync')
  return dest
}

/**
 * The move of a keep whose sidecar is already published (a P1 resume, UD38):
 * `check`, `rename(src, dest)`, sync the area, then OP, with the same hooks as
 * `publishTree`'s move. `EXDEV` (nothing moved) runs `across`, doctor's
 * cross-device copy (6a-iii); without it, it stops `write-failed`.
 */
export async function moveKept(
  st: SwapState,
  src: string,
  dest: string,
  kind: PublishKind,
  across?: () => Promise<void>
): Promise<void> {
  try {
    await renameChecked(st, src, dest)
  } catch (err) {
    if (codeOf(err) === 'EXDEV') {
      if (across !== undefined) return across()
      throw new SwapFault('write-failed', `${dest} is on another device: not resumed here`, err)
    }
    throw err
  }
  st.published = { src, dest, kind }
  await hook(st, 'afterPublishRename')
  await syncDir(st, st.areaPath)
  await hook(st, 'afterPublishAreaSync')
  await syncDir(st, st.opDir)
  await hook(st, 'afterPublishOpSync')
}
