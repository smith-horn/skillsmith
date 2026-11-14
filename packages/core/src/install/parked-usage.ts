/**
 * SMI-6531 (A1 step 6c-ii-a): how much the set-aside folders hold per volume,
 * and the warning when it is over the threshold (ADR-166 D-11, UD66), ported
 * from the SMI-6676 spike's `trash-usage.mjs` `trashUsage` / `trashWarning`.
 *
 * It takes the listing's already-measured entries (`prune.measure.ts`) rather
 * than listing anything itself. The total is ALLOCATED bytes, de-duplicated by
 * `(dev, ino)` across every entry on one volume, and a volume is the `st_dev`
 * of the directory an entry sits in (owner decisions D6, D7). Both stores
 * count, and so does the old MCP store `~/.claude/skills/.backups`, which is
 * reported but never selected: its entries arrive here like any other.
 *
 * The threshold per volume is min(1 GB, 5% of that volume's free space). It
 * warns when the total is over it, and ALWAYS names unmeasured entries: the
 * spike stayed silent below half the threshold (SMI-7127), which let an
 * unreadable directory hide. The words are "set-aside folders", never "trash".
 *
 * Read-only. `statfs` is looked up at call time, so a test can inject it.
 *
 * @module @skillsmith/core/install/parked-usage
 */
import fs from 'node:fs'
import path from 'node:path'

/** One measured copy, leftover or old-store entry the warning counts. */
export interface ParkedUsageEntry {
  /** The entry's path, for the "largest" list. */
  path: string
  /** The directory that holds it: the volume is this directory's `st_dev`, and `statfs` runs here. */
  storeDir: string
  /** Allocated bytes per `"<dev>:<ino>"` from `measure()`; hard links across entries count once. */
  units: ReadonlyMap<string, number>
  /** Entries `measure()` could not measure. */
  unmeasured: number
  /** Where the copy came from, or null. */
  originPath: string | null
  /** The op id, or the entry's name: what is shown when there is no origin. */
  opId: string
}

export interface StatfsResult {
  bavail: number | bigint
  bsize: number | bigint
}

export interface ParkedUsageOptions {
  /** Defaults to `fs.statfsSync`, looked up at call time. */
  statfs?: (dir: string) => StatfsResult
  /** The hard cap, bytes. Default 1e9. */
  capBytes?: number
  /** The fraction of a volume's free space. Default 0.05. */
  freeFraction?: number
  /** How many of the largest entries to name. Default 3. */
  top?: number
}

export interface VolumeVerdict {
  /** `st_dev`, or `unknown` when the directory could not be read. */
  dev: string
  storeDir: string
  /** Free bytes on the volume, or null when `statfs` failed (the cap alone then applies). */
  freeBytes: number | null
  thresholdBytes: number
  /** Allocated bytes held, de-duplicated across the volume. A lower bound when `unmeasuredEntries > 0`. */
  heldBytes: number
  unmeasuredEntries: number
  overThreshold: boolean
  /** This volume warns: over the threshold, or part of it could not be measured. */
  warn: boolean
  largest: { path: string; bytes: number; label: string }[]
}

export interface ParkedUsageWarning {
  /** Any volume warns. */
  warn: boolean
  perVolume: VolumeVerdict[]
  /** What to print (to stderr, in the product), or null when nothing warns. */
  message: string | null
}

/** Bytes for people, decimal. `null` is an unknown size. */
export const human = (n: number | null): string =>
  n === null
    ? 'unknown size'
    : n >= 1e9
      ? `${(n / 1e9).toFixed(2)} GB`
      : n >= 1e6
        ? `${(n / 1e6).toFixed(1)} MB`
        : n >= 1e3
          ? `${(n / 1e3).toFixed(1)} KB`
          : `${n} B`

const sumOf = (m: ReadonlyMap<string, number>): number => {
  let n = 0
  for (const v of m.values()) n += v
  return n
}

interface Volume {
  dev: string
  storeDir: string
  entries: ParkedUsageEntry[]
  seen: Map<string, number>
}

/** Groups entries by the `st_dev` of their store directory, unreadable ones apart. */
function byVolume(entries: readonly ParkedUsageEntry[]): Volume[] {
  const vols = new Map<string, Volume>()
  for (const e of entries) {
    let dev: string
    try {
      dev = String(fs.lstatSync(e.storeDir, { bigint: true }).dev)
    } catch {
      dev = `unknown:${e.storeDir}`
    }
    let v = vols.get(dev)
    if (v === undefined) {
      v = {
        dev: dev.startsWith('unknown:') ? 'unknown' : dev,
        storeDir: e.storeDir,
        entries: [],
        seen: new Map(),
      }
      vols.set(dev, v)
    }
    v.entries.push(e)
    for (const [k, b] of e.units) v.seen.set(k, b)
  }
  return [...vols.values()]
}

function freeBytesOf(
  dir: string,
  statfs: NonNullable<ParkedUsageOptions['statfs']>
): number | null {
  try {
    const s = statfs(dir)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return null
  }
}

const labelOf = (e: ParkedUsageEntry): string =>
  e.originPath !== null ? path.basename(e.originPath) : e.opId

/** Judges each volume. `warn` is `heldBytes > min(cap, fraction x free)` OR any unmeasured entry. */
export function judgeParkedUsage(
  entries: readonly ParkedUsageEntry[],
  { statfs, capBytes = 1e9, freeFraction = 0.05, top = 3 }: ParkedUsageOptions = {}
): VolumeVerdict[] {
  const statfsAt = statfs ?? ((p: string): StatfsResult => fs.statfsSync(p))
  return byVolume(entries).map((v) => {
    const freeBytes = freeBytesOf(v.storeDir, statfsAt)
    const thresholdBytes =
      freeBytes === null ? capBytes : Math.min(capBytes, freeFraction * freeBytes)
    const heldBytes = sumOf(v.seen)
    const unmeasuredEntries = v.entries.reduce((n, e) => n + e.unmeasured, 0)
    const overThreshold = heldBytes > thresholdBytes
    const largest = v.entries
      .map((e) => ({ path: e.path, bytes: sumOf(e.units), label: labelOf(e) }))
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, top)
    return {
      dev: v.dev,
      storeDir: v.storeDir,
      freeBytes,
      thresholdBytes,
      heldBytes,
      unmeasuredEntries,
      overThreshold,
      warn: overThreshold || unmeasuredEntries > 0,
      largest,
    }
  })
}

function sentence(p: VolumeVerdict): string {
  const n = p.unmeasuredEntries
  const held =
    n > 0
      ? `at least ${human(p.heldBytes)}; ${n} ${n === 1 ? 'entry' : 'entries'} could not be measured ` +
        `(warning level ${human(p.thresholdBytes)})`
      : `${human(p.heldBytes)}, over the ${human(p.thresholdBytes)} warning level`
  const big = p.largest.map((c) => `${c.label} ${human(c.bytes)} (${c.path})`).join(', ')
  return (
    `Skillsmith's set-aside folders on this disk hold ${held}. ` +
    (big === '' ? '' : `Largest: ${big}. `) +
    'Nothing is deleted automatically. See every set-aside folder with `skillsmith doctor backups`.'
  )
}

/**
 * Evaluates the entries: the verdict per volume and the message to print. The
 * message is null only when no volume is over its threshold and every entry
 * measured.
 */
export function evaluateParkedUsage(
  entries: readonly ParkedUsageEntry[],
  options: ParkedUsageOptions = {}
): ParkedUsageWarning {
  const perVolume = judgeParkedUsage(entries, options)
  const warning = perVolume.filter((p) => p.warn)
  if (warning.length === 0) return { warn: false, perVolume, message: null }
  return { warn: true, perVolume, message: warning.map(sentence).join('\n') }
}
