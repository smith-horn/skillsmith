/**
 * SMI-6531 (A1 step 4a): the transaction's shared state and its traced,
 * checked filesystem wrappers (A1 plan §3.3 `check` and sync rule; T-P4).
 *
 * Every mutation here runs `check` immediately before its syscall, so a caller
 * cannot forget it: R, ST, OP (once made), the lock file (inside lock 1) and
 * the backup-area components (once bound) must still have their bound
 * identities. A swap between that `check` and the syscall is the §3.0 item 9
 * residual: Node has no directory-fd syscalls.
 *
 * Every file this run creates is bound (dev, ino, birthtime, file type) when
 * it is created, and is unlinked only through `unlinkOwned`, which verifies
 * that binding first and leaves anything else untouched. The window between
 * that verification and the `unlink` is the same residual (no `unlinkat`).
 *
 * Each successful mutation and every directory sync is reported to the
 * optional `trace` sink in order (T-P4). A directory sync that `failed` stops
 * the operation (the entry it was to make durable may not survive a crash);
 * `unsupported` is accepted, as in `skill-write-lock.ts`.
 *
 * @module @skillsmith/core/services/skill-swap.ops
 */
import fs from 'node:fs'
import path from 'node:path'
import { LockOrderError } from '../config/lock-tracker.js'
import { syncDirectory } from '../install/dir-sync.js'
import { identityOf, sameIdentity } from '../install/park-tree.identity.js'
import type { BoundIdentity } from '../install/park-tree.identity.js'
import type { TreeRecord } from '../install/tree-hash.js'
import { O_NOFOLLOW, writeFullBuffer } from '../utils/safe-fs.js'
import { checkSkillsRootBinding } from './skill-write-lock.js'
import type { SkillsRootBinding, SkillWriteContext } from './skill-write-lock.types.js'
import {
  NEW_DIR,
  OLD_DIR,
  OWNER_FILE,
  PARK_INTENT_FILE,
  RECORD_FILE,
  UNDONE_DIR,
} from './skill-swap.types.js'
import type {
  SwapHookPoint,
  SwapIncomplete,
  SwapInput,
  SwapOptions,
  SwapWarning,
  TraceOp,
} from './skill-swap.types.js'

/** An expected stop, with the plan's reason word. Mapped to a result by the orchestrator. */
export class SwapFault extends Error {
  constructor(
    readonly reason: string,
    readonly detail: string,
    cause?: unknown
  ) {
    super(`${reason}: ${detail}`, cause === undefined ? {} : { cause })
    this.name = 'SwapFault'
  }
}

/** Which step a failure after the commit belongs to. */
export type PostCommitStep = SwapIncomplete['step']

/** The bound paths and progress of one transaction. */
export interface SwapState {
  readonly input: SwapInput
  readonly options: SwapOptions
  readonly opId: string
  readonly binding: SkillsRootBinding
  readonly warnings: SwapWarning[]
  readonly opDir: string
  /** Set once lock 1 is held: `check` then also verifies the lock file. */
  ctx: SkillWriteContext | null
  /** True once this call's `mkdir` made OP. */
  opCreated: boolean
  op: { path: string; identity: BoundIdentity } | null
  area: Array<{ path: string; identity: BoundIdentity }> | null
  /** N's identity, bound when the build's `mkdir` made `new/` (plan §3.3 step 1). */
  buildIdentity: BoundIdentity | null
  /**
   * The last tree `publishTree` moved, set the moment its rename is known to
   * have happened: a stop in the syncs after it must still report the tree as
   * kept (`skill-swap.abort.ts`).
   */
  published: { src: string; dest: string; kind: string } | null
  /**
   * Across devices (4c): every tree `publishTree` copied and verified, by its
   * name in OP. The verified source stays in OP, which is then parked whole
   * (UD28); `identity` is the source's as bound for its sidecar, `dest` the
   * verified copy's path.
   */
  moveSources: Map<string, { identity: BoundIdentity; dest: string }>
  /** What `owner.json` says, once this run published it (the park intent copies it). */
  owner: { pid: number; host: string; uid: number } | null
  newIdentity: BoundIdentity | null
  postTree: string | null
  postRecord: TreeRecord | null
  /** The native realpath of `stateRoot` (or its resolved path when that fails). */
  stateRootReal: string
  /** `<stateRootReal>/backups/update/<client>/<rootKey>/<dirName>`. */
  areaPath: string
  /** The backup path: resolved before the record is written, the published one once step 12 ran. */
  backupDest: string
  /** True once step 13 unlinked `record.json`: a result must not name it after that. */
  recordRemoved: boolean
  /**
   * The identity of every file `writeNewFile` created, by path: the metadata
   * (`owner.json`, `record.json`) and their temps, the sidecar temp, and every
   * `create` file of the write set inside `new/`. Only the metadata and the
   * temps are ever unlinked, through `unlinkOwned`. A hard link made by
   * `linkChecked` is the same inode, so its new path is bound too.
   */
  owned: Map<string, BoundIdentity>
  /** `staging` → `locked` (lock 1 held) → `swapped` (rename 1 ran) → `committed` (manifest written). */
  phase: 'staging' | 'locked' | 'swapped' | 'committed'
  step: PostCommitStep
}

export const opPaths = (st: SwapState) => ({
  newDir: path.join(st.opDir, NEW_DIR),
  oldDir: path.join(st.opDir, OLD_DIR),
  undoneDir: path.join(st.opDir, UNDONE_DIR),
  record: path.join(st.opDir, RECORD_FILE),
  owner: path.join(st.opDir, OWNER_FILE),
  intent: path.join(st.opDir, PARK_INTENT_FILE),
})

export const codeOf = (err: unknown): string | null => {
  const c = (err as { code?: unknown } | null)?.code
  return typeof c === 'string' ? c : null
}

export const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message : String(err)

/** Plan §3.3 `check`, scoped to what is bound so far. Throws `SkillWriteStop`. */
export function check(st: SwapState): void {
  const scope = {
    ...(st.op === null ? {} : { op: st.op }),
    ...(st.area === null ? {} : { backupArea: st.area }),
  }
  if (st.ctx !== null) st.ctx.check(scope)
  else checkSkillsRootBinding(st.binding, scope)
}

export function trace(st: SwapState, op: TraceOp): void {
  st.options.trace?.(op)
}

export async function hook(st: SwapState, point: SwapHookPoint): Promise<void> {
  await st.options.hooks?.[point]?.()
}

/** `fsync` a directory; `failed` stops the operation (`write-failed`). */
export async function syncDir(st: SwapState, dir: string): Promise<void> {
  const s = await syncDirectory(dir)
  if (s.outcome === 'failed') {
    throw new SwapFault('write-failed', `${dir} could not be synced (${s.code})`, s.error)
  }
  trace(st, { op: 'dirsync', path: dir })
}

export async function renameChecked(st: SwapState, from: string, to: string): Promise<void> {
  check(st)
  await fs.promises.rename(from, to)
  trace(st, { op: 'rename', path: from, dest: to })
}

/** A hard link at `to`; refuses (`EEXIST`) rather than replace anything there. */
export async function linkChecked(st: SwapState, from: string, to: string): Promise<void> {
  check(st)
  await fs.promises.link(from, to)
  const id = st.owned.get(from)
  if (id !== undefined) st.owned.set(to, id)
  trace(st, { op: 'link', path: from, dest: to })
}

/** A lock-order violation is a bug, never an outcome: every catch rethrows it first. */
export function rethrowLockOrder(err: unknown): void {
  if (err instanceof LockOrderError) throw err
}

/**
 * Unlinks a file this run created, and only that file: `p` must still be the
 * inode `writeNewFile` bound (dev, ino, birthtime, file type). Anything else
 * there (a replacement, a link, nothing) stops with `reason` and is left
 * untouched. Node has no `unlinkat` relative to a verified directory, so a
 * swap between this verification and the `unlink` is the plan §3.0 item 9
 * residual.
 */
export async function unlinkOwned(
  st: SwapState,
  p: string,
  reason: 'staging-unsafe' | 'backup-unsafe'
): Promise<void> {
  check(st)
  const bound = st.owned.get(p)
  const now = await lstatOrNull(p)
  if (bound === undefined || now === null || !sameIdentity(bound, identityOf(now))) {
    throw new SwapFault(reason, `${p} is not the file this run wrote; it was left untouched`)
  }
  await fs.promises.unlink(p)
  st.owned.delete(p)
  trace(st, { op: 'unlink', path: p })
}

export async function rmdirChecked(st: SwapState, p: string): Promise<void> {
  check(st)
  await fs.promises.rmdir(p)
  trace(st, { op: 'rmdir', path: p })
}

/**
 * Creates `p` (`O_CREAT|O_EXCL|O_NOFOLLOW`, never through an existing entry),
 * writes all of `bytes` and `fsync`s it before returning: files are synced
 * before they are linked into place (sync rule). A failure leaves what was
 * written; nothing is removed.
 */
export async function writeNewFile(
  st: SwapState,
  p: string,
  bytes: Buffer,
  mode: number
): Promise<void> {
  check(st)
  const fh = await fs.promises.open(
    p,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW,
    mode
  )
  trace(st, { op: 'create', path: p })
  try {
    st.owned.set(p, identityOf(await fh.stat({ bigint: true })))
    await writeFullBuffer(fh, bytes)
    await fh.sync()
    trace(st, { op: 'fsync', path: p })
  } finally {
    await fh.close().catch(() => undefined)
  }
}

/** A bigint `lstat` of `p`, or null when it does not exist. Other errors throw. */
export async function lstatOrNull(p: string): Promise<fs.BigIntStats | null> {
  try {
    return await fs.promises.lstat(p, { bigint: true })
  } catch (err) {
    if (codeOf(err) === 'ENOENT') return null
    throw err
  }
}
