/**
 * SMI-6531 (A1 step 5): the record scan (plan §3.3 step 3, R1, UD8), shared
 * by the transaction's step 3 and A2's probe (§4.2, §4.3 rows 0b and 3).
 *
 * It reads `ST/<entry>/record.json` for every entry of ST that is a real
 * directory and whose name doesn't start with `.` (the parked area and the
 * clock gate's probes do), and never reads `record.json.tmp`. An entry with
 * no `record.json` never blocks anything (a crash before step 5).
 *
 * A record counts only when it verifies as a record of this root (owner
 * decisions 2026-10-24): opened no-follow as a regular file of at most
 * `MAX_RECORD_BYTES`, valid JSON with
 * exactly the schema-1 keys, a `recordSha256` that matches its body, an
 * `opId` equal to its op dir's name, and a `target.skillsDir` equal to this
 * root. Anything else is **unreadable**: it can't be trusted to name the
 * right skill, so it blocks every write in the root until `doctor recovery
 * --park <opId>` (`recovery-record-unreadable`). A verified record blocks
 * only the skill whose `realDir` or `comparedPath` it names
 * (`recovery-pending`).
 *
 * Read-only: the scan changes nothing, so a crashed state stays exactly as
 * the crash left it for doctor (R1: automatic recovery never mutates).
 *
 * @module @skillsmith/core/services/skill-swap.records
 */
import fs from 'node:fs'
import path from 'node:path'
import { MAX_RECORD_BYTES, verifyRecordBytes } from './skill-swap.record-schema.js'
import { RECORD_FILE } from './skill-swap.types.js'

export {
  computeRecordSha256,
  isSwapRecord,
  MAX_RECORD_BYTES,
  parseRecordBytes,
  verifyRecordBytes,
} from './skill-swap.record-schema.js'
export type { RecordBytesWhy, RecordParseWhy } from './skill-swap.record-schema.js'

/** Why a record is unreadable. Each one blocks the whole skills root. */
export type UnreadableRecordWhy =
  /** `open` or `read` failed (the errno says why: `ELOOP` for a symlink, `ENXIO` for a socket). */
  | 'open-failed'
  /** A directory, FIFO or device: never read. */
  | 'not-a-file'
  /** More than `MAX_RECORD_BYTES`, however long it was when the read began. */
  | 'too-large'
  | 'not-json'
  /** Not exactly the schema-1 keys and types. */
  | 'malformed'
  | 'hash-mismatch'
  /** Its `opId` isn't its op dir's name: a record copied or moved between op dirs. */
  | 'foreign-op-dir'
  /** Its `target.skillsDir` isn't this root: a moved root, or a record copied in. */
  | 'foreign-root'

export interface UnreadableRecord {
  /** The op dir's name (the `opId` doctor's `--park` takes). */
  opId: string
  path: string
  why: UnreadableRecordWhy
  errno?: string
}

/** A record that verified as this root's. */
export interface PendingRecord {
  opId: string
  path: string
  comparedPath: string
  realDir: string
}

export type RecordScan =
  | { ok: true; pending: PendingRecord[]; unreadable: UnreadableRecord[] }
  /** ST could not be listed, or an entry could not be inspected: nothing can be concluded. */
  | { ok: false; path: string; errno: string }

const errnoOf = (err: unknown): string => {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' && code !== '' ? code : 'UNKNOWN'
}

/** Up to `limit` bytes from the start of `handle`, stopping early at EOF. */
async function readAtMost(handle: fs.promises.FileHandle, limit: number): Promise<Buffer> {
  const buf = Buffer.alloc(limit)
  let got = 0
  while (got < limit) {
    const { bytesRead } = await handle.read(buf, got, limit - got, got)
    if (bytesRead === 0) break
    got += bytesRead
  }
  return buf.subarray(0, got)
}

type Verdict =
  | { kind: 'none' }
  | { kind: 'pending'; record: PendingRecord }
  | { kind: 'unreadable'; record: UnreadableRecord }

/** The bytes of a record file, or why there are none (see `readRecordFile`). */
export type RecordFileRead =
  | { ok: true; bytes: Buffer }
  /** No file: a crash before step 5, which never blocks (§3.3). */
  | { ok: false; kind: 'none' }
  | { ok: false; kind: 'unreadable'; why: 'open-failed' | 'not-a-file'; errno?: string }

/**
 * One bounded, no-follow read of a record file: opened `O_NOFOLLOW`, a regular
 * file, at most `MAX_RECORD_BYTES + 1` bytes however long it was when the read
 * began. The scan's `judge` and anything else that reads a record share it.
 */
export async function readRecordFile(file: string): Promise<RecordFileRead> {
  let handle: fs.promises.FileHandle
  try {
    // `O_NONBLOCK`: opening a FIFO would otherwise wait for a writer forever,
    // under lock 1. It changes nothing for a regular file.
    handle = await fs.promises.open(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
    )
  } catch (err) {
    if (errnoOf(err) === 'ENOENT') return { ok: false, kind: 'none' }
    return { ok: false, kind: 'unreadable', why: 'open-failed', errno: errnoOf(err) }
  }
  try {
    if (!(await handle.stat()).isFile()) return { ok: false, kind: 'unreadable', why: 'not-a-file' }
    // A bounded read, not `readFile`: that reads to EOF, so a record that grew
    // after a size check would still be read whole, under lock 1.
    return { ok: true, bytes: await readAtMost(handle, MAX_RECORD_BYTES + 1) }
  } catch (err) {
    return { ok: false, kind: 'unreadable', why: 'open-failed', errno: errnoOf(err) }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** One op dir's `record.json`, judged against `root` (see the module comment). */
async function judge(root: string, opId: string, file: string): Promise<Verdict> {
  const unreadable = (why: UnreadableRecordWhy, errno?: string): Verdict => ({
    kind: 'unreadable',
    record: { opId, path: file, why, ...(errno === undefined ? {} : { errno }) },
  })
  const read = await readRecordFile(file)
  if (!read.ok) {
    return read.kind === 'none' ? { kind: 'none' } : unreadable(read.why, read.errno)
  }
  const v = verifyRecordBytes(read.bytes, root, opId)
  if (!v.ok) return unreadable(v.why)
  return {
    kind: 'pending',
    record: {
      opId,
      path: file,
      comparedPath: v.record.target.comparedPath,
      realDir: v.record.target.realDir,
    },
  }
}

/**
 * Scans `<root>/.skillsmith-staging/` (`stagingDir`) for records. `root` is
 * the skills root as `bindSkillsRoot` binds it (`realpath`), which is what
 * step 5 writes as `target.skillsDir`. An absent ST holds no records.
 */
export async function scanStagingRecords(root: string, stagingDir: string): Promise<RecordScan> {
  let names: string[]
  try {
    names = await fs.promises.readdir(stagingDir)
  } catch (err) {
    if (errnoOf(err) === 'ENOENT') return { ok: true, pending: [], unreadable: [] }
    return { ok: false, path: stagingDir, errno: errnoOf(err) }
  }
  const pending: PendingRecord[] = []
  const unreadable: UnreadableRecord[] = []
  for (const name of names.sort()) {
    if (name.startsWith('.')) continue
    const entry = path.join(stagingDir, name)
    let st: fs.Stats
    try {
      st = await fs.promises.lstat(entry)
    } catch (err) {
      // Gone since the listing (an op dir another run just parked): no record.
      if (errnoOf(err) === 'ENOENT') continue
      return { ok: false, path: entry, errno: errnoOf(err) }
    }
    // Only a real directory is an op dir; a symlink is never followed.
    if (!st.isDirectory()) continue
    const v = await judge(root, name, path.join(entry, RECORD_FILE))
    if (v.kind === 'pending') pending.push(v.record)
    else if (v.kind === 'unreadable') unreadable.push(v.record)
  }
  return { ok: true, pending, unreadable }
}

/**
 * The verified records naming this target: a record's `realDir` or
 * `comparedPath` equal to either of this target's (plan §3.3 step 3).
 */
export function recordsNaming(
  pending: readonly PendingRecord[],
  target: { realDir: string; comparedPath: string }
): PendingRecord[] {
  const mine = new Set([target.realDir, target.comparedPath])
  return pending.filter((r) => mine.has(r.realDir) || mine.has(r.comparedPath))
}
