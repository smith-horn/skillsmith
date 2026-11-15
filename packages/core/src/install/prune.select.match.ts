/**
 * SMI-6531 (A1 step 6c-ii-b): what `planPrune` selects from, and which
 * selectors match. Pure: no fs, no builtin.
 *
 *  - `candidatesOf` flattens a listing into one row per listed copy, both
 *    stores. Temps, `.prune-*` leftovers, orphan sidecars, the parked index,
 *    legacy leftovers and the older MCP store are not rows of any view, so
 *    they are never candidates (M-S1..S3, D7).
 *  - `keepGuards` computes `--keep n` per `(client, rootKey, dirName)` from the
 *    area's path segments, across every state root. With D4, a verified tree's
 *    sidecar agrees with those segments; a tree whose sidecar did not verify is
 *    still in its area's group, so it cannot escape the guard (M-K4). Unknown
 *    age counts as newer than every dated tree and is always guarded (D5).
 *  - `matches` intersects the selectors the request gives (UD29, UD65, D15).
 *
 * @module @skillsmith/core/install/prune.select.match
 */
import type {
  BackupRow,
  BackupsListing,
  ParkedRow,
} from '../services/skill-backups.listing.types.js'
import type { ExcludeReason, PruneRequest } from './prune.plan.types.js'
import { policyFor } from './prune.kinds.js'
import { bytewise, rootKeyOf } from './prune.select.digest.js'

const DAY_MS = 86_400_000

/** One listed copy, with what the selectors and the lock grouping need. */
export type Candidate =
  | {
      store: 'backup'
      row: BackupRow
      /** The `<client>/<rootKey>/<dirName>` area it is listed in. */
      areaPath: string
      rootKey: string
      /** `(client, rootKey, dirName)` from the area's path segments: `--keep`'s group. */
      keepGroup: string
    }
  | {
      store: 'parked'
      row: ParkedRow
      /** The `.skillsmith-parked` directory it is listed in. */
      areaPath: string
      /** The discovered skills root the area belongs to, or null for an index-only area. */
      skillsRoot: string | null
    }

/** Every copy the listing shows, both stores, in listing order. */
export function candidatesOf(listing: BackupsListing): Candidate[] {
  const out: Candidate[] = []
  for (const v of listing.parked) {
    for (const row of v.rows) {
      out.push({ store: 'parked', row, areaPath: v.ref.areaDir, skillsRoot: v.ref.skillsRoot })
    }
  }
  for (const s of listing.backups) {
    for (const a of s.areas) {
      const keepGroup = [a.client, a.rootKey, a.dirName].join('\0')
      for (const row of a.rows) {
        out.push({ store: 'backup', row, areaPath: a.areaPath, rootKey: a.rootKey, keepGroup })
      }
    }
  }
  return out
}

/** The last path segment, whichever separator the platform used. */
export const baseName = (p: string): string =>
  p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1)

/**
 * The kind `--keep` counts a backup tree by: its sidecar's, else the tree NAME's
 * (`<opId>` is a backup, `<opId>.<kind>[.<k>]` names its kind). A tree whose
 * sidecar did not parse must still be counted, or a corrupt sidecar would let
 * the guard skip it.
 */
export function keepKind(row: BackupRow): string {
  if (row.kind !== null) return row.kind
  const parts = row.copy.name.split('.')
  return parts.length === 1 ? 'backup' : (parts[1] as string)
}

const str = (o: Record<string, unknown> | null, k: string): string | null =>
  o !== null && typeof o[k] === 'string' ? (o[k] as string) : null

/** Why each guarded tree is kept, by `copyPath`. */
export type Guards = Map<string, ExcludeReason>

/**
 * UD65 and UD64's `never-newest` (D5): per keep group, every counted tree of
 * unknown age is guarded (`unknown-age`) and the newest `keep` dated ones are
 * guarded (`newest-kept`). A `never-newest` kind (`merge-base`) keeps its own
 * newest per group. Computed from the rows alone, so a scoped listing that
 * shows the whole group computes the same guards.
 */
export function keepGuards(cands: readonly Candidate[], keep: number): Guards {
  const guards: Guards = new Map()
  const groups = new Map<string, BackupRow[]>()
  const add = (key: string, row: BackupRow): void => {
    const g = groups.get(key)
    if (g === undefined) groups.set(key, [row])
    else g.push(row)
  }
  for (const c of cands) {
    if (c.store !== 'backup') continue
    const policy = policyFor('backup', keepKind(c.row))
    if (policy?.countedByKeep === true) add('keep\0' + c.keepGroup, c.row)
    else if (policy?.neverNewest === true) add(keepKind(c.row) + '\0' + c.keepGroup, c.row)
  }
  for (const [key, rows] of groups) {
    const slots = key.startsWith('keep\0') ? keep : 1
    const dated: BackupRow[] = []
    for (const r of rows) {
      if (r.createdMs === null) guards.set(r.copy.copyPath, { code: 'unknown-age' })
      else dated.push(r)
    }
    dated.sort(
      (a, b) =>
        (b.createdMs as number) - (a.createdMs as number) || bytewise(b.copy.name, a.copy.name)
    )
    for (const r of dated.slice(0, Math.max(0, slots))) {
      guards.set(r.copy.copyPath, { code: 'newest-kept' })
    }
  }
  return guards
}

/** True when the request gives at least one selector (`--keep` only when given explicitly). */
export function hasSelector(r: PruneRequest): boolean {
  return (
    r.olderThanDays !== undefined ||
    r.keep !== undefined ||
    r.client !== undefined ||
    (r.roots !== undefined && r.roots.length > 0) ||
    r.skill !== undefined ||
    r.op !== undefined ||
    (r.paths !== undefined && r.paths.length > 0)
  )
}

const clientOf = (c: Candidate): string | null =>
  c.store === 'backup' ? c.row.client : str(c.row.classification.sidecar, 'client')

/** D15: a backup by its restore root (the area's root key when no sidecar parsed); a parked copy by its area's root. */
function rootMatches(c: Candidate, roots: readonly string[]): boolean {
  if (c.store === 'parked') return c.skillsRoot !== null && roots.includes(c.skillsRoot)
  if (c.row.skillsDir !== null) return roots.includes(c.row.skillsDir)
  return roots.some((r) => rootKeyOf(r) === c.rootKey)
}

/** Every given selector matches (they intersect, over both stores). */
export function matches(c: Candidate, r: PruneRequest): boolean {
  const row = c.row
  if (r.olderThanDays !== undefined) {
    // D5: an unknown age never matches `--older-than`.
    if (row.createdMs === null || r.now - row.createdMs < r.olderThanDays * DAY_MS) return false
  }
  if (r.keep !== undefined) {
    // Given explicitly, `--keep` selects the trees it counts; the guard removes the newest n.
    if (c.store !== 'backup' || policyFor('backup', keepKind(c.row))?.countedByKeep !== true) {
      return false
    }
  }
  if (r.client !== undefined && clientOf(c) !== r.client) return false
  if (r.roots !== undefined && r.roots.length > 0 && !rootMatches(c, r.roots)) return false
  if (r.skill !== undefined) {
    const skill =
      c.store === 'backup' ? c.row.dirName : c.row.origin === null ? null : baseName(c.row.origin)
    if (skill !== r.skill) return false
  }
  if (r.op !== undefined) {
    const op = c.store === 'backup' ? c.row.opId : c.row.copy.opId
    if (op !== r.op) return false
  }
  if (r.paths !== undefined && r.paths.length > 0 && !r.paths.includes(row.copy.copyPath)) {
    return false
  }
  return true
}
