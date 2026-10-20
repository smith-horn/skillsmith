/**
 * SMI-6531 (A1 step 2): lock 1, the per-skills-root write lock, with the root
 * and `.skillsmith-staging/` binding that goes with it (A1 plan §3.2, §3.3).
 *
 * Two phases, because the transaction needs ST bound before the staging build
 * and lock 1 taken after it (plan §3.3 steps 1 and 2):
 *
 *  1. `bindSkillsRoot(skillsDir)`, outside any lock: resolve R (native
 *     `realpath`), bind its identity, create or verify `<R>/.skillsmith-staging/`
 *     with R's permission bits, bind that.
 *  2. `withSkillWriteLock(binding, label, fn)`: take `<R>/.skillsmith-writes.lock`
 *     (rank `'1'`, 30 s, never blocking the event loop), bind the lock file,
 *     `check`, run `fn`. `fn` calls `ctx.check()` before each mutation.
 *
 * The lock file sits inside the root, so every spelling of the root, every
 * state root and every bind mount of it resolves to one file. Nothing slow runs
 * under it: the `.gitignore` hint (one `git check-ignore` pair) runs after
 * release, and only for the run whose `mkdir` created ST.
 *
 * Out of scope here (later steps): OP creation and the record, the backup-area
 * binding, creating an absent root (UD22), `doctor locks` discovery.
 *
 * @module @skillsmith/core/services/skill-write-lock
 */
import fs from 'node:fs'
import path from 'node:path'
import { endedOnUnreadableClaim, withFileLock } from '../config/file-lock.js'
import { LockOrderError } from '../config/lock-tracker.js'
import { StuckLockError } from '../config/owned-lock.js'
import { syncDirectory } from '../install/dir-sync.js'
import { mkdirWithParentBits } from '../install/mkdir-parent-bits.js'
import { modeUnsafeMessage } from '../install/mkdir-parent-bits.policy.js'
import { bindIdentity, identityOf, sameIdentity } from '../install/park-tree.identity.js'
import type { BoundIdentity } from '../install/park-tree.identity.js'
import { stagingGitignoreHint } from './skill-write-lock.gitignore.js'
import {
  SKILL_WRITE_LOCK_BASENAME,
  SkillWriteStop,
  STAGING_DIR_NAME,
} from './skill-write-lock.types.js'
import type {
  CheckScope,
  SkillsRootBinding,
  SkillWriteContext,
  SkillWriteLockOptions,
  SkillWriteResult,
} from './skill-write-lock.types.js'

export * from './skill-write-lock.types.js'

/** `<root>/.skillsmith-writes.lock` and its reclaim lock: what `doctor locks` will list (step 6). */
export function skillsRootLockPaths(root: string): string[] {
  const lock = path.join(root, `${SKILL_WRITE_LOCK_BASENAME}.lock`)
  return [lock, `${lock}.reclaim`]
}

function stop(
  code: 'root-unsafe' | 'root-changed' | 'staging-unsafe' | 'backup-unsafe',
  p: string,
  detail: string,
  cause?: unknown
): SkillWriteStop {
  return new SkillWriteStop({ code, path: p, detail, ...(cause === undefined ? {} : { cause }) })
}

/** Phase 1: bind R and ST. Throws `SkillWriteStop` (`root-unsafe`, `staging-unsafe`). */
export async function bindSkillsRoot(skillsDir: string): Promise<SkillsRootBinding> {
  const dir = path.resolve(skillsDir)
  let root: string
  let rootStat: fs.BigIntStats
  try {
    root = await fs.promises.realpath(dir)
    rootStat = await fs.promises.lstat(root, { bigint: true })
  } catch (err) {
    throw stop('root-unsafe', dir, 'the skills root does not exist or cannot be resolved', err)
  }
  if (!rootStat.isDirectory()) throw stop('root-unsafe', root, 'the skills root is not a directory')
  const rootIdentity = identityOf(rootStat)

  const stagingDir = path.join(root, STAGING_DIR_NAME)
  const made = mkdirWithParentBits(stagingDir, Number(rootStat.mode))
  if (!made.ok) {
    throw stop(
      'staging-unsafe',
      stagingDir,
      made.phase === 'mode-unsafe'
        ? modeUnsafeMessage({
            subject: STAGING_DIR_NAME,
            parent: 'the skills root',
            wanted: made.wanted,
            actual: made.actual,
            reasons: made.reasons,
          })
        : made.errno === null
          ? `${STAGING_DIR_NAME} is not a usable directory (${made.phase})`
          : `${STAGING_DIR_NAME} could not be made (${made.phase}: ${made.errno})`
    )
  }
  let stagingReal: string
  try {
    stagingReal = await fs.promises.realpath(stagingDir)
  } catch (err) {
    throw stop('staging-unsafe', stagingDir, `${STAGING_DIR_NAME} cannot be resolved`, err)
  }
  if (stagingReal !== stagingDir) {
    throw stop('staging-unsafe', stagingDir, `${STAGING_DIR_NAME} resolves to ${stagingReal}`)
  }
  const now = bindIdentity(stagingDir)
  if (!now.ok || !sameIdentity(made.identity, now)) {
    throw stop('staging-unsafe', stagingDir, `${STAGING_DIR_NAME} changed while it was bound`)
  }

  // A created entry is followed by a sync of its parent (plan §3.3). A
  // filesystem that cannot sync a directory is accepted and recorded; any
  // other failure means the entry may not survive a crash, so the write stops.
  const rootSync = made.created ? await syncDirectory(root) : null
  if (rootSync !== null && rootSync.outcome === 'failed') {
    throw stop(
      'staging-unsafe',
      root,
      `the skills root could not be synced after creating ${STAGING_DIR_NAME} (${rootSync.code})`,
      rootSync.error
    )
  }
  return {
    skillsDir: dir,
    root,
    rootIdentity,
    stagingDir,
    stagingIdentity: made.identity,
    stagingCreated: made.created,
    rootSync,
    stagingBits: made.bitsApplied,
    warnings: made.warnings,
  }
}

function mustMatch(
  p: string,
  bound: BoundIdentity,
  code: 'root-changed' | 'staging-unsafe' | 'backup-unsafe',
  what: string
): void {
  const now = bindIdentity(p)
  if (!now.ok || !sameIdentity(bound, now)) {
    throw stop(code, p, `${what} is not the one that was bound`)
  }
}

/**
 * Re-verify what was bound (plan §3.3 `check`): `realpath(skillsDir) === R`; R,
 * ST, the optional OP and backup-area components, and (inside lock 1) the lock
 * file still have their bound identities. Throws `SkillWriteStop`. A swap
 * between a `check` and the syscall it guards is a residual (plan §3.0 item 9).
 */
export function checkSkillsRootBinding(
  binding: SkillsRootBinding,
  scope: CheckScope = {},
  lock?: { path: string; identity: BoundIdentity }
): void {
  let resolved: string
  try {
    resolved = fs.realpathSync.native(binding.skillsDir)
  } catch (err) {
    throw stop('root-changed', binding.skillsDir, 'the skills root no longer resolves', err)
  }
  if (resolved !== binding.root) {
    throw stop('root-changed', binding.skillsDir, `the skills root now resolves to ${resolved}`)
  }
  mustMatch(binding.root, binding.rootIdentity, 'root-changed', 'the skills root')
  if (lock !== undefined) mustMatch(lock.path, lock.identity, 'root-changed', 'the lock file')
  mustMatch(binding.stagingDir, binding.stagingIdentity, 'staging-unsafe', STAGING_DIR_NAME)
  if (scope.op !== undefined) {
    mustMatch(scope.op.path, scope.op.identity, 'staging-unsafe', 'the operation directory')
  }
  for (const part of scope.backupArea ?? []) {
    mustMatch(part.path, part.identity, 'backup-unsafe', 'a backup-area directory')
  }
}

/**
 * `busy` after the wait ended on a claim this user cannot read. Owned-lock's own
 * remedy tells the user to `rm` the lock, which is wrong here: the claim belongs
 * to another user's live writer.
 */
function unreadableClaimDetail(lockPath: string): string {
  return (
    `the write lock at ${lockPath} is held by another user whose claim this user cannot read. ` +
    'Try again later; do not remove the lock file.'
  )
}

/** Bindings whose staging hint has been taken: it is computed once per binding. */
const hintTaken = new WeakSet<SkillsRootBinding>()

/**
 * The staging `.gitignore` hint, for the run whose `mkdir` created ST; null
 * otherwise. Runs after lock 1 is released. The hint is advisory: a failure to
 * compute it is dropped, except a `LockOrderError`, which means it ran under a
 * lock and is a bug to surface.
 */
async function takeStagingHint(binding: SkillsRootBinding): Promise<string | undefined> {
  if (!binding.stagingCreated || hintTaken.has(binding)) return undefined
  hintTaken.add(binding)
  try {
    return (await stagingGitignoreHint(binding.root)) ?? undefined
  } catch (err) {
    if (err instanceof LockOrderError) throw err
    return undefined
  }
}

/**
 * Phase 2: run `fn` holding lock 1 for the bound root. A refusal comes back as
 * `{ ok: false, stop }`: `busy` when lock 1's wait runs out or its claim can't
 * be waited on (`stop.reason` is owned-lock's; `stop.detail` is its remedy, or,
 * for another user's unreadable claim, a retry-later message that says not to
 * remove it), `root-changed` / `staging-unsafe` / `backup-unsafe` from `check`.
 * Anything else `fn` throws, `LockOrderError` and a `StuckLockError` from a lock
 * `fn` took itself included, propagates. A string runs
 * `bindSkillsRoot` first. The result carries the binding's `warnings` (how ST is
 * narrower than R's permission bits) whenever there are any, ok or not.
 */
export async function withSkillWriteLock<T>(
  binding: SkillsRootBinding | string,
  label: string,
  fn: (ctx: SkillWriteContext) => Promise<T>,
  options: SkillWriteLockOptions = {}
): Promise<SkillWriteResult<T>> {
  let bound: SkillsRootBinding
  if (typeof binding === 'string') {
    try {
      bound = await bindSkillsRoot(binding)
    } catch (err) {
      if (err instanceof SkillWriteStop) return { ok: false, stop: err }
      throw err
    }
  } else {
    bound = binding
  }
  const target = path.join(bound.root, SKILL_WRITE_LOCK_BASENAME)
  const lockPath = `${target}.lock`
  let outcome: SkillWriteResult<T>
  // Set as the first statement under lock 1: a `StuckLockError` is lock 1's own
  // busy refusal only while this is false. After it, one can only come from a
  // lock `fn` took itself, and must not be reported as lock 1 being busy.
  let acquired = false
  try {
    // Before the lock is requested: a root swapped before this call is refused
    // here, so no lock file is created in the directory now at R's path. Node
    // has no openat-style relative create, so this narrows the window and cannot
    // close it: a swap after this check still gets a lock file created by path,
    // is refused by the check under the lock before `fn` runs, and the release
    // removes that lock file again.
    checkSkillsRootBinding(bound)
    await options.beforeLock?.()
    const value = await withFileLock(
      target,
      label,
      async () => {
        acquired = true
        const lockIdentity = bindIdentity(lockPath)
        if (!lockIdentity.ok) {
          throw stop(
            'root-changed',
            lockPath,
            'the lock file cannot be inspected after acquiring it'
          )
        }
        const lock = { path: lockPath, identity: lockIdentity }
        const check = (scope?: CheckScope): void => checkSkillsRootBinding(bound, scope, lock)
        check()
        return fn({ ...bound, lockPath, lockIdentity, check })
      },
      {
        rank: '1',
        waitWhileUnreadable: true,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      }
    )
    outcome = { ok: true, value }
  } catch (err) {
    if (err instanceof SkillWriteStop) {
      outcome = { ok: false, stop: err }
    } else if (err instanceof StuckLockError && !acquired && err.lockPath === lockPath) {
      outcome = {
        ok: false,
        stop: new SkillWriteStop({
          code: 'busy',
          path: lockPath,
          detail: endedOnUnreadableClaim(err) ? unreadableClaimDetail(lockPath) : err.message,
          reason: err.reason,
          cause: err,
        }),
      }
    } else {
      throw err
    }
  }
  // Lock 1 is released here (withFileLock's finally ran): the hint's
  // `git check-ignore` never runs under it.
  const gitignoreHint = await takeStagingHint(bound)
  const withHint = gitignoreHint === undefined ? outcome : { ...outcome, gitignoreHint }
  return bound.warnings.length === 0 ? withHint : { ...withHint, warnings: bound.warnings }
}
