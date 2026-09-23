/**
 * Unit tests for `withFileLock`'s release contract (SMI-6735
 * adversarial-review finding 2b).
 * @module @skillsmith/core/config/file-lock.test
 *
 * `withFileLock` (`file-lock.ts`) is what SMI-6735 (commit 67adb01f2)
 * consolidated two independent hand-rolled manifest-lock protocols onto —
 * specifically FOR its `try { fn() } finally { release() }` guarantee: the
 * lock must not leak whatever `fn` does. That guarantee had no direct test
 * anywhere in the repo: the nearest existing coverage
 * (`packages/mcp-server/tests/unit/install-helpers.test.ts`'s
 * `updateManifestSafely` suite) only ever exercises `fn` succeeding, because
 * `loadManifest` swallows every read failure into an empty manifest before
 * `fn` runs — see that file's corrected comment on the renamed test for the
 * full explanation of why it never reached the throw path.
 *
 * Real fs throughout, matching `owned-lock.test.ts`'s style: `withFileLock`
 * acquires via `acquireOwnedLock`, which creates its claim through
 * synchronous `node:fs` (`owned-lock.claim.ts`) — a `fs/promises` mock would
 * never observe it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { hostname } from 'node:os'

import { withFileLock } from './file-lock.js'
import { StuckLockError } from './owned-lock.js'
import { mintDeadPid } from '../../tests/helpers/deterministic-dead-pid.js'

/** A well-formed v1 claim for `pid`, so the refusal reason is the one under test. */
function v1(pid: number): string {
  return (
    JSON.stringify({
      v: 1,
      pid,
      token: 'a'.repeat(16),
      host: hostname(),
      acquiredAt: Date.now(),
    }) + '\n'
  )
}

let dir: string
let target: string
let lockPath: string

beforeEach(() => {
  dir =
    os.tmpdir() + path.sep + `file-lock-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  mkdirSync(dir, { recursive: true })
  target = path.join(dir, 'store.json')
  lockPath = `${target}.lock`
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('withFileLock — RETRYABLE_REASONS membership is behaviour (SMI-6776 round 2)', () => {
  /**
   * Membership in `RETRYABLE_REASONS` decides whether a refusal is waited out
   * or fails at once. Three mutations to that set survived every test: dropping
   * `reclaim_unavailable`, dropping `reclaim_disabled`, and adding
   * `unreclaimable_unparseable`. Only the legacy reason was exercised through
   * this wrapper, so the rest of the set was free.
   *
   * The discriminator is a FROZEN CLOCK, not a faked timer. Vitest's fake
   * timers do NOT patch `node:timers/promises`, which is where
   * `acquireFileLock`'s `delay(FILE_LOCK_POLL_MS)` comes from -- measured,
   * `vi.getTimerCount()` is 0 while an acquisition sits on it. Two mechanisms
   * do the work, and neither is the one an earlier revision of this comment
   * claimed:
   *
   *   - a NON-retryable refusal rejects, and `advanceTimersByTimeAsync(0)`
   *     drains the microtask queue, so it settles. One tick is needed, and the
   *     advance crosses a macrotask boundary, so the queue drains to
   *     EXHAUSTION -- measured, a 5000-deep `.then` chain settles in one call.
   *     There is no budget to exceed.
   *   - a RETRYABLE refusal cannot settle at all, because `Date.now()` is
   *     frozen and `acquireFileLock`'s deadline (`file-lock.ts:61`) is
   *     therefore never reached. That half is immune to load; it is not a
   *     race against the real 50ms poll.
   *
   * So the margin is implicit, not absent. Do NOT describe this as
   * threshold-free, and do not reintroduce an explicit threshold either: two
   * revisions asserted a wall-clock bound and both passed while resting on
   * something false, the second importing `LOCK_RETRY_DELAY_MS` -- a constant
   * this wrapper never reaches, since `timeoutMs: 0` means `acquireOwnedLock`'s
   * own retry loop never sleeps. Measurements in SMI-6776, SMI-6786, SMI-6796.
   *
   * One mutation this does not reject cleanly: replacing the poll's `delay()`
   * with a microtask-only yield. The zero advance drains it, the loop spins,
   * and with the clock frozen it never reaches the deadline -- so the suite
   * HANGS to a timeout instead of failing an assertion. Still caught; read
   * such a timeout as this rather than as flake.
   */

  /**
   * THREE outcomes, because two cannot express what these tests assert. Keep
   * all three, and keep each settlement arm on its OWN narrow literal type --
   * never the wide `Outcome`. An arm annotated with the union can be mis-wired
   * to another arm's value and still typecheck; narrow, each mis-wiring is a
   * compile error. `settled` is deliberately the SAME assignment in both arms,
   * so it carries no outcome information and cannot be mis-wired either.
   *
   * `settle()` answers one question -- which outcome, within one microtask
   * drain -- for the three tests that need only that. A test asserting a refusal's
   * IDENTITY runs its OWN acquisition and captures that attempt's rejection
   * inline, so outcome, identity and reason all describe the SAME
   * `withFileLock` call.
   *
   * Two things this protects against, both measured. A test-owned function
   * between the throw and the assertion can be edited to reconstruct the error.
   * And two separate acquisitions let a stateful mutant answer the first one
   * wrongly and the second one correctly -- the test name then claims of one
   * refusal what was observed of two.
   *
   * Neither is made impossible: no test can defend against edits to itself.
   * What one invocation buys is that the defeating edit has to be written
   * beside the assertion it defeats.
   *
   * Every claim above was measured, and the numbers live in the issues rather
   * than here, where they would rot: SMI-6776 (the two-way collapse),
   * SMI-6786 (reason swap, arm typing), SMI-6796 (the helper-as-oracle and the
   * wall-clock thresholds that replaced it).
   */
  type Outcome = 'refused' | 'acquired' | 'pending'

  // Scoped to this describe. What these tests need from it is the FROZEN
  // `Date.now()` -- that is what keeps a retryable acquisition from ever
  // reaching its deadline. The `withFileLock` block further down needs neither
  // and runs on the real clock; measured, hooks nest outer-then-inner on entry
  // and inner-then-outer on exit, so the tmpdir is built on a live clock and
  // `useRealTimers()` runs before the outer `rmSync`.
  /**
   * ENV POLICY FOR THIS DESCRIBE: NEUTRALIZE, then restore.
   *
   * An INHERITED `SKILLSMITH_LOCK_NO_AUTO_RECLAIM=1` -- the documented switch a
   * developer exports to unstick a lock, then forgets -- silently disarms the
   * `reclaim_unavailable` test below. Measured: with it set, the same fixture
   * yields `reclaim_disabled` instead; both reasons are retryable, so every
   * assertion still passes while 14 production lines and 14 branches stop being
   * exercised (SMI-6807).
   *
   * THE RULE: a switch that DISARMS silently gets cleared; a switch that BREAKS
   * loudly gets kept. It is about which failure the variable produces, not
   * about the variable -- so each hazard declares its own policy in its own
   * file, and they are not "unified" into a shared helper, because the correct
   * answer differs per variable. This describe is the NEUTRALIZE case; the
   * PRESERVE case is `SKILLSMITH_DISABLE_CLIENT_CACHE`, per SMI-6810.
   *
   * The policy governs the AMBIENT baseline only, and one test below breaks it
   * on purpose: "a dead holder under SKILLSMITH_LOCK_NO_AUTO_RECLAIM IS waited
   * out" sets the variable in its own body and restores it in its own
   * `finally`, composing with the `afterEach` here. That is not a policy
   * violation -- it is the only test that reaches `reclaim_disabled`. Removing
   * it to satisfy NEUTRALIZE would re-open SMI-6807 from the other side.
   *
   * Restoring in `afterEach` matters, and the first version of this fix omitted
   * it: a bare `delete` in `beforeEach` neutralizes for THIS describe and then
   * stays deleted for the rest of the process -- the same unconditional-
   * teardown shape this fix exists to remove, reproduced inside the fix itself.
   * That was the hazard in the omitted-`afterEach` version specifically. With
   * the restore below in place it is closed: anything appended after this
   * describe sees the variable as the process supplied it.
   */
  let prevNoAutoReclaim: string | undefined

  beforeEach(() => {
    prevNoAutoReclaim = process.env.SKILLSMITH_LOCK_NO_AUTO_RECLAIM
    delete process.env.SKILLSMITH_LOCK_NO_AUTO_RECLAIM
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    if (prevNoAutoReclaim === undefined) {
      delete process.env.SKILLSMITH_LOCK_NO_AUTO_RECLAIM
    } else {
      process.env.SKILLSMITH_LOCK_NO_AUTO_RECLAIM = prevNoAutoReclaim
    }
  })

  async function settle(): Promise<Outcome> {
    let settled = false
    const attempt = withFileLock(target, 'probe', async () => 'ok').then(
      (): 'acquired' => {
        settled = true
        return 'acquired'
      },
      (): 'refused' => {
        settled = true
        return 'refused'
      }
    )
    await vi.advanceTimersByTimeAsync(0)
    return settled ? attempt : 'pending'
  }

  it('an unparseable claim is REFUSED without sleeping, as a StuckLockError naming its reason', async () => {
    writeFileSync(lockPath, 'not a claim at all')
    const before = readFileSync(lockPath)
    // ONE acquisition, with its rejection captured, asserted within a single
    // microtask drain. Outcome, identity and reason then all describe
    // the SAME attempt. Splitting them across two `withFileLock` calls -- which
    // an earlier revision did -- lets a stateful mutant throw the wrong reason
    // on the first and the right one on the second, and pass.
    let settled = false
    let caught: unknown
    const attempt = withFileLock(target, 'probe', async () => 'ok').then(
      (): 'acquired' => {
        settled = true
        return 'acquired'
      },
      (err: unknown): 'refused' => {
        settled = true
        caught = err
        return 'refused'
      }
    )
    await vi.advanceTimersByTimeAsync(0)
    const outcome: Outcome = settled ? await attempt : 'pending'

    // `refused`, not merely "not pending". The distinction is the whole point:
    // an unparseable claim that became acquirable would be a lock-safety
    // regression, and the two-way version could not tell them apart.
    //
    // What `refused` after a ZERO advance establishes, stated exactly: the
    // rejection arrived within one microtask drain, so the acquisition did not
    // reach `delay(FILE_LOCK_POLL_MS)` -- given that the retry is a real timer
    // and the clock is frozen. It does not, on its own, exclude a retry that
    // yields only on microtasks; see the block comment above.
    // Measured: misclassifying attempt 1 as retryable and attempt 2 correctly
    // leaves this 'pending', where the previous wall-clock bound passed it.
    expect(outcome).toBe('refused')
    // And it must be the DOCUMENTED refusal, not any rejection. Without these
    // two lines, returning `unreclaimable_legacy` where `mapRefusalToReason`
    // returns `unreclaimable_unparseable` passes 6 of 6 -- measured -- taking
    // `reason` and the manual-unstick remedy with it while the suite stays green.
    expect(caught).toBeInstanceOf(StuckLockError)
    expect((caught as StuckLockError).reason).toBe('unreclaimable_unparseable')
    // And the bytes survive, because a refusal must not delete anything.
    expect(readFileSync(lockPath).equals(before)).toBe(true)
  })

  it('a live holder IS waited out — still polling when an unparseable claim would have failed', async () => {
    // Known-positive control for the probe above: same harness, same clock,
    // opposite answer. Without this, 'pending' could mean the probe is broken
    // rather than that the acquire is genuinely waiting.
    // An earlier revision advanced +500ms here and asserted 'pending' again,
    // claiming that proved the lock was being POLLED rather than hung. It
    // proved nothing: `settle()` starts a NEW acquisition, so the second call
    // observed a fresh first attempt and never re-read the original -- deleting
    // the advance changed no verdict. Polled-vs-hung is not reachable from this
    // shape at all, since a hung acquire returns the same 'pending'. Both
    // round-4 reviewers found it independently; deleted rather than patched.
    writeFileSync(lockPath, v1(process.pid))
    await expect(settle()).resolves.toBe('pending')
  })

  it('a busy reclaim lock IS waited out — the reason nothing else here reaches', async () => {
    // `reclaim_unavailable`. This was the last of the three retry-set mutations
    // still surviving after the other two were pinned, for the plain reason
    // that no test produced this reason through `withFileLock` at all.
    //
    // Reaching it needs both halves: a dead owner on the main lock, so a
    // reclaim is attempted, AND a reclaim lock that refuses. `file-lock.ts`
    // passes `reclaimLockTimeoutMs: 0`, so a held reclaim lock yields
    // 'unavailable' immediately rather than blocking.
    writeFileSync(lockPath, v1(mintDeadPid()))
    writeFileSync(`${lockPath}.reclaim`, v1(process.pid))
    await expect(settle()).resolves.toBe('pending')
  })

  it('a dead holder under SKILLSMITH_LOCK_NO_AUTO_RECLAIM IS waited out', async () => {
    // `reclaim_disabled`. A differently-configured peer can still reclaim and
    // release, so waiting can pay off -- which is why it is in the set.
    const prev = process.env.SKILLSMITH_LOCK_NO_AUTO_RECLAIM
    process.env.SKILLSMITH_LOCK_NO_AUTO_RECLAIM = '1'
    try {
      writeFileSync(lockPath, v1(mintDeadPid()))
      await expect(settle()).resolves.toBe('pending')
    } finally {
      if (prev === undefined) delete process.env.SKILLSMITH_LOCK_NO_AUTO_RECLAIM
      else process.env.SKILLSMITH_LOCK_NO_AUTO_RECLAIM = prev
    }
  })
})

describe('withFileLock', () => {
  it('(i) propagates a rejection from fn() unchanged, and releases the lock', async () => {
    await expect(
      withFileLock(target, 'test lock', async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    // The release-on-throw contract itself: the lock file this call created
    // must not survive the throw.
    expect(existsSync(lockPath)).toBe(false)
  })

  it('(ii) a non-retryable StuckLockError from acquisition itself propagates unwrapped', async () => {
    // A bare-decimal-PID "legacy" claim (owned-lock's pre-v1 format —
    // owned-lock.claim.ts's parseClaim) carries no host attribution and is
    // NEVER auto-reclaimed (SMI-5883 D-5). classifyRefusal maps it to
    // 'unreclaimable_legacy', which file-lock.ts's RETRYABLE_REASONS does
    // NOT include, so the very first acquisition attempt throws instead of
    // polling out the full 30s FILE_LOCK_TIMEOUT_MS budget.
    writeFileSync(lockPath, '999999999\n')
    const fn = async (): Promise<string> => 'never reached'

    let caught: unknown
    try {
      await withFileLock(target, 'test lock', fn)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(StuckLockError)
    expect((caught as StuckLockError).reason).toBe('unreclaimable_legacy')
    // withFileLock never owned the foreign legacy claim, so it must not
    // touch it — this is a fail-closed refusal, not a reclaim.
    expect(existsSync(lockPath)).toBe(true)
  })
})
