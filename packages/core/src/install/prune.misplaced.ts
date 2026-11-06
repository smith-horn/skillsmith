/**
 * SMI-6531 (A1 step 6c-i, pre-merge gate F1): misplacement records, and the
 * rule that a misplaced entry is never deleted (ADR-166 D-11, R-misplace;
 * owner decision 2026-11-06).
 *
 * When the delete walk renames an entry to a random name and finds a
 * different inode there, it stops and records the entry's exact path and
 * original name. Each misplacement gets its own record,
 * `S/misplaced-<16 hex>.json` (`wx`), so two can never collide; the legacy
 * single `S/misplaced.json` is still read.
 *
 * While any record names a path that still exists, the leftover is
 * `misplaced-pending`: the listing offers no resume and the walker refuses one,
 * until the user moves each entry out by hand. A record whose path is gone no
 * longer blocks; a resumed run removes it with the rest of S's metadata.
 *
 * If no record can be written (a full device), the walker renames its
 * `deleting` marker to `misplaced-unrecorded`, which blocks every resume until
 * the user inspects `S` and removes the marker by hand. A rename needs no new
 * data blocks, so it can succeed where the write failed. If that fails too,
 * the result says so (`misplacedRecordError`, `misplacedMarkerError`).
 *
 * fs is the DEFAULT export, looked up at call time. Nothing here deletes.
 *
 * @module @skillsmith/core/install/prune.misplaced
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { errCode, errCodeOrMessage } from './park-result.js'
import { readStable } from './prune.sidecar.js'
import { renameNoReplace } from './prune.walk.shared.js'
import type { MetaRecord } from './prune.metadata.js'

export const MISPLACED_RECORD_RE = /^misplaced-[0-9a-f]{16}\.json$/
export const LEGACY_MISPLACED = 'misplaced.json'
/** The marker that blocks every resume when a misplacement could not be recorded. */
export const UNRECORDED_MARKER = 'misplaced-unrecorded'
const RECORD_MAX_BYTES = 64 * 1024

export const isMisplacedRecordName = (n: string): boolean =>
  n === LEGACY_MISPLACED || MISPLACED_RECORD_RE.test(n)

/** One misplaced entry, as its record names it. */
export interface MisplacedEntry {
  path: string
  originalRel: string
  cause: string
}

export interface MisplacedState {
  /** Why no resume may run now; empty when none blocks. */
  blocking: string[]
  /** Records whose path is gone: removable metadata, by the record each was read as. */
  cleared: Record<string, MetaRecord>
  /** Every readable record's entry, for the listing. */
  entries: MisplacedEntry[]
}

const isEntry = (v: unknown): v is MisplacedEntry => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const o = v as Record<string, unknown>
  return (
    typeof o.path === 'string' &&
    path.isAbsolute(o.path) &&
    typeof o.originalRel === 'string' &&
    typeof o.cause === 'string'
  )
}

/**
 * What the misplacement records in `S` (whose entries are `names`) say.
 * An unreadable or malformed record blocks, failing closed: its entry might
 * still exist.
 */
export function misplacedState(S: string, names: readonly string[]): MisplacedState {
  const out: MisplacedState = { blocking: [], cleared: {}, entries: [] }
  if (names.includes(UNRECORDED_MARKER)) {
    out.blocking.push(
      `a misplacement could not be recorded; inspect ${S} for .d-<hex> entries, move each out by hand, then remove ${path.join(S, UNRECORDED_MARKER)}`
    )
  }
  for (const name of names.filter(isMisplacedRecordName).sort()) {
    const p = path.join(S, name)
    const rs = readStable(p, { maxBytes: RECORD_MAX_BYTES })
    let rec: unknown = null
    try {
      rec = rs.ok ? JSON.parse(rs.bytes.toString('utf8')) : null
    } catch {
      rec = null
    }
    if (!rs.ok || !isEntry(rec)) {
      out.blocking.push(`${p}: an unreadable misplacement record; inspect ${S} by hand`)
      continue
    }
    out.entries.push({ path: rec.path, originalRel: rec.originalRel, cause: rec.cause })
    try {
      fs.lstatSync(rec.path)
      out.blocking.push(`${rec.path} (originally ${rec.originalRel}): move it out by hand`)
    } catch (err) {
      if (errCode(err) === 'ENOENT') {
        out.cleared[name] = { ino: String(rs.ino), bytes: rs.bytes.toString('base64') }
      } else {
        out.blocking.push(
          `${rec.path} (originally ${rec.originalRel}): unreadable (${errCode(err)})`
        )
      }
    }
  }
  return out
}

/** The outcome of recording one misplacement. */
export interface RecordOutcome {
  recordError: string | null
  markerError: string | null
}

/**
 * Records one misplacement in its own `wx` record. On failure, renames
 * `S/deleting` to `S/misplaced-unrecorded` so no later resume runs.
 */
export function recordMisplacement(S: string, rec: object): RecordOutcome {
  const name = `misplaced-${crypto.randomBytes(8).toString('hex')}.json`
  try {
    fs.writeFileSync(path.join(S, name), JSON.stringify(rec, null, 2), { flag: 'wx' })
    return { recordError: null, markerError: null }
  } catch (err) {
    const recordError = errCodeOrMessage(err)
    try {
      renameNoReplace(path.join(S, 'deleting'), path.join(S, UNRECORDED_MARKER))
      return { recordError, markerError: null }
    } catch (e) {
      return { recordError, markerError: errCodeOrMessage(e) }
    }
  }
}
