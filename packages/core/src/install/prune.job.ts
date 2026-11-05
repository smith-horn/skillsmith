/**
 * SMI-6531 (A1 step 6c-i): the one job a prune parent passes its walker child
 * on stdin (ADR-166 D-11), ported from the SMI-6676 spike's `prune.job.mjs`.
 * bigints travel as decimal strings and sidecar bytes as base64.
 *
 * The job carries the approval for its one copy: `klass` (the D-11 class the
 * listing gave it) and `authorization` (`batch` for the batch yes, `per-item`
 * for the per-item yes that `--allow-changed <path>` asks for). The walker
 * refuses a non-clean copy whose job does not say `per-item` (`prune.walk.ts`),
 * so a batch yes never covers it, whatever the parent does.
 *
 * No caller yet: 6c-iii's `--prune --apply` builds and encodes jobs.
 *
 * @module @skillsmith/core/install/prune.job
 */
import type { MetaRecord } from './prune.metadata.js'

/** The classes a walker may be handed. A mounted copy is never offered, so it is not one. */
export type PruneClass = 'clean' | 'held' | 'changed' | 'unverified'
export type PruneAuthorization = 'batch' | 'per-item'

const CLASSES: ReadonlySet<string> = new Set(['clean', 'held', 'changed', 'unverified'])
const AUTHORIZATIONS: ReadonlySet<string> = new Set(['batch', 'per-item'])

/** The copy root's identity as the listing bound it. */
export interface RootIdentity {
  dev: bigint
  ino: bigint
  birthtimeNs: bigint
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
    rootIdentity: { dev: String(id.dev), ino: String(id.ino), birthtimeNs: String(id.birthtimeNs) },
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

/** Decodes and validates a job. Every refusal is a TypeError before any filesystem work. */
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
  if (raw.inheritedMeta !== undefined && !isObj(raw.inheritedMeta)) {
    fail('inheritedMeta must be an object')
  }
  return {
    ...(raw as unknown as PruneJob),
    rootIdentity: {
      dev: big(ri, 'dev', 'rootIdentity'),
      ino: big(ri, 'ino', 'rootIdentity'),
      birthtimeNs: big(ri, 'birthtimeNs', 'rootIdentity'),
    },
    sidecarRead,
  }
}
