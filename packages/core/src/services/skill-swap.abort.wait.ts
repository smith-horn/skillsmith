/**
 * SMI-6531 (A1 step 4b): lock 1 for abort cleanup (A1 plan §3.3 "Abort
 * cleanup" step 1, UD16), when the abort did not already hold it.
 *
 *  - A step-1 failure (`abortBeforeLock`) takes lock 1 with one normal wait
 *    (§3.2: `lockTimeoutMs`, default 30 s), runs step 3's record scan (a
 *    `recovery-*` refusal replaces the build's reason; T-X2), then cleanup.
 *  - After a step-2 `busy` (`abortAfterBusy`), the update waits once more:
 *    `withSkillWriteLock` with `timeoutMs: 0` every 50 ms for up to 30 s more.
 *    Between polls it holds no lock and no `.reclaim` claim, creates nothing
 *    in the skills root and leaves OP as it is, so any other writer can take
 *    lock 1 the moment it is free. It never prompts, and asserts it holds no
 *    skills-root lock. It announces itself with exactly one stderr line. If it
 *    gets lock 1, cleanup runs and `busy` stays the reason (the update never
 *    ran).
 *
 * A run that never gets lock 1 (still busy, or `check` refusing as lock 1 was
 * taken) is `left` with a `removal-not-done` warning and writes no stderr line
 * of its own: OP is untouched and names `--clean-staging`.
 *
 * @module @skillsmith/core/services/skill-swap.abort.wait
 */
import { setTimeout as delay } from 'node:timers/promises'
import { assertSkillWriteLockNotHeld } from '../config/lock-tracker.js'
import { withSkillWriteLock } from './skill-write-lock.js'
import type { SkillWriteResult, SkillWriteStop } from './skill-write-lock.types.js'
import { noneResult, refused, runCleanup, say } from './skill-swap.abort.js'
import type { Refused } from './skill-swap.abort.js'
import { hook } from './skill-swap.ops.js'
import { recordedReason } from './skill-swap.scan.js'
import type { SwapState } from './skill-swap.ops.js'
import type { SwapRefuseReason, SwapResult } from './skill-swap.types.js'

const DEFAULT_SECOND_WAIT_MS = 30_000
const DEFAULT_POLL_MS = 50
const LABEL = 'skill update abort cleanup'

const withHint = <R extends SwapResult>(r: R, hint: string | undefined): R =>
  hint === undefined ? r : { ...r, gitignoreHint: hint }

/** Lock 1 was not taken (busy, or `check` refused as it was taken): OP is left. */
function leftUnlocked(
  st: SwapState,
  reason: SwapRefuseReason,
  detail: string,
  stop: SkillWriteStop
): Refused {
  return refused(st, reason, detail, {
    staged: 'left',
    notDone: { status: 'stopped', reason: stop.code, detail: stop.detail },
  })
}

/** A step-1 failure: lock 1 with one normal wait (§3.2), then cleanup. */
export async function abortBeforeLock(
  st: SwapState,
  reason: SwapRefuseReason,
  detail: string
): Promise<SwapResult> {
  if (!st.opCreated) return noneResult(st, reason, detail)
  const locked = await withSkillWriteLock(
    st.binding,
    LABEL,
    async (ctx) => {
      st.ctx = ctx
      const recorded = await recordedReason(st)
      if (recorded === null) return runCleanup(st, reason, detail)
      return runCleanup(st, recorded.reason, recorded.detail)
    },
    st.options.lockTimeoutMs === undefined ? {} : { timeoutMs: st.options.lockTimeoutMs }
  )
  st.ctx = null
  if (locked.ok) return withHint(locked.value, locked.gitignoreHint)
  return withHint(leftUnlocked(st, reason, detail, locked.stop), locked.gitignoreHint)
}

/**
 * After step 2 did not get lock 1. `busy`: the second wait (UD16), then
 * cleanup with `busy` kept as the reason; still busy, OP is left. Any other
 * stop (`check` refused as the lock was taken): OP is left, nothing touched.
 */
export async function abortAfterBusy(
  st: SwapState,
  first: SkillWriteResult<SwapResult> & { ok: false }
): Promise<SwapResult> {
  const { stop } = first
  if (stop.code !== 'busy') {
    return withHint(leftUnlocked(st, stop.code, stop.detail, stop), first.gitignoreHint)
  }
  const waitMs = st.options.secondWaitMs ?? DEFAULT_SECOND_WAIT_MS
  const pollMs = st.options.secondWaitPollMs ?? DEFAULT_POLL_MS
  assertSkillWriteLockNotHeld('update: the second wait for lock 1')
  say(
    st,
    `Another Skillsmith operation is changing ${st.binding.root}; waiting up to ` +
      `${Math.ceil(waitMs / 1000)} s to set aside this update's unused staged copy.`
  )
  await hook(st, 'secondWaitStart')
  let hint = first.gitignoreHint
  const deadline = Date.now() + waitMs
  for (;;) {
    const r = await withSkillWriteLock(
      st.binding,
      LABEL,
      async (ctx) => {
        st.ctx = ctx
        return runCleanup(st, 'busy', stop.detail)
      },
      { timeoutMs: 0 }
    )
    st.ctx = null
    hint ??= r.gitignoreHint
    if (r.ok) return withHint(r.value, hint)
    if (r.stop.code !== 'busy') return withHint(leftUnlocked(st, 'busy', stop.detail, r.stop), hint)
    if (Date.now() >= deadline) return withHint(leftUnlocked(st, 'busy', stop.detail, r.stop), hint)
    await delay(pollMs)
  }
}
