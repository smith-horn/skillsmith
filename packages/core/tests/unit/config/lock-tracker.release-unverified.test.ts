/**
 * SMI-6531 (A1 step 1): a release that cannot show the lock is gone answers
 * false, and keeps answering false.
 *
 * The case is real, not injected: a lock path UNDER A REGULAR FILE. Opening it
 * fails ENOTDIR (the claim reads as `unparseable`) and `lstat` fails ENOTDIR
 * too, which is not ENOENT: nothing proves the lock is gone, so `releaseOwned`
 * must answer false and warn `lock_release_unverified` (not `not_owner`).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { releaseClaimFile } from '../../../src/config/owned-lock.claim.js'
import { makeRelease, releaseOwned } from '../../../src/config/owned-lock.release.js'

const TOKEN = 'a'.repeat(16)
let dir: string
let lockPath: string
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lock-release-unverified-')))
  fs.writeFileSync(path.join(dir, 'file'), 'a regular file, not a folder')
  lockPath = path.join(dir, 'file', 'x.lock')
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
})

const warned = (name: string): boolean =>
  warnSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes(name))

// The claim-file release is where the verdict is reached. `releaseOwned` wraps
// it in `<lock>.reclaim` (SMI-7148), which cannot even be created under a
// regular file, so the guarded release answers false for a different reason
// (`lock_release_reclaim_failed`, last test of this block).
describe('releaseClaimFile when lstat fails with something other than ENOENT', () => {
  it('the path really fails with ENOTDIR, not ENOENT (the precondition)', () => {
    let code: string | undefined
    try {
      fs.lstatSync(lockPath)
    } catch (e) {
      code = (e as NodeJS.ErrnoException).code
    }
    expect(code).toBe('ENOTDIR')
  })

  it('answers false and warns lock_release_unverified, not not_owner', () => {
    expect(releaseClaimFile(lockPath, TOKEN)).toBe(false)
    expect(warned('lock_release_unverified')).toBe(true)
    expect(warned('lock_release_not_owner')).toBe(false)
  })

  it('control: a path that is really gone answers true', () => {
    expect(releaseClaimFile(path.join(dir, 'missing.lock'), TOKEN)).toBe(true)
    expect(warned('lock_release_unverified')).toBe(false)
  })

  it('the guarded releaseOwned also answers false here, because .reclaim cannot be created', () => {
    expect(releaseOwned(lockPath, TOKEN)).toBe(false)
    expect(warned('lock_release_reclaim_failed')).toBe(true)
    expect(warned('lock_release_not_owner')).toBe(false)
  })
})

describe('makeRelease memoises a false answer', () => {
  it('a second call after a false first call is also false, and does not release again', () => {
    const release = makeRelease(lockPath, TOKEN)
    expect(release()).toBe(false)
    const warningsAfterFirst = warnSpy.mock.calls.length
    expect(warningsAfterFirst).toBeGreaterThan(0)
    expect(release()).toBe(false)
    expect(warnSpy.mock.calls.length).toBe(warningsAfterFirst)
  })

  it('control: a true first answer is also repeated', () => {
    const release = makeRelease(path.join(dir, 'missing.lock'), TOKEN)
    expect(release()).toBe(true)
    expect(release()).toBe(true)
  })
})
