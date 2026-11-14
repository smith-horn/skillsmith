/**
 * SMI-6531 (A1 step 6c-ii-a): `--root` and `--client` narrow what the listing
 * SHOWS (PLAN 2046; UD22). Both are post-filters on a complete listing, and
 * both read the ledger (`skill-backups.ledger.ts`): one predicate per row
 * decides whether it is shown, the views are filtered by that predicate, and
 * the counts of what was left out are the ledger rows it hid, by what they are
 * (a copy, another entry, an older store). So an anomaly, a refused area or a
 * skipped staging directory that is hidden is counted, never dropped. The
 * ledger itself and the space warning are never narrowed.
 *
 * What belongs to a root:
 *  - a parked row is the root's when its area is the root's own
 *    `.skillsmith-parked` or its staging directory's; an area only the parked
 *    index names belongs to no discovered root, so it is left out;
 *  - a backup row is the root's when its `<rootKey>` path segment is the
 *    root's key, or, for a kept tree, when its sidecar's `skillsDir` (by real
 *    path) is the root. The store itself and a `<client>` level hold every
 *    root's trees and belong to none, so they are always shown;
 *  - an old MCP store and legacy leftovers belong to the root they sit in;
 *  - the parked index's rows belong to no root and are always shown.
 *
 * What belongs to a client: a backup row whose `<client>` segment matches (the
 * store itself is always shown); a parked copy whose sidecar names the client
 * or names none. Every other parked row, older store and index row is shown.
 *
 * Read-only.
 *
 * @module @skillsmith/core/services/skill-backups.narrow
 */
import fs from 'node:fs'
import { rootKeyFor } from '../install/prune.classify.js'
import type { LedgerRow } from './skill-backups.ledger.js'
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

type Visible = (row: LedgerRow) => boolean

/** The listing's views filtered by `visible`, and the counts of the rows it hid. */
function narrowBy(l: BackupsListing, visible: Visible) {
  const byPath = new Map(l.accounting.rows.map((r) => [r.path, r]))
  // A path with no row is shown: hiding it would hide something the ledger never counted.
  const shown = (p: string): boolean => {
    const r = byPath.get(p)
    return r === undefined || visible(r)
  }
  const counts = { parkedCopies: 0, backupTrees: 0, otherEntries: 0, olderStores: 0 }
  for (const r of l.accounting.rows) {
    if (r.item === null || visible(r)) continue
    if (r.item === 'copy') {
      if (r.where.store === 'parked') counts.parkedCopies += 1
      else counts.backupTrees += 1
    } else if (r.item === 'entry') counts.otherEntries += 1
    else counts.olderStores += 1
  }
  const parked = l.parked.flatMap((a) => {
    if (!shown(a.ref.skipped === undefined ? a.ref.areaDir : a.ref.root)) return []
    return [
      {
        ...a,
        rows: a.rows.filter((r) => shown(r.copy.copyPath)),
        leftovers: a.leftovers.filter((v) => shown(v.leftover.S)),
        orphanSidecars: a.orphanSidecars.filter(shown),
        anomalies: a.anomalies.filter((x) => shown(x.path)),
      },
    ]
  })
  const backups = l.backups.map((s) => ({
    ...s,
    anomalies: s.anomalies.filter((x) => shown(x.path)),
    areas: s.areas.flatMap((a): BackupAreaView[] => {
      const v: BackupAreaView = {
        ...a,
        rows: a.rows.filter((r) => shown(r.copy.copyPath)),
        temps: a.temps.filter((t) => shown(t.path)),
        leftovers: a.leftovers.filter((x) => shown(x.leftover.S)),
        orphanSidecars: a.orphanSidecars.filter(shown),
        anomalies: a.anomalies.filter((x) => shown(x.path)),
      }
      const any =
        v.rows.length + v.temps.length + v.leftovers.length + v.orphanSidecars.length > 0 ||
        v.anomalies.length > 0
      // An area whose own row is shown stays even when empty, as before narrowing.
      return shown(a.areaPath) || any ? [v] : []
    }),
  }))
  const mcpStores = l.mcpStores.filter((m) => shown(m.path))
  const legacy = l.legacy.flatMap((g) => {
    const paths = g.paths.filter(shown)
    const unreadable = g.unreadable !== null && shown(g.root) ? g.unreadable : null
    return paths.length > 0 || unreadable !== null ? [{ ...g, paths, unreadable }] : []
  })
  return { listing: { ...l, parked, backups, mcpStores, legacy }, counts }
}

/** The listing narrowed to `roots` (real paths), with the counts of what was left out. */
export function narrowToRoots(l: BackupsListing, roots: readonly string[]): BackupsListing {
  const keys = new Set(roots.map(rootKeyFor))
  const visible: Visible = (r) => {
    const w = r.where
    if (w.store === 'index') return true
    if (w.store !== 'backup') return w.skillsRoot !== null && roots.includes(w.skillsRoot)
    if (w.rootKey === null || keys.has(w.rootKey)) return true
    return (
      r.item === 'copy' && w.sidecarSkillsDir !== null && roots.includes(realOr(w.sidecarSkillsDir))
    )
  }
  const { listing, counts } = narrowBy(l, visible)
  const out: ExcludedByRoot = counts
  return { ...listing, narrowedTo: [...roots], excludedByRoot: out }
}

/** `--client`: the listing narrowed to one client, with the counts of what was left out. */
export function narrowToClient(l: BackupsListing, client: string): BackupsListing {
  const visible: Visible = (r) => {
    const w = r.where
    if (w.store === 'backup') return w.client === null || w.client === client
    if (w.store === 'parked' && r.item === 'copy') {
      return w.sidecarClient === null || w.sidecarClient === client
    }
    return true
  }
  const { listing, counts } = narrowBy(l, visible)
  const out: ExcludedByClient = {
    parkedCopies: counts.parkedCopies,
    backupTrees: counts.backupTrees,
    otherEntries: counts.otherEntries,
  }
  return { ...listing, excludedByClient: out }
}
