/**
 * SMI-7143 (retro governance L2): the second `releaseOwned` warning,
 * `lock_release_unlink_failed`, cannot throw either.
 *
 * Releasing a lock this process still owns unlinks it. When that unlink
 * fails with anything but ENOENT, release warns. Release runs in
 * `withFileLock`'s `finally`, so a throwing `console.warn` there would replace
 * the work's result. `unlinkSync` is a named import in `owned-lock.claim.ts`,
 * so the failure is injected by mocking `node:fs` for one lock path only.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const inject = vi.hoisted(() => ({ failUnlinkOf: null as string | null }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const unlinkSync = ((p: fs.PathLike) => {
    if (inject.failUnlinkOf !== null && String(p) === inject.failUnlinkOf) {
      throw Object.assign(new Error(`EACCES: permission denied, unlink '${String(p)}'`), {
        code: 'EACCES',
      })
    }
    return actual.unlinkSync(p)
  }) as typeof actual.unlinkSync
  return { ...actual, unlinkSync, default: { ...actual, unlinkSync } }
})

import { withFileLock } from '../../../src/config/file-lock.js'

const roots: string[] = []
afterEach(() => {
  inject.failUnlinkOf = null
  vi.restoreAllMocks()
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

describe('releaseOwned when the unlink of an owned lock fails', () => {
  it("warns, does not throw, and withFileLock returns the work's result", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'warn-unlink-')))
    roots.push(root)
    const t = path.join(root, 'manifest.json')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('logger exploded')
    })

    const out = await withFileLock(t, 'test', async () => {
      inject.failUnlinkOf = `${t}.lock`
      return 'saved'
    })

    expect(out).toBe('saved')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('lock_release_unlink_failed'))
    // The unlink really failed: the lock is still there.
    expect(fs.existsSync(`${t}.lock`)).toBe(true)
  })
})
