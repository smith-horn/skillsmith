/**
 * SMI-6531 (A1 step 1): `lockFileKey` of a `link/../x` spelling when the lock
 * FILE exists. The existing path-identity tests key a target (`lockKey`) or run
 * with no lock file on disk; here the file exists and a stray file sits at the
 * lexical collapse, so a key that collapses `..` before resolving (the JS
 * `realpathSync`, or a `normalize` first) lands on the wrong file.
 *
 * With `link -> real/sub`, `link/../x.lock` is opened by the OS as `real/x.lock`.
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

let dir: string
let realX: string

// path.join would collapse '..' lexically, so build the raw spelling by hand.
const rawDotDot = (): string => `${path.join(dir, 'link')}${path.sep}..${path.sep}x`

beforeEach(() => {
  setLockTrackerEnabledForTests(true)
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lock-link-key-')))
  const realSub = path.join(dir, 'real', 'sub')
  fs.mkdirSync(realSub, { recursive: true })
  fs.symlinkSync(realSub, path.join(dir, 'link'))
  realX = path.join(dir, 'real', 'x')
  // The lock file at the REAL location, and a stray at the lexical collapse
  // <dir>/x.lock, so both candidate spellings resolve to an existing file.
  fs.writeFileSync(`${realX}.lock`, 'real holder')
  fs.writeFileSync(path.join(dir, 'x.lock'), 'stray')
})

afterEach(() => {
  setLockTrackerEnabledForTests(true)
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('lockFileKey with an existing lock file reached through link/..', () => {
  it('keys link/../x like real/x, and not like the lexical collapse', () => {
    expect(lockFileKey(rawDotDot())).toBe(lockFileKey(realX))
    expect(lockFileKey(rawDotDot())).not.toBe(lockFileKey(path.join(dir, 'x')))
  })

  it('control: the stray file really is a different file with a different key', () => {
    expect(lockFileKey(path.join(dir, 'x'))).not.toBe(lockFileKey(realX))
  })
})

describe('a held lock is recognised through link/..', () => {
  it('holding real/x then requesting link/../x is refused as re-entry at once, not waited on', async () => {
    fs.rmSync(`${realX}.lock`) // withFileLock takes it for real below
    let outcome: { error: unknown; ms: number } | undefined
    await withFileLock(
      realX,
      'outer',
      async () => {
        const start = performance.now()
        try {
          await withFileLock(rawDotDot(), 'inner', async () => 'unreachable', {
            rank: 'unordered',
            timeoutMs: 400,
          })
          outcome = { error: undefined, ms: performance.now() - start }
        } catch (error) {
          outcome = { error, ms: performance.now() - start }
        }
      },
      { rank: 'unordered' }
    )
    expect(outcome?.error).toBeInstanceOf(LockOrderError)
    expect((outcome?.error as LockOrderError).kind).toBe('re-entry')
    expect(outcome?.ms).toBeLessThan(200)
  })
})
