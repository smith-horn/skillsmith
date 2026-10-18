/**
 * SMI-6531 (A1 step 3a): the parked index, `<stateRoot>/parked-index.jsonl`
 * (ADR-166 D-3, D-9; A1 plan §3.5), ported from the SMI-6676 spike's
 * `trash-index.mjs` (its `.gitignore` suggestion is not part of this port).
 *
 * The index is advisory, never an authority: discovery scans the parked areas
 * and only merges the index, so a copy the index omits is still listed and a
 * line whose copy is gone is not an error.
 *
 * Every write to the index takes lock 4 (UD31) through `park-call.ts`
 * (`parkTreeIndexed`, `appendParkedIndexLocked`, `compactParkedIndexLocked`).
 * The functions here take no lock themselves.
 *
 * @module @skillsmith/core/install/parked-index
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { errCodeOrMessage } from './park-result.js'

/** The index file's name under the state root (UD26). */
export const PARKED_INDEX_FILE = 'parked-index.jsonl'

const FIELDS = ['opId', 'path', 'client', 'rootKey', 'kind', 'bytes', 'createdAt'] as const

export interface ParkedIndexEntry {
  opId: string | null
  path: string
  client: string | null
  rootKey: string | null
  kind: string | null
  bytes: number | null
  createdAt: string | null
}

/**
 * Appends one entry as a single line with O_APPEND and one write(2), so
 * concurrent appenders never interleave inside a line. Throws on failure; the
 * park records it as `indexError` and keeps its status. Takes no lock: call
 * `appendParkedIndexLocked`, so a concurrent compaction cannot drop the line.
 */
export function appendParkedIndex(
  indexPath: string,
  entry: Partial<ParkedIndexEntry> & { path: string }
): void {
  const line: Record<string, unknown> = {}
  for (const k of FIELDS) line[k] = entry[k] ?? null
  if (typeof line.path !== 'string' || !path.isAbsolute(line.path)) {
    throw new TypeError('appendParkedIndex: path must be absolute')
  }
  const buf = Buffer.from(JSON.stringify(line) + '\n', 'utf8')
  const fd = fs.openSync(
    indexPath,
    fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT,
    0o600
  )
  try {
    const n = fs.writeSync(fd, buf, 0, buf.length)
    if (n !== buf.length) throw new Error(`appendParkedIndex: short write ${n}/${buf.length}`)
  } finally {
    fs.closeSync(fd)
  }
}

/** One line of the index as read: its exact text, and its entry when valid. */
export interface ParkedIndexLine {
  raw: string
  /**
   * Null when the line is not JSON, not an object with an absolute `path`, or
   * has another field whose type differs from ParkedIndexEntry's.
   */
  entry: ParkedIndexEntry | null
}

export type ParkedIndexRead =
  | {
      ok: true
      /** False when the index file does not exist (not an error). */
      present: boolean
      entries: ParkedIndexEntry[]
      lines: ParkedIndexLine[]
      errors: { line: number; error: string }[]
    }
  /** The index exists but could not be read; nothing about its contents is known. */
  | { ok: false; present: true; errno: string }

/** A field of an index line that does not have its declared type. */
class InvalidEntry extends Error {}

/** The entry a parsed line describes, or why it is not one. */
function entryOf(line: string): ParkedIndexEntry | string {
  let e: unknown
  try {
    e = JSON.parse(line)
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
  if (e === null || typeof e !== 'object' || Array.isArray(e)) return 'not an object'
  const o: Record<string, unknown> = { ...e }
  const p = o.path
  if (typeof p !== 'string' || !path.isAbsolute(p)) return 'path is not an absolute string'
  // Every other field must have the type ParkedIndexEntry claims; an absent
  // field reads as null. A line that fails is kept verbatim by compaction.
  const str = (k: string): string | null => {
    const v = o[k] ?? null
    if (v === null || typeof v === 'string') return v
    throw new InvalidEntry(`${k} is not a string or null`)
  }
  const num = (k: string): number | null => {
    const v = o[k] ?? null
    if (v === null || (typeof v === 'number' && Number.isFinite(v))) return v
    throw new InvalidEntry(`${k} is not a finite number or null`)
  }
  try {
    return {
      opId: str('opId'),
      path: p,
      client: str('client'),
      rootKey: str('rootKey'),
      kind: str('kind'),
      bytes: num('bytes'),
      createdAt: str('createdAt'),
    }
  } catch (err) {
    if (err instanceof InvalidEntry) return err.message
    throw err
  }
}

/**
 * Reads the index. A read failure other than ENOENT is `ok: false`, never an
 * empty index (UD31: the index may be the only route to a parked copy). A line
 * that is not a valid entry is reported by number and kept in `lines`.
 */
export function readParkedIndex(indexPath: string): ParkedIndexRead {
  let text: string
  try {
    text = fs.readFileSync(indexPath, 'utf8')
  } catch (err) {
    const code = errCodeOrMessage(err)
    if (code === 'ENOENT') return { ok: true, present: false, entries: [], lines: [], errors: [] }
    return { ok: false, present: true, errno: code }
  }
  const entries: ParkedIndexEntry[] = []
  const lines: ParkedIndexLine[] = []
  const errors: { line: number; error: string }[] = []
  const parts = text.split('\n')
  // Only the empty element after a final newline is not a line; an interior
  // empty line is kept verbatim as malformed, like any other invalid line.
  if (parts[parts.length - 1] === '') parts.pop()
  parts.forEach((raw, i) => {
    const e = entryOf(raw)
    if (typeof e === 'string') {
      errors.push({ line: i + 1, error: e })
      lines.push({ raw, entry: null })
    } else {
      entries.push(e)
      lines.push({ raw, entry: e })
    }
  })
  return { ok: true, present: true, entries, lines, errors }
}

export type CompactResult =
  | { ok: true; kept: number; dropped: number; keptMalformed: number }
  /** `tmpPath`: a temp file this compaction may have left; the index is unchanged. */
  | { ok: false; errno: string; tmpPath?: string }

/** Codes that prove the parked copy is gone; any other lstat error keeps its line. */
const GONE = new Set(['ENOENT', 'ENOTDIR'])

/**
 * Drops lines whose parked copy is provably gone (lstat ENOENT or ENOTDIR),
 * via a temp file and rename(2). Every other line is kept verbatim, including
 * a malformed one and one whose lstat failed for any other reason. An index
 * that cannot be read is left untouched and the error is returned.
 *
 * PRECONDITION: the caller holds lock 4 (UD31, withFileLock on the index path),
 * and every append to this index takes the same lock. Without it, a line a
 * concurrent park appends between the read and the rename is lost: O_APPEND does
 * not survive the path being replaced. Call `compactParkedIndexLocked`, which
 * takes the lock.
 */
export function compactParkedIndex(indexPath: string): CompactResult {
  const read = readParkedIndex(indexPath)
  if (!read.ok) return { ok: false, errno: read.errno }
  if (!read.present) return { ok: true, kept: 0, dropped: 0, keptMalformed: 0 }
  let dropped = 0
  let keptMalformed = 0
  const keep = read.lines.filter((l) => {
    if (l.entry === null) {
      keptMalformed += 1
      return true
    }
    try {
      fs.lstatSync(l.entry.path)
      return true
    } catch (err) {
      const gone = GONE.has(errCodeOrMessage(err))
      if (gone) dropped += 1
      return !gone
    }
  })
  const tmp = `${indexPath}.tmp-${crypto.randomBytes(8).toString('hex')}`
  // A failed write or rename leaves the index untouched and returns the error.
  // A temp file left behind is never deleted here (the park graph contains no
  // delete call); prune (A1 step 6) reports and removes Skillsmith's own leftovers.
  try {
    fs.writeFileSync(tmp, keep.map((l) => l.raw + '\n').join(''), { flag: 'wx', mode: 0o600 })
  } catch (err) {
    const errno = errCodeOrMessage(err)
    // EEXIST: the name was taken, so nothing of ours was written there.
    return errno === 'EEXIST' ? { ok: false, errno } : { ok: false, errno, tmpPath: tmp }
  }
  try {
    fs.renameSync(tmp, indexPath)
  } catch (err) {
    return { ok: false, errno: errCodeOrMessage(err), tmpPath: tmp }
  }
  return { ok: true, kept: keep.length - keptMalformed, dropped, keptMalformed }
}
