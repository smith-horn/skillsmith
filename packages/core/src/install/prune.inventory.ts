/**
 * SMI-6531 (A1 step 6c-i, F1 re-derived; owner decision 2026-11-06): prune
 * deletes only approved entries. After the first run verifies the staged copy,
 * and before anything is deleted, the walker writes the approved inventory to
 * `S/inventory.json`, durably, once. No run ever rewrites it, and every delete
 * on any run must match one of its rows. A swapped-in, moved-in or recreated
 * entry matches no row and is kept wherever it sits; nothing depends on a
 * record of what not to delete.
 *
 * This module holds the schema (with the staging directory's own record),
 * the write protocol, the strict read and the digest; the matcher and the
 * listing's one-to-one diff are in `prune.inventory.match.ts`. It never
 * deletes anything.
 *
 * fs is the DEFAULT export, looked up at call time.
 *
 * @module @skillsmith/core/install/prune.inventory
 */
import fs from 'node:fs'
import type { BigIntStats } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { errCode } from './park-result.js'
import { S_IFMT } from './park-tree.perms.js'
import type { MetaRecord } from './prune.metadata.js'
import { readStable } from './prune.sidecar.js'
import { SIDECAR_KEY, renameNoReplace } from './prune.walk.shared.js'
import type { Inventory as VerifiedMap } from './prune.walk.shared.js'

export const INVENTORY_VERSION = 'skillsmith-prune-inventory-1'
export const INVENTORY_FILE = 'inventory.json'
export const INVENTORY_TMP = 'inventory.json.tmp'
/** The parent of the staged root and of the sidecar: the staging directory S. A NUL is never in a name. */
export const STAGING_KEY = '\0staging'
/** The cap: the walker reads the whole inventory into memory; 100,000 rows is ~6x the largest real skill measured. */
export const MAX_ROWS = 100_000
export const MAX_BYTES = 32 * 1024 * 1024
export const D_NAME_RE = /^\.d-[0-9a-f]{16}$/
const HASH = /^[0-9a-f]{64}$/
const DECIMAL = /^-?[0-9]+$/

/** The staging directory's identity and trust facts, as `stagingProblem` checks them. */
export interface StagingRecord {
  dev: bigint
  ino: bigint
  birthtimeNs: bigint
  fmt: bigint
  mode: bigint
  uid: bigint
}

export type RowType = 'dir' | 'file' | 'symlink'

/** One approved entry. */
export interface ApprovedRow {
  rel: string
  parent: string
  type: RowType
  dev: bigint
  ino: bigint
  birthtimeNs: bigint
  fmt: bigint
  mode: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
  sha256?: string
  linkText?: string
}

export interface PruneInventory {
  pruneId: string
  leaf: string
  treeHash: string
  staging: StagingRecord
  rows: ApprovedRow[]
}

const parentOf = (rel: string): string =>
  rel === '' || rel === SIDECAR_KEY
    ? STAGING_KEY
    : rel.includes('/')
      ? rel.slice(0, rel.lastIndexOf('/'))
      : ''

/** The inventory of what verification measured (`verifyAtStaging`'s map). */
export function buildInventory(a: {
  pruneId: string
  leaf: string
  treeHash: string
  staging: BigIntStats
  verified: VerifiedMap
}): PruneInventory {
  const rows: ApprovedRow[] = []
  for (const [rel, r] of a.verified) {
    if (r.type === 'other' || r.birthtimeNs === null) {
      throw new TypeError(`buildInventory: ${rel || '.'} is not an approvable entry`)
    }
    rows.push({
      rel,
      parent: parentOf(rel),
      type: r.type,
      dev: r.dev,
      ino: r.ino,
      birthtimeNs: r.birthtimeNs,
      fmt: r.mode & S_IFMT,
      mode: r.mode,
      size: r.size,
      mtimeNs: r.mtimeNs,
      ctimeNs: r.ctimeNs,
      ...(r.sha256 !== undefined ? { sha256: r.sha256 } : {}),
      ...(r.linkText !== undefined ? { linkText: r.linkText } : {}),
    })
  }
  const st = a.staging
  return {
    pruneId: a.pruneId,
    leaf: a.leaf,
    treeHash: a.treeHash,
    staging: {
      dev: st.dev,
      ino: st.ino,
      birthtimeNs: st.birthtimeNs,
      fmt: st.mode & S_IFMT,
      mode: st.mode,
      uid: st.uid,
    },
    rows,
  }
}

/** The exact bytes written: one JSON object, bigints as decimal strings. */
export function serializeInventory(inv: PruneInventory): Buffer {
  const big = (_k: string, v: unknown): unknown => (typeof v === 'bigint' ? String(v) : v)
  return Buffer.from(
    JSON.stringify(
      {
        version: INVENTORY_VERSION,
        pruneId: inv.pruneId,
        leaf: inv.leaf,
        treeHash: inv.treeHash,
        staging: inv.staging,
        rowCount: inv.rows.length,
        rows: inv.rows,
      },
      big
    )
  )
}

export const sha256Of = (b: Buffer): string => crypto.createHash('sha256').update(b).digest('hex')

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(o).sort().join('\0') === [...keys].sort().join('\0')
const bigOf = (v: unknown): bigint | null =>
  typeof v === 'string' && DECIMAL.test(v) ? BigInt(v) : null
const ID_KEYS = ['dev', 'ino', 'birthtimeNs', 'fmt', 'mode', 'size', 'mtimeNs', 'ctimeNs'] as const
const ROW_BASE = ['rel', 'parent', 'type', ...ID_KEYS]

function parseRow(v: unknown): ApprovedRow | null {
  if (!isObj(v) || typeof v.rel !== 'string' || typeof v.parent !== 'string') return null
  const t = v.type
  const extra = t === 'file' ? ['sha256'] : t === 'symlink' ? ['linkText'] : t === 'dir' ? [] : null
  if (extra === null || !exactKeys(v, [...ROW_BASE, ...extra])) return null
  const nums = ID_KEYS.map((k) => bigOf(v[k]))
  if (nums.some((n) => n === null)) return null
  const [dev, ino, birthtimeNs, fmt, mode, size, mtimeNs, ctimeNs] = nums as bigint[]
  if ((mode! & S_IFMT) !== fmt) return null
  if (t === 'file' && !(typeof v.sha256 === 'string' && HASH.test(v.sha256))) return null
  if (t === 'symlink' && typeof v.linkText !== 'string') return null
  return {
    rel: v.rel,
    parent: v.parent,
    type: t as RowType,
    dev: dev!,
    ino: ino!,
    birthtimeNs: birthtimeNs!,
    fmt: fmt!,
    mode: mode!,
    size: size!,
    mtimeNs: mtimeNs!,
    ctimeNs: ctimeNs!,
    ...(t === 'file' ? { sha256: v.sha256 as string } : {}),
    ...(t === 'symlink' ? { linkText: v.linkText as string } : {}),
  }
}

/** The strict schema: exact keys, typed fields, unique rels, and a consistent parent tree (R1). */
export function parseInventoryStrict(bytes: Buffer): PruneInventory | null {
  let o: unknown
  try {
    o = JSON.parse(bytes.toString('utf8'))
  } catch {
    return null
  }
  const top = ['version', 'pruneId', 'leaf', 'treeHash', 'staging', 'rowCount', 'rows']
  if (!isObj(o) || !exactKeys(o, top) || o.version !== INVENTORY_VERSION) return null
  if (typeof o.pruneId !== 'string' || !/^[0-9a-f]{16}$/.test(o.pruneId)) return null
  if (typeof o.leaf !== 'string' || o.leaf === '' || o.leaf.includes('/')) return null
  if (typeof o.treeHash !== 'string' || !HASH.test(o.treeHash)) return null
  const sk = ['dev', 'ino', 'birthtimeNs', 'fmt', 'mode', 'uid']
  if (!isObj(o.staging) || !exactKeys(o.staging, sk)) return null
  const sv = sk.map((k) => bigOf((o.staging as Record<string, unknown>)[k]))
  if (sv.some((n) => n === null)) return null
  if (!Array.isArray(o.rows) || o.rows.length !== o.rowCount || o.rows.length > MAX_ROWS)
    return null
  const rows: ApprovedRow[] = []
  for (const raw of o.rows) {
    const r = parseRow(raw)
    if (r === null) return null
    rows.push(r)
  }
  const byRel = new Map(rows.map((r) => [r.rel, r]))
  if (byRel.size !== rows.length) return null
  const root = byRel.get('')
  if (root === undefined || root.parent !== STAGING_KEY) return null
  for (const r of rows) {
    if (r.rel === '' || r.rel === SIDECAR_KEY) {
      if (r.parent !== STAGING_KEY || (r.rel === SIDECAR_KEY && r.type !== 'file')) return null
      continue
    }
    const p = byRel.get(r.parent)
    const name = r.parent === '' ? r.rel : r.rel.slice(r.parent.length + 1)
    const relOk = r.parent === '' ? !r.rel.includes('/') : r.rel === `${r.parent}/${name}`
    if (p === undefined || p.type !== 'dir' || !relOk || name === '' || name.includes('/'))
      return null
  }
  const [dev, ino, birthtimeNs, fmt, mode, uid] = sv as bigint[]
  return {
    pruneId: o.pruneId,
    leaf: o.leaf,
    treeHash: o.treeHash,
    staging: { dev: dev!, ino: ino!, birthtimeNs: birthtimeNs!, fmt: fmt!, mode: mode!, uid: uid! },
    rows,
  }
}

const DIR_SYNC_UNSUPPORTED = new Set(['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR', 'ENOSYS'])

export type WriteStep = 'too-large' | 'open' | 'write' | 'fsync' | 'close' | 'rename' | 'dir-fsync'
export type InventoryWrite =
  | { ok: true; record: MetaRecord; digest: string }
  | { ok: false; step: WriteStep; errno: string | null }

/**
 * Writes `S/inventory.json` (R3): exclusive open of the temp, a complete-write
 * loop, fsync, close, a no-replace rename, then an fsync of `S`. Any failure
 * returns `ok: false` and the caller deletes nothing. A failure of the last
 * step (`dir-fsync`) leaves a complete `inventory.json` that a later listing
 * may accept after a strict read and a digest match (R4).
 */
export function writeInventory(S: string, inv: PruneInventory): InventoryWrite {
  const bytes = serializeInventory(inv)
  if (bytes.length > MAX_BYTES || inv.rows.length > MAX_ROWS) {
    return { ok: false, step: 'too-large', errno: null }
  }
  const tmp = path.join(S, INVENTORY_TMP)
  const c = fs.constants
  let fd: number
  try {
    fd = fs.openSync(tmp, c.O_WRONLY | c.O_CREAT | c.O_EXCL | c.O_NOFOLLOW, 0o600)
  } catch (err) {
    return { ok: false, step: 'open', errno: errCode(err) }
  }
  let step: WriteStep = 'write'
  let ino: bigint
  try {
    for (let off = 0; off < bytes.length; ) {
      const n = fs.writeSync(fd, bytes, off, bytes.length - off)
      if (n <= 0) throw Object.assign(new Error('a write made no progress'), { code: 'EIO' })
      off += n
    }
    step = 'fsync'
    fs.fsyncSync(fd)
    ino = fs.fstatSync(fd, { bigint: true }).ino
  } catch (err) {
    try {
      fs.closeSync(fd)
    } catch {
      /* the failure already reported stands */
    }
    return { ok: false, step, errno: errCode(err) }
  }
  try {
    fs.closeSync(fd)
  } catch (err) {
    return { ok: false, step: 'close', errno: errCode(err) }
  }
  try {
    renameNoReplace(tmp, path.join(S, INVENTORY_FILE))
  } catch (err) {
    return { ok: false, step: 'rename', errno: errCode(err) }
  }
  const dirErr = fsyncDir(S)
  if (dirErr !== null) return { ok: false, step: 'dir-fsync', errno: dirErr }
  return {
    ok: true,
    record: { ino: String(ino), bytes: bytes.toString('base64') },
    digest: sha256Of(bytes),
  }
}

function fsyncDir(dir: string): string | null {
  if (process.platform === 'win32') return null
  let fd: number
  try {
    fd = fs.openSync(dir, 'r')
  } catch (err) {
    const code = errCode(err)
    return code !== null && DIR_SYNC_UNSUPPORTED.has(code) ? null : (code ?? 'EIO')
  }
  try {
    fs.fsyncSync(fd)
    return null
  } catch (err) {
    const code = errCode(err)
    return code !== null && DIR_SYNC_UNSUPPORTED.has(code) ? null : (code ?? 'EIO')
  } finally {
    try {
      fs.closeSync(fd)
    } catch {
      /* the sync's own outcome stands */
    }
  }
}

export type InventoryLoad =
  | { ok: true; inv: PruneInventory; record: MetaRecord; digest: string }
  | { ok: false; why: string }

/** Reads `S/inventory.json`: stable, no-follow, capped, then strictly parsed. */
export function loadInventory(S: string): InventoryLoad {
  const rs = readStable(path.join(S, INVENTORY_FILE), { maxBytes: MAX_BYTES })
  if (!rs.ok) return { ok: false, why: `inventory ${rs.reason}` }
  const inv = parseInventoryStrict(rs.bytes)
  if (inv === null) return { ok: false, why: "inventory.json is not Skillsmith's inventory schema" }
  return {
    ok: true,
    inv,
    record: { ino: String(rs.ino), bytes: rs.bytes.toString('base64') },
    digest: sha256Of(rs.bytes),
  }
}

/** `S` is still the staging directory the inventory recorded. */
export const stagingMatches = (rec: StagingRecord, s: BigIntStats): boolean =>
  rec.dev === s.dev &&
  rec.ino === s.ino &&
  rec.birthtimeNs === s.birthtimeNs &&
  rec.fmt === (s.mode & S_IFMT) &&
  rec.mode === s.mode &&
  rec.uid === s.uid
