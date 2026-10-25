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
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { FullDeviceStage, RecordIdentity, SwapRecord } from './skill-swap.types.js'
import { RECORD_FILE } from './skill-swap.types.js'

/** sha256 of the record's JSON without `recordSha256`, in the record's fixed key order. */
export function computeRecordSha256(record: Omit<SwapRecord, 'recordSha256'>): string {
  const ordered: Omit<SwapRecord, 'recordSha256'> = {
    schema: record.schema,
    opId: record.opId,
    pid: record.pid,
    host: record.host,
    uid: record.uid,
    target: {
      comparedPath: record.target.comparedPath,
      realDir: record.target.realDir,
      skillsDir: record.target.skillsDir,
      manifestPath: record.target.manifestPath,
      manifestKey: record.target.manifestKey,
      client: record.target.client,
    },
    rootIdentity: record.rootIdentity,
    opDirIdentity: record.opDirIdentity,
    oldIdentity: record.oldIdentity,
    newIdentity: record.newIdentity,
    preTree: record.preTree,
    postTree: record.postTree,
    preEntry: record.preEntry,
    postEntry: record.postEntry,
    backupDest: record.backupDest,
    // Explicit key order, like every other field (governance round 4).
    ...(record.fullDevice === undefined
      ? {}
      : {
          fullDevice: {
            cause: record.fullDevice.cause,
            stage: record.fullDevice.stage,
            area: record.fullDevice.area,
            opId: record.fullDevice.opId,
            dest: record.fullDevice.dest,
          },
        }),
  }
  const idOrder = (i: RecordIdentity): RecordIdentity => ({
    dev: i.dev,
    ino: i.ino,
    birthtimeNs: i.birthtimeNs,
    fmt: i.fmt,
  })
  ordered.rootIdentity = idOrder(ordered.rootIdentity)
  ordered.opDirIdentity = idOrder(ordered.opDirIdentity)
  ordered.oldIdentity = idOrder(ordered.oldIdentity)
  ordered.newIdentity = idOrder(ordered.newIdentity)
  return crypto.createHash('sha256').update(JSON.stringify(ordered)).digest('hex')
}

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

/** Far above any record step 5 writes (its manifest entries are small). */
export const MAX_RECORD_BYTES = 1024 * 1024

const errnoOf = (err: unknown): string => {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' && code !== '' ? code : 'UNKNOWN'
}

const TOP_KEYS = [
  'schema',
  'opId',
  'pid',
  'host',
  'uid',
  'target',
  'rootIdentity',
  'opDirIdentity',
  'oldIdentity',
  'newIdentity',
  'preTree',
  'postTree',
  'preEntry',
  'postEntry',
  'backupDest',
  'recordSha256',
] as const
const TARGET_KEYS = [
  'comparedPath',
  'realDir',
  'skillsDir',
  'manifestPath',
  'manifestKey',
  'client',
] as const
const IDENTITY_KEYS = ['dev', 'ino', 'birthtimeNs', 'fmt'] as const
const MARKER_KEYS = ['cause', 'stage', 'area', 'opId', 'dest'] as const
const STAGES: ReadonlySet<string> = new Set<FullDeviceStage>([
  'copy',
  'partial-keep',
  'sidecar-rewrite',
  'final-rename',
  'final-sync',
])

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** `v` has every one of `keys`, and no own key outside `keys` and `optional`. */
function hasExactKeys(
  v: Record<string, unknown>,
  keys: readonly string[],
  optional: readonly string[] = []
): boolean {
  const own = Object.keys(v)
  return (
    keys.every((k) => Object.hasOwn(v, k)) &&
    own.every((k) => keys.includes(k) || optional.includes(k))
  )
}

const allStrings = (v: Record<string, unknown>, keys: readonly string[]): boolean =>
  keys.every((k) => typeof v[k] === 'string')

/** The record's shape is exactly schema 1's (`SwapRecord`, `skill-swap.types.ts`). */
export function isSwapRecord(v: unknown): v is SwapRecord {
  if (!isObject(v) || !hasExactKeys(v, TOP_KEYS, ['fullDevice'])) return false
  if (v.schema !== 1 || !Number.isInteger(v.pid) || !Number.isInteger(v.uid)) return false
  if (!allStrings(v, ['opId', 'host', 'preTree', 'postTree', 'backupDest', 'recordSha256'])) {
    return false
  }
  const t = v.target
  if (!isObject(t) || !hasExactKeys(t, TARGET_KEYS) || !allStrings(t, TARGET_KEYS)) return false
  for (const k of ['rootIdentity', 'opDirIdentity', 'oldIdentity', 'newIdentity'] as const) {
    const id = v[k]
    if (!isObject(id) || !hasExactKeys(id, IDENTITY_KEYS) || !allStrings(id, IDENTITY_KEYS)) {
      return false
    }
  }
  if (v.fullDevice === undefined) return true
  const m = v.fullDevice
  return (
    isObject(m) &&
    hasExactKeys(m, MARKER_KEYS) &&
    allStrings(m, MARKER_KEYS) &&
    (m.cause === 'ENOSPC' || m.cause === 'EDQUOT') &&
    STAGES.has(m.stage as string)
  )
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

/** One op dir's `record.json`, judged against `root` (see the module comment). */
async function judge(root: string, opId: string, file: string): Promise<Verdict> {
  const unreadable = (why: UnreadableRecordWhy, errno?: string): Verdict => ({
    kind: 'unreadable',
    record: { opId, path: file, why, ...(errno === undefined ? {} : { errno }) },
  })
  let bytes: Buffer
  let handle: fs.promises.FileHandle
  try {
    // `O_NONBLOCK`: opening a FIFO would otherwise wait for a writer forever,
    // under lock 1. It changes nothing for a regular file.
    handle = await fs.promises.open(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
    )
  } catch (err) {
    // No record: a crash before step 5, which never blocks (§3.3).
    if (errnoOf(err) === 'ENOENT') return { kind: 'none' }
    return unreadable('open-failed', errnoOf(err))
  }
  try {
    if (!(await handle.stat()).isFile()) return unreadable('not-a-file')
    // A bounded read, not `readFile`: that reads to EOF, so a record that grew
    // after a size check would still be read whole, under lock 1.
    bytes = await readAtMost(handle, MAX_RECORD_BYTES + 1)
  } catch (err) {
    return unreadable('open-failed', errnoOf(err))
  } finally {
    await handle.close().catch(() => undefined)
  }
  const v = verifyRecordBytes(bytes, root, opId)
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

/** Why bytes that were read are not this root's record (every reason after the read). */
export type RecordBytesWhy = Exclude<UnreadableRecordWhy, 'open-failed' | 'not-a-file'>

/**
 * Every check the scan makes after reading a record's bytes: the size cap,
 * JSON, the schema-1 shape, the hash recomputed from the parsed body, the op
 * dir's name and the root. Step 5 and the full-device rewrite run it on the
 * exact bytes they then write, so a record they publish is one the scan
 * accepts (owner decision 2026-10-25, retro of PR #3162).
 */
export function verifyRecordBytes(
  bytes: Buffer,
  root: string,
  opId: string
): { ok: true; record: SwapRecord } | { ok: false; why: RecordBytesWhy } {
  if (bytes.length > MAX_RECORD_BYTES) return { ok: false, why: 'too-large' }
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch {
    return { ok: false, why: 'not-json' }
  }
  if (!isSwapRecord(parsed)) return { ok: false, why: 'malformed' }
  const { recordSha256, ...body } = parsed
  if (computeRecordSha256(body) !== recordSha256) return { ok: false, why: 'hash-mismatch' }
  if (parsed.opId !== opId) return { ok: false, why: 'foreign-op-dir' }
  if (parsed.target.skillsDir !== root) return { ok: false, why: 'foreign-root' }
  return { ok: true, record: parsed }
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
