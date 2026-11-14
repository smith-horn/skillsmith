/**
 * SMI-6531 (A1 step 6c-i, F1 re-derived): the matcher that decides whether an
 * entry is an approved row of the inventory (`prune.inventory.ts`), shared by
 * the walker's deletes and the listing's diff, split out for the file-length
 * limit. A row matches at most one entry per run (`consumed`); a `.d-` name is
 * matched by identity only where a crashed run may have left it, and an
 * ambiguous match is unapproved (R5). Read-only; nothing here deletes.
 *
 * fs is the DEFAULT export, looked up at call time.
 *
 * @module @skillsmith/core/install/prune.inventory.match
 */
import fs from 'node:fs'
import type { BigIntStats } from 'node:fs'
import path from 'node:path'
import { errCode } from './park-result.js'
import { S_IFMT } from './park-tree.perms.js'
import {
  D_NAME_RE,
  INVENTORY_FILE,
  INVENTORY_TMP,
  STAGING_KEY,
  sha256Of,
} from './prune.inventory.js'
import type { ApprovedRow, PruneInventory } from './prune.inventory.js'
import { readStable } from './prune.sidecar.js'
import { SIDECAR_KEY, typeOf } from './prune.walk.shared.js'

/** Where an entry was found: at its inventory name, or at a `.d-` name a crashed run gave it. */
export type FoundAt = 'original' | 'random'
export type Located = { row: ApprovedRow; at: FoundAt } | { row: null; why: string }

/**
 * The approved rows, indexed for the walk and the listing, with the
 * one-to-one `consumed` set: a row matches at most one entry per run (UD69).
 */
export class Approved {
  readonly inv: PruneInventory
  private readonly byRel: Map<string, ApprovedRow>
  private readonly byId = new Map<string, ApprovedRow[]>()
  private readonly consumed = new Set<string>()
  constructor(inv: PruneInventory) {
    this.inv = inv
    this.byRel = new Map(inv.rows.map((r) => [r.rel, r]))
    for (const r of inv.rows) {
      const k = `${r.dev}:${r.ino}`
      this.byId.set(k, [...(this.byId.get(k) ?? []), r])
    }
  }
  row(rel: string): ApprovedRow | undefined {
    return this.byRel.get(rel)
  }
  consume(row: ApprovedRow): void {
    this.consumed.add(row.rel)
  }
  /**
   * The row for entry `name` in directory `parentRel` (or `STAGING_KEY` for
   * S). By name first; a `.d-` name, only when `byIdentity` (a resume, or the
   * listing), by identity among this parent's unconsumed rows, where more than
   * one candidate is ambiguous and so unapproved (R5).
   */
  locate(parentRel: string, name: string, s: BigIntStats, byIdentity: boolean): Located {
    const rel =
      parentRel === STAGING_KEY
        ? name === this.inv.leaf
          ? ''
          : name === 'sidecar.json'
            ? SIDECAR_KEY
            : null
        : parentRel === ''
          ? name
          : `${parentRel}/${name}`
    const byName = rel === null ? undefined : this.byRel.get(rel)
    if (byName !== undefined && byName.parent === parentRel) {
      return this.consumed.has(byName.rel)
        ? { row: null, why: 'its approved row was already matched' }
        : { row: byName, at: 'original' }
    }
    if (!byIdentity || !D_NAME_RE.test(name))
      return { row: null, why: 'not in the approved inventory' }
    const cands = (this.byId.get(`${s.dev}:${s.ino}`) ?? []).filter(
      (r) => r.parent === parentRel && !this.consumed.has(r.rel)
    )
    if (cands.length === 1) return { row: cands[0]!, at: 'random' }
    return {
      row: null,
      why:
        cands.length === 0
          ? 'not in the approved inventory'
          : 'ambiguous: several approved rows share its identity',
    }
  }
}

const identityProblem = (row: ApprovedRow, s: BigIntStats): string | null =>
  row.dev !== s.dev || row.ino !== s.ino || row.birthtimeNs !== s.birthtimeNs
    ? 'not the approved inode'
    : row.fmt !== (s.mode & S_IFMT) || row.type !== typeOf(s)
      ? 'not the approved file type'
      : null

/**
 * Why a file or symlink is not its approved row (UD69): identity, type, mode,
 * size and mtime; ctime on a first run, and on a resume where the entry is at
 * its inventory name (our own rename changed it under a `.d-` name).
 */
export function leafProblem(
  row: ApprovedRow,
  s: BigIntStats,
  at: FoundAt,
  resume: boolean
): string | null {
  if (row.type === 'dir') return 'approved as a directory'
  const id = identityProblem(row, s)
  if (id !== null) return id
  if (row.mode !== s.mode || row.size !== s.size || row.mtimeNs !== s.mtimeNs) {
    return 'changed since it was approved'
  }
  if ((!resume || at === 'original') && row.ctimeNs !== s.ctimeNs)
    return 'changed since it was approved'
  return null
}

/** On a resume, the content itself: the file's sha256 by a stable read, or the link's text. */
export function contentProblem(row: ApprovedRow, p: string): string | null {
  if (row.type === 'symlink') {
    try {
      return fs.readlinkSync(p) === row.linkText ? null : 'its link text is not the approved one'
    } catch (err) {
      return `unreadable (${errCode(err)})`
    }
  }
  const rs = readStable(p)
  if (!rs.ok) return `unreadable (${rs.reason})`
  if (rs.ino !== row.ino) return 'not the approved inode'
  return sha256Of(rs.bytes) === row.sha256 ? null : 'its content is not the approved content'
}

/** Why a directory is not its approved row. */
export function dirProblem(row: ApprovedRow, s: BigIntStats): string | null {
  if (row.type !== 'dir') return 'approved as a non-directory'
  return identityProblem(row, s)
}

/** One entry the listing or a walk keeps, with where it is and why. */
export interface KeptEntry {
  path: string
  rel: string | null
  why: string
}

/** Names in `S` that are prune's own metadata, never part of the diff. */
export const STAGING_METADATA: ReadonlySet<string> = new Set([
  'intent.json',
  'intent.json.tmp',
  'deleting',
  INVENTORY_FILE,
  INVENTORY_TMP,
])

export interface InventoryDiff {
  /** Approved files and symlinks still present: what a resume would delete. */
  remaining: { path: string; rel: string }[]
  /** Approved directories still present; a resume never removes them (R2). */
  dirs: { path: string; rel: string }[]
  /** Everything matching no row, one-to-one (R5): kept, never removed. */
  unapproved: KeptEntry[]
}

/**
 * The listing's diff of `S` against the inventory, read-only (R5): the same
 * matcher a resume uses, one-to-one through the consumed set. `.m-` names at
 * the top of `S` are left to the caller (metadata mid-removal).
 */
export function diffInventory(S: string, inv: PruneInventory): InventoryDiff {
  const ap = new Approved(inv)
  const out: InventoryDiff = { remaining: [], dirs: [], unapproved: [] }
  const visit = (dirAbs: string, parentRel: string): void => {
    for (const n of fs.readdirSync(dirAbs).sort()) {
      if (parentRel === STAGING_KEY && (STAGING_METADATA.has(n) || /^\.m-[0-9a-f]{16}$/.test(n)))
        continue
      const abs = path.join(dirAbs, n)
      let s: BigIntStats
      try {
        s = fs.lstatSync(abs, { bigint: true })
      } catch (err) {
        out.unapproved.push({ path: abs, rel: null, why: `unreadable (${errCode(err)})` })
        continue
      }
      const loc = ap.locate(parentRel, n, s, true)
      if (loc.row === null) {
        out.unapproved.push({ path: abs, rel: null, why: loc.why })
        continue
      }
      const row = loc.row
      if (row.type === 'dir') {
        const bad = dirProblem(row, s)
        if (bad !== null) {
          out.unapproved.push({ path: abs, rel: row.rel, why: bad })
          continue
        }
        ap.consume(row)
        out.dirs.push({ path: abs, rel: row.rel })
        visit(abs, row.rel)
        continue
      }
      const bad = leafProblem(row, s, loc.at, true) ?? contentProblem(row, abs)
      if (bad !== null) {
        out.unapproved.push({ path: abs, rel: row.rel, why: bad })
        continue
      }
      ap.consume(row)
      out.remaining.push({ path: abs, rel: row.rel })
    }
  }
  visit(S, STAGING_KEY)
  return out
}
