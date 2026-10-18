/**
 * SMI-6531 (A1 step 3a): the parked index, `<stateRoot>/parked-index.jsonl`
 * (ADR-166 D-3, D-9; A1 plan §3.5), ported from the SMI-6676 spike's
 * `trash-index.mjs` (its `.gitignore` suggestion is not part of this port).
 *
 * The index is advisory, never an authority: discovery scans the parked areas
 * and only merges the index, so a copy the index omits is still listed and a
 * line whose copy is gone is not an error.
 *
 * Appends and compaction take lock 4 (UD31) in the next part of A1 step 3a.
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
 * park records it as `indexError` and keeps its status.
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

export interface ParkedIndexRead {
  /** False when the index file does not exist (not an error). */
  present: boolean
  entries: ParkedIndexEntry[]
  errors: { line: number; error: string }[]
}

/** Reads the index. A malformed line is reported with its number, never thrown. */
export function readParkedIndex(indexPath: string): ParkedIndexRead {
  let text: string
  try {
    text = fs.readFileSync(indexPath, 'utf8')
  } catch (err) {
    const code = errCodeOrMessage(err)
    if (code === 'ENOENT') return { present: false, entries: [], errors: [] }
    return { present: true, entries: [], errors: [{ line: 0, error: code }] }
  }
  const entries: ParkedIndexEntry[] = []
  const errors: { line: number; error: string }[] = []
  text.split('\n').forEach((l, i) => {
    if (l === '') return
    try {
      const e = JSON.parse(l) as unknown
      if (
        e === null ||
        typeof e !== 'object' ||
        typeof (e as { path?: unknown }).path !== 'string'
      ) {
        throw new Error('no path')
      }
      entries.push(e as ParkedIndexEntry)
    } catch (err) {
      errors.push({ line: i + 1, error: err instanceof Error ? err.message : String(err) })
    }
  })
  return { present: true, entries, errors }
}

/**
 * Drops entries whose path no longer exists, via a temp file and rename(2).
 * Must run under lock 4 (UD31) once that lock exists.
 */
export function compactParkedIndex(indexPath: string): { kept: number; dropped: number } {
  const { present, entries } = readParkedIndex(indexPath)
  if (!present) return { kept: 0, dropped: 0 }
  const keep = entries.filter((e) => {
    try {
      fs.lstatSync(e.path)
      return true
    } catch {
      return false
    }
  })
  const tmp = `${indexPath}.tmp-${crypto.randomBytes(8).toString('hex')}`
  fs.writeFileSync(tmp, keep.map((e) => JSON.stringify(e) + '\n').join(''), {
    flag: 'wx',
    mode: 0o600,
  })
  fs.renameSync(tmp, indexPath)
  return { kept: keep.length, dropped: entries.length - keep.length }
}
