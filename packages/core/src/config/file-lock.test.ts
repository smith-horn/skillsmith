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
   * THREE outcomes, because two cannot express what these tests assert.
   *
   * The first version mapped both fulfilment and rejection to 'settled':
   *
   *   withFileLock(...).then(() => 'settled', () => 'settled')
   *
   * So "the acquire was REFUSED at once" and "the acquire SUCCEEDED at once"
   * returned the same value, and a test asserting the first would accept the
   * second. Measured: making an unparseable claim reclaimable -- so the acquire
   * succeeds and DELETES the lock file -- passed all six tests here. That is
   * the claim-admission class (SMI-6776 round 3) walking straight through a
   * test written to guard the retry set.
   *
   * A control that returns one value for two opposite outcomes is not
   * measuring the thing it names.
   *
   * The outcome alone is still too coarse, and the post-merge retro on #2904
   * measured why: discarding the rejection makes 'refused' mean "rejected for
   * ANY reason", so the tests cannot tell the DOCUMENTED refusal from any
   * rejection. The mutation that demonstrates it is a REASON SWAP -- return
   * `unreclaimable_legacy` where `mapRefusalToReason` returns
   * `unreclaimable_unparseable`. Both are non-retryable, so no outcome moves,
   * and it passed 6 of 6 before the error-identity assertions existed. So the
   * error travels with the outcome and the refusal test asserts its identity
   * AND its reason, the way test (ii) below already does for the legacy path.
   *
   * (An earlier revision of this comment cited "a plain Error instead of
   * StuckLockError" as having survived every test. That is only true of the
   * NARROW form -- a plain Error thrown for the unparseable reason alone.
   * Replacing the whole throw site was already caught four ways at the parent
   * commit. Conflating the two overstated what the new assertions buy, inside
   * a comment whose subject is measuring; the reason swap is the true and
   * stronger claim, so it is the one stated above.)
   *
   * ALL THREE race arms carry their own narrow literal type, not the wide
   * `Settled`. Any arm annotated with the union can be mis-wired to another
   * arm's value and still typecheck, which is the arm-to-value mis-binding
   * this whole block exists to remove. Measured: with the fulfilment arm left
   * wide, wiring it to 'pending' is `tsc`-clean and makes a real lock-theft
   * regression pass 6 of 6 -- inside the test named "a live holder IS waited
   * out". Narrow on every arm turns each such mis-wiring into a TS2322
   * (measured, not predicted) and costs nothing: `Promise.race` still infers
   * a union assignable to the declared return type.
   */
  type Outcome = 'refused' | 'acquired' | 'pending'
  type Settled = { outcome: Outcome; error?: unknown }

  async function settle(): Promise<Settled> {
    const attempt = withFileLock(target, 'probe', async () => 'ok').then(
      (): { outcome: 'acquired' } => ({ outcome: 'acquired' }),
      (error: unknown): { outcome: 'refused'; error: unknown } => ({ outcome: 'refused', error })
    )
    const timer = new Promise<{ outcome: 'pending' }>((r) =>
      setTimeout(() => r({ outcome: 'pending' }), SETTLE_MS)
    )
    return Promise.race([attempt, timer])
  }

  it('an unparseable claim is REFUSED at once, as a StuckLockError naming its reason', async () => {
    writeFileSync(lockPath, 'not a claim at all')
    const before = readFileSync(lockPath)
    const settled = await settle()
    // `refused`, not merely "not pending". The distinction is the whole point:
    // an unparseable claim that became acquirable would be a lock-safety
    // regression, and the two-way version could not tell them apart.
    expect(settled.outcome).toBe('refused')
    // And it must be the DOCUMENTED refusal, not any rejection. Without these
    // two lines a plain `throw new Error(...)` in place of StuckLockError
    // passes -- measured, post-merge retro on #2904 -- taking `reason`, both
    // paths and the manual-unstick remedy with it while the suite stays green.
    expect(settled.error).toBeInstanceOf(StuckLockError)
    expect((settled.error as StuckLockError).reason).toBe('unreclaimable_unparseable')
    // And the bytes survive, because a refusal must not delete anything.
    expect(readFileSync(lockPath).equals(before)).toBe(true)
  })

  it('a live holder IS waited out — still polling when an unparseable claim would have failed', async () => {
    // Known-positive control for the probe above: same harness, same window,
    // opposite answer. Without this, 'pending' could mean the probe is broken
    // rather than that the acquire is genuinely still polling.
    writeFileSync(lockPath, v1(process.pid))
    await expect(settle()).resolves.toEqual({ outcome: 'pending' })
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
    await expect(settle()).resolves.toEqual({ outcome: 'pending' })
  })

  it('a dead holder under SKILLSMITH_LOCK_NO_AUTO_RECLAIM IS waited out', async () => {
    // `reclaim_disabled`. A differently-configured peer can still reclaim and
    // release, so waiting can pay off -- which is why it is in the set.
    const prev = process.env.SKILLSMITH_LOCK_NO_AUTO_RECLAIM
    process.env.SKILLSMITH_LOCK_NO_AUTO_RECLAIM = '1'
    try {
      writeFileSync(lockPath, v1(mintDeadPid()))
      await expect(settle()).resolves.toEqual({ outcome: 'pending' })
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
