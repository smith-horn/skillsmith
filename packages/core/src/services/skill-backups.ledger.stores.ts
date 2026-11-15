/**
 * SMI-6531 (A1 step 6c-ii-a): the ledger rows for each store `doctor backups`
 * reads (the rules are in `skill-backups.ledger.ts`).
 *
 * Each builder first gives a row to everything its lister returned (copies,
 * leftovers, temps, orphan sidecars, anomalies, a refused or absent root),
 * then a directory's own inode, and then SWEEPS: it lists every directory the
 * lister went into again, and any name there with no row yet (a copy's
 * sidecar, an empty level directory, or anything that appeared since) gets
 * one. So a name the lister reads but does not report cannot fall out of the
 * accounting, whatever it is.
 *
 * Position decides the rule, never an anomaly's detail text: a name at a store
 * LEVEL (op dir, `<client>`, `<rootKey>`, `<dirName>`) the lister did not go
 * into is `unmeasured` when it is a directory or a symlink; a name inside an
 * op dir or area is measured as it is (never followed).
 *
 * The parked index runs last, so a path it names that some other row already
 * accounts for is not counted twice. Read-only.
 *
 * @module @skillsmith/core/services/skill-backups.ledger.stores
 */
import fs from 'node:fs'
import path from 'node:path'
import { errCode } from '../install/park-result.js'
import type { Measured } from '../install/prune.measure.js'
import type { Anomaly, BackupStoreListing, ParkedAreaListing } from '../install/prune.list.types.js'
import {
  NOT_UTF8,
  entryDisposition,
  fromMeasured,
  levelDisposition,
  lstatOr,
  selfDisposition,
  SYMLINK_LEVEL,
  utf8Clean,
  whereOf,
} from './skill-backups.ledger.js'
import type { Disposition, Ledger, LedgerItem, LedgerWhere } from './skill-backups.ledger.js'
import type { AreaRef, IndexFacts } from './skill-backups.areas.js'
import type { BackupRow, ParkedRow } from './skill-backups.listing.types.js'

export interface LedgerCtx {
  ledger: Ledger
  measureOf: (abs: string) => Measured
}

interface PutOptions {
  item: LedgerItem
  where: LedgerWhere
  /** A directory whose contents have rows of their own. */
  self?: boolean
  /** A level or root that was not looked inside. */
  level?: boolean
  label?: string
  originPath?: string | null
  storeDir?: string
}

function put(ctx: LedgerCtx, p: string, d: Disposition, o: PutOptions): void {
  ctx.ledger.add({
    path: p,
    storeDir: o.storeDir ?? path.dirname(p),
    covers: o.self === true && d.kind === 'measured' ? 'self' : 'tree',
    item: o.item,
    mayHideCopies: o.level === true && d.kind === 'unmeasured',
    label: o.label ?? path.basename(p),
    originPath: o.originPath ?? null,
    where: o.where,
    disposition: d,
  })
}

/** A directory's own inode, unless something (an anomaly) already accounts for it. */
function putSelf(ctx: LedgerCtx, p: string, where: LedgerWhere): void {
  if (!ctx.ledger.has(p)) put(ctx, p, selfDisposition(p), { item: null, where, self: true })
}

/** A listed copy: what the classifier measured, or `vanished` when it is gone. */
function copyDisposition(p: string, m: Measured): Disposition {
  const st = lstatOr(p)
  return 'kind' in st ? st : fromMeasured(m)
}

/**
 * Every name under `dir` that has no row gets one. `levelsBelow` counts the
 * store levels still under `dir` (0: `dir` is an op dir or area, its names are
 * entries). `isLevel` is the lister's own rule for which names at a level are
 * level directories: in a parked area a dot-name is an entry, never an op dir.
 */
function sweep(
  ctx: LedgerCtx,
  dir: string,
  levelsBelow: number,
  whereAt: (p: string) => LedgerWhere,
  isLevel: (name: string) => boolean
): void {
  let names: Buffer[]
  try {
    names = fs.readdirSync(dir, { encoding: 'buffer' }).sort(Buffer.compare)
  } catch (err) {
    if (errCode(err) !== 'ENOENT') ctx.ledger.downgrade(dir, `unreadable (${errCode(err)})`)
    return
  }
  for (const raw of names) {
    const n = raw.toString('utf8')
    const p = path.join(dir, n)
    if (!utf8Clean(raw)) {
      // No string reaches it: it is never gone, and what it holds is not measured.
      if (!ctx.ledger.has(p)) {
        const d: Disposition = { kind: 'unmeasured', reason: NOT_UTF8, partial: null }
        put(ctx, p, d, { item: null, where: whereAt(p), level: true })
      }
      continue
    }
    const row = ctx.ledger.get(p)
    if (row !== undefined) {
      if (row.covers === 'self' && levelsBelow > 0) sweep(ctx, p, levelsBelow - 1, whereAt, isLevel)
      continue
    }
    if (levelsBelow === 0 || !isLevel(n)) {
      put(ctx, p, entryDisposition(p, ctx.measureOf), { item: null, where: whereAt(p) })
      continue
    }
    const st = lstatOr(p)
    if (!('kind' in st) && st.isDirectory() && !st.isSymbolicLink()) {
      putSelf(ctx, p, whereAt(p))
      sweep(ctx, p, levelsBelow - 1, whereAt, isLevel)
      continue
    }
    const d = levelDisposition(p, 'not reached by the listing', ctx.measureOf)
    put(ctx, p, d, { item: null, where: whereAt(p), level: true })
  }
}

/** An anomaly: a level the lister did not go into, or an entry it does not recognise. */
function putAnomaly(
  ctx: LedgerCtx,
  a: Anomaly,
  atLevel: boolean,
  where: LedgerWhere,
  storeDir?: string
): void {
  const d = atLevel
    ? levelDisposition(a.path, a.detail, ctx.measureOf)
    : entryDisposition(a.path, ctx.measureOf)
  put(ctx, a.path, d, {
    item: 'entry',
    where,
    level: atLevel,
    ...(storeDir === undefined ? {} : { storeDir }),
  })
}

/** One parked area (`l` is null when the area was skipped). */
export function ledgerParkedArea(
  ctx: LedgerCtx,
  ref: AreaRef,
  l: ParkedAreaListing | null,
  rows: readonly ParkedRow[]
): void {
  const where = whereOf('parked', { skillsRoot: ref.skillsRoot })
  if (l === null || ref.skipped !== undefined) {
    const d: Disposition = {
      kind: 'unmeasured',
      reason: ref.skipped ?? SYMLINK_LEVEL,
      partial: null,
    }
    put(ctx, ref.root, d, { item: 'entry', where, level: true })
    return
  }
  if (l.absent) {
    put(ctx, ref.areaDir, { kind: 'exempt', reason: 'absent' }, { item: null, where })
    return
  }
  if (l.refused !== null) {
    const d: Disposition = { kind: 'unmeasured', reason: l.refused, partial: null }
    put(ctx, ref.areaDir, d, { item: 'entry', where, level: true, storeDir: ref.root })
    return
  }
  for (const r of rows) {
    const sidecarClient = r.classification.sidecar?.['client']
    put(ctx, r.copy.copyPath, copyDisposition(r.copy.copyPath, r.classification.measured), {
      item: 'copy',
      where: whereOf('parked', {
        skillsRoot: ref.skillsRoot,
        sidecarClient: typeof sidecarClient === 'string' ? sidecarClient : null,
      }),
      label: r.copy.opId,
      originPath: r.origin,
    })
  }
  for (const lo of l.leftovers) {
    put(ctx, lo.S, entryDisposition(lo.S, ctx.measureOf), { item: 'entry', where })
  }
  for (const o of l.orphanSidecars) {
    put(ctx, o, entryDisposition(o, ctx.measureOf), { item: 'entry', where })
  }
  for (const a of l.anomalies) {
    // An op dir is a non-dot name directly in the area; everything else is an entry.
    const atLevel =
      a.path === ref.areaDir ||
      (path.dirname(a.path) === ref.areaDir && !path.basename(a.path).startsWith('.'))
    putAnomaly(ctx, a, atLevel, where)
  }
  putSelf(ctx, ref.areaDir, where)
  sweep(
    ctx,
    ref.areaDir,
    1,
    () => where,
    (n) => !n.startsWith('.')
  )
}

/** Where a path in the backup store sits: its `<client>` and `<rootKey>` segments. */
function backupWhere(updateDir: string, p: string, sidecarSkillsDir: string | null = null) {
  const rel = path.relative(updateDir, p)
  const segs = rel === '' ? [] : rel.split(path.sep)
  return whereOf('backup', {
    client: segs[0] ?? null,
    rootKey: segs[1] ?? null,
    sidecarSkillsDir,
  })
}

/** One update backup store. `rows` maps each area's path to its classified trees. */
export function ledgerBackupStore(
  ctx: LedgerCtx,
  store: BackupStoreListing,
  rows: ReadonlyMap<string, readonly BackupRow[]>
): void {
  const u = store.updateDir
  const at = (p: string) => backupWhere(u, p)
  if (store.absent) {
    put(ctx, u, { kind: 'exempt', reason: 'absent' }, { item: null, where: at(u) })
    return
  }
  if (store.refused !== null) {
    const d: Disposition = { kind: 'unmeasured', reason: store.refused, partial: null }
    put(ctx, u, d, { item: 'entry', where: at(u), level: true })
    return
  }
  // Every store-level anomaly is a level: the store itself, a `<client>`, `<rootKey>` or `<dirName>`.
  for (const a of store.anomalies) putAnomaly(ctx, a, true, at(a.path))
  putSelf(ctx, u, at(u))
  for (const a of store.areas) {
    for (const x of a.anomalies) putAnomaly(ctx, x, x.path === a.areaPath, at(x.path))
    putSelf(ctx, a.areaPath, at(a.areaPath))
    for (const r of rows.get(a.areaPath) ?? []) {
      put(ctx, r.copy.copyPath, copyDisposition(r.copy.copyPath, r.classification.measured), {
        item: 'copy',
        where: backupWhere(u, r.copy.copyPath, r.skillsDir),
        label: `${a.dirName}/${r.copy.name}`,
      })
    }
    for (const t of a.temps) {
      put(ctx, t.path, entryDisposition(t.path, ctx.measureOf), {
        item: 'entry',
        where: at(t.path),
      })
    }
    for (const lo of a.leftovers) {
      put(ctx, lo.S, entryDisposition(lo.S, ctx.measureOf), { item: 'entry', where: at(lo.S) })
    }
    for (const o of a.orphanSidecars) {
      put(ctx, o, entryDisposition(o, ctx.measureOf), { item: 'entry', where: at(o) })
    }
  }
  // Every name at a backup level is a level directory (`prune.list.backups.ts`).
  sweep(ctx, u, 3, at, () => true)
}

/** The old MCP store of one Claude Code root. Returns its size when it is listed as a store. */
export function ledgerMcpStore(ctx: LedgerCtx, root: string, p: string): Measured | null {
  const where = whereOf('mcp', { skillsRoot: root })
  const st = lstatOr(p)
  if ('kind' in st) {
    // Gone before it was looked at is the same as never there: a store root that is absent.
    const d: Disposition = st.kind === 'exempt' ? { kind: 'exempt', reason: 'absent' } : st
    put(ctx, p, d, { item: d.kind === 'exempt' ? null : 'older-store', where, level: true })
    return null
  }
  if (st.isSymbolicLink()) {
    const d: Disposition = { kind: 'unmeasured', reason: SYMLINK_LEVEL, partial: null }
    put(ctx, p, d, { item: 'older-store', where, level: true })
    return null
  }
  const m = ctx.measureOf(p)
  put(ctx, p, fromMeasured(m), { item: 'older-store', where, label: '.backups' })
  return m
}

/** Legacy `.skillsmith-removing-*` leftovers: listed, never counted (D7). */
export function ledgerLegacy(
  ctx: LedgerCtx,
  root: string,
  paths: readonly string[],
  unreadable: string | null
): void {
  const where = whereOf('legacy', { skillsRoot: root })
  const d: Disposition = { kind: 'exempt', reason: 'legacy-leftover' }
  for (const p of paths) put(ctx, p, d, { item: 'older-store', where })
  // What a failed scan of the root could have found is legacy leftovers only, exempt by D7. The
  // marker sits at a key of its own: an exempt row never stands for the root or anything under it.
  if (unreadable !== null)
    put(ctx, `${root}:legacy-scan`, d, { item: 'older-store', where, storeDir: root })
}

/** A path the index names: accounted already, `absent`, or there and not reached (`unmeasured`). */
function indexNamed(
  ctx: LedgerCtx,
  p: string,
  storeDir: string,
  why: string,
  mayHideCopies: boolean
): void {
  if (ctx.ledger.coverOf(p) !== null) return
  const st = lstatOr(p)
  const d: Disposition =
    'kind' in st
      ? st.kind === 'exempt'
        ? { kind: 'exempt', reason: 'absent' }
        : st
      : { kind: 'unmeasured', reason: why, partial: null }
  put(ctx, p, d, { item: null, where: whereOf('index', {}), level: mayHideCopies, storeDir })
}

/** The parked index: run after every store, so it never counts what a store already did. */
export function ledgerIndex(ctx: LedgerCtx, facts: IndexFacts): void {
  const where = whereOf('index', {})
  for (const u of facts.unreadable) {
    const d: Disposition = {
      kind: 'unmeasured',
      reason: `parked index unreadable (${u.errno}); it may name set-aside folders nothing else reaches`,
      partial: null,
    }
    put(ctx, u.indexPath, d, { item: null, where, level: true, storeDir: u.stateRoot })
  }
  for (const r of facts.rejected) {
    const storeDir = path.dirname(r.indexPath)
    if (r.path !== null && path.isAbsolute(r.path)) {
      // Not a copy's shape, so not a place a set-aside record can be: counted, never protecting.
      indexNamed(
        ctx,
        r.path,
        storeDir,
        'the parked index names it, but it is not a set-aside copy',
        false
      )
      continue
    }
    const d: Disposition = {
      kind: 'unmeasured',
      reason: `malformed parked index line (${r.reason}); the folder it named is unknown`,
      partial: null,
    }
    put(ctx, `${r.indexPath}:${r.line ?? 0}`, d, { item: null, where, level: true, storeDir })
  }
  for (const l of facts.lines) {
    const why = 'named by the parked index, not listed'
    indexNamed(ctx, l.copyPath, path.dirname(l.areaDir), why, true)
  }
}
