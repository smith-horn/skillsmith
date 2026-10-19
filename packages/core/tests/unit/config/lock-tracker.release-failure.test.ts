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

const inject = vi.hoisted(() => ({
  failUnlinkOf: null as string | null,
  failed: 0,
  // 'ENOENT' simulates the file vanishing between the claim read and the
  // unlink: the mock removes it for real, then throws ENOENT.
  failUnlinkCode: 'EACCES',
  // `openSync` of this path throws `failOpenCode` for the next `failOpenTimes`
  // calls only, so the claim read in a release fails while a later acquisition
  // (the leftover request) opens normally.
  failOpenOf: null as string | null,
  failOpenCode: 'EMFILE',
  failOpenTimes: 0,
  openFailed: 0,
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const unlinkSync = ((p: fs.PathLike) => {
    if (inject.failUnlinkOf !== null && String(p) === inject.failUnlinkOf) {
      inject.failed += 1
      if (inject.failUnlinkCode === 'ENOENT') actual.unlinkSync(p)
      throw Object.assign(new Error(`${inject.failUnlinkCode}: injected, unlink '${String(p)}'`), {
        code: inject.failUnlinkCode,
      })
    }
    return actual.unlinkSync(p)
  }) as typeof actual.unlinkSync
  const openSync = ((p: fs.PathLike, ...rest: unknown[]) => {
    if (inject.failOpenOf !== null && String(p) === inject.failOpenOf && inject.failOpenTimes > 0) {
      inject.failOpenTimes -= 1
      inject.openFailed += 1
      throw Object.assign(new Error(`${inject.failOpenCode}: injected, open '${String(p)}'`), {
        code: inject.failOpenCode,
      })
    }
    return (actual.openSync as (...a: unknown[]) => number)(p, ...rest)
  }) as typeof actual.openSync
  return { ...actual, unlinkSync, openSync, default: { ...actual, unlinkSync, openSync } }
})

import { withFileLock } from '../../../src/config/file-lock.js'
import { StuckLockError } from '../../../src/config/owned-lock.js'
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

let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  setLockTrackerEnabledForTests(true)
  inject.failUnlinkOf = null
  inject.failed = 0
  inject.failUnlinkCode = 'EACCES'
  inject.failOpenOf = null
  inject.failOpenTimes = 0
  inject.openFailed = 0
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lock-tracker-release-')))
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  inject.failUnlinkOf = null
  inject.failOpenOf = null
  inject.failOpenTimes = 0
  setLockTrackerEnabledForTests(true)
  vi.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
})

const warned = (name: string): boolean =>
  warnSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes(name))

/** Make the claim read of the next release fail with `code` (the file stays on disk). */
function failNextClaimRead(t: string, code: string): void {
  inject.failOpenOf = `${t}.lock`
  inject.failOpenCode = code
  inject.failOpenTimes = 1
}

interface Leftover {
  error: unknown
  ms: number
  lockFileExists: boolean
  unlinkFailures: number
  openFailures: number
}

/**
 * Take `t`, run `duringFn(t)` inside the lock, start a request for `t` that
 * fires after `fn` has settled, and report how the leftover fared.
 */
async function leftoverAfterFn(
  t: string,
  duringFn: (t: string) => void,
  leftoverTimeoutMs = LEFTOVER_TIMEOUT_MS
): Promise<Leftover> {
  let leftover: Promise<{ error: unknown; ms: number }> = Promise.resolve({
    error: 'unset',
    ms: 0,
  })
  await withFileLock(
    t,
    'outer',
    async () => {
      duringFn(t)
      leftover = new Promise((resolve) => {
        setTimeout(() => {
          resolve(
            settle(
              withFileLock(t, 'leftover', async () => 'late', {
                rank: 'unordered',
                timeoutMs: leftoverTimeoutMs,
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
    openFailures: inject.openFailed,
  }
}

function leftoverAfterRelease(t: string, failRelease: boolean): Promise<Leftover> {
  return leftoverAfterFn(t, () => {
    if (failRelease) inject.failUnlinkOf = `${t}.lock`
  })
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

describe('a release that could not READ the claim leaves the lock held while the file remains', () => {
  // EMFILE/ENFILE read as `absent` and EACCES/ELOOP as `unparseable`: both used
  // to fall into the not-owner branch and be reported as "no longer ours" while
  // our own file was still on disk.
  it.each([
    ['EMFILE', 'absent'],
    ['EACCES', 'unparseable'],
  ])(
    'open fails with %s (claim reads as %s): file kept, unverified warning, leftover refused as re-entry promptly',
    async (code) => {
      const t = path.join(dir, `r-${code}`)
      const r = await leftoverAfterFn(t, () => failNextClaimRead(t, code))
      expect(r.openFailures).toBe(1) // the claim read really failed
      expect(r.lockFileExists).toBe(true) // and our file is still there
      expect(warned('lock_release_unverified')).toBe(true)
      expect(warned('lock_release_not_owner')).toBe(false)
      expect(r.error).toBeInstanceOf(LockOrderError)
      expect((r.error as LockOrderError).kind).toBe('re-entry')
      expect(r.ms).toBeLessThan(PROMPT_MS)
    }
  )

  it('control: when the file is really gone at release time, the leftover request takes the lock', async () => {
    const t = path.join(dir, 'g')
    const r = await leftoverAfterFn(t, () => fs.rmSync(`${t}.lock`))
    expect(r.lockFileExists).toBe(false)
    expect(warned('lock_release_unverified')).toBe(false)
    expect(r.error).toBeUndefined()
  })

  it('our claim removed between the read and the unlink: warns not_owner, and the leftover takes the lock', async () => {
    const t = path.join(dir, 'race')
    const r = await leftoverAfterFn(t, () => {
      inject.failUnlinkOf = `${t}.lock`
      inject.failUnlinkCode = 'ENOENT'
    })
    expect(r.unlinkFailures).toBeGreaterThan(0) // the release's own unlink hit the vanished file
    expect(r.lockFileExists).toBe(false)
    expect(warned('lock_release_not_owner')).toBe(true)
    expect(warned('lock_release_unverified')).toBe(false)
    expect(r.error).toBeUndefined()
  })

  it('control: a readable v1 claim naming another token is not removed, and the tracker stops counting it', async () => {
    const t = path.join(dir, 'h')
    const foreign = JSON.stringify({
      v: 1,
      pid: process.pid,
      token: 'f'.repeat(16),
      host: os.hostname(),
      acquiredAt: Date.now(),
    })
    const r = await leftoverAfterFn(t, () => fs.writeFileSync(`${t}.lock`, `${foreign}\n`), 300)
    expect(r.lockFileExists).toBe(true) // never unlinked: it is someone else's
    expect(fs.readFileSync(`${t}.lock`, 'utf8')).toBe(`${foreign}\n`)
    expect(warned('lock_release_not_owner')).toBe(true)
    expect(warned('lock_release_unverified')).toBe(false)
    // Admitted (not a re-entry): it waited on the foreign holder and timed out.
    expect(r.error).toBeInstanceOf(StuckLockError)
    expect(r.error).not.toBeInstanceOf(LockOrderError)
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
