/**
 * SMI-6531 (A1 step 6d-ii): `executeRestore`, the locked half of
 * `skillsmith restore <id>` (design note §5). Under the lock chosen by the plan
 * (lock 1 of the origin's skills root, or lock 1′ of the set-aside area) it
 * re-plans, compares digests, then restores by type: a folder by claim-publish,
 * a file or symlink by the no-replace primitives in `skill-restore.entry.ts`.
 * The sidecar is unlinked only once the parked name is gone. Every write is
 * preceded by `guard()`: `ctx.check()` under lock 1, `ctx.recheck()` under
 * lock 1′ (§3.1 check 4).
 *
 * @module @skillsmith/core/services/skill-restore.exec
 */
import fs from 'node:fs'
import {
  ParkedLockChanged,
  strandedOf,
  withParkedAreaLock,
  type StrandedClaim,
} from '../config/file-lock.parked.js'
import { readStable } from '../install/prune.sidecar.js'
import { replanUnderLock } from './skill-restore.js'
import {
  restoreFileEntry,
  restoreSymlinkEntry,
  sameEntryText,
  type EntryOutcome,
} from './skill-restore.entry.js'
import { claimPublish } from './skill-tree.js'
import { SkillWriteStop, withSkillWriteLock } from './skill-write-lock.js'
import type { RestoreHooks, RestorePlan, RestoreResult } from './skill-restore.types.js'

/** A guard failure inside the locked body: the lock's own check refused. */
class GuardStop extends Error {
  constructor(
    readonly cause0: unknown,
    readonly detail: string
  ) {
    super(detail)
  }
}

type Failure = Extract<RestoreResult, { status: 'refused' | 'stopped' }>

const stopLine = (what: string): string => `Restore stopped: ${what}`

const S_IFMT = 0o170000n

/** The parked entry is still the one the plan bound (design note §5.2 D1, §5.1 step 4). */
function copyStillBound(plan: RestorePlan): boolean {
  try {
    const st = fs.lstatSync(plan.copy.copyPath, { bigint: true })
    const r = plan.rootIdentity
    return (
      st.dev === r.dev &&
      st.ino === r.ino &&
      (st.mode & S_IFMT) === r.fmt &&
      st.birthtimeNs === r.birthtimeNs
    )
  } catch {
    return false
  }
}

const sameLock = (a: RestorePlan['lock'], b: RestorePlan['lock']): boolean =>
  a.kind === b.kind &&
  a.path === b.path &&
  (a.kind === 'lock1'
    ? b.kind === 'lock1' && a.root === b.root
    : b.kind === 'lock1prime' && a.stateRoot === b.stateRoot && a.areaReal === b.areaReal)

/**
 * What must agree between the plan the caller holds and the one derived under
 * the lock. Execution then uses the fresh plan, so nothing the caller wrote
 * into its own plan reaches a write; a disagreement is `plan-changed`.
 */
function sameExecution(a: RestorePlan, b: RestorePlan): boolean {
  return (
    a.digest === b.digest &&
    a.target === b.target &&
    a.type === b.type &&
    sameLock(a.lock, b.lock) &&
    a.rootIdentity.dev === b.rootIdentity.dev &&
    a.rootIdentity.ino === b.rootIdentity.ino &&
    a.rootIdentity.birthtimeNs === b.rootIdentity.birthtimeNs &&
    a.rootIdentity.fmt === b.rootIdentity.fmt &&
    a.sidecarIno === b.sidecarIno &&
    a.sidecarBytes.equals(b.sidecarBytes)
  )
}

/** The set-aside folder changed between the plan and the claim's rename. */
class CopySwapped extends Error {}

const PLAN_CHANGED =
  'The copy or its origin changed after you confirmed. Nothing was restored. Run `skillsmith restore <id>` again to see the new plan.'

const bodyOf =
  (asked: RestorePlan, hooks: RestoreHooks, check: () => void, state: { changed: boolean }) =>
  async (): Promise<RestoreResult> => {
    const guard = (): void => {
      try {
        check()
      } catch (err) {
        throw new GuardStop(err, err instanceof Error ? err.message : String(err))
      }
    }
    const fail = (
      reason: Failure['reason'],
      message: string,
      status: Failure['status'] = state.changed ? 'stopped' : 'refused'
    ): Failure => ({ status, reason, message, changed: state.changed, warnings: [] })
    try {
      guard()
      // Re-plan under the lock (D12): the same copy, rediscovered, reclassified, re-digested.
      const again = await replanUnderLock(asked, {
        ...(asked.options.discovery === undefined ? {} : { discovery: asked.options.discovery }),
        ...(asked.options.measure === undefined ? {} : { measure: asked.options.measure }),
      })
      if (again.status !== 'planned' || !sameExecution(asked, again.plan)) {
        return fail('plan-changed', PLAN_CHANGED)
      }
      // From here on every write is made from the plan derived under the lock.
      const plan = again.plan
      hooks.beforeClaim?.()
      const warnings: string[] = []
      if (plan.type === 'directory') {
        guard()
        // D1: the parked folder is still the planned one before anything is claimed.
        if (!copyStillBound(plan)) return fail('plan-changed', PLAN_CHANGED)
        let claim: Awaited<ReturnType<typeof claimPublish>>
        try {
          claim = await claimPublish(plan.copy.copyPath, plan.target, undefined, {
            beforeRename: () => {
              // The claim exists by now: a stop here leaves it (D10).
              state.changed = true
              guard()
              if (!copyStillBound(plan)) throw new CopySwapped()
            },
          })
        } catch (err) {
          if (err instanceof CopySwapped) {
            return fail(
              'claim-left',
              claimLeftMessage(
                plan,
                'the set-aside folder changed',
                'it is no longer the planned folder'
              ),
              'stopped'
            )
          }
          if (err instanceof GuardStop) {
            return fail(
              'claim-left',
              claimLeftMessage(plan, 'the lock no longer holds', err.detail),
              'stopped'
            )
          }
          throw err
        }
        if (!claim.ok) return directoryFailure(plan, claim, state, fail)
        if (claim.syncs.publish.outcome === 'failed') {
          warnings.push(
            `Restored, but the folder holding it could not be synced (${claim.syncs.publish.code ?? 'unknown'}); it may not survive a power loss.`
          )
        }
        state.changed = true
      } else {
        const run = plan.type === 'file' ? restoreFileEntry : restoreSymlinkEntry
        let out: EntryOutcome
        try {
          out = run({
            copyPath: plan.copy.copyPath,
            target: plan.target,
            display: plan.origin,
            rid: plan.rootIdentity,
            guard,
            onChanged: () => {
              state.changed = true
            },
            ...(hooks.afterLink === undefined ? {} : { afterLink: hooks.afterLink }),
          })
        } catch (err) {
          // A stop after the new name exists and before the parked name is removed: both names
          // hold the same entry (F4), which the user must be told, not "the lock no longer holds".
          if (err instanceof GuardStop && state.changed) {
            return fail(
              'unlink-failed',
              `Restored to \`${plan.origin}\`, but the set-aside name \`${plan.copyPath}\` could not be removed (the lock no longer holds: ${err.detail}). ${sameEntryText(plan.type === 'symlink' ? 'symlink' : 'file')}; remove \`${plan.copyPath}\` and its \`.json\` by hand.`,
              'stopped'
            )
          }
          throw err
        }
        if (!out.ok) {
          return fail(out.code, out.message, out.changed || state.changed ? 'stopped' : 'refused')
        }
        warnings.push(...out.warnings)
      }
      warnings.push(...unlinkSidecar(plan, hooks, guard))
      return {
        status: 'restored',
        origin: plan.origin,
        copyPath: plan.copyPath,
        notes: notesOf(plan),
        warnings,
      }
    } catch (err) {
      if (err instanceof GuardStop) {
        return fail('locks-dir-changed', stopLine(`the lock no longer holds (${err.detail}).`))
      }
      throw err
    }
  }

function directoryFailure(
  plan: RestorePlan,
  claim: Exclude<Awaited<ReturnType<typeof claimPublish>>, { ok: true }>,
  state: { changed: boolean },
  fail: (r: Failure['reason'], m: string, s?: Failure['status']) => Failure
): Failure {
  if (claim.reason === 'target-exists') {
    return fail(
      'origin-occupied',
      `Something already exists at \`${plan.origin}\`. Move it aside first, then run \`skillsmith restore <id>\` again.`,
      'refused'
    )
  }
  if (claim.reason === 'claim-failed') {
    return fail(
      'restore-failed',
      `Could not restore \`${plan.origin}\` (${claim.errno ?? 'unknown'}). Nothing was changed.`,
      'refused'
    )
  }
  state.changed = true
  const why =
    claim.reason === 'sync-failed'
      ? 'the folder could not be synced'
      : 'the copy could not be moved in'
  return fail(
    claim.reason === 'sync-failed' ? 'sync-failed' : 'claim-left',
    claimLeftMessage(plan, why, claim.errno ?? 'unknown'),
    'stopped'
  )
}

/** D10: the empty claim stays, the copy and its record are untouched. */
const claimLeftMessage = (plan: RestorePlan, why: string, detail: string): string =>
  stopLine(
    `an empty folder was created at \`${plan.origin}\`, but ${why} (${detail}). The copy is still at \`${plan.copyPath}\`. Remove the empty folder with \`rmdir\`, then run \`skillsmith restore <id>\` again.`
  )

/** §5.4: only after the parked name is gone, and only the record the listing read. */
function unlinkSidecar(plan: RestorePlan, hooks: RestoreHooks, guard: () => void): string[] {
  const p = plan.copy.sidecarPath
  const handBy = (e: string): string[] => [
    `Restored to \`${plan.origin}\`. Its record \`${p}\` could not be removed (${e}); remove it by hand.`,
  ]
  hooks.beforeUnlink?.()
  const read = readStable(p)
  if (!read.ok) return handBy('it could not be read again')
  if (read.ino !== plan.sidecarIno || !read.bytes.equals(plan.sidecarBytes)) {
    return handBy('it changed since it was read')
  }
  try {
    guard()
  } catch (err) {
    // Already restored: the lock stopping now only leaves the record (D8), exit 0.
    if (err instanceof GuardStop) return handBy('the lock no longer holds')
    throw err
  }
  try {
    fs.unlinkSync(p)
  } catch (err) {
    return handBy((err as NodeJS.ErrnoException).code ?? 'UNKNOWN')
  }
  return []
}

function notesOf(plan: RestorePlan): string[] {
  const out: string[] = []
  if (plan.held || plan.contents.state === 'changed')
    out.push('It differs from what was set aside.')
  if (plan.kind === 'uninstall') {
    out.push(
      plan.held
        ? 'Its manifest entry was kept, so it is tracked again.'
        : 'The skill was uninstalled when it was set aside, so it is not tracked: `skillsmith list` shows it as yours until you reinstall or adopt it.'
    )
  }
  return out
}

/**
 * Restores the copy `plan` names (the public entry; it takes no test seams).
 * Under the lock the plan is re-derived from the disk, and it must agree with
 * the plan given on its digest, write target, lock (the one actually taken),
 * type, copy identity and record identity, or the result is `plan-changed`
 * with nothing written; every write is then made from the re-derived plan, not
 * the given one. The plan's own `discovery`, `measure` and `discovered`
 * options are ignored here; `stateRoot` and `roots` are honoured.
 */
export function executeRestore(plan: RestorePlan): Promise<RestoreResult> {
  const { discovered: _a, discovery: _b, measure: _c, ...options } = plan.options
  return executeRestoreWith({ ...plan, options }, {})
}

/** @internal `executeRestore` with the test seams; not exported from the package. */
export async function executeRestoreWith(
  plan: RestorePlan,
  hooks: RestoreHooks = {}
): Promise<RestoreResult> {
  const state = { changed: false }
  const wrap = (real: () => void): (() => void) =>
    hooks.wrapCheck === undefined ? real : hooks.wrapCheck(real)
  const timeout = hooks.lockTimeoutMs === undefined ? {} : { timeoutMs: hooks.lockTimeoutMs }
  const busy = (lock: string): Failure => ({
    status: 'refused',
    reason: 'restore-busy',
    message: `Another Skillsmith process holds ${lock}. Wait for it to finish, then run \`skillsmith restore <id>\` again.`,
    changed: false,
    warnings: [],
  })
  const withStranded = (r: RestoreResult, s: StrandedClaim | undefined): RestoreResult =>
    s === undefined ? r : { ...r, strandedLockClaim: s }
  if (plan.lock.kind === 'lock1') {
    const run = await withSkillWriteLock(
      plan.lock.root,
      'skillsmith restore',
      (ctx) =>
        bodyOf(
          plan,
          hooks,
          wrap(() => ctx.check()),
          state
        )(),
      timeout
    )
    if (run.ok) return run.value
    if (run.stop.code === 'busy') return busy(plan.lock.path)
    return {
      status: state.changed ? 'stopped' : 'refused',
      reason: 'locks-dir-changed',
      message: stopLine(`the skills folder lock refused (${run.stop.code}: ${run.stop.detail}).`),
      changed: state.changed,
      warnings: [],
    }
  }
  try {
    const run = await (hooks.runLock ?? withParkedAreaLock)(
      plan.lock.path,
      'skillsmith restore',
      (ctx) =>
        bodyOf(
          plan,
          hooks,
          wrap(() => ctx.recheck()),
          state
        )(),
      timeout
    )
    if (run.ok) return withStranded(run.value, run.stranded)
    if (run.stop.code === 'busy') return withStranded(busy(plan.lock.path), run.stranded)
    return withStranded(
      {
        status: 'refused',
        reason: 'locks-dir-changed',
        message: stopLine(`the set-aside-area lock folder is not safe (${run.stop.code}).`),
        changed: false,
        warnings: [],
      },
      run.stranded
    )
  } catch (err) {
    if (err instanceof ParkedLockChanged || err instanceof SkillWriteStop) {
      return withStranded(
        {
          status: state.changed ? 'stopped' : 'refused',
          reason: 'locks-dir-changed',
          message: stopLine(err.message),
          changed: state.changed,
          warnings: [],
        },
        strandedOf(err)
      )
    }
    throw err
  }
}
