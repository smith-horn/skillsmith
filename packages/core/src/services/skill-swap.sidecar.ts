/**
 * SMI-6531 (A1 steps 4a, 4c): a kept tree's names and sidecar in the backup
 * area (A1 plan §3.3 "`publishTree`" names, "Metadata publish"; §3.5), shared
 * by the one-device move (`skill-swap.publish.ts`) and the cross-device copy
 * (`skill-swap.xdev.ts`).
 *
 * A sidecar is written to `<dest>.json.tmp`, synced, `link`ed to
 * `<dest>.json` (never renamed over an entry: an entry planted at the final
 * name is refused with `EEXIST`), the temp unlinked after a check that it is
 * the file this run wrote (`unlinkOwned`), then the area synced.
 *
 * @module @skillsmith/core/services/skill-swap.sidecar
 */
import crypto from 'node:crypto'
import path from 'node:path'
import type { BoundIdentity } from '../install/park-tree.identity.js'
import type { TreeHashResult } from './skill-tree.js'
import {
  codeOf,
  hook,
  linkChecked,
  lstatOrNull,
  SwapFault,
  syncDir,
  unlinkOwned,
  writeNewFile,
} from './skill-swap.ops.js'
import type { SwapState } from './skill-swap.ops.js'
import { recordIdentity } from './skill-swap.staging.js'
import type { RecordIdentity, SwapHookPoint } from './skill-swap.types.js'

/**
 * A kept tree's kind (plan §3.5): 4a's three, abort cleanup's three (4b), and
 * `partial-copy` (4c: a cross-device copy temp that did not verify).
 * `failed-build`, `unrecorded-new` and `partial-copy` are kept even when the
 * tree cannot be hashed (the sidecar's `treeHash` is then null, with
 * `treeHashError`). Every other kind needs the hash.
 */
export type PublishKind =
  | 'backup'
  | 'undone'
  | 'conflict'
  | 'failed-build'
  | 'edited-new'
  | 'unrecorded-new'
  | 'partial-copy'

/** A sidecar, in its fixed key order. */
export interface Sidecar {
  opId: string
  kind: PublishKind
  dirName: string
  createdAt: string
  treeHash: string | null
  treeHashError?: string
  identity: RecordIdentity
  client: string
  skillsDir: string
  scope: string
  manifestKey: string
  /** `partial-copy` only: the copy's source still hashed to its own sidecar's `treeHash`. */
  sourceUnchanged?: boolean
  /**
   * `partial-copy` only (round 2): why the copy was kept. `enospc` (the device
   * filled, `ENOSPC` or `EDQUOT`) blocks every later cross-device copy into the
   * area until it is pruned (`skill-swap.space.ts`); `mismatch` (the source
   * changed while it was copied) and `copy-failed` (any other copy error) do
   * not.
   */
  partialCause?: PartialCause
}

export type PartialCause = 'enospc' | 'mismatch' | 'copy-failed'

/** First 16 hex characters of sha256 over R, the skills root's realpath (UD22). */
export const rootKeyOf = (root: string): string =>
  crypto.createHash('sha256').update(root).digest('hex').slice(0, 16)

/** The sidecar of a tree kept as `kind`, hashed as `h`, with `id`. */
export function sidecarOf(
  st: SwapState,
  kind: PublishKind,
  h: TreeHashResult,
  id: BoundIdentity,
  extra: Pick<Sidecar, 'sourceUnchanged' | 'partialCause'> = {}
): Sidecar {
  return {
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
    ...extra,
  }
}

const bytesOf = (s: Sidecar): Buffer => Buffer.from(JSON.stringify(s, null, 2) + '\n')

/** An entry exists at `p`. A missing or non-directory ancestor (the area not made yet) is not one. */
export async function present(p: string): Promise<boolean> {
  try {
    return (await lstatOrNull(p)) !== null
  } catch (err) {
    if (codeOf(err) === 'ENOTDIR') return false
    throw err
  }
}

/** A name is taken when the tree, its sidecar or its sidecar temp exists. */
export async function taken(p: string): Promise<boolean> {
  return (await present(p)) || (await present(`${p}.json`)) || (await present(`${p}.json.tmp`))
}

/** A kept tree other than the backup: `<area>/<opId>.<kind>`, with a `.<k>` suffix when taken. */
export async function destFor(
  st: SwapState,
  kind: Exclude<PublishKind, 'backup'>
): Promise<string> {
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

/** Links the synced temp at `final`; an entry already there is `backup-unsafe`, untouched. */
async function linkSidecar(st: SwapState, tmp: string, final: string): Promise<void> {
  try {
    await linkChecked(st, tmp, final)
  } catch (err) {
    if (codeOf(err) === 'EEXIST') {
      throw new SwapFault('backup-unsafe', `${final} appeared after the name was chosen`)
    }
    throw err
  }
}

/** Publishes `<dest>.json` (metadata publish). `afterTemp` runs once the temp is synced. */
export async function writeSidecar(
  st: SwapState,
  dest: string,
  body: Sidecar,
  afterTemp?: SwapHookPoint
): Promise<void> {
  const tmp = `${dest}.json.tmp`
  await writeNewFile(st, tmp, bytesOf(body), 0o600)
  if (afterTemp !== undefined) await hook(st, afterTemp)
  await linkSidecar(st, tmp, `${dest}.json`)
  await unlinkOwned(st, tmp, 'backup-unsafe')
  await syncDir(st, st.areaPath)
}

/**
 * Replaces this run's own `<dest>.json` with `body` (plan §3.3 `publishTree`
 * step 4, a source that changed after the sidecar was hashed): the new
 * sidecar's temp is written and synced, and the area synced so the temp's
 * entry is durable, before the old sidecar is unlinked (only once verified to
 * be the file this run linked there); then the temp is linked at the final
 * name (an entry planted there meanwhile is refused) and the area synced, so
 * the new sidecar is durable before its temp goes; then the temp is unlinked
 * and the area synced again. An unsynced change in one directory may reach
 * disk without an earlier one (T-P5's model): without the first sync the old
 * sidecar's removal could persist without the temp, and without the second
 * the temp's removal could persist without the link. A kill, or a power loss,
 * between the old sidecar's unlink and the link leaves the new sidecar as
 * `<dest>.json.tmp` (hook `afterSidecarUnlink`), never neither.
 */
export async function rewriteSidecar(st: SwapState, dest: string, body: Sidecar): Promise<void> {
  const tmp = `${dest}.json.tmp`
  await writeNewFile(st, tmp, bytesOf(body), 0o600)
  await syncDir(st, st.areaPath)
  await unlinkOwned(st, `${dest}.json`, 'backup-unsafe')
  await hook(st, 'afterSidecarUnlink')
  await linkSidecar(st, tmp, `${dest}.json`)
  await syncDir(st, st.areaPath)
  await unlinkOwned(st, tmp, 'backup-unsafe')
  await syncDir(st, st.areaPath)
}
