/**
 * SMI-6531 (A1 step 6c-i): the one job a prune parent passes its walker child
 * on stdin (ADR-166 D-11), ported from the SMI-6676 spike's `prune.job.mjs`.
 * bigints travel as decimal strings and sidecar bytes as base64.
 *
 * Two shapes (F1 re-derived, owner decision 2026-11-06):
 *  - a fresh job approves one copy: `klass` (the D-11 class the listing gave
 *    it), `authorization` (`batch` for the batch yes, `per-item` for the
 *    per-item yes that `--allow-changed <path>` asks for), the tree hash the
 *    user approved, and the root's and sidecar's identity. The walker refuses
 *    a non-clean copy whose job does not say `per-item`, so a batch yes never
 *    covers it unless the parent labels the job per-item;
 *  - a resume job approves nothing new. It names a leftover `S` and the digest
 *    of the inventory the user was shown (`inventorySha256`); the walker
 *    deletes only entries matching that inventory, which the first run wrote.
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

interface JobBase {
  /** The copy's name; it keeps this name inside the staging directory. */
  leaf: string
  klass: PruneClass
  authorization: PruneAuthorization
  /** The directory the walker makes (or made) its `.prune-<16 hex>` staging directory in. */
  stagingRoot: string
  /** The copy's own directory, removed at the end if it is then empty. */
  opDir: string
}

/** A fresh job: one approved copy, not yet staged. */
export interface FreshJob extends JobBase {
  S?: null
  copyPath: string
  /** Its sidecar's path, `<copyPath>.json`, or null when it has none. */
  sidecarPath: string | null
  sidecarRead: SidecarRead | null
  rootIdentity: RootIdentity
  /** The tree hash the user approved (the recorded hash, or the listing's fresh hash per item). */
  approvedHash: string
}

/** A resume job: the leftover `S`, bound to the inventory the user was shown. */
export interface ResumeJob extends JobBase {
  S: string
  /** `S/<leaf>`: where the staged root was put (it may now sit at a `.d-` name). */
  copyPath: string
  /** sha256 of the `S/inventory.json` bytes the listing showed. */
  inventorySha256: string
  /** Metadata the parent inspected in that leftover, which this run may remove if unchanged. */
  inheritedMeta?: Record<string, MetaRecord>
}

export type PruneJob = FreshJob | ResumeJob

export const isResume = (job: PruneJob): job is ResumeJob => typeof job.S === 'string'

/** The job as JSON carries it. */
export type EncodedJob =
  | (Omit<FreshJob, 'rootIdentity' | 'sidecarRead'> & {
      rootIdentity: Record<keyof RootIdentity, string>
      sidecarRead: null | Record<keyof SidecarRead, string>
    })
  | ResumeJob

export function encodeJob(job: PruneJob): EncodedJob {
  if (isResume(job)) return { ...job }
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

/** What both shapes share: strings, the class and authorization, absolute paths, a plain leaf. */
function checkBase(raw: Record<string, unknown>): void {
  for (const k of ['copyPath', 'leaf', 'stagingRoot', 'opDir']) {
    if (typeof raw[k] !== 'string') fail(`${k} must be a string`)
  }
  if (typeof raw.klass !== 'string' || !CLASSES.has(raw.klass)) {
    fail(`klass must be one of ${[...CLASSES].join(', ')}`)
  }
  if (typeof raw.authorization !== 'string' || !AUTHORIZATIONS.has(raw.authorization)) {
    fail(`authorization must be one of ${[...AUTHORIZATIONS].join(', ')}`)
  }
  for (const k of ['copyPath', 'stagingRoot', 'opDir']) {
    if (!path.isAbsolute(raw[k] as string)) fail(`${k} must be an absolute path`)
  }
  const leaf = raw.leaf as string
  try {
    assertPathSegment('leaf', leaf)
  } catch (err) {
    fail((err as Error).message)
  }
  if (META.has(leaf) || RANDOM_NAME_RE.test(leaf) || leaf.startsWith('inventory.json')) {
    fail(`leaf ${JSON.stringify(leaf)} is one of prune's own names`)
  }
}

/** A resume job: `S` in `stagingRoot`, `copyPath` `S/<leaf>`, the inventory digest, per-item only. */
function decodeResume(raw: Record<string, unknown>): ResumeJob {
  for (const k of ['approvedHash', 'rootIdentity', 'sidecarRead', 'sidecarPath']) {
    if (raw[k] !== undefined) fail(`a resume job carries no ${k}: it approves nothing new`)
  }
  const S = raw.S as string
  const stagingRoot = raw.stagingRoot as string
  if (!PRUNE_DIR_RE.test(path.basename(S)) || path.dirname(S) !== stagingRoot) {
    fail('S must be a .prune-<16 hex> directory directly in stagingRoot')
  }
  if (raw.copyPath !== path.join(S, raw.leaf as string)) fail('with S, copyPath must be S/<leaf>')
  // The intent's op dir is on disk, out of reach of this fs-free decode; the
  // walker checks opDir against the intent (`checkResume`).
  const opDir = raw.opDir as string
  if (opDir !== S && opDir !== stagingRoot && path.dirname(opDir) !== stagingRoot) {
    fail('with S, opDir must be S, stagingRoot, or a directory directly in stagingRoot')
  }
  if (typeof raw.inventorySha256 !== 'string' || !HASH.test(raw.inventorySha256)) {
    fail('a resume job must carry inventorySha256, 64 lowercase hex')
  }
  if (raw.authorization !== 'per-item') fail('a resume is approved per item only')
  if (raw.inheritedMeta !== undefined) {
    if (!isObj(raw.inheritedMeta)) fail('inheritedMeta must be an object')
    for (const [k, v] of Object.entries(raw.inheritedMeta as Record<string, unknown>)) {
      if (!INHERITABLE.has(k))
        fail(`inheritedMeta may hold only intent.json and deleting, not ${k}`)
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
  return raw as unknown as ResumeJob
}

/** A fresh job: the copy's own name and directory, its sidecar beside it, the approved hash. */
function decodeFresh(raw: Record<string, unknown>): FreshJob {
  for (const k of ['inventorySha256', 'inheritedMeta']) {
    if (raw[k] !== undefined) fail(`${k} needs S`)
  }
  if (raw.sidecarPath !== null && typeof raw.sidecarPath !== 'string') {
    fail('sidecarPath must be a string or null')
  }
  const copyPath = raw.copyPath as string
  if (path.basename(copyPath) !== raw.leaf) fail('leaf must be the copy name')
  if (raw.sidecarPath !== null && raw.sidecarPath !== `${copyPath}.json`) {
    fail('a fresh copy’s sidecarPath must be <copyPath>.json or null')
  }
  if (raw.opDir !== path.dirname(copyPath)) fail("opDir must be the copy's own directory")
  if (typeof raw.approvedHash !== 'string' || !HASH.test(raw.approvedHash)) {
    fail('approvedHash must be 64 lowercase hex')
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
  return {
    ...(raw as unknown as FreshJob),
    rootIdentity: {
      dev: big(ri, 'dev', 'rootIdentity'),
      ino: big(ri, 'ino', 'rootIdentity'),
      birthtimeNs: big(ri, 'birthtimeNs', 'rootIdentity'),
      fmt: big(ri, 'fmt', 'rootIdentity'),
    },
    sidecarRead,
  }
}

/**
 * Decodes and validates a job, fresh or resume, before any filesystem work.
 * Every refusal is a TypeError.
 */
export function decodeJob(raw: unknown): PruneJob {
  if (!isObj(raw)) return fail('not an object')
  if (raw.S !== undefined && raw.S !== null && typeof raw.S !== 'string') {
    fail('S must be a string, null or absent')
  }
  checkBase(raw)
  return typeof raw.S === 'string' ? decodeResume(raw) : decodeFresh(raw)
}
