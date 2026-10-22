/**
 * SMI-6531 (A1 step 4a): the backup area, `publishTree` on one device, and
 * the op dir's final step (A1 plan §3.3 steps 12-13, "`publishTree`"; §3.5).
 *
 * `publishTree(src, kind)` is the single keep path: the only way a tree
 * leaves OP. Its sidecar is published before the tree moves, so no crash
 * leaves a kept tree without one. On one device the move is a `rename`.
 *
 * The backup's name is fixed, `<area>/<opId>` (owner decision 2026-10-22), so
 * `record.json`, the journal's `backup_ref` and the result name one path. A
 * name already taken stops the run (before rename 1 a refusal, at step 12 an
 * incomplete publish); nothing at that name is touched. Other kinds take
 * `<opId>.<kind>` with a `.<k>` suffix. The sidecar is linked into place (never
 * renamed over an entry), and its temp is unlinked only after verifying it is
 * the file this run wrote (`unlinkOwned`).
 *
 * Residual (the ADR-155 empty-directory class): the backup move itself is a
 * plain `rename(src, dest)`. An empty directory another process creates at
 * `dest` after `assertBackupNameFree` and before that `rename` is replaced by
 * it silently (`rename` over an empty directory succeeds; over a non-empty one
 * it fails `ENOTEMPTY`, which stops the run). Nothing is lost but that empty
 * directory. Node has no `renameat2(RENAME_NOREPLACE)`.
 *
 * Not here yet:
 *  - Cross-device (SMI-6531 step 4c): an `EXDEV` from the move stops with
 *    `cross-device`; the record stays and the tree stays in OP. 4c copies,
 *    verifies and parks instead.
 *  - Step 13's park call and park intent (step 4c; abort cleanup's are 4b's,
 *    `skill-swap.abort.ts`): on one device OP is empty at step 13, so step 13
 *    unlinks the metadata and `rmdir`s OP. An OP holding anything else stops
 *    with nothing removed (`op-not-empty`); 4c replaces that stop with the park.
 *
 * The backup area is `<stateRoot>/backups/update/<client>/<rootKey>/<dirName>/`
 * under the native realpath of the state root, so a symlinked state root
 * (a HOME behind a link) is resolved once, and a symlink planted at any
 * component below it fails the area (`backup-unsafe`).
 *
 * @module @skillsmith/core/services/skill-swap.publish
 */
import crypto from 'node:crypto'
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
  linkChecked,
  lstatOrNull,
  opPaths,
  renameChecked,
  rmdirChecked,
  SwapFault,
  syncDir,
  trace,
  unlinkOwned,
  writeNewFile,
} from './skill-swap.ops.js'
import type { SwapState } from './skill-swap.ops.js'
import { recordIdentity } from './skill-swap.staging.js'
import { OWNER_FILE, RECORD_FILE } from './skill-swap.types.js'

/**
 * A kept tree's kind (plan §3.5): 4a's three, and abort cleanup's three (4b).
 * `failed-build` and `unrecorded-new` are kept even when the tree cannot be
 * hashed (the sidecar's `treeHash` is then null, with `treeHashError`): that
 * is why they are kept rather than parked. Every other kind needs the hash.
 */
export type PublishKind =
  | 'backup'
  | 'undone'
  | 'conflict'
  | 'failed-build'
  | 'edited-new'
  | 'unrecorded-new'

const HASH_OPTIONAL: ReadonlySet<PublishKind> = new Set(['failed-build', 'unrecorded-new'])

/** First 16 hex characters of sha256 over R, the skills root's realpath (UD22). */
export const rootKeyOf = (root: string): string =>
  crypto.createHash('sha256').update(root).digest('hex').slice(0, 16)

/** One path component: not empty, not `.`/`..`, no separator or NUL. */
const oneComponent = (s: string): boolean =>
  s !== '' && s !== '.' && s !== '..' && !s.includes('/') && !s.includes('\\') && !s.includes('\0')

export function backupAreaPath(
  stateRootReal: string,
  client: string,
  root: string,
  dirName: string
): string {
  return path.join(stateRootReal, 'backups', 'update', client, rootKeyOf(root), dirName)
}

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

/** An entry exists at `p`. A missing or non-directory ancestor (the area not made yet) is not one. */
async function present(p: string): Promise<boolean> {
  try {
    return (await lstatOrNull(p)) !== null
  } catch (err) {
    if (codeOf(err) === 'ENOTDIR') return false
    throw err
  }
}

/** A name is taken when the tree, its sidecar or its sidecar temp exists. */
async function taken(p: string): Promise<boolean> {
  return (await present(p)) || (await present(`${p}.json`)) || (await present(`${p}.json.tmp`))
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

/** A kept tree other than the backup: `<area>/<opId>.<kind>`, with a `.<k>` suffix when taken. */
async function destFor(st: SwapState, kind: Exclude<PublishKind, 'backup'>): Promise<string> {
  const base = `${st.opId}.${kind}`
  let dest = path.join(st.areaPath, base)
  for (let k = 1; await taken(dest); k++) dest = path.join(st.areaPath, `${base}.${k}`)
  return dest
}

/** Adds `backup-holds-foreign-change` once per update, naming the backup's (final) path. */
export function warnForeignChange(st: SwapState, backup: string): void {
  const w = st.warnings.find((x) => x.code === 'backup-holds-foreign-change')
  if (w === undefined) st.warnings.push({ code: 'backup-holds-foreign-change', backup })
  else if (w.code === 'backup-holds-foreign-change') w.backup = backup
}

/**
 * Moves `src` out of OP into the backup area as `kind` (same device). Returns
 * the tree's new path. Throws `SwapFault` (`backup-unsafe`, `write-failed`,
 * `cross-device`) or `SkillWriteStop` from a `check`.
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
  const sidecar = {
    opId: st.opId,
    kind,
    dirName: st.input.dirName,
    createdAt: new Date().toISOString(),
    treeHash: h.ok ? h.hash : null,
    ...(h.ok ? {} : { treeHashError: `${h.reason} at ${h.path}` }),
    identity: recordIdentity(id),
    client: st.input.client,
    skillsDir: st.binding.root,
    scope: st.input.scope,
    manifestKey: st.input.manifestKey,
  }
  const tmp = `${dest}.json.tmp`
  await writeNewFile(st, tmp, Buffer.from(JSON.stringify(sidecar, null, 2) + '\n'), 0o600)
  // A link, not a rename: a rename would silently replace a file that appeared
  // at the sidecar's name after the name was chosen.
  try {
    await linkChecked(st, tmp, `${dest}.json`)
  } catch (err) {
    if (codeOf(err) === 'EEXIST') {
      throw new SwapFault('backup-unsafe', `${dest}.json appeared after the name was chosen`)
    }
    throw err
  }
  await unlinkOwned(st, tmp, 'backup-unsafe')
  await syncDir(st, st.areaPath)
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
    if (codeOf(err) === 'EXDEV') {
      // SMI-6531 step 4c replaces this stop with the verified cross-device copy.
      throw new SwapFault('cross-device', `the state root is on another device than ${src}`)
    }
    throw err
  }
  await syncDir(st, st.areaPath)
  await syncDir(st, st.opDir)
  return dest
}

/**
 * Step 13 on one device: unlink `record.json` (sync OP), unlink `owner.json`,
 * `rmdir` OP (sync ST). OP holding anything else stops first, with nothing
 * removed (`op-not-empty`); SMI-6531 step 4c parks OP whole there instead.
 */
export async function finishOp(st: SwapState): Promise<void> {
  check(st)
  const meta = new Set([RECORD_FILE, OWNER_FILE])
  const extra = (await fs.promises.readdir(st.opDir)).filter((n) => !meta.has(n)).sort()
  if (extra.length > 0) {
    throw new SwapFault('op-not-empty', `${st.opDir} still holds ${extra.join(', ')}`)
  }
  const { record, owner } = opPaths(st)
  await unlinkOwned(st, record, 'staging-unsafe')
  st.recordRemoved = true
  await syncDir(st, st.opDir)
  await unlinkOwned(st, owner, 'staging-unsafe')
  const left = await fs.promises.readdir(st.opDir)
  if (left.length > 0) {
    throw new SwapFault('op-not-empty', `${st.opDir} gained ${left.sort().join(', ')}`)
  }
  await rmdirChecked(st, st.opDir)
  await syncDir(st, st.binding.stagingDir)
}
