/**
 * SMI-6531 (A1 step 6c-ii-b): the two run-wide facts a plan reports beside its
 * selection, both from the listing alone. Pure: no fs, no builtin.
 *
 *  - `unmatchedPaths` (D18): each `--path` that names no listed copy, and why,
 *    so the CLI can exit 1 rather than silently select nothing. Paths are
 *    compared exactly: the request carries native realpaths, and so does the
 *    listing.
 *  - `preconditionsOf` (D10): why `--apply` would refuse the whole run, shown
 *    and not enforced.
 *
 * @module @skillsmith/core/install/prune.select.paths
 */
import type { BackupsListing } from '../services/skill-backups.listing.types.js'
import type { Precondition } from './prune.plan.types.js'
import { PARKED_INDEX_FILE } from './parked-index.name.js'
import { baseName } from './prune.select.match.js'

const PRUNE_DIR = /^\.prune-[0-9a-f]{16}$/
const LEGACY = /^\..+\.skillsmith-removing-[0-9a-f]{32}$/
const TEMP = /^\.tmp-|\.json\.tmp$/

export const WHY = {
  pruneDir: 'a .prune-* directory: prune never selects its own staging directories',
  temp: 'an unfinished temp: prune never selects it (doctor recovery owns it)',
  index: 'the parked index: prune never selects it',
  legacy: 'a legacy removal leftover: listed, never selected',
  mcpStore: 'the older MCP backup store: reported, never selected',
  sidecar: 'a sidecar, not a tree: prune selects the tree it describes',
  refused: 'in an area the listing refused, so nothing in it can be selected',
  notFound: 'not found: no tree prune lists is at this path',
  outside: 'outside every store prune lists',
} as const

const under = (p: string, dir: string): boolean =>
  p === dir || p.startsWith(dir + '/') || p.startsWith(dir + '\\')

/** Every path the listing names that is not a copy, with the reason it is never one. */
function knownNonCopies(listing: BackupsListing): Map<string, string> {
  const known = new Map<string, string>()
  for (const v of listing.parked) {
    for (const l of v.leftovers) known.set(l.leftover.S, WHY.pruneDir)
    for (const o of v.orphanSidecars) known.set(o, WHY.sidecar)
  }
  for (const s of listing.backups) {
    for (const a of s.areas) {
      for (const t of a.temps) known.set(t.path, WHY.temp)
      for (const l of a.leftovers) known.set(l.leftover.S, WHY.pruneDir)
      for (const o of a.orphanSidecars) known.set(o, WHY.sidecar)
    }
  }
  for (const r of listing.index.facts.reads) known.set(r.indexPath, WHY.index)
  for (const u of listing.index.facts.unreadable) known.set(u.indexPath, WHY.index)
  for (const g of listing.legacy) for (const p of g.paths) known.set(p, WHY.legacy)
  return known
}

/** The store directories a path may sit under: parked areas and each update backup store. */
const storeDirs = (listing: BackupsListing): string[] => [
  ...listing.parked.map((v) => v.ref.areaDir),
  ...listing.backups.map((s) => s.updateDir),
]

/** Areas and stores the listing refused or skipped whole: nothing in them is listed. */
const refusedDirs = (listing: BackupsListing): { path: string; reason: string }[] => [
  ...listing.parked.flatMap((v) => {
    const reason = v.refused ?? v.ref.skipped
    return reason === undefined ? [] : [{ path: v.ref.areaDir, reason }]
  }),
  ...listing.backups.flatMap((s) =>
    s.refused === null ? [] : [{ path: s.updateDir, reason: s.refused }]
  ),
]

/** D18: each requested path that names no listed copy, and why, decided from the listing alone. */
export function unmatchedPaths(
  listing: BackupsListing,
  paths: readonly string[],
  copyPaths: ReadonlySet<string>
): { path: string; why: string }[] {
  const known = knownNonCopies(listing)
  const out: { path: string; why: string }[] = []
  for (const p of paths) {
    if (copyPaths.has(p)) continue
    const name = baseName(p)
    let why = known.get(p)
    if (why === undefined) {
      if (PRUNE_DIR.test(name)) why = WHY.pruneDir
      else if (TEMP.test(name)) why = WHY.temp
      else if (name === PARKED_INDEX_FILE) why = WHY.index
      else if (LEGACY.test(name)) why = WHY.legacy
      else if (listing.mcpStores.some((m) => under(p, m.path))) why = WHY.mcpStore
      else if (p.endsWith('.json') && copyPaths.has(p.slice(0, -5))) why = WHY.sidecar
      else {
        const refused = refusedDirs(listing).find((d) => under(p, d.path))
        if (refused !== undefined) why = `${WHY.refused} (${refused.reason})`
        else if (storeDirs(listing).some((d) => under(p, d))) why = WHY.notFound
        else why = WHY.outside
      }
    }
    out.push({ path: p, why })
  }
  return out
}

/** D10: unreadable records by root, and every area or index the listing could not read. */
export function preconditionsOf(listing: BackupsListing): Precondition[] {
  const out: Precondition[] = []
  for (const u of listing.records.unreadable) {
    out.push({ code: 'unreadable-record', root: u.root, recordPath: u.record.path })
  }
  // A staging directory that could not be scanned may hold an unreadable record.
  for (const f of listing.records.scanFailures) {
    out.push({ code: 'unreadable-record', root: f.root, recordPath: f.path })
  }
  for (const v of listing.parked) {
    if (v.refused !== null)
      out.push({ code: 'area-refused', path: v.ref.areaDir, reason: v.refused })
    else if (v.ref.skipped !== undefined) {
      out.push({ code: 'area-refused', path: v.ref.areaDir, reason: v.ref.skipped })
    }
  }
  for (const s of listing.backups) {
    if (s.refused !== null) out.push({ code: 'area-refused', path: s.updateDir, reason: s.refused })
  }
  for (const u of listing.index.facts.unreadable) {
    out.push({
      code: 'area-refused',
      path: u.indexPath,
      reason: `the parked index could not be read (${u.errno})`,
    })
  }
  return out
}
