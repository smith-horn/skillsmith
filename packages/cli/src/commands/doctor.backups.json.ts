/**
 * @fileoverview The `--json` document for `skillsmith doctor backups` (SMI-6531
 * step 6c-ii-a): the listing as plain data. The listing's own rows carry
 * bigint identities, raw sidecar bytes and Maps that JSON cannot hold, so this
 * projects exactly the fields a person or a script reads.
 * @module @skillsmith/cli/commands/doctor.backups.json
 */

import type { BackupsListing, LeftoverView, ParkedRow, BackupRow } from '@skillsmith/core'

/** Allocated bytes and count per kind, over both stores (the listing's "total per kind"). */
export function kindTotals(
  l: BackupsListing
): Record<string, { count: number; allocatedBytes: number }> {
  const out: Record<string, { count: number; allocatedBytes: number }> = {}
  const add = (kind: string | null, bytes: number): void => {
    const k = kind ?? 'unknown'
    const cur = (out[k] ??= { count: 0, allocatedBytes: 0 })
    cur.count += 1
    cur.allocatedBytes += bytes
  }
  for (const a of l.parked) for (const r of a.rows) add(r.kind, r.allocatedBytes)
  for (const s of l.backups)
    for (const a of s.areas) for (const r of a.rows) add(r.kind, r.allocatedBytes)
  return out
}

const classOf = (
  r: ParkedRow | BackupRow
): { class: string; reason: string | null; detail: string | null } => ({
  class: r.classification.klass,
  reason: r.classification.reason,
  detail: r.classification.detail,
})

const createdAt = (r: ParkedRow | BackupRow): string | null =>
  r.createdMs === null ? null : new Date(r.createdMs).toISOString()

const leftoverJson = (v: LeftoverView): Record<string, unknown> => ({
  path: v.leftover.S,
  state: v.leftover.state,
  detail: v.leftover.detail ?? null,
  unapproved: v.leftover.unapproved.length,
  remaining: v.leftover.remaining?.length ?? 0,
  skeletons: v.leftover.skeletons ?? [],
  resumeOffered: v.resumeOffered,
})

const sizes = (r: { allocatedBytes: number; apparentBytes: number; unmeasured: number }) => ({
  allocatedBytes: r.allocatedBytes,
  apparentBytes: r.apparentBytes,
  unmeasured: r.unmeasured,
})

/** The listing as a JSON-safe object. */
export function listingJson(l: BackupsListing): Record<string, unknown> {
  return {
    stateRoots: l.discovery.stateRoots,
    roots: l.discovery.roots.map((r) => r.root),
    skippedRoots: l.discovery.skipped,
    client: l.client,
    narrowedTo: l.narrowedTo,
    excludedByRoot: l.excludedByRoot,
    excludedByClient: l.excludedByClient,
    parked: l.parked.map((a) => ({
      area: a.ref.areaDir,
      origin: a.ref.origin,
      skillsRoot: a.ref.skillsRoot,
      absent: a.absent,
      refused: a.refused,
      copies: a.rows.map((r) => ({
        path: r.copy.copyPath,
        opId: r.copy.opId,
        kind: r.kind,
        ...classOf(r),
        origin: r.origin,
        index: r.index,
        createdAt: createdAt(r),
        ageDays: r.ageDays,
        ...sizes(r),
      })),
      leftovers: a.leftovers.map(leftoverJson),
      orphanSidecars: a.orphanSidecars,
      anomalies: a.anomalies,
    })),
    backups: l.backups.map((s) => ({
      stateRoot: s.stateRoot,
      updateDir: s.updateDir,
      absent: s.absent,
      refused: s.refused,
      anomalies: s.anomalies,
      areas: s.areas.map((a) => ({
        path: a.areaPath,
        client: a.client,
        rootKey: a.rootKey,
        dirName: a.dirName,
        trees: a.rows.map((r) => ({
          path: r.copy.copyPath,
          opId: r.opId,
          kind: r.kind,
          ...classOf(r),
          skillsDir: r.skillsDir,
          createdAt: createdAt(r),
          ageDays: r.ageDays,
          hashStillEquals: r.hashStillEquals,
          protection: r.protection,
          newestOfGroup: r.newestOfGroup,
          ...sizes(r),
        })),
        temps: a.temps,
        leftovers: a.leftovers.map(leftoverJson),
        orphanSidecars: a.orphanSidecars,
        anomalies: a.anomalies,
      })),
    })),
    legacyLeftovers: l.legacy,
    olderMcpBackups: l.mcpStores.map((m) => ({ path: m.path, ...sizes(m) })),
    index: {
      reads: l.index.facts.reads,
      unreadable: l.index.facts.unreadable,
      rejected: l.index.facts.rejected,
      stale: l.index.stale.map((s) => ({ path: s.line.entry.path, reason: s.reason })),
    },
    records: {
      liveOpIds: [...l.records.live.keys()],
      unreadable: l.records.unreadable.map((u) => ({ root: u.root, ...u.record })),
      scanFailures: l.records.scanFailures,
    },
    totalsPerKind: kindTotals(l),
    unmeasuredEntries: l.unmeasured,
    // The ledger's verdicts that are not plain measurements: what could not be measured and why,
    // and what counts for nothing and why (absent, vanished, or a legacy leftover).
    accounting: {
      unmeasured: l.accounting.rows.flatMap((r) =>
        r.disposition.kind === 'unmeasured' ? [{ path: r.path, reason: r.disposition.reason }] : []
      ),
      exempt: l.accounting.rows.flatMap((r) =>
        r.disposition.kind === 'exempt' ? [{ path: r.path, reason: r.disposition.reason }] : []
      ),
    },
    warning: { warn: l.warning.warn, message: l.warning.message },
  }
}
