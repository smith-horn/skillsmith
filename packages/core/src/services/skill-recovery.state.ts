/**
 * SMI-6531 (A1 step 6a-ii): what doctor's one-device actions hold while they
 * mutate: a `SwapState` built from a verified record (`recoveryState`), the
 * op dir it adopts (`adoptOp`), the metadata files it may unlink
 * (`adoptMetadata`), and the one way it unlinks them (`unlinkAdopted`).
 * Design `step6a-design.md` § 4 "Adoption", "`recoveryState`".
 *
 * Doctor did not write the metadata it removes, so `unlinkOwned` (which needs
 * this run's own binding) does not apply. Instead each metadata file is
 * adopted from the re-plan's transcript: its identity (dev, ino, birthtime,
 * file type) and the sha256 of its bytes, both as the classifier read them
 * under lock 1. `unlinkAdopted` re-checks both immediately before the unlink:
 * `check`, a no-follow open, `fstat` identity equal, the bytes' sha256 equal,
 * close, `unlink`. A file rewritten in place (same inode, new bytes) refuses
 * and stays untouched. The window between that byte check and the `unlink` is
 * the plan's §3.0 item 9 residual (no `unlinkat`).
 *
 * @module @skillsmith/core/services/skill-recovery.state
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { BoundIdentity } from '../install/park-tree.identity.js'
import { O_NOFOLLOW } from '../utils/safe-fs.js'
import { createManifestPort } from './skill-manifest.port.js'
import { backupAreaPath } from './skill-swap.area.js'
import { check, codeOf, SwapFault, trace } from './skill-swap.ops.js'
import type { SwapState } from './skill-swap.ops.js'
import type { ManifestPort, RecordIdentity, SwapOptions, SwapRecord } from './skill-swap.types.js'
import type { ReadTranscript } from './skill-recovery.types.js'
import type { SkillsRootBinding, SkillWriteContext } from './skill-write-lock.types.js'

/** A metadata file doctor may unlink: the identity and byte hash the re-plan read. */
export interface Adopted {
  path: string
  identity: RecordIdentity
  sha256: string
}

/** The bigint identity of a record's decimal-string one. */
export function boundOf(id: RecordIdentity): BoundIdentity {
  return {
    ok: true,
    dev: BigInt(id.dev),
    ino: BigInt(id.ino),
    birthtimeNs: BigInt(id.birthtimeNs),
    fmt: BigInt(id.fmt),
  }
}

/**
 * Adopts `file` from `transcript`: the classifier's last complete (not
 * truncated) `readFile` of it, with both its identity and its byte hash. A
 * bounded read that stopped at its cap hashed only part of the file, so it
 * cannot vouch for the bytes. Throws `SwapFault('staging-unsafe')` when the
 * re-plan did not read the whole file.
 */
export function adoptMetadata(transcript: ReadTranscript, file: string): Adopted {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const e = transcript[i]!
    if (e.method !== 'readFile' || e.key !== file) continue
    const f = e.fact as {
      ok: boolean
      identity?: RecordIdentity
      sha256?: string
      truncated?: boolean
    }
    if (!f.ok) break
    if (f.truncated === true) continue
    if (f.identity !== undefined && typeof f.sha256 === 'string') {
      return { path: file, identity: f.identity, sha256: f.sha256 }
    }
  }
  throw new SwapFault('staging-unsafe', `${file} was not read by the re-plan, so it is not adopted`)
}

const sameRecordId = (a: RecordIdentity, b: RecordIdentity): boolean =>
  a.fmt !== '' &&
  a.fmt === b.fmt &&
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.birthtimeNs === b.birthtimeNs

/** The bound metadata files never exceed this; a larger file is not the one adopted. */
const ADOPT_CAP = 2 * 1024 * 1024

/** The file's identity and the sha256 of all its bytes, read without following a link. */
function fingerprint(p: string): { identity: RecordIdentity; sha256: string } {
  const fd = fs.openSync(p, fs.constants.O_RDONLY | O_NOFOLLOW | (fs.constants.O_NONBLOCK ?? 0))
  try {
    const st = fs.fstatSync(fd, { bigint: true })
    const identity: RecordIdentity = {
      dev: st.dev.toString(),
      ino: st.ino.toString(),
      birthtimeNs: st.birthtimeNs.toString(),
      fmt: (st.mode & 0o170000n).toString(),
    }
    const buf = Buffer.alloc(Math.min(Number(st.size) + 1, ADOPT_CAP))
    let got = 0
    while (got < buf.length) {
      const n = fs.readSync(fd, buf, got, buf.length - got, got)
      if (n === 0) break
      got += n
    }
    return {
      identity,
      sha256: crypto.createHash('sha256').update(buf.subarray(0, got)).digest('hex'),
    }
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Unlinks an adopted metadata file, and only that file: `check`, then its
 * identity and byte hash must still be the adopted ones. Anything else (a
 * replacement, a rewrite in place, nothing) stops with `reason` and is left
 * untouched.
 */
export async function unlinkAdopted(
  st: SwapState,
  a: Adopted,
  reason: 'staging-unsafe' | 'backup-unsafe' = 'staging-unsafe'
): Promise<void> {
  check(st)
  let now: { identity: RecordIdentity; sha256: string }
  try {
    now = fingerprint(a.path)
  } catch (err) {
    throw new SwapFault(
      reason,
      `${a.path} could not be re-read (${codeOf(err)}); left untouched`,
      err
    )
  }
  if (!sameRecordId(now.identity, a.identity) || now.sha256 !== a.sha256) {
    throw new SwapFault(
      reason,
      `${a.path} is not the file the plan read (its identity or bytes changed); it was left untouched`
    )
  }
  await fs.promises.unlink(a.path)
  trace(st, { op: 'unlink', path: a.path })
}

export interface RecoveryStateInput {
  record: SwapRecord
  binding: SkillsRootBinding
  ctx: SkillWriteContext
  options: SwapOptions
  /** `--accept-identity`: the identities observed now, used for every later re-check. */
  identities?: { old?: RecordIdentity; new?: RecordIdentity }
  /** @internal Test seam: replaces the record's `createManifestPort`. */
  manifest?: ManifestPort
}

/**
 * A `SwapState` for a recorded update, the second constructor beside
 * `newState`: the input comes from the record (`writeSet: []`, `stateRoot =
 * dirname(manifestPath)`, the manifest port from its entries), the op dir is
 * adopted with the record's `opDirIdentity`, and lock 1 is already held.
 */
export function recoveryState(i: RecoveryStateInput): SwapState {
  const rec = i.record
  const t = rec.target
  const stateRoot = path.dirname(t.manifestPath)
  let stateRootReal: string
  try {
    stateRootReal = fs.realpathSync.native(stateRoot)
  } catch {
    stateRootReal = path.resolve(stateRoot)
  }
  const ports = { manifestPath: t.manifestPath, manifestKey: t.manifestKey }
  const oldId = boundOf(i.identities?.old ?? rec.oldIdentity)
  const opDir = path.join(i.binding.stagingDir, rec.opId)
  return {
    input: {
      skillsDir: t.skillsDir,
      client: t.client,
      scope: t.scope,
      stateRoot,
      manifestPath: t.manifestPath,
      manifestKey: t.manifestKey,
      comparedPath: t.comparedPath,
      realDir: t.realDir,
      dirName: t.dirName,
      oldIdentity: oldId,
      preTree: rec.preTree,
      writeSet: [],
      preEntry: rec.preEntry,
      postEntry: rec.postEntry,
      manifest:
        i.manifest ??
        createManifestPort({ ...ports, preEntry: rec.preEntry, postEntry: rec.postEntry }),
    },
    options: i.options,
    opId: rec.opId,
    binding: i.binding,
    warnings: [],
    opDir,
    ctx: i.ctx,
    opCreated: false,
    op: adoptOp(opDir, rec),
    area: null,
    buildIdentity: null,
    published: null,
    moveSources: new Map(),
    owner: null,
    newIdentity: boundOf(i.identities?.new ?? rec.newIdentity),
    postTree: rec.postTree,
    postRecord: null,
    stateRootReal,
    areaPath: backupAreaPath(stateRootReal, t.client, i.binding.root, t.dirName),
    backupDest: rec.backupDest,
    recordRemoved: false,
    record: rec,
    owned: new Map(),
    blockedBy: null,
    phase: 'locked',
    step: 'audit',
  }
}

/** OP bound with the record's `opDirIdentity`: every later `check` requires it. */
export function adoptOp(opDir: string, rec: SwapRecord): { path: string; identity: BoundIdentity } {
  return { path: opDir, identity: boundOf(rec.opDirIdentity) }
}
