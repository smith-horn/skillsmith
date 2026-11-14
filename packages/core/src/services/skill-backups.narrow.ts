/**
 * SMI-6531 (A1 step 6c-ii-a): `--root` narrows the listing as well as adding a
 * root to discovery (PLAN 2046; UD22). It is a post-filter on a complete
 * listing, so the space warning still counts everything and nothing is hidden
 * without being counted.
 *
 * What belongs to a root:
 *  - a parked area is the root's when it is the root's own `.skillsmith-parked`
 *    or its staging directory's; an area only the parked index names belongs to
 *    no discovered root, so it is left out;
 *  - a kept backup tree is the root's when its sidecar's `skillsDir` (by real
 *    path) is the root, or the area's `<rootKey>` path segment is the root's
 *    key. A tree whose sidecar is absent, unreadable or names another root, in
 *    an area keyed to another root, is attributable to none of them, so it is
 *    left out and counted in `excludedByRoot`, never dropped uncounted. A
 *    sidecar that disagrees with its area (a mismatched one) belongs to either
 *    root it names, and is shown with its `unverified` class.
 *
 * `--client` (`narrowToClient`) is the same kind of post-filter: it keeps a
 * backup row whose `<client>` segment matches, and a parked row whose sidecar
 * client does or is unknown. What it drops (other clients' parked rows, and
 * whole backup areas with their temps, leftovers, orphan sidecars and
 * anomalies) is counted in `excludedByClient`, never dropped uncounted.
 *
 * Read-only.
 *
 * @module @skillsmith/core/services/skill-backups.narrow
 */
import fs from 'node:fs'
import { rootKeyFor } from '../install/prune.classify.js'
import type {
  BackupAreaView,
  BackupsListing,
  ExcludedByClient,
  ExcludedByRoot,
} from './skill-backups.listing.types.js'

const realOr = (p: string): string => {
  try {
    return fs.realpathSync(p)
  } catch {
    return p
  }
}

/** The listing narrowed to `roots` (real paths), with the counts of what was left out. */
export function narrowToRoots(l: BackupsListing, roots: readonly string[]): BackupsListing {
  const keys = new Set(roots.map(rootKeyFor))
  const out: ExcludedByRoot = { parkedCopies: 0, backupTrees: 0, otherEntries: 0, olderStores: 0 }
  const parked = l.parked.filter((a) => {
    if (a.ref.skillsRoot !== null && roots.includes(a.ref.skillsRoot)) return true
    out.parkedCopies += a.rows.length
    out.otherEntries += a.leftovers.length + a.orphanSidecars.length
    return false
  })
  const backups = l.backups.map((s) => ({
    ...s,
    areas: s.areas.flatMap((a): BackupAreaView[] => {
      const keyed = keys.has(a.rootKey)
      const rows = a.rows.filter(
        (r) => keyed || (r.skillsDir !== null && roots.includes(realOr(r.skillsDir)))
      )
      out.backupTrees += a.rows.length - rows.length
      if (!keyed) out.otherEntries += a.temps.length + a.leftovers.length + a.orphanSidecars.length
      if (rows.length === 0 && !keyed) return []
      return [keyed ? { ...a, rows } : { ...a, rows, temps: [], leftovers: [], orphanSidecars: [] }]
    }),
  }))
  const mcpStores = l.mcpStores.filter((m) => roots.includes(m.root))
  const legacy = l.legacy.filter((g) => roots.includes(g.root))
  out.olderStores = l.mcpStores.length - mcpStores.length + (l.legacy.length - legacy.length)
  return { ...l, parked, backups, mcpStores, legacy, narrowedTo: [...roots], excludedByRoot: out }
}

const sidecarClient = (r: {
  classification: { sidecar: Record<string, unknown> | null }
}): string | null => {
  const c = r.classification.sidecar?.['client']
  return typeof c === 'string' ? c : null
}

/** `--client`: the listing narrowed to one client, with the counts of what was left out. */
export function narrowToClient(l: BackupsListing, client: string): BackupsListing {
  const out: ExcludedByClient = { parkedCopies: 0, backupTrees: 0, otherEntries: 0 }
  const parked = l.parked.map((a) => {
    const rows = a.rows.filter((r) => {
      const c = sidecarClient(r)
      return c === null || c === client
    })
    out.parkedCopies += a.rows.length - rows.length
    return { ...a, rows }
  })
  const backups = l.backups.map((s) => ({
    ...s,
    areas: s.areas.filter((a) => {
      if (a.client === client) return true
      out.backupTrees += a.rows.length
      out.otherEntries +=
        a.temps.length + a.leftovers.length + a.orphanSidecars.length + a.anomalies.length
      return false
    }),
  }))
  return { ...l, parked, backups, excludedByClient: out }
}
