/**
 * SMI-6531 (A1 step 1): the tracker keys a request by its lock FILE, so two
 * spellings of one physical lock (`<target>.lock`) are one key and a nested
 * request is refused instead of waiting on itself.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { withFileLock } from '../../../src/config/file-lock.js'
import {
  LockOrderError,
  lockFileKey,
  setLockTrackerEnabledForTests,
} from '../../../src/config/lock-tracker.js'

/** Well under the wait a non-refused request would spend. */
const PROMPT_MS = 500
const WAIT_TIMEOUT_MS = 3000

let dir: string

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
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lock-tracker-key-')))
})

afterEach(() => {
  setLockTrackerEnabledForTests(true)
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('two names for one lock file are one lock', () => {
  it('refuses a nested request for a symlinked alias of the held lock file as re-entry, promptly', async () => {
    const b = path.join(dir, 'b')
    const a = path.join(dir, 'a')
    fs.symlinkSync('b.lock', `${a}.lock`) // a.lock -> b.lock
    let nested: { error: unknown; ms: number } = { error: 'unset', ms: 0 }
    let sameFile: unknown = 'unset'
    await withFileLock(
      b,
      'outer',
      async () => {
        // Same physical lock: O_EXCL on the alias fails while b.lock exists.
        try {
          fs.closeSync(fs.openSync(`${a}.lock`, 'wx'))
          sameFile = false
        } catch (err) {
          sameFile = (err as NodeJS.ErrnoException).code
        }
        nested = await settle(
          withFileLock(a, 'nested', async () => 'x', {
            rank: 'unordered',
            timeoutMs: WAIT_TIMEOUT_MS,
          })
        )
      },
      { rank: 'unordered' }
    )
    expect(sameFile).toBe('EEXIST')
    expect(nested.error).toBeInstanceOf(LockOrderError)
    expect((nested.error as LockOrderError).kind).toBe('re-entry')
    expect(nested.ms).toBeLessThan(PROMPT_MS)
  })

  it('control: two different targets with no alias are not refused', async () => {
    let nested: { error: unknown; ms: number } = { error: 'unset', ms: 0 }
    await withFileLock(
      path.join(dir, 'b'),
      'outer',
      async () => {
        nested = await settle(
          withFileLock(path.join(dir, 'c'), 'nested', async () => 'x', { rank: 'unordered' })
        )
      },
      { rank: 'unordered' }
    )
    expect(nested.error).toBeUndefined()
  })

  it('keys an existing lock file by its resolved path and a missing one by its spelling', () => {
    const b = path.join(dir, 'b')
    fs.symlinkSync('b.lock', path.join(dir, 'a.lock'))
    fs.writeFileSync(`${b}.lock`, '')
    expect(lockFileKey(path.join(dir, 'a'))).toBe(lockFileKey(b))
    expect(lockFileKey(b)).toBe(`${b}.lock`)
    expect(lockFileKey(path.join(dir, 'missing'))).toBe(path.join(dir, 'missing.lock'))
  })

  // Only a case-insensitive volume folds the final name; this container is Linux.
  it.skipIf(process.platform !== 'darwin')(
    'refuses a case variant of the held target where the OS folds case (macOS)',
    async () => {
      let nested: { error: unknown; ms: number } = { error: 'unset', ms: 0 }
      await withFileLock(
        path.join(dir, 'Foo'),
        'outer',
        async () => {
          nested = await settle(
            withFileLock(path.join(dir, 'foo'), 'nested', async () => 'x', {
              rank: 'unordered',
              timeoutMs: WAIT_TIMEOUT_MS,
            })
          )
        },
        { rank: 'unordered' }
      )
      expect(nested.error).toBeInstanceOf(LockOrderError)
      expect((nested.error as LockOrderError).kind).toBe('re-entry')
      expect(nested.ms).toBeLessThan(PROMPT_MS)
    }
  )
})
