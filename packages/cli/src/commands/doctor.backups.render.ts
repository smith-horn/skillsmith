/**
 * @fileoverview The text of `skillsmith doctor backups` (SMI-6531 step
 * 6c-ii-a): one section per store, each copy with its class, size on disk,
 * age and origin, then the unfinished temps and `.prune-*` leftovers, the
 * legacy leftovers, the older MCP store, and the index's own findings. Sizes
 * are allocated bytes, labelled "on disk" (owner decision D6). The words are
 * "set-aside folders", never "trash" (UD66).
 * @module @skillsmith/cli/commands/doctor.backups.render
 */

import { humanBytes, leftoverLines } from '@skillsmith/core'
import type {
  BackupAreaView,
  BackupRow,
  BackupsListing,
  ParkedAreaView,
  ParkedRow,
} from '@skillsmith/core'
import { kindTotals } from './doctor.backups.json.js'

const days = (d: number | null): string => (d === null ? 'age unknown' : `${d}d`)
const why = (reason: string | null): string => (reason === null ? '' : ` (${reason})`)
/**
 * A copy's class and reason. A root whose real path could not be resolved is
 * never offered, as a mounted one is, but it is not known to be mounted: it
 * may have vanished or be unreadable, so it says so.
 */
const classText = (c: { klass: string; reason: string | null }): string =>
  c.klass === 'mounted' && c.reason === 'realpath-failed'
    ? 'could not be resolved (realpath-failed)'
    : `${c.klass}${why(c.reason)}`
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`
/** What `otherEntries` counts, named in full: a narrowing hides no kind without saying so. */
const OTHER_ONE = 'temp, leftover, orphan sidecar, anomaly or refused area'
const OTHER_MANY = 'temps, leftovers, orphan sidecars, anomalies or refused areas'

/** Where an area sits, in words: the area-aware "next to your own directory" sentence (Q9). */
function whereSentence(a: ParkedAreaView): string {
  const area = a.ref.areaDir
  if (a.ref.origin === 'root') {
    return (
      `Skillsmith set these folders aside in ${area}, next to your own directory ` +
      `${a.ref.skillsRoot ?? a.ref.root}. Nothing here is deleted automatically.`
    )
  }
  if (a.ref.origin === 'staging') {
    return (
      `Skillsmith set these folders aside in ${area}, inside the staging folder of ` +
      `${a.ref.skillsRoot ?? a.ref.root}. Nothing here is deleted automatically.`
    )
  }
  return (
    `Skillsmith set these folders aside in ${area}. Only the parked index names this place; ` +
    'no skills root skillsmith discovered holds it. Nothing here is deleted automatically.'
  )
}

function parkedRowLine(r: ParkedRow): string {
  const c = r.classification
  return (
    `  ${classText(c)}  ${humanBytes(r.allocatedBytes)} on disk  ${days(r.ageDays)}  ` +
    `${r.copy.copyPath}  origin: ${r.origin ?? 'unknown'}  index: ${r.index}` +
    (r.kind === null ? '' : `  kind: ${r.kind}`) +
    protectionText(r.protection)
  )
}

/** UD61's protection, as one clause (two leading spaces): the same words for a backup and a parked copy. */
function protectionText(p: BackupRow['protection']): string {
  return p.status === 'unknown'
    ? `  protection unknown: ${p.reason}`
    : p.status === 'unprotected'
      ? '  no update record protects it'
      : p.rule === 'live-record'
        ? `  protected by record ${p.path}`
        : `  protected by parked unreadable record ${p.path}`
}

function parkedLines(l: BackupsListing): string[] {
  const lines: string[] = []
  for (const a of l.parked) {
    if (a.absent) continue
    if (a.refused !== null) {
      lines.push(`${a.ref.areaDir}: not used (${a.refused}). Nothing in it is listed or deleted.`)
      continue
    }
    const empty = a.rows.length === 0 && a.leftovers.length === 0 && a.orphanSidecars.length === 0
    if (empty && a.anomalies.length === 0) continue
    const bytes = a.rows.reduce((n, r) => n + r.allocatedBytes, 0)
    lines.push(
      `Set-aside folders in ${a.ref.areaDir}: ${plural(a.rows.length, 'copy', 'copies')}, ` +
        `${humanBytes(bytes)} on disk`
    )
    lines.push(whereSentence(a))
    for (const r of a.rows) lines.push(parkedRowLine(r))
    for (const v of a.leftovers) lines.push(...leftoverLines(v))
    for (const o of a.orphanSidecars) lines.push(`  orphan sidecar (its copy is gone): ${o}`)
    for (const x of a.anomalies) lines.push(`  not listed: ${x.path} (${x.detail})`)
  }
  return lines
}

function backupRowLine(r: BackupRow): string {
  const c = r.classification
  const hash =
    r.hashStillEquals === null
      ? ''
      : r.hashStillEquals
        ? '  hash matches sidecar'
        : '  hash differs from sidecar'
  const prot = protectionText(r.protection)
  return (
    `  ${r.kind ?? 'unknown kind'}  ${classText(c)}  ${humanBytes(r.allocatedBytes)} on disk  ` +
    `${days(r.ageDays)}  ${r.copy.name}  opId ${r.opId}${hash}${prot}` +
    (r.newestOfGroup ? '  newest backup of this folder' : '')
  )
}

function backupAreaLines(a: BackupAreaView): string[] {
  const roots = [...new Set(a.rows.map((r) => r.skillsDir ?? 'unknown'))]
  const lines = [
    `${a.client}: ${a.dirName}  (${a.areaPath})  restores to: ${roots.join(', ') || 'unknown'}`,
  ]
  for (const r of a.rows) lines.push(backupRowLine(r))
  for (const t of a.temps) {
    lines.push(
      `  unfinished (${t.kind}): ${t.path}` +
        (t.ownedBy === null ? '' : `  owned by record ${t.ownedBy}`)
    )
  }
  for (const v of a.leftovers) lines.push(...leftoverLines(v))
  for (const o of a.orphanSidecars) lines.push(`  orphan sidecar (its tree is gone): ${o}`)
  for (const x of a.anomalies) lines.push(`  not listed: ${x.path} (${x.detail})`)
  return lines
}

function backupLines(l: BackupsListing): string[] {
  const lines: string[] = []
  for (const s of l.backups) {
    if (s.absent) continue
    if (s.refused !== null) {
      lines.push(`${s.updateDir}: not used (${s.refused}). Nothing in it is listed or deleted.`)
      continue
    }
    const rows = s.areas.reduce((n, a) => n + a.rows.length, 0)
    const bytes = s.areas.reduce((n, a) => n + a.rows.reduce((m, r) => m + r.allocatedBytes, 0), 0)
    lines.push(
      `Kept backups in ${s.updateDir}: ${plural(rows, 'tree', 'trees')}, ${humanBytes(bytes)} on disk`
    )
    for (const a of s.areas) lines.push(...backupAreaLines(a))
    for (const x of s.anomalies) lines.push(`  not listed: ${x.path} (${x.detail})`)
  }
  return lines
}

function sideLines(l: BackupsListing): string[] {
  const lines: string[] = []
  for (const g of l.legacy) {
    lines.push(`Older removal leftovers in ${g.root} (owner unknown, never selected for deletion):`)
    for (const p of g.paths) lines.push(`  ${p}`)
    if (g.unreadable !== null) lines.push(`  ${g.unreadable}`)
  }
  for (const m of l.mcpStores) {
    lines.push(
      `Older MCP backups, not managed by prune: ${m.path}  ${humanBytes(m.allocatedBytes)} on disk`
    )
  }
  const idx = l.index
  for (const u of idx.facts.unreadable) {
    lines.push(
      `Set-aside folders found only through the parked index are not listed: ` +
        `${u.indexPath} could not be read (${u.errno}).`
    )
  }
  for (const r of idx.facts.rejected) {
    lines.push(
      `Parked index ${r.indexPath}${r.line === null ? '' : ` line ${r.line}`} ignored: ${r.reason}` +
        (r.path === null ? '' : ` (${r.path})`)
    )
  }
  if (idx.stale.length > 0) {
    lines.push(
      `Parked index: ${plural(idx.stale.length, 'line names', 'lines name')} a copy that is not there ` +
        '(advisory, not an error).'
    )
  }
  for (const u of l.records.unreadable) {
    lines.push(
      `Unreadable update record ${u.record.path} (${u.record.why}) blocks writes in ${u.root}; ` +
        `see \`skillsmith doctor recovery --park ${u.record.opId}\`.`
    )
  }
  for (const f of l.records.scanFailures) {
    lines.push(
      `Update records under ${f.root} could not be read (${f.errno}): protection from them is unknown.`
    )
  }
  return lines
}

/** The whole listing as text lines. */
export function renderListing(l: BackupsListing): string[] {
  const body = [...parkedLines(l), ...backupLines(l), ...sideLines(l)]
  const lines: string[] = []
  if (l.discovery.stateRoots.length === 0) {
    lines.push('No Skillsmith state folder was found, so there are no kept backups to list.')
  }
  lines.push(...body)
  if (body.length === 0) lines.push('No set-aside folders or kept backups found.')
  const totals = Object.entries(kindTotals(l)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  if (totals.length > 0) {
    lines.push(
      'Total per kind: ' +
        totals
          .map(([k, v]) => `${k} ${v.count} (${humanBytes(v.allocatedBytes)} on disk)`)
          .join(', ')
    )
  }
  const x = l.excludedByRoot
  if (x !== null && l.narrowedTo !== null) {
    lines.push(`Narrowed by --root to ${l.narrowedTo.join(', ') || 'no usable root'}.`)
    const parts = [
      x.parkedCopies > 0 && plural(x.parkedCopies, 'set-aside folder', 'set-aside folders'),
      x.backupTrees > 0 && plural(x.backupTrees, 'kept backup tree', 'kept backup trees'),
      x.otherEntries > 0 && plural(x.otherEntries, OTHER_ONE, OTHER_MANY),
      x.olderStores > 0 && plural(x.olderStores, 'older store', 'older stores'),
    ].filter((p): p is string => p !== false)
    if (parts.length > 0) {
      lines.push(
        `Excluded by --root (they belong to other skills roots, or to none you named): ${parts.join(', ')}.`
      )
    }
  }
  const c = l.excludedByClient
  if (c !== null && c !== undefined && l.client !== null) {
    const parts = [
      c.parkedCopies > 0 && plural(c.parkedCopies, 'set-aside folder', 'set-aside folders'),
      c.backupTrees > 0 && plural(c.backupTrees, 'kept backup tree', 'kept backup trees'),
      c.otherEntries > 0 && plural(c.otherEntries, OTHER_ONE, OTHER_MANY),
    ].filter((p): p is string => p !== false)
    if (parts.length > 0) {
      lines.push(
        `Excluded by --client ${l.client} (they belong to other clients): ${parts.join(', ')}.`
      )
    }
  }
  if (l.unmeasured > 0) {
    lines.push(`${plural(l.unmeasured, 'entry', 'entries')} could not be measured.`)
    for (const r of l.accounting.rows) {
      if (r.disposition.kind === 'unmeasured') lines.push(`  ${r.path}: ${r.disposition.reason}`)
    }
  }
  return lines
}
