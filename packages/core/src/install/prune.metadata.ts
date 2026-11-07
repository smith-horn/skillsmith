/**
 * SMI-6531 (A1 step 6c-i): prune's own staging metadata (`intent.json`,
 * `deleting`) is removed only when it is PROVABLY ours (ADR-166 D-11), ported
 * from the SMI-6676 spike's `prune.metadata.mjs`.
 *
 * A name is not proof. A file is removed only if it is the exact bytes and
 * inode that were recorded, either written by this very process, or
 * stable-read and schema-checked when the leftover was inspected and then
 * covered by the user's confirmation, and it is never unlinked by its known
 * name: it is renamed to a random name and re-checked there first
 * (`removeIfIdentical`). On any mismatch the file is kept and the caller
 * reports its exact path.
 *
 * Residual (stated, not closed): one syscall between the final lstat of the
 * random name and its unlink, the R-swap class (ADR-166 D-11), out of model.
 *
 * fs is the DEFAULT export, looked up at call time.
 *
 * @module @skillsmith/core/install/prune.metadata
 */
import fs from 'node:fs'
import type { BigIntStats } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { errCode } from './park-result.js'
import { readStable } from './prune.sidecar.js'
import type { StableRead } from './prune.sidecar.js'
import { PRUNE_DIR_RE, renameNoReplace } from './prune.walk.shared.js'

/**
 * The only names `removeIfIdentical` may remove, and only directly in a
 * `.prune-<16 hex>` staging directory: prune's own intent (and its temp), its
 * `deleting` marker and its approved inventory. User entries, the sidecar
 * included, are deleted only by the walk, against the inventory.
 */
export const REMOVABLE_METADATA: ReadonlySet<string> = new Set([
  'intent.json',
  'intent.json.tmp',
  'deleting',
  'inventory.json',
])
/**
 * One name pattern is removable too (F6): prune's own metadata caught
 * mid-removal under its random `.m-<16 hex>` name, once the listing has proved
 * it parses as that metadata. A `.d-<16 hex>` name is never metadata: it is a
 * user entry the walk renamed, and is kept and reported (R5).
 */
const REMOVABLE_PATTERNS = [/^\.m-[0-9a-f]{16}$/]

/** A name `removeIfIdentical` may remove (inside a `.prune-<16 hex>` directory). */
export const isRemovableMetadata = (name: string): boolean =>
  REMOVABLE_METADATA.has(name) || REMOVABLE_PATTERNS.some((re) => re.test(name))

const HEX16 = /^[0-9a-f]{16}$/
const HASH = /^[0-9a-f]{64}$/
const INTENT_KEYS = [
  'pruneId',
  'copyPath',
  'sidecarPath',
  'leaf',
  'approvedHash',
  'approvedSidecarSha256',
  'class',
  'authorization',
  'createdAt',
  'pid',
  'host',
  'version',
]
/** The intent schema's tag. A leftover with any other tag is not Skillsmith's and is never touched. */
export const INTENT_VERSION = 'skillsmith-prune-intent-1'

/** The intent the walker writes at P4c, exactly. */
export interface PruneIntent {
  pruneId: string
  copyPath: string
  sidecarPath: string | null
  leaf: string
  approvedHash: string
  approvedSidecarSha256: string | null
  class: string
  authorization: string
  createdAt: string
  pid: number
  host: string | null
  version: string
}

/**
 * The `deleting` marker the walker writes after the inventory and before the
 * first delete: the run ID (`pruneId`, as the intent and the inventory carry
 * it) and the inventory's sha256, which bind the inventory to its run.
 */
export interface DeletingMarker {
  pruneId: string
  inventorySha256: string
  pid: number
}

/** What a later removal is checked against: the inode (decimal) and the bytes (base64). */
export interface MetaRecord {
  ino: string
  bytes: string
}

const exactKeys = (o: unknown, keys: readonly string[]): o is Record<string, unknown> =>
  o !== null &&
  typeof o === 'object' &&
  !Array.isArray(o) &&
  Object.keys(o).sort().join('\0') === [...keys].sort().join('\0')

const parse = (bytes: Buffer | string): unknown => {
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch {
    return undefined
  }
}

/** The intent the walker writes at P4c, exactly, or null. */
export function parseIntentStrict(bytes: Buffer | string): PruneIntent | null {
  const o = parse(bytes)
  if (!exactKeys(o, INTENT_KEYS)) return null
  const d = new Date(o.createdAt as string)
  const ok =
    typeof o.pruneId === 'string' &&
    HEX16.test(o.pruneId) &&
    typeof o.copyPath === 'string' &&
    path.isAbsolute(o.copyPath) &&
    (o.sidecarPath === null ||
      (typeof o.sidecarPath === 'string' && path.isAbsolute(o.sidecarPath))) &&
    typeof o.leaf === 'string' &&
    o.leaf.length > 0 &&
    !o.leaf.includes('/') &&
    o.leaf !== '.' &&
    o.leaf !== '..' &&
    typeof o.approvedHash === 'string' &&
    HASH.test(o.approvedHash) &&
    (o.approvedSidecarSha256 === null ||
      (typeof o.approvedSidecarSha256 === 'string' && HASH.test(o.approvedSidecarSha256))) &&
    typeof o.class === 'string' &&
    typeof o.authorization === 'string' &&
    typeof o.createdAt === 'string' &&
    !Number.isNaN(d.getTime()) &&
    d.toISOString() === o.createdAt &&
    Number.isSafeInteger(o.pid) &&
    (o.host === null || typeof o.host === 'string') &&
    o.version === INTENT_VERSION
  return ok ? (o as unknown as PruneIntent) : null
}

/** The `deleting` marker the walker writes, exactly, or null. */
export function parseDeletingStrict(bytes: Buffer | string): DeletingMarker | null {
  const o = parse(bytes)
  if (!exactKeys(o, ['pruneId', 'inventorySha256', 'pid'])) return null
  return typeof o.pruneId === 'string' &&
    HEX16.test(o.pruneId) &&
    typeof o.inventorySha256 === 'string' &&
    HASH.test(o.inventorySha256) &&
    Number.isSafeInteger(o.pid)
    ? (o as unknown as DeletingMarker)
    : null
}

/**
 * Why a leftover's intent, `deleting` marker and inventory are not one run's,
 * or null (owner decision 2026-11-07). A resume is offered and accepted only
 * when all three exist and agree: the same run ID, the marker's digest equal
 * to the inventory's actual digest, and the intent naming the inventory's
 * leaf. This catches a stale, mixed or replaced inventory; a deliberate
 * same-user forgery of all three is a stated residual (ADR-166 D-0).
 */
export function runBindingProblem(b: {
  intent: PruneIntent | null
  marker: DeletingMarker | null
  inv: { pruneId: string; leaf: string }
  digest: string
}): string | null {
  if (b.intent === null) return 'no intent: the run cannot be identified'
  if (b.marker === null) return 'no deleting marker: the delete never started'
  if (b.intent.pruneId !== b.inv.pruneId || b.marker.pruneId !== b.inv.pruneId) {
    return 'the intent, the deleting marker and the inventory are not from one run'
  }
  if (b.marker.inventorySha256 !== b.digest) {
    return 'the inventory is not the one its deleting marker recorded'
  }
  if (b.intent.leaf !== b.inv.leaf || path.basename(b.intent.copyPath) !== b.inv.leaf) {
    return "the intent does not name the inventory's leaf"
  }
  return null
}

/** The record a later removal is checked against. */
export function recordOf(p: string, bytes: Buffer | string): MetaRecord {
  const st = fs.lstatSync(p, { bigint: true })
  return { ino: String(st.ino), bytes: Buffer.from(bytes).toString('base64') }
}

/** Is the stable read `rs` exactly the recorded `expect` (inode and bytes)? */
const matches = (rs: StableRead, expect: MetaRecord): boolean =>
  rs.ok && String(rs.ino) === expect.ino && rs.bytes.equals(Buffer.from(expect.bytes, 'base64'))

export type RemoveResult = { removed: true } | { removed: false; kept: string | null }

/**
 * Removes `p` only if it is exactly `expect`, with the walk's own discipline:
 * the known name is never unlinked.
 *  1. pre-check at the known name (stable read: inode and bytes); a mismatch
 *     leaves the file untouched where it is;
 *  2. rename it to a fresh random `.m-<16 hex>` name in the same directory;
 *  3. re-check inode and bytes AT THE RANDOM NAME, and an lstat immediately
 *     before unlink (inode, size, mtime, ctime as just read);
 *  4. unlink the random name.
 * A swap at the known name after step 1 is caught in step 3: the replacement
 * is kept under its random name and reported by that exact path. What remains
 * is one syscall between step 3's lstat and the unlink of a random name, the
 * R-swap class (ADR-166 D-11), out of model.
 *
 * `kept` is null when the file is absent, and otherwise names its exact
 * current path and why it was kept. A path that is not one of
 * `isRemovableMetadata`'s names directly in a `.prune-<16 hex>` directory is a
 * TypeError: this is not a general delete.
 */
export function removeIfIdentical(p: string, expect: MetaRecord | undefined): RemoveResult {
  if (
    !isRemovableMetadata(path.basename(p)) ||
    !PRUNE_DIR_RE.test(path.basename(path.dirname(p)))
  ) {
    throw new TypeError(
      `removeIfIdentical removes only prune's own metadata directly in a .prune-<16 hex> directory, not ${p}`
    )
  }
  const keep = (at: string, why: string): RemoveResult => ({
    removed: false,
    kept: `${at}: ${why}`,
  })
  try {
    fs.lstatSync(p, { bigint: true })
  } catch (err) {
    if (errCode(err) === 'ENOENT') return { removed: false, kept: null }
    return keep(p, `unreadable (${errCode(err)})`)
  }
  if (!expect) return keep(p, 'not written or inspected by this run')
  const pre = readStable(p)
  if (!pre.ok) return keep(p, pre.reason)
  if (!matches(pre, expect)) return keep(p, 'not the inode and bytes recorded')
  const r = path.join(path.dirname(p), `.m-${crypto.randomBytes(8).toString('hex')}`)
  try {
    renameNoReplace(p, r)
  } catch (err) {
    return keep(p, `rename to a random name failed (${errCode(err)})`)
  }
  const post = readStable(r)
  if (!post.ok || !matches(post, expect)) {
    return keep(r, `renamed from ${path.basename(p)}, but not the inode and bytes recorded`)
  }
  let now: BigIntStats
  try {
    now = fs.lstatSync(r, { bigint: true })
  } catch (err) {
    return { removed: false, kept: `${r}: vanished before removal (${errCode(err)})` }
  }
  if (
    now.ino !== post.ino ||
    now.size !== post.size ||
    now.mtimeNs !== post.mtimeNs ||
    now.ctimeNs !== post.ctimeNs
  ) {
    return keep(r, 'changed immediately before removal')
  }
  try {
    fs.unlinkSync(r)
  } catch (err) {
    return keep(r, `unlink failed (${errCode(err)})`)
  }
  return { removed: true }
}
