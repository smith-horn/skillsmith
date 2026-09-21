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

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { hostname } from 'node:os'

import { withFileLock } from './file-lock.js'
import { StuckLockError } from './owned-lock.js'
import { LOCK_RETRY_DELAY_MS } from './owned-lock.types.js'
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
   * The discriminator does not need the full 30s budget. A non-retryable
   * refusal rejects on the FIRST attempt; a retryable one is still polling.
   * Sampling at 400ms separates them cleanly and keeps the suite fast.
   */
  const SETTLE_MS = 400

  /**
   * THREE outcomes, because two cannot express what these tests assert. Keep
   * all three, and keep each race arm on its OWN narrow literal type -- never
   * the wide `Outcome`. An arm annotated with the union can be mis-wired to
   * another arm's value and still typecheck; narrow, each mis-wiring is a
   * compile error.
   *
   * `settle()` answers one question -- which outcome, inside the window -- for
   * the three tests that need only that. A test asserting a refusal's IDENTITY
   * races its OWN acquisition and captures that attempt's rejection inline, so
   * promptness, identity and reason all describe the SAME `withFileLock` call.
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
   * SMI-6786 (reason swap, arm typing), SMI-6796 (the helper-as-oracle).
   */
  type Outcome = 'refused' | 'acquired' | 'pending'

  async function settle(): Promise<Outcome> {
    const attempt = withFileLock(target, 'probe', async () => 'ok').then(
      (): 'acquired' => 'acquired',
      (): 'refused' => 'refused'
    )
    const timer = new Promise<'pending'>((r) => setTimeout(() => r('pending'), SETTLE_MS))
    return Promise.race([attempt, timer])
  }

  it('an unparseable claim is REFUSED at once, as a StuckLockError naming its reason', async () => {
    writeFileSync(lockPath, 'not a claim at all')
    const before = readFileSync(lockPath)
    // ONE acquisition, raced against the window, with its rejection captured.
    // Promptness, identity and reason are then all asserted about the SAME
    // attempt. Splitting them across two `withFileLock` calls -- which an
    // earlier revision did -- lets a stateful mutant throw the wrong reason on
    // the first and the right one on the second, and pass.
    let caught: unknown
    const t0 = performance.now()
    const attempt = withFileLock(target, 'probe', async () => 'ok').then(
      (): 'acquired' => 'acquired',
      (err: unknown): 'refused' => {
        caught = err
        return 'refused'
      }
    )
    const timer = new Promise<'pending'>((r) => setTimeout(() => r('pending'), SETTLE_MS))
    const outcome = await Promise.race([attempt, timer])
    const elapsed = performance.now() - t0

    // `refused`, not merely "not pending". The distinction is the whole point:
    // an unparseable claim that became acquirable would be a lock-safety
    // regression, and the two-way version could not tell them apart.
    expect(outcome).toBe('refused')
    // And it must be the DOCUMENTED refusal, not any rejection. Without these
    // two lines, returning `unreclaimable_legacy` where `mapRefusalToReason`
    // returns `unreclaimable_unparseable` passes 6 of 6 -- measured -- taking
    // `reason` and the manual-unstick remedy with it while the suite stays green.
    expect(caught).toBeInstanceOf(StuckLockError)
    expect((caught as StuckLockError).reason).toBe('unreclaimable_unparseable')
    // On the FIRST attempt, which is a stronger claim than "inside the window"
    // and needs its own predicate. Threshold is the real retry delay, imported
    // rather than guessed: anything at or past it necessarily slept at least
    // once, so it polled. Measured -- misclassifying the first attempt as a
    // RETRYABLE reason and the second correctly rejects at ~1x the delay, well
    // inside SETTLE_MS, and passed every other assertion here.
    expect(elapsed).toBeLessThan(LOCK_RETRY_DELAY_MS)
    // And the bytes survive, because a refusal must not delete anything.
    expect(readFileSync(lockPath).equals(before)).toBe(true)
  })

  it('a live holder IS waited out — still polling when an unparseable claim would have failed', async () => {
    // Known-positive control for the probe above: same harness, same window,
    // opposite answer. Without this, 'pending' could mean the probe is broken
    // rather than that the acquire is genuinely still polling.
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
