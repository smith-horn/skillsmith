/**
 * SMI-6531 (A1 step 6c-ii-a): the accounting ledger behind `doctor backups`
 * and its space warning.
 *
 * The requirement: nothing the listing can see, or knows it could not see, may
 * be absent from both the listing and the warning's accounting. So every path
 * the listing touches gets exactly one ledger row with exactly one
 * disposition:
 *
 *  - `measured`: its allocated bytes (de-duplicated by `(dev, ino)` per volume
 *    by the warning);
 *  - `unmeasured`: with a reason, when it was refused, could not be read, is a
 *    symlink where a store directory belongs, or its size walk did not finish;
 *  - `exempt`: only for a reason in the closed set {@link ExemptReason}.
 *
 * The warning's entries are produced from these rows and nothing else
 * ({@link usageFromLedger}), and `--root` / `--client` count what they hide
 * from the same rows. No disposition is ever decided from an anomaly's detail
 * text: only from `lstat`, the row's position in the store, and what the
 * lister returned.
 *
 * The rows themselves are built by `skill-backups.ledger.stores.ts`. Read-only.
 *
 * @module @skillsmith/core/services/skill-backups.ledger
 */
import fs from 'node:fs'
import type { BigIntStats } from 'node:fs'
import path from 'node:path'
import { errCode } from '../install/park-result.js'
import type { Measured } from '../install/prune.measure.js'
import type { ParkedUsageEntry } from '../install/parked-usage.js'

/**
 * The only reasons a path may count for nothing. `absent`: it does not exist
 * (a store or area root that was never created, or a path the index names
 * that is not there). `vanished`: a directory listing named it, and it was gone
 * when it was looked at, so it holds nothing. `legacy-leftover`: a
 * `.skillsmith-removing-*` leftover, listed but not counted (owner decision D7).
 */
export type ExemptReason = 'absent' | 'vanished' | 'legacy-leftover'

export type Disposition =
  | { kind: 'measured'; measured: Measured }
  | {
      kind: 'unmeasured'
      reason: string
      /** What a size walk that did not finish did measure: counted as a lower bound. */
      partial: Measured | null
    }
  | { kind: 'exempt'; reason: ExemptReason }

/**
 * What a row is in the listing, which decides how a narrowing counts it when it
 * hides it. `copy` is a set-aside folder or kept backup tree; `entry` is a temp,
 * a `.prune-*` leftover, an orphan sidecar, an anomaly, or a refused or skipped
 * area or store; `older-store` is the old MCP store or a legacy leftover. A
 * `null` row is structure (a directory's own inode, a copy's sidecar) that is
 * accounted but not a listed item of its own.
 */
export type LedgerItem = 'copy' | 'entry' | 'older-store' | null

/** Where a row sits, for narrowing. */
export interface LedgerWhere {
  store: 'parked' | 'backup' | 'mcp' | 'legacy' | 'index'
  /** parked, mcp, legacy: the skills root (null for an area only the index names). */
  skillsRoot: string | null
  /** backup: the `<client>` path segment, when the row is at or under it. */
  client: string | null
  /** backup: the `<rootKey>` path segment, when the row is at or under it. */
  rootKey: string | null
  /** A copy's sidecar `client` (parked) or `skillsDir` (backup), when it parsed. */
  sidecarClient: string | null
  sidecarSkillsDir: string | null
}

export interface LedgerRow {
  path: string
  /** The directory holding it: the warning's volume is this directory's `st_dev`. */
  storeDir: string
  /** `self`: only this directory's own inode (what is below has rows of its own). `tree`: all of it. */
  covers: 'self' | 'tree'
  item: LedgerItem
  /** An area or level that was not looked inside, so it may hold a set-aside record (UD61 (c)). */
  mayHideCopies: boolean
  /** What the warning shows for it when it is among the largest. */
  label: string
  originPath: string | null
  where: LedgerWhere
  disposition: Disposition
}

export const whereOf = (store: LedgerWhere['store'], over: Partial<LedgerWhere>): LedgerWhere => ({
  store,
  skillsRoot: null,
  client: null,
  rootKey: null,
  sidecarClient: null,
  sidecarSkillsDir: null,
  ...over,
})

/** Every row, one per path. */
export class Ledger {
  private readonly byPath = new Map<string, LedgerRow>()
  /** Paths a second row was offered for. Always empty unless a builder is wrong (the invariant test reads it). */
  readonly duplicates: string[] = []

  add(row: LedgerRow): void {
    if (this.byPath.has(row.path)) {
      this.duplicates.push(row.path)
      return
    }
    this.byPath.set(row.path, row)
  }

  has(p: string): boolean {
    return this.byPath.has(p)
  }

  get(p: string): LedgerRow | undefined {
    return this.byPath.get(p)
  }

  /** A directory whose own row said `self` turned out unreadable when its contents were read. */
  downgrade(p: string, reason: string): void {
    const row = this.byPath.get(p)
    if (row === undefined) return
    this.byPath.set(p, {
      ...row,
      covers: 'tree',
      mayHideCopies: true,
      disposition: { kind: 'unmeasured', reason, partial: null },
    })
  }

  /**
   * The row that accounts for `p`: its own, or a `tree` row above it; null when none does.
   * An exempt row says what its OWN path holds and never stands in for another path.
   */
  coverOf(p: string): LedgerRow | null {
    const own = this.byPath.get(p)
    if (own !== undefined) return own
    for (let d = path.dirname(p); ; d = path.dirname(d)) {
      const row = this.byPath.get(d)
      if (row !== undefined && row.covers === 'tree' && row.disposition.kind !== 'exempt')
        return row
      if (path.dirname(d) === d) return null
    }
  }

  rows(): LedgerRow[] {
    return [...this.byPath.values()]
  }
}

/** A size walk's result as a disposition: a walk that did not finish is `unmeasured`, its bytes kept. */
export function fromMeasured(m: Measured): Disposition {
  if (m.unmeasured > 0) {
    return { kind: 'unmeasured', reason: 'the size walk could not finish', partial: m }
  }
  return { kind: 'measured', measured: m }
}

const unreadable = (err: unknown): Disposition => ({
  kind: 'unmeasured',
  reason: `unreadable (${errCode(err) ?? 'error'})`,
  partial: null,
})

/** A name whose bytes are not valid UTF-8 has no string spelling that reaches it. */
export const NOT_UTF8 = 'name is not valid UTF-8; could not be addressed'

/** Whether a directory entry's bytes survive a decode to a string and back. */
export const utf8Clean = (b: Buffer): boolean => Buffer.from(b.toString('utf8')).equals(b)

const VANISHED: Disposition = { kind: 'exempt', reason: 'vanished' }

/**
 * `lstat` said ENOENT for `p`. That proves the name is gone only if the parent,
 * listed again as bytes, no longer has it: a name that is not valid UTF-8 reads
 * back as U+FFFD, and no string reaches it. A parent that is itself gone is
 * judged the same way; a parent that cannot be listed proves nothing.
 */
function goneOrUnreachable(p: string): Disposition {
  const parent = path.dirname(p)
  if (parent === p) return VANISHED
  let names: Buffer[]
  try {
    names = fs.readdirSync(parent, { encoding: 'buffer' })
  } catch (err) {
    return errCode(err) === 'ENOENT' ? goneOrUnreachable(parent) : unreadable(err)
  }
  const base = path.basename(p)
  for (const n of names) {
    if (n.toString('utf8') !== base) continue
    const reason = utf8Clean(n) ? 'listed, but could not be looked at (ENOENT)' : NOT_UTF8
    return { kind: 'unmeasured', reason, partial: null }
  }
  return VANISHED
}

/** `lstat`, as a stat or the disposition its failure gives (ENOENT is `vanished` only once proven). */
export function lstatOr(p: string): BigIntStats | Disposition {
  try {
    return fs.lstatSync(p, { bigint: true })
  } catch (err) {
    return errCode(err) === 'ENOENT' ? goneOrUnreachable(p) : unreadable(err)
  }
}

const isStat = (x: BigIntStats | Disposition): x is BigIntStats => !('kind' in x)

/** One inode's own size: a directory whose contents have rows of their own. */
export function selfDisposition(p: string): Disposition {
  const st = lstatOr(p)
  if (!isStat(st)) return st
  const allocated = Number(st.blocks) * 512
  return {
    kind: 'measured',
    measured: {
      allocatedBytes: allocated,
      apparentBytes: Number(st.size),
      unmeasured: 0,
      units: new Map([[`${st.dev}:${st.ino}`, allocated]]),
    },
  }
}

/** A symlink where a store directory belongs: data may lie behind it, and it is not followed. */
export const SYMLINK_LEVEL = 'a symlink where a store directory belongs; not followed'

/**
 * A name at a store LEVEL (an op dir, a backup `<client>`/`<rootKey>`/`<dirName>`
 * directory) that the lister did not go into. Gone: `vanished`. A symlink, or a
 * directory it refused or could not read: `unmeasured` (`why` is the lister's
 * own words, carried and never parsed). Anything else (a stray file): measured.
 */
export function levelDisposition(
  p: string,
  why: string,
  measureOf: (abs: string) => Measured
): Disposition {
  const st = lstatOr(p)
  if (!isStat(st)) return st
  if (st.isSymbolicLink()) return { kind: 'unmeasured', reason: SYMLINK_LEVEL, partial: null }
  if (st.isDirectory()) return { kind: 'unmeasured', reason: why, partial: null }
  return fromMeasured(measureOf(p))
}

/** A name inside an op dir or backup area that is not a copy: measured as it is, never followed. */
export function entryDisposition(p: string, measureOf: (abs: string) => Measured): Disposition {
  const st = lstatOr(p)
  if (!isStat(st)) return st
  return fromMeasured(measureOf(p))
}

/** The space warning's entries, from the ledger alone: every row that is not exempt. */
export function usageFromLedger(rows: readonly LedgerRow[]): ParkedUsageEntry[] {
  const out: ParkedUsageEntry[] = []
  for (const r of rows) {
    const d = r.disposition
    if (d.kind === 'exempt') continue
    const m = d.kind === 'measured' ? d.measured : d.partial
    out.push({
      path: r.path,
      storeDir: r.storeDir,
      units: m?.units ?? new Map(),
      unmeasured: d.kind === 'measured' ? 0 : Math.max(1, m?.unmeasured ?? 0),
      originPath: r.originPath,
      opId: r.label,
    })
  }
  return out
}
