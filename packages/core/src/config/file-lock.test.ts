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
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { withFileLock } from './file-lock.js'
import { StuckLockError } from './owned-lock.js'

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
