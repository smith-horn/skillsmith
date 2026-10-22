/**
 * SMI-6531 (A1 step 4a): applying the approved write set inside `new/`, and
 * comparing walk records (A1 plan §3.3 step 1, §3.7).
 *
 * Every write lands in `OP/new`, never in the live folder: a missing parent
 * directory is created there, one component at a time, with its parent's
 * bits (`mkdirWithParentBits`), and each created one is followed by a sync of
 * its parent (T-X7). A `modify` target must already be a regular file with
 * `nlink` 1 in the copy; a `create` target must not exist. A path component
 * that is a symlink in the copy (copied verbatim from the live folder) is
 * refused, so no write goes through a link.
 *
 * @module @skillsmith/core/services/skill-swap.writeset
 */
import fs from 'node:fs'
import path from 'node:path'
import { mkdirWithParentBits } from '../install/mkdir-parent-bits.js'
import type { TreeRecord, TreeRecordEntry } from '../install/tree-hash.js'
import { O_NOFOLLOW, writeFullBuffer } from '../utils/safe-fs.js'
import {
  check,
  lstatOrNull,
  messageOf,
  SwapFault,
  syncDir,
  trace,
  writeNewFile,
} from './skill-swap.ops.js'
import type { SwapState } from './skill-swap.ops.js'
import { SkillWriteStop } from './skill-write-lock.types.js'
import type { SwapWriteEntry } from './skill-swap.types.js'

/** What the write set did inside `new/`. */
export interface WriteSetOutcome {
  /** Relative paths of the directories it created. */
  createdDirs: Set<string>
  /** Absolute paths of every directory it wrote an entry in (to sync). */
  touchedDirs: Set<string>
}

const fault = (detail: string, cause?: unknown): SwapFault =>
  new SwapFault('write-failed', detail, cause)

/** A relative path with no empty, `.` or `..` component, not absolute. */
export function validRel(rel: string): boolean {
  if (rel === '' || path.isAbsolute(rel) || rel.includes('\0')) return false
  return rel.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
}

/** Creates `rel`'s missing parent directories inside `newDir` (never elsewhere). */
async function ensureParents(
  st: SwapState,
  newDir: string,
  entry: SwapWriteEntry,
  out: WriteSetOutcome
): Promise<void> {
  const segs = entry.rel.split('/')
  let parentAbs = newDir
  for (let i = 0; i < segs.length - 1; i++) {
    const dirRel = segs.slice(0, i + 1).join('/')
    const abs = path.join(newDir, dirRel)
    const existing = await lstatOrNull(abs)
    if (existing !== null) {
      if (existing.isSymbolicLink() || !existing.isDirectory()) {
        throw fault(`${dirRel} is not a directory in the new folder`)
      }
      parentAbs = abs
      continue
    }
    if (entry.kind === 'modify')
      throw fault(`${entry.rel} is to be modified but ${dirRel} is absent`)
    const parentStat = await fs.promises.lstat(parentAbs, { bigint: true })
    check(st)
    const made = mkdirWithParentBits(abs, Number(parentStat.mode))
    if (!made.ok) throw fault(`${dirRel} could not be created in the new folder (${made.phase})`)
    if (made.created) {
      trace(st, { op: 'mkdir', path: abs })
      out.createdDirs.add(dirRel)
      await syncDir(st, parentAbs)
    }
    for (const w of made.warnings) st.warnings.push({ code: 'mode', path: abs, detail: w })
    parentAbs = abs
  }
}

/** Rewrites an existing regular file with `nlink` 1 in place, then `fsync`s it. */
async function modifyFile(st: SwapState, abs: string, rel: string, bytes: Buffer): Promise<void> {
  check(st)
  // Opened without O_TRUNC: the type and link count are checked on the
  // descriptor before anything is truncated. O_NONBLOCK makes a FIFO fail.
  let fh: fs.promises.FileHandle
  try {
    fh = await fs.promises.open(abs, fs.constants.O_WRONLY | O_NOFOLLOW | fs.constants.O_NONBLOCK)
  } catch (err) {
    throw fault(`${rel} could not be opened for writing (${messageOf(err)})`, err)
  }
  try {
    const s = await fh.stat()
    if (!s.isFile() || s.nlink !== 1) throw fault(`${rel} is not a regular file with one link`)
    await fh.truncate(0)
    await writeFullBuffer(fh, bytes, 0)
    await fh.sync()
    trace(st, { op: 'fsync', path: abs })
  } finally {
    await fh.close().catch(() => undefined)
  }
}

/** Applies the write set to `newDir` (plan §3.3 step 1). Throws `SwapFault('write-failed')`. */
export async function applyWriteSet(st: SwapState, newDir: string): Promise<WriteSetOutcome> {
  const out: WriteSetOutcome = { createdDirs: new Set(), touchedDirs: new Set() }
  const seen = new Set<string>()
  for (const entry of st.input.writeSet) {
    if (!validRel(entry.rel))
      throw fault(`write-set path ${JSON.stringify(entry.rel)} is not valid`)
    if (seen.has(entry.rel)) throw fault(`write-set path ${entry.rel} appears twice`)
    seen.add(entry.rel)
    await ensureParents(st, newDir, entry, out)
    const abs = path.join(newDir, entry.rel)
    if (entry.kind === 'modify') {
      await modifyFile(st, abs, entry.rel, entry.bytes)
    } else {
      try {
        await writeNewFile(st, abs, entry.bytes, 0o644)
      } catch (err) {
        if (err instanceof SwapFault || err instanceof SkillWriteStop) throw err
        throw fault(`${entry.rel} could not be created (${messageOf(err)})`, err)
      }
    }
    out.touchedDirs.add(path.dirname(abs))
  }
  return out
}

/** The same projection the §3.4 tree hash uses: no size for a directory, no mode for a link. */
function projection(e: TreeRecordEntry): string {
  const content = e.type === 'file' ? e.contentHash : e.type === 'symlink' ? e.linkText : ''
  const mode = e.type === 'symlink' ? '' : String(e.mode)
  const size = e.type === 'dir' ? '' : String(e.size)
  return `${e.type}\0${mode}\0${size}\0${content}`
}

/** Relative paths whose entry differs between two walk records, or exists in only one; sorted. */
export function changedPaths(a: TreeRecord, b: TreeRecord): string[] {
  const out: string[] = []
  for (const rel of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(rel)
    const y = b.get(rel)
    if (x === undefined || y === undefined || projection(x) !== projection(y)) out.push(rel)
  }
  return out.sort()
}

/**
 * The new folder differs from the copy only in the write set (plan §3.7 item
 * 5): every changed path is a write-set file (now a regular file) or a
 * directory the write set created. Returns the offending paths.
 */
export function outsideWriteSet(
  copy: TreeRecord,
  built: TreeRecord,
  writeSet: ReadonlyArray<SwapWriteEntry>,
  createdDirs: ReadonlySet<string>
): string[] {
  const files = new Set(writeSet.map((e) => e.rel))
  const bad: string[] = []
  for (const rel of changedPaths(copy, built)) {
    const now = built.get(rel)
    if (files.has(rel) && now?.type === 'file') continue
    if (createdDirs.has(rel) && now?.type === 'dir') continue
    bad.push(rel)
  }
  for (const rel of files) if (built.get(rel)?.type !== 'file') bad.push(rel)
  return [...new Set(bad)].sort()
}
