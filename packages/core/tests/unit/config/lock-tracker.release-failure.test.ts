/**
 * SMI-6531 (A1 step 1): a lock whose release FAILS is still held.
 *
 * `releaseOwned` suppresses a non-ENOENT unlink failure with a warning, which
 * leaves the lock file on disk and still ours. The tracker must keep counting
 * that lock for work the lock's `fn` started and left running: otherwise that
 * work passes admission, then waits on its own retained lock file. The failure
 * is injected by mocking `node:fs` for one lock path only (`unlinkSync` is a
 * named import in `owned-lock.claim.ts`).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const inject = vi.hoisted(() => ({ failUnlinkOf: null as string | null, failed: 0 }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const unlinkSync = ((p: fs.PathLike) => {
    if (inject.failUnlinkOf !== null && String(p) === inject.failUnlinkOf) {
      inject.failed += 1
      throw Object.assign(new Error(`EACCES: permission denied, unlink '${String(p)}'`), {
        code: 'EACCES',
      })
    }
    return actual.unlinkSync(p)
  }) as typeof actual.unlinkSync
  return { ...actual, unlinkSync, default: { ...actual, unlinkSync } }
})

import { withFileLock } from '../../../src/config/file-lock.js'
import {
  LockOrderError,
  runHoldingLock,
  setLockTrackerEnabledForTests,
} from '../../../src/config/lock-tracker.js'

/** Well under `LEFTOVER_TIMEOUT_MS`: a refusal is immediate, a wait is not. */
const PROMPT_MS = 500
/** Long enough that a request which waits on the retained file is plainly not prompt. */
const LEFTOVER_TIMEOUT_MS = 3000

let dir: string
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function settle(p: Promise<unknown>): Promise<{ error: unknown; ms: number }> {
  const start = performance.now()
  try {
    await p
    return { error: undefined, ms: performance.now() - start }
  } catch (error) {
    return { error, ms: performance.now() - start }
  }
}

beforeEach(() => {
  setLockTrackerEnabledForTests(true)
  inject.failUnlinkOf = null
  inject.failed = 0
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lock-tracker-release-')))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  inject.failUnlinkOf = null
  setLockTrackerEnabledForTests(true)
  vi.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
})

/**
 * Take `t`, start a request for `t` that fires after `fn` has settled, make the
 * lock's release fail when `failRelease`, and report how the leftover fared.
 */
async function leftoverAfterRelease(
  t: string,
  failRelease: boolean
): Promise<{ error: unknown; ms: number; lockFileExists: boolean; unlinkFailures: number }> {
  let leftover: Promise<{ error: unknown; ms: number }> = Promise.resolve({
    error: 'unset',
    ms: 0,
  })
  await withFileLock(
    t,
    'outer',
    async () => {
      if (failRelease) inject.failUnlinkOf = `${t}.lock`
      leftover = new Promise((resolve) => {
        setTimeout(() => {
          resolve(
            settle(
              withFileLock(t, 'leftover', async () => 'late', {
                rank: 'unordered',
                timeoutMs: LEFTOVER_TIMEOUT_MS,
              })
            )
          )
        }, 40)
      })
    },
    { rank: 'unordered' }
  )
  const lockFileExistsAfterFn = fs.existsSync(`${t}.lock`)
  const result = await leftover
  return {
    ...result,
    lockFileExists: lockFileExistsAfterFn,
    unlinkFailures: inject.failed,
  }
}

describe('a lock whose release failed stays held for work it started', () => {
  it('refuses a leftover request for the same target as re-entry, promptly, while the file is retained', async () => {
    const r = await leftoverAfterRelease(path.join(dir, 'a'), true)
    // The unlink really failed: the lock file is still there and still ours.
    expect(r.unlinkFailures).toBeGreaterThan(0)
    expect(r.lockFileExists).toBe(true)
    expect(r.error).toBeInstanceOf(LockOrderError)
    expect((r.error as LockOrderError).kind).toBe('re-entry')
    expect(r.ms).toBeLessThan(PROMPT_MS)
  })

  it('control: when the release succeeds, the same leftover request takes the lock', async () => {
    const r = await leftoverAfterRelease(path.join(dir, 'b'), false)
    expect(r.unlinkFailures).toBe(0)
    expect(r.lockFileExists).toBe(false)
    expect(r.error).toBeUndefined()
  })
})

describe('the runHoldingLock backstop', () => {
  async function leftoverRequest(
    t: string,
    fn: (acquired: () => void, releasing: () => void) => Promise<void>
  ): Promise<unknown> {
    let leftover: Promise<{ error: unknown; ms: number }> = Promise.resolve({
      error: 'unset',
      ms: 0,
    })
    await settle(
      runHoldingLock(t, 'outer', 'unordered', async (acquired, releasing) => {
        leftover = new Promise((resolve) => {
          setTimeout(() => {
            // admit throws synchronously; settle needs a promise
            resolve(
              settle((async () => runHoldingLock(t, 'leftover', 'unordered', async () => 'late'))())
            )
          }, 20)
        })
        await fn(acquired, releasing)
      })
    )
    await sleep(0)
    return (await leftover).error
  }

  it('clears the entry when the acquisition never completed (fn throws before acquired())', async () => {
    const error = await leftoverRequest(path.join(dir, 'c'), async () => {
      throw new Error('acquisition failed')
    })
    expect(error).toBeUndefined()
  })

  it('keeps an acquired lock live when fn settles without releasing()', async () => {
    const error = await leftoverRequest(path.join(dir, 'd'), async (acquired) => {
      acquired()
    })
    expect(error).toBeInstanceOf(LockOrderError)
    expect((error as LockOrderError).kind).toBe('re-entry')
  })

  it('stops counting an acquired lock once releasing() is called', async () => {
    const error = await leftoverRequest(path.join(dir, 'e'), async (acquired, releasing) => {
      acquired()
      releasing()
    })
    expect(error).toBeUndefined()
  })

  it('a withFileLock that fails to acquire leaves the target free for the same context', async () => {
    const t = path.join(dir, 'f')
    fs.writeFileSync(`${t}.lock`, '1\n') // a legacy claim: refused at once, never reclaimed
    const refused = await settle(
      withFileLock(t, 'refused', async () => 'x', { rank: 'unordered', timeoutMs: 0 })
    )
    expect(refused.error).toBeInstanceOf(Error)
    expect(refused.error).not.toBeInstanceOf(LockOrderError)
    fs.rmSync(`${t}.lock`)
    const again = await settle(withFileLock(t, 'again', async () => 'y', { rank: 'unordered' }))
    expect(again.error).toBeUndefined()
  })
})
