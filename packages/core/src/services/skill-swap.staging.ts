/**
 * SMI-6531 (A1 step 4a): the operation directory and what goes in it (A1 plan
 * §3.3 "Staging", step 1 and step 5): OP, `owner.json`, the build of `new/`,
 * `record.json`, and the metadata publish they share (also used by the park
 * intent, `skill-swap.abort.ts`).
 *
 * `buildIdentity` is bound by the build's own `mkdir` of `new/`, before
 * anything is copied into it (plan §3.3 step 1), so abort cleanup can tell the
 * tree it built from one put there in its place, even after a partial build.
 *
 * Step 1 runs outside any lock. OP is `ST/<opId>`, made with a plain `mkdir`
 * (an existing entry is `staging-collision`: a random `opId` cannot collide,
 * so whatever is there was planted or copied, and it is not touched). The
 * build copies the live folder with the no-follow copy and then requires the
 * COPY's tree hash to equal `preTree`: that is what catches a change made
 * while the copy ran (the copy is not a snapshot). Step 4's re-hash of the
 * live folder, under lock 1, catches a change made after it.
 *
 * Copy failures map to two reasons: a source that could not be read, changed
 * type or identity mid-copy, or held an unsupported entry is
 * `changed-since-plan` (the plan hashed that same folder cleanly); a
 * destination write failure is `write-failed`.
 *
 * @module @skillsmith/core/services/skill-swap.staging
 */
import fs from 'node:fs'
import os from 'node:os'
import { bindIdentity, identityOf, sameIdentity } from '../install/park-tree.identity.js'
import type { BoundIdentity } from '../install/park-tree.identity.js'
import { S_IFDIR } from '../install/park-tree.perms.js'
import { copyTreeNoFollow, treeHashOf } from './skill-tree.js'
import {
  check,
  codeOf,
  hook,
  opPaths,
  linkChecked,
  messageOf,
  SwapFault,
  syncDir,
  trace,
  unlinkOwned,
  writeNewFile,
} from './skill-swap.ops.js'
import type { SwapState } from './skill-swap.ops.js'
import type {
  RecordIdentity,
  SwapHookPoint,
  SwapRecord,
  SwapRefuseReason,
} from './skill-swap.types.js'
import { computeRecordSha256, MAX_RECORD_BYTES, verifyRecordBytes } from './skill-swap.records.js'
import type { RecordBytesWhy } from './skill-swap.records.js'
import { applyWriteSet, outsideWriteSet } from './skill-swap.writeset.js'

/** The bigint identity as `record.json` stores it (decimal strings). */
export function recordIdentity(id: BoundIdentity): RecordIdentity {
  return {
    dev: id.dev.toString(),
    ino: id.ino.toString(),
    birthtimeNs: id.birthtimeNs.toString(),
    fmt: id.fmt.toString(),
  }
}

/** Plan §3.3 bound paths: OP, made by this call, a real directory. Then sync ST. */
export async function createOp(st: SwapState): Promise<void> {
  check(st)
  try {
    await fs.promises.mkdir(st.opDir, { mode: 0o700 })
  } catch (err) {
    if (codeOf(err) === 'EEXIST') {
      throw new SwapFault('staging-collision', `${st.opDir} already exists; it was not touched`)
    }
    throw new SwapFault('write-failed', `${st.opDir} could not be made (${codeOf(err)})`, err)
  }
  st.opCreated = true
  trace(st, { op: 'mkdir', path: st.opDir })
  let s: fs.BigIntStats
  try {
    s = await fs.promises.lstat(st.opDir, { bigint: true })
  } catch (err) {
    throw new SwapFault('staging-unsafe', `${st.opDir} cannot be inspected`, err)
  }
  if (s.isSymbolicLink() || !s.isDirectory()) {
    throw new SwapFault('staging-unsafe', `${st.opDir} is not a directory`)
  }
  st.op = { path: st.opDir, identity: identityOf(s) }
  await syncDir(st, st.binding.stagingDir)
}

/**
 * Writes `JSON` to `<final>.tmp` and syncs it, links it at `final` (never
 * replacing: an entry already there stops with `staging-unsafe` and is left
 * untouched), unlinks the temp (verified to be the one written), syncs OP.
 * `afterTemp` runs once the temp is synced, before the link (a kill point).
 */
export async function publishJson(
  st: SwapState,
  final: string,
  value: unknown,
  afterTemp?: SwapHookPoint
): Promise<void> {
  await publishBytes(st, final, jsonBytes(value), afterTemp)
}

/** The bytes `publishJson` writes for `value`. */
export const jsonBytes = (value: unknown): Buffer =>
  Buffer.from(JSON.stringify(value, null, 2) + '\n')

/** `publishJson` for bytes already serialized (and, for a record, verified). */
export async function publishBytes(
  st: SwapState,
  final: string,
  bytes: Buffer,
  afterTemp?: SwapHookPoint
): Promise<void> {
  const tmp = `${final}.tmp`
  await writeNewFile(st, tmp, bytes, 0o600)
  if (afterTemp !== undefined) await hook(st, afterTemp)
  try {
    await linkChecked(st, tmp, final)
  } catch (err) {
    if (codeOf(err) === 'EEXIST') {
      throw new SwapFault('staging-unsafe', `${final} already exists; it was left untouched`)
    }
    throw err
  }
  await unlinkOwned(st, tmp, 'staging-unsafe')
  await syncDir(st, st.opDir)
}

/** `owner.json`: `{ pid, host, uid, createdAt }`, written first (plan §3.3 "Staging"). */
export async function writeOwner(st: SwapState): Promise<void> {
  const owner = { pid: process.pid, host: os.hostname(), uid: process.getuid?.() ?? -1 }
  await publishJson(st, opPaths(st).owner, { ...owner, createdAt: new Date().toISOString() })
  st.owner = owner
}

function copyReason(reason: string): SwapRefuseReason {
  return reason === 'write-failed' || reason === 'dest-exists'
    ? 'write-failed'
    : 'changed-since-plan'
}

/**
 * Step 1's build: copy, verify the copy against `preTree`, apply the write
 * set, sync, compute `postTree`, verify only the write set changed, bind
 * `newIdentity`. Throws `SwapFault` / `SkillWriteStop`.
 */
export async function buildNewFolder(st: SwapState): Promise<void> {
  const { newDir } = opPaths(st)
  const { realDir, preTree } = st.input
  check(st)
  const copied = await copyTreeNoFollow(realDir, newDir, {
    // `buildIdentity`: N as the build's own mkdir made it. Abort cleanup keeps
    // or parks N only while N still has it (plan §3.3 abort step 3). What the
    // mkdir made must be a directory; anything else stops the copy before a
    // byte is written into it. `sameIdentity` compares the file type too, so
    // every later check of N against this binding requires a directory.
    afterRootMade: () => {
      const made = bindIdentity(newDir)
      if (!made.ok || made.fmt !== S_IFDIR) {
        throw new SwapFault('write-failed', `${newDir} is not the directory the build made`)
      }
      st.buildIdentity = made
    },
    afterEntry: (rel) => {
      st.options.duringCopy?.(rel)
      check(st)
    },
  })
  if (!copied.ok) {
    throw new SwapFault(
      copyReason(copied.reason),
      `copying the live folder failed (${copied.reason} at ${copied.path})`
    )
  }
  trace(st, { op: 'copy', path: realDir, dest: newDir })
  const buildIdentity = st.buildIdentity
  const copiedId = bindIdentity(newDir)
  if (buildIdentity === null || !copiedId.ok || !sameIdentity(buildIdentity, copiedId)) {
    throw new SwapFault('staging-unsafe', `${newDir} is not the directory the build made`)
  }
  await hook(st, 'afterCopy')

  const copyHash = treeHashOf(newDir)
  if (!copyHash.ok || copyHash.hash !== preTree) {
    throw new SwapFault(
      'changed-since-plan',
      copyHash.ok
        ? 'the live folder changed while it was copied'
        : `the copy could not be hashed (${copyHash.reason} at ${copyHash.path})`
    )
  }

  const ws = await applyWriteSet(st, newDir)
  for (const dir of [...ws.touchedDirs].sort()) await syncDir(st, dir)
  await syncDir(st, st.opDir)

  const built = treeHashOf(newDir)
  if (!built.ok) {
    throw new SwapFault('write-failed', `the new folder could not be hashed (${built.reason})`)
  }
  const stray = outsideWriteSet(copyHash.record, built.record, st.input.writeSet, ws.createdDirs)
  if (stray.length > 0) {
    throw new SwapFault(
      'write-failed',
      `the new folder differs from the old one outside the write set: ${stray.join(', ')}`
    )
  }
  const now = bindIdentity(newDir)
  if (!now.ok || !sameIdentity(buildIdentity, now)) {
    throw new SwapFault('staging-unsafe', `${newDir} changed while it was built`)
  }
  st.newIdentity = now
  st.postTree = built.hash
  st.postRecord = built.record
  await hook(st, 'afterBuild')
}

/** What a seal refusal says to do, by the scan's reason. */
const SEAL_HINT: Partial<Record<RecordBytesWhy, string>> = {
  malformed: 'preEntry and postEntry must be JSON values (null for no entry)',
  'too-large': `the record must be at most ${MAX_RECORD_BYTES} bytes`,
  'hash-mismatch': 'an entry serialized differently between calls',
}

/**
 * Serializes the record once and runs the scan's own checks on those exact
 * bytes (`verifyRecordBytes`), so the bytes written are a record the scan
 * accepts; otherwise publishing it would block every write in the root
 * (`recovery-record-unreadable`). A serialization that throws (a cycle, a
 * `BigInt`) or bytes the scan would refuse (an entry JSON drops, a record over
 * `MAX_RECORD_BYTES`, an entry whose JSON changes between calls) is
 * `write-failed`, before the temp exists. The record returned is the one
 * parsed from those bytes, plain data, so a later rewrite serializes it the
 * same way. A value JSON changes inside an entry (a nested `undefined`, a
 * `NaN`) is recorded as JSON writes it (UD47, an accepted residual).
 */
export function sealRecord(
  body: Omit<SwapRecord, 'recordSha256'>,
  root: string,
  opId: string
): { bytes: Buffer; record: SwapRecord } {
  let bytes: Buffer
  try {
    // The hash serializes the body too, so it is inside the guard.
    bytes = jsonBytes({ ...body, recordSha256: computeRecordSha256(body) })
  } catch (err) {
    throw new SwapFault('write-failed', `the record can't be serialized (${messageOf(err)})`, err)
  }
  const v = verifyRecordBytes(bytes, root, opId)
  if (!v.ok) {
    throw new SwapFault(
      'write-failed',
      `the record would be read as unreadable (${v.why}): ${SEAL_HINT[v.why] ?? 'see its reason'}`
    )
  }
  return { bytes, record: v.record }
}

/** Step 5: `record.json`, published through its temp under lock 1. */
export async function writeRecord(st: SwapState): Promise<void> {
  if (st.op === null || st.newIdentity === null || st.postTree === null) {
    throw new SwapFault('write-failed', 'the record was requested before the build finished')
  }
  const { input } = st
  const body: Omit<SwapRecord, 'recordSha256'> = {
    schema: 1,
    opId: st.opId,
    pid: process.pid,
    host: os.hostname(),
    uid: process.getuid?.() ?? -1,
    target: {
      comparedPath: input.comparedPath,
      realDir: input.realDir,
      skillsDir: st.binding.root,
      manifestPath: input.manifestPath,
      manifestKey: input.manifestKey,
      client: input.client,
    },
    rootIdentity: recordIdentity(st.binding.rootIdentity),
    opDirIdentity: recordIdentity(st.op.identity),
    oldIdentity: recordIdentity(input.oldIdentity),
    newIdentity: recordIdentity(st.newIdentity),
    preTree: input.preTree,
    postTree: st.postTree,
    preEntry: input.preEntry,
    postEntry: input.postEntry,
    backupDest: st.backupDest,
  }
  const sealed = sealRecord(body, st.binding.root, st.opId)
  await publishBytes(st, opPaths(st).record, sealed.bytes)
  st.record = sealed.record
}

/** `skillsmith doctor recovery --clean-staging <opId>`: what a left op dir is cleaned with. */
export const cleanStagingHint = (opId: string): string =>
  `skillsmith doctor recovery --clean-staging ${opId}`
