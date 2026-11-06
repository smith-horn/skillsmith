/**
 * SMI-6531 (A1 step 6c-i): the one job a prune parent passes its walker child
 * on stdin (ADR-166 D-11), ported from the SMI-6676 spike's `prune.job.mjs`.
 * bigints travel as decimal strings and sidecar bytes as base64.
 *
 * The job carries the approval for its one copy: `klass` (the D-11 class the
 * listing gave it) and `authorization` (`batch` for the batch yes, `per-item`
 * for the per-item yes that `--allow-changed <path>` asks for). The walker
 * refuses a non-clean copy whose job does not say `per-item` (`prune.walk.ts`),
 * so a batch yes never covers it unless the parent labels the job per-item.
 *
 * No caller yet: 6c-iii's `--prune --apply` builds and encodes jobs.
 *
 * @module @skillsmith/core/install/prune.job
 */
import path from 'node:path'
import { assertPathSegment } from './park-result.js'
import type { MetaRecord } from './prune.metadata.js'
import { META, PRUNE_DIR_RE, RANDOM_NAME_RE } from './prune.walk.shared.js'

/** The classes a walker may be handed. A mounted copy is never offered, so it is not one. */
export type PruneClass = 'clean' | 'held' | 'changed' | 'unverified'
export type PruneAuthorization = 'batch' | 'per-item'

const CLASSES: ReadonlySet<string> = new Set(['clean', 'held', 'changed', 'unverified'])
const AUTHORIZATIONS: ReadonlySet<string> = new Set(['batch', 'per-item'])
const HASH = /^[0-9a-f]{64}$/
const DECIMAL = /^[0-9]+$/
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
/** The metadata a resumed run may inherit from the leftover the parent inspected. */
const INHERITABLE: ReadonlySet<string> = new Set(['intent.json', 'deleting'])

/** The copy root's identity as the listing bound it, file type included (SMI-7130). */
export interface RootIdentity {
  dev: bigint
  ino: bigint
  birthtimeNs: bigint
  /** `mode & S_IFMT`. */
  fmt: bigint
}

/** The sidecar as the listing stable-read it: the exact bytes and the inode they came from. */
export interface SidecarRead {
  bytes: Buffer
  ino: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}

export interface PruneJob {
  /** The copy to delete (or, with `S`, the staged copy at `S/<leaf>`). */
  copyPath: string
  /** Its sidecar's path, or null when it has none. */
  sidecarPath: string | null
  sidecarRead: SidecarRead | null
  /** The copy's name; it keeps this name inside the staging directory. */
  leaf: string
  rootIdentity: RootIdentity
  /** The tree hash the user approved (the recorded hash, or the listing's fresh hash per item). */
  approvedHash: string
  klass: PruneClass
  authorization: PruneAuthorization
  /** The directory the walker makes its `.prune-<16 hex>` staging directory in. */
  stagingRoot: string
  /** The copy's own directory, removed at the end if it is then empty. */
  opDir: string
  /** A staging directory a crashed run left: resume there instead of staging anew. */
  S?: string | null
  /** The leftover was interrupted mid-delete: its `deleting` marker already exists. */
  resume?: boolean
  /** Metadata the parent inspected in that leftover, which this run may remove if unchanged. */
  inheritedMeta?: Record<string, MetaRecord>
}

/** The job as JSON carries it. */
export type EncodedJob = Omit<PruneJob, 'rootIdentity' | 'sidecarRead'> & {
  rootIdentity: Record<keyof RootIdentity, string>
  sidecarRead: null | Record<keyof SidecarRead, string>
}

export function encodeJob(job: PruneJob): EncodedJob {
  const id = job.rootIdentity
  const sr = job.sidecarRead
  return {
    ...job,
    rootIdentity: {
      dev: String(id.dev),
      ino: String(id.ino),
      birthtimeNs: String(id.birthtimeNs),
      fmt: String(id.fmt),
    },
    sidecarRead:
      sr === null || sr === undefined
        ? null
        : {
            bytes: Buffer.from(sr.bytes).toString('base64'),
            ino: String(sr.ino),
            size: String(sr.size),
            mtimeNs: String(sr.mtimeNs),
            ctimeNs: String(sr.ctimeNs),
          },
  }
}

const fail = (why: string): never => {
  throw new TypeError(`prune job: ${why}`)
}
const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const big = (o: Record<string, unknown>, k: string, label: string): bigint => {
  const v = o[k]
  if (typeof v !== 'string' || !/^-?[0-9]+$/.test(v)) fail(`${label}.${k} must be a decimal string`)
  return BigInt(v as string)
}

/** The paths and names in a job, and how they must relate. */
function checkRelations(raw: Record<string, unknown>): void {
  for (const k of ['copyPath', 'stagingRoot', 'opDir']) {
    if (!path.isAbsolute(raw[k] as string)) fail(`${k} must be an absolute path`)
  }
  if (typeof raw.sidecarPath === 'string' && !path.isAbsolute(raw.sidecarPath)) {
    fail('sidecarPath must be an absolute path or null')
  }
  const leaf = raw.leaf as string
  try {
    assertPathSegment('leaf', leaf)
  } catch (err) {
    fail((err as Error).message)
  }
  if (META.has(leaf) || RANDOM_NAME_RE.test(leaf) || /^misplaced-[0-9a-f]{16}\.json$/.test(leaf)) {
    fail(`leaf ${JSON.stringify(leaf)} is one of prune's own names`)
  }
  if (!HASH.test(raw.approvedHash as string)) fail('approvedHash must be 64 lowercase hex')
  const copyPath = raw.copyPath as string
  const opDir = raw.opDir as string
  const stagingRoot = raw.stagingRoot as string
  if (typeof raw.S === 'string') {
    const S = raw.S
    if (!PRUNE_DIR_RE.test(path.basename(S)) || path.dirname(S) !== stagingRoot) {
      fail('S must be a .prune-<16 hex> directory directly in stagingRoot')
    }
    if (copyPath !== path.join(S, leaf)) fail('with S, copyPath must be S/<leaf>')
    // The intent's original sidecar path and op dir are on disk, out of reach of
    // this fs-free decode; the walker checks both against the intent (`checkResume`).
    if (opDir !== S && opDir !== stagingRoot && path.dirname(opDir) !== stagingRoot) {
      fail('with S, opDir must be S, stagingRoot, or a directory directly in stagingRoot')
    }
  } else {
    if (path.basename(copyPath) !== leaf) fail('leaf must be the copy name')
    if (raw.sidecarPath !== null && raw.sidecarPath !== `${copyPath}.json`) {
      fail('a fresh copy’s sidecarPath must be <copyPath>.json or null')
    }
    if (opDir !== path.dirname(copyPath)) fail("opDir must be the copy's own directory")
    if (raw.resume === true) fail('resume needs S')
    if (raw.inheritedMeta !== undefined) fail('inheritedMeta needs S')
  }
  if (raw.inheritedMeta === undefined) return
  if (!isObj(raw.inheritedMeta)) return fail('inheritedMeta must be an object')
  for (const [k, v] of Object.entries(raw.inheritedMeta)) {
    if (!INHERITABLE.has(k)) fail(`inheritedMeta may hold only intent.json and deleting, not ${k}`)
    const ok =
      isObj(v) &&
      Object.keys(v).sort().join(',') === 'bytes,ino' &&
      typeof v.ino === 'string' &&
      DECIMAL.test(v.ino) &&
      typeof v.bytes === 'string' &&
      BASE64.test(v.bytes)
    if (!ok) fail(`inheritedMeta.${k} must be {ino: decimal, bytes: base64}`)
  }
}

/**
 * Decodes and validates a job: the type of every field the walker reads, and
 * how its paths relate (`checkRelations`): absolute paths, a single-segment
 * leaf that is not one of prune's own names, a 64-hex approved hash, and
 * either a fresh copy (`leaf` its name, `opDir` its directory) or a leftover
 * `S` (a `.prune-<16 hex>` directory directly in `stagingRoot`, holding
 * `S/<leaf>`). Every refusal is a TypeError before any filesystem work.
 */
export function decodeJob(raw: unknown): PruneJob {
  if (!isObj(raw)) return fail('not an object')
  for (const k of ['copyPath', 'leaf', 'approvedHash', 'stagingRoot', 'opDir']) {
    if (typeof raw[k] !== 'string') fail(`${k} must be a string`)
  }
  if (raw.sidecarPath !== null && typeof raw.sidecarPath !== 'string') {
    fail('sidecarPath must be a string or null')
  }
  if (typeof raw.klass !== 'string' || !CLASSES.has(raw.klass)) {
    fail(`klass must be one of ${[...CLASSES].join(', ')}`)
  }
  if (typeof raw.authorization !== 'string' || !AUTHORIZATIONS.has(raw.authorization)) {
    fail(`authorization must be one of ${[...AUTHORIZATIONS].join(', ')}`)
  }
  if (!isObj(raw.rootIdentity)) fail('rootIdentity must be an object')
  const ri = raw.rootIdentity as Record<string, unknown>
  let sidecarRead: SidecarRead | null = null
  if (raw.sidecarRead !== null) {
    if (!isObj(raw.sidecarRead) || typeof raw.sidecarRead.bytes !== 'string') {
      fail('sidecarRead must be null or carry base64 bytes')
    }
    const sr = raw.sidecarRead as Record<string, unknown>
    sidecarRead = {
      bytes: Buffer.from(sr.bytes as string, 'base64'),
      ino: big(sr, 'ino', 'sidecarRead'),
      size: big(sr, 'size', 'sidecarRead'),
      mtimeNs: big(sr, 'mtimeNs', 'sidecarRead'),
      ctimeNs: big(sr, 'ctimeNs', 'sidecarRead'),
    }
  }
  if (raw.S !== undefined && raw.S !== null && typeof raw.S !== 'string') {
    fail('S must be a string, null or absent')
  }
  if (raw.resume !== undefined && typeof raw.resume !== 'boolean') fail('resume must be a boolean')
  checkRelations(raw)
  return {
    ...(raw as unknown as PruneJob),
    rootIdentity: {
      dev: big(ri, 'dev', 'rootIdentity'),
      ino: big(ri, 'ino', 'rootIdentity'),
      birthtimeNs: big(ri, 'birthtimeNs', 'rootIdentity'),
      fmt: big(ri, 'fmt', 'rootIdentity'),
    },
    sidecarRead,
  }
}
