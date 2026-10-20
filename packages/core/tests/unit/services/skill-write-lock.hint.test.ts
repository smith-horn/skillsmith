/**
 * SMI-6531 (A1 step 2): when the staging `.gitignore` hint is computed.
 *
 * The hint module is replaced by a recording stub here (its own behaviour is
 * tested with it). What this file pins is the CALLER's contract (A1 plan §3.2):
 * the hint is computed only when this call's `mkdir` created
 * `.skillsmith-staging/` (not when it merely took lock 1), and only after lock 1
 * is released.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hint = vi.hoisted(() => ({ fn: vi.fn() }))
vi.mock('../../../src/services/skill-write-lock.gitignore.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/skill-write-lock.gitignore.js')>()),
  stagingGitignoreHint: hint.fn,
}))

import {
  assertSkillWriteLockNotHeld,
  LockOrderError,
  setLockTrackerEnabledForTests,
} from '../../../src/config/lock-tracker.js'
import { bindSkillsRoot, withSkillWriteLock } from '../../../src/services/skill-write-lock.js'

const LINE = 'hint: test line'
let base: string

/** What the stub saw at the moment it ran. */
interface Seen {
  root: string
  lockFileExists: boolean
  lock1NotHeld: boolean
}
let seen: Seen[]

function makeRoot(name: string): string {
  const root = path.join(base, name)
  fs.mkdirSync(root)
  return fs.realpathSync(root)
}

beforeEach(() => {
  setLockTrackerEnabledForTests(true)
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skill-write-lock-hint-')))
  seen = []
  hint.fn.mockReset()
  hint.fn.mockImplementation(async (root: string) => {
    let notHeld = true
    try {
      assertSkillWriteLockNotHeld('hint-stub')
    } catch {
      notHeld = false
    }
    seen.push({
      root,
      lockFileExists: fs.existsSync(path.join(root, '.skillsmith-writes.lock')),
      lock1NotHeld: notHeld,
    })
    return LINE
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(base, { recursive: true, force: true })
})

describe('the staging hint', () => {
  it('is computed once, after lock 1 is released, for the run that created ST', async () => {
    const root = makeRoot('r')
    const r = await withSkillWriteLock(root, 't', async () => {
      expect(hint.fn).not.toHaveBeenCalled() // not before, not under the lock
      return 'v'
    })
    expect(r).toEqual({ ok: true, value: 'v', gitignoreHint: LINE })
    expect(hint.fn).toHaveBeenCalledTimes(1)
    expect(hint.fn).toHaveBeenCalledWith(root)
    // At the moment it ran, the tracker held no lock 1 and the lock file was gone.
    expect(seen).toEqual([{ root, lockFileExists: false, lock1NotHeld: true }])
  })

  it('control: the same assertion DOES throw while lock 1 is held', async () => {
    const root = makeRoot('r')
    let inside: unknown
    await withSkillWriteLock(root, 't', async () => {
      try {
        assertSkillWriteLockNotHeld('under-lock')
      } catch (err) {
        inside = err
      }
    })
    expect(inside).toBeInstanceOf(LockOrderError)
    expect((inside as LockOrderError).kind).toBe('held-while-planning')
  })

  it('is NOT computed when ST already existed: taking lock 1 alone does not trigger it', async () => {
    const root = makeRoot('r')
    await bindSkillsRoot(root) // ST now exists; this binding's hint is never taken
    hint.fn.mockClear()
    const r = await withSkillWriteLock(root, 't', async () => 'v')
    expect(r).toEqual({ ok: true, value: 'v' })
    expect('gitignoreHint' in r).toBe(false)
    expect(hint.fn).not.toHaveBeenCalled()
  })

  it('a binding is asked once: a second lock-1 run on the same binding does not repeat it', async () => {
    const root = makeRoot('r')
    const b = await bindSkillsRoot(root)
    const first = await withSkillWriteLock(b, 'one', async () => 1)
    const second = await withSkillWriteLock(b, 'two', async () => 2)
    expect(first).toMatchObject({ ok: true, gitignoreHint: LINE })
    expect(second).toEqual({ ok: true, value: 2 })
    expect(hint.fn).toHaveBeenCalledTimes(1)
  })

  it('still reaches the caller when the run ends in a stop, and runs after release', async () => {
    const root = makeRoot('r')
    const r = await withSkillWriteLock(root, 't', async (ctx) => {
      fs.renameSync(ctx.stagingDir, `${ctx.stagingDir}.moved`)
      fs.mkdirSync(ctx.stagingDir)
      ctx.check()
    })
    expect(!r.ok && r.stop.code).toBe('staging-unsafe')
    expect(r.gitignoreHint).toBe(LINE)
    expect(seen[0]).toMatchObject({ lockFileExists: false, lock1NotHeld: true })
  })

  it('a null answer leaves the result without a hint', async () => {
    hint.fn.mockResolvedValue(null)
    const r = await withSkillWriteLock(makeRoot('r'), 't', async () => 'v')
    expect(hint.fn).toHaveBeenCalledTimes(1)
    expect(r).toEqual({ ok: true, value: 'v' })
  })

  it('an advisory failure is dropped and does not fail the write', async () => {
    hint.fn.mockRejectedValue(new Error('git exploded'))
    const r = await withSkillWriteLock(makeRoot('r'), 't', async () => 'v')
    expect(hint.fn).toHaveBeenCalledTimes(1)
    expect(r).toEqual({ ok: true, value: 'v' })
  })

  it('a LockOrderError from the hint is NOT dropped: it means the hint ran under a lock', async () => {
    hint.fn.mockRejectedValue(new LockOrderError('held-while-planning', 'ran under lock 1'))
    await expect(withSkillWriteLock(makeRoot('r'), 't', async () => 'v')).rejects.toBeInstanceOf(
      LockOrderError
    )
  })
})
