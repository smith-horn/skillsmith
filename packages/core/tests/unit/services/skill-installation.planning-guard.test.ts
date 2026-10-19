/**
 * SMI-6531 (A1 step 1), T-L10: the fetch and scan wrappers install uses call
 * `assertSkillWriteLockNotHeld` on entry, so none of them can run under the
 * skills-root lock (plan §3.2 "Never held across").
 *
 * Each wrapper is run twice: inside lock 1 (must throw `held-while-planning`
 * before touching the network or the scanner) and outside any lock (must not
 * throw a `LockOrderError`; the control proves the guard, not the wrapper's
 * own failure, produced the first result).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withFileLock } from '../../../src/config/file-lock.js'
import { LockOrderError, setLockTrackerEnabledForTests } from '../../../src/config/lock-tracker.js'
import {
  fetchAndScanOptionalFiles,
  fetchFromGitHub,
} from '../../../src/services/skill-installation.io.js'
import { scanContentFiles } from '../../../src/services/skill-installation.content.js'

let dir: string

beforeEach(() => {
  setLockTrackerEnabledForTests(true)
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planning-guard-'))
})

afterEach(() => {
  vi.restoreAllMocks()
  setLockTrackerEnabledForTests(true)
  fs.rmSync(dir, { recursive: true, force: true })
})

/** Run `fn` inside a rank-'1' lock; resolves with what `fn` threw, or undefined. */
async function thrownUnderLockOne(fn: () => unknown): Promise<unknown> {
  let thrown: unknown
  await withFileLock(
    path.join(dir, 'skills-writes'),
    'test lock 1',
    async () => {
      try {
        await fn()
      } catch (error) {
        thrown = error
      }
    },
    { rank: '1' }
  )
  return thrown
}

function expectHeldWhilePlanning(error: unknown, label: string): void {
  expect(error).toBeInstanceOf(LockOrderError)
  expect((error as LockOrderError).kind).toBe('held-while-planning')
  expect((error as LockOrderError).message).toContain(label)
}

function mockFetchOk(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    return { ok: true, status: 200, text: async () => '# readme\n' } as unknown as Response
  })
}

describe('T-L10: fetch wrappers refuse to run under lock 1', () => {
  it('fetchFromGitHub throws held-while-planning and never calls fetch', async () => {
    const fetchSpy = mockFetchOk()
    const error = await thrownUnderLockOne(() => fetchFromGitHub('o', 'r', 'SKILL.md'))
    expectHeldWhilePlanning(error, 'fetchFromGitHub')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('fetchFromGitHub runs normally outside any lock', async () => {
    const fetchSpy = mockFetchOk()
    await expect(fetchFromGitHub('o', 'r', 'SKILL.md')).resolves.toBe('# readme\n')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('fetchAndScanOptionalFiles throws held-while-planning and never calls fetch', async () => {
    const fetchSpy = mockFetchOk()
    const error = await thrownUnderLockOne(() =>
      fetchAndScanOptionalFiles('o', 'r', '', 'main', 'o/r', { riskThreshold: 40 })
    )
    expectHeldWhilePlanning(error, 'fetchAndScanOptionalFiles')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('fetchAndScanOptionalFiles runs normally outside any lock', async () => {
    const fetchSpy = mockFetchOk()
    const result = await fetchAndScanOptionalFiles('o', 'r', '', 'main', 'o/r', {
      riskThreshold: 40,
    })
    expect(result.failedScans).toEqual([])
    expect(fetchSpy).toHaveBeenCalled()
  })
})

describe('T-L10: the content scan wrapper refuses to run under lock 1', () => {
  it('scanContentFiles throws held-while-planning under lock 1', async () => {
    const error = await thrownUnderLockOne(() =>
      scanContentFiles({ 'SKILL.md': '# a clean skill\n' }, 'acme/tool')
    )
    expectHeldWhilePlanning(error, 'scanContentFiles')
  })

  it('scanContentFiles runs normally outside any lock', () => {
    expect(scanContentFiles({ 'SKILL.md': '# a clean skill\n' }, 'acme/tool')).toBeNull()
  })
})

describe('SMI-6531: a lock-order refusal is not hidden behind the generic install error', () => {
  it('sanitizeInstallError passes a LockOrderError message through', async () => {
    const { sanitizeInstallError } =
      await import('../../../src/services/skill-installation.helpers.js')
    const { LockOrderError } = await import('../../../src/config/lock-tracker.js')
    const err = new LockOrderError(
      'held-while-planning',
      'scan: scanContentFiles ran while holding lock 1'
    )

    expect(sanitizeInstallError(err)).toBe(err.message)
    expect(sanitizeInstallError(new Error('something private'))).toBe(
      'Installation failed due to an internal error'
    )
  })
})
