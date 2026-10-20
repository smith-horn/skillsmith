/**
 * SMI-6531 (A1 step 2): a `StuckLockError` is lock 1's `busy` only while lock 1
 * is being waited on. One thrown by a lock `fn` takes itself (rank '2a') is a
 * different lock's refusal, raised after `fn` may already have mutated files, so
 * reporting it as "lock 1 is busy" would tell the caller nothing was written.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/services/skill-write-lock.gitignore.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/skill-write-lock.gitignore.js')>()),
  stagingGitignoreHint: vi.fn(async () => null),
}))

import { withFileLock } from '../../../src/config/file-lock.js'
import { setLockTrackerEnabledForTests } from '../../../src/config/lock-tracker.js'
import { StuckLockError } from '../../../src/config/owned-lock.js'
import { withSkillWriteLock } from '../../../src/services/skill-write-lock.js'

let root: string

beforeEach(() => {
  setLockTrackerEnabledForTests(true)
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skill-write-lock-inner-')))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('a StuckLockError from a lock fn took itself', () => {
  it('propagates as the error it is, after fn wrote, and is not reported as lock 1 busy', async () => {
    const innerTarget = path.join(root, 'inner')
    fs.writeFileSync(`${innerTarget}.lock`, 'not a claim at all\n') // corrupt: refused at once
    const written = path.join(root, 'written-by-fn')
    const err = await withSkillWriteLock(root, 't', async () => {
      fs.writeFileSync(written, 'mutation')
      return withFileLock(innerTarget, 'inner', async () => 'ran', { rank: '2a' })
    }).then(
      (r) => r,
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(StuckLockError)
    expect((err as StuckLockError).lockPath).toBe(`${innerTarget}.lock`)
    expect(fs.existsSync(written)).toBe(true) // fn had mutated before the inner lock refused
    expect(fs.existsSync(path.join(root, '.skillsmith-writes.lock'))).toBe(false) // lock 1 released
  })

  // The conversion to `busy` needs BOTH conjuncts: lock 1 not yet acquired, AND
  // the error is about lock 1's own file. Each has its own test, because the
  // other test cannot tell if it is dropped.
  it('a StuckLockError naming lock 1’s own file, thrown from inside fn after lock 1 was acquired, propagates', async () => {
    const lockPath = path.join(root, '.skillsmith-writes.lock')
    const inside = new StuckLockError(lockPath, `${lockPath}.reclaim`, 'lock 1', 'held', {
      kind: 'absent',
    })
    const err = await withSkillWriteLock(root, 't', async () => {
      throw inside
    }).then(
      (r) => r,
      (e: unknown) => e
    )
    expect(err).toBe(inside) // rethrown as it is, not turned into `{ ok: false, stop: busy }`
  })

  it('a StuckLockError for some other file, thrown before lock 1 is requested, propagates', async () => {
    const other = path.join(root, 'elsewhere.lock')
    const foreign = new StuckLockError(other, `${other}.reclaim`, 'other', 'held', {
      kind: 'absent',
    })
    const fn = vi.fn(async () => 'ran')
    const err = await withSkillWriteLock(root, 't', fn, {
      beforeLock: () => {
        throw foreign
      },
    }).then(
      (r) => r,
      (e: unknown) => e
    )
    expect(err).toBe(foreign) // lock 1 was never acquired, but the error is not about lock 1's file
    expect(fn).not.toHaveBeenCalled()
  })

  it('control: lock 1 itself refused is still the busy result', async () => {
    fs.writeFileSync(path.join(root, '.skillsmith-writes.lock'), 'not a claim at all\n')
    const fn = vi.fn(async () => 'ran')
    const r = await withSkillWriteLock(root, 't', fn, { timeoutMs: 300 })
    expect(fn).not.toHaveBeenCalled()
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.stop.code).toBe('busy')
    expect(r.stop.reason).toBe('unreclaimable_unparseable')
    expect(r.stop.path).toBe(path.join(root, '.skillsmith-writes.lock'))
  })
})
