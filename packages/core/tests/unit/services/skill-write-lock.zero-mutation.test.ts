/**
 * SMI-6531 (A1 step 2, T-L15 lock level): a skills root swapped after the bind.
 *
 *  - Swapped BEFORE `withSkillWriteLock` is called: the pre-lock check refuses
 *    before lock 1 is requested, so not even the lock file is created in the
 *    directory now at R's path.
 *  - Swapped AFTER the pre-lock check and before the lock is acquired: Node has
 *    no openat-style relative create, so the lock file IS created in the
 *    replacement root. The check under the lock refuses before `fn` runs, and
 *    the release removes the lock file, so nothing of ours is left there.
 *
 * Creating and removing the lock file leaves no trace in a snapshot, so the
 * first test watches the exclusive creates themselves: every `openSync` with a
 * write flag under the watched directory is counted. The control takes the lock
 * on an unswapped root and must see at least one, which proves the watch can
 * see a lock acquisition (an absence claim needs a presence proof from the
 * same run).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const watch = vi.hoisted(() => ({ dir: null as string | null, creates: [] as string[] }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const openSync = ((p: import('node:fs').PathLike, flags?: unknown, ...rest: unknown[]) => {
    if (
      watch.dir !== null &&
      String(p).startsWith(`${watch.dir}${path.sep}`) &&
      typeof flags === 'string' &&
      /[wa+]/.test(flags)
    ) {
      watch.creates.push(String(p))
    }
    return (actual.openSync as (...a: unknown[]) => number)(p, flags, ...rest)
  }) as typeof actual.openSync
  return { ...actual, openSync, default: { ...actual, openSync } }
})

vi.mock('../../../src/services/skill-write-lock.gitignore.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/skill-write-lock.gitignore.js')>()),
  stagingGitignoreHint: vi.fn(async () => null),
}))

import { setLockTrackerEnabledForTests } from '../../../src/config/lock-tracker.js'
import { bindSkillsRoot, withSkillWriteLock } from '../../../src/services/skill-write-lock.js'

let base: string

beforeEach(() => {
  setLockTrackerEnabledForTests(true)
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skill-write-lock-zero-')))
  watch.dir = null
  watch.creates = []
})
afterEach(() => {
  watch.dir = null
  fs.rmSync(base, { recursive: true, force: true })
})

describe('a root swapped before the call gets no lock file at all', () => {
  it('control: on an unswapped root the lock acquisition IS visible to the watch', async () => {
    const root = path.join(base, 'r')
    fs.mkdirSync(root)
    const b = await bindSkillsRoot(root)
    watch.dir = b.root
    const r = await withSkillWriteLock(b, 't', async () => 'ran')
    expect(r).toMatchObject({ ok: true })
    expect(watch.creates.length).toBeGreaterThan(0)
    expect(watch.creates.some((p) => p.includes('.skillsmith-writes'))).toBe(true)
  })

  it.each([
    ['empty', false],
    ['a cp -R copy', true],
  ])('R renamed away and recreated as %s: root-changed, zero creates under R', async (_l, copy) => {
    const root = path.join(base, 'r')
    fs.mkdirSync(root)
    const b = await bindSkillsRoot(root)
    const moved = path.join(base, 'moved')
    fs.renameSync(root, moved)
    if (copy) fs.cpSync(moved, root, { recursive: true })
    else fs.mkdirSync(root)
    watch.dir = b.root
    const fn = vi.fn(async () => 'ran')
    const r = await withSkillWriteLock(b, 't', fn)
    expect(!r.ok && r.stop.code).toBe('root-changed')
    expect(fn).not.toHaveBeenCalled()
    expect(watch.creates).toEqual([])
  })
})

describe('a root swapped after the pre-lock check, before the lock is acquired', () => {
  it.each([
    ['empty', false],
    ['a cp -R copy', true],
  ])(
    'R replaced by %s: fn never runs, the result is root-changed, and nothing of ours is left in the replacement',
    async (_l, copy) => {
      const root = path.join(base, 'r')
      fs.mkdirSync(root)
      const b = await bindSkillsRoot(root)
      const moved = path.join(base, 'moved')
      const entriesBefore: string[] = []
      watch.dir = b.root
      const fn = vi.fn(async () => 'ran')
      const r = await withSkillWriteLock(b, 't', fn, {
        beforeLock: () => {
          fs.renameSync(root, moved)
          if (copy) fs.cpSync(moved, root, { recursive: true })
          else fs.mkdirSync(root)
          entriesBefore.push(...fs.readdirSync(root).sort())
        },
      })
      expect(!r.ok && r.stop.code).toBe('root-changed')
      expect(fn).not.toHaveBeenCalled()
      // Presence proof from the same run: the lock file really was created by
      // path in the replacement root (this is the residual), so the absence
      // below is the release removing it, not a watch that saw nothing.
      expect(watch.creates.some((p) => p.includes('.skillsmith-writes'))).toBe(true)
      expect(fs.existsSync(path.join(root, '.skillsmith-writes.lock'))).toBe(false)
      expect(fs.readdirSync(root).sort()).toEqual(entriesBefore)
    }
  )
})
