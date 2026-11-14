/**
 * SMI-6531 (A1 step 6c-ii-a): which `.skillsmith-parked` areas `doctor backups`
 * scans, and how the parked index merges into what the scan found (PLAN
 * 1752-1759, 2046; UD22; SPIKE Q6 and Q8).
 *
 * Areas come from the directory scan first: `<root>/.skillsmith-parked` and
 * `<root>/.skillsmith-staging/.skillsmith-parked` for every discovered skills
 * root. The index only ADDS areas the scan cannot reach (an area under a
 * folder discovery never named, such as an `author init --path` target), and
 * only for a line whose path is exactly `<area>/<opId>/<name>-<8 hex>` under
 * a directory named `.skillsmith-parked`. A line that names anything else is
 * neither listed nor counted: it is reported as rejected. The index is
 * advisory (parked-index.ts): a copy with no line is still listed, `missing`,
 * and a line whose copy is gone is `stale`, never an error.
 *
 * Index paths are compared by native real path of the area, so a symlinked
 * spelling of the same area matches (Q6). Read-only: it takes no lock and
 * writes nothing.
 *
 * @module @skillsmith/core/services/skill-backups.areas
 */
import fs from 'node:fs'
import path from 'node:path'
import { PARKED_INDEX_FILE, readParkedIndex } from '../install/parked-index.js'
import type { ParkedIndexEntry } from '../install/parked-index.js'
import { PARKED_DIR } from '../install/prune.list.parked.js'

/** The staging directory under a skills root (`skill-swap` ST). */
export const STAGING_DIR = '.skillsmith-staging'

/** Where a scanned area was found. */
export type AreaOrigin = 'root' | 'staging' | 'indexed'

export interface AreaRef {
  /** The directory `.skillsmith-parked` sits in. */
  root: string
  areaDir: string
  origin: AreaOrigin
  /** The discovered skills root this area belongs to, or null for an index-only area. */
  skillsRoot: string | null
}

const realOr = (p: string): string => {
  try {
    return fs.realpathSync(p)
  } catch {
    return p
  }
}

/** The areas the directory scan covers: each root's own and its staging directory's. */
export function scannedAreas(roots: readonly string[]): AreaRef[] {
  const out: AreaRef[] = []
  const seen = new Set<string>()
  const add = (root: string, origin: AreaOrigin, skillsRoot: string | null): void => {
    const areaDir = path.join(realOr(root), PARKED_DIR)
    if (seen.has(areaDir)) return
    seen.add(areaDir)
    out.push({ root: realOr(root), areaDir, origin, skillsRoot })
  }
  for (const r of roots) {
    add(r, 'root', r)
    add(path.join(r, STAGING_DIR), 'staging', r)
  }
  return out
}

/** The parts of an index path that names a parked copy, or null when it names anything else. */
export function parkedCopyParts(p: string): { areaDir: string; opId: string; name: string } | null {
  if (!path.isAbsolute(p)) return null
  const name = path.basename(p)
  const opDir = path.dirname(p)
  const areaDir = path.dirname(opDir)
  if (path.basename(areaDir) !== PARKED_DIR) return null
  if (!/^.+-[0-9a-f]{8}$/.test(name)) return null
  const opId = path.basename(opDir)
  if (opId === '' || opId.startsWith('.') || opId === PARKED_DIR) return null
  if (path.dirname(areaDir) === areaDir) return null
  return { areaDir, opId, name }
}

/** An index path with its area resolved to the native real path (the copy itself may be gone). */
export function normalisedCopyPath(p: string): string {
  const parts = parkedCopyParts(p)
  if (parts === null) return p
  return path.join(realOr(parts.areaDir), parts.opId, parts.name)
}

export interface IndexedLine {
  stateRoot: string
  indexPath: string
  entry: ParkedIndexEntry
  /** `entry.path` with its area at the native real path. */
  copyPath: string
  /** The area, at its native real path. */
  areaDir: string
}

export interface RejectedIndexLine {
  indexPath: string
  /** 1-based line number, when the line is known. */
  line: number | null
  path: string | null
  reason: string
}

export interface IndexFacts {
  /** Index files read (present or absent), one per state root. */
  reads: { stateRoot: string; indexPath: string; present: boolean }[]
  lines: IndexedLine[]
  rejected: RejectedIndexLine[]
  /** Indexes that exist but could not be read (D13): never silence. */
  unreadable: { stateRoot: string; indexPath: string; errno: string }[]
}

/** Reads every state root's parked index. Never creates one. */
export function readIndexes(stateRoots: readonly string[]): IndexFacts {
  const facts: IndexFacts = { reads: [], lines: [], rejected: [], unreadable: [] }
  for (const stateRoot of stateRoots) {
    const indexPath = path.join(stateRoot, PARKED_INDEX_FILE)
    const read = readParkedIndex(indexPath)
    if (!read.ok) {
      facts.unreadable.push({ stateRoot, indexPath, errno: read.errno })
      continue
    }
    facts.reads.push({ stateRoot, indexPath, present: read.present })
    read.lines.forEach((l, i) => {
      if (l.entry === null) {
        const why = read.errors.find((e) => e.line === i + 1)?.error ?? 'not a valid entry'
        facts.rejected.push({ indexPath, line: i + 1, path: null, reason: why })
        return
      }
      const parts = parkedCopyParts(l.entry.path)
      if (parts === null) {
        facts.rejected.push({
          indexPath,
          line: i + 1,
          path: l.entry.path,
          reason: `not <area>/<opId>/<name>-<8 hex> under a ${PARKED_DIR} directory`,
        })
        return
      }
      facts.lines.push({
        stateRoot,
        indexPath,
        entry: l.entry,
        copyPath: normalisedCopyPath(l.entry.path),
        areaDir: realOr(parts.areaDir),
      })
    })
  }
  return facts
}

/** Areas only the index names: one per distinct real area dir not already scanned. */
export function indexOnlyAreas(facts: IndexFacts, scanned: readonly AreaRef[]): AreaRef[] {
  const known = new Set(scanned.map((a) => a.areaDir))
  const out: AreaRef[] = []
  for (const l of facts.lines) {
    if (known.has(l.areaDir)) continue
    known.add(l.areaDir)
    out.push({
      root: path.dirname(l.areaDir),
      areaDir: l.areaDir,
      origin: 'indexed',
      skillsRoot: null,
    })
  }
  return out
}

export interface StaleIndexLine {
  line: IndexedLine
  reason: 'copy-gone' | 'area-not-listed'
}

/**
 * Splits the index lines by whether the scan found their copy. `present` is
 * the set of real copy paths found. A line whose area was refused or absent
 * is `area-not-listed`, so a refused area never reads as a deleted copy.
 */
export function staleLines(
  facts: IndexFacts,
  present: ReadonlySet<string>,
  listedAreas: ReadonlySet<string>
): StaleIndexLine[] {
  const out: StaleIndexLine[] = []
  for (const line of facts.lines) {
    if (present.has(line.copyPath)) continue
    out.push({ line, reason: listedAreas.has(line.areaDir) ? 'copy-gone' : 'area-not-listed' })
  }
  return out
}
