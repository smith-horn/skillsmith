/**
 * Tests for scripts/lib/release-git.ts — SMI-4775 lockfile regen + createCommit lockfile inclusion.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { execFileSync } from 'child_process'

// ESM-safe module mocks (must be declared before importing SUT).
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process')
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) }
})

import { regenerateLockfile, createCommit } from '../lib/release-git'
import { PACKAGE_SPECS, ROOT_DIR } from '../lib/version-utils'
import type { BumpPlan } from '../lib/release-collision'

const mockedExecFileSync = vi.mocked(execFileSync)

const corePlan: BumpPlan = {
  spec: PACKAGE_SPECS.find((s) => s.shortName === 'core')!,
  currentVersion: '0.5.8',
  newVersion: '0.6.0',
}

describe('regenerateLockfile (SMI-4775)', () => {
  beforeEach(() => {
    mockedExecFileSync.mockReset()
    mockedExecFileSync.mockReturnValue('' as never)
  })

  it("calls 'npm install --package-lock-only --ignore-scripts' from ROOT_DIR", () => {
    regenerateLockfile()
    expect(mockedExecFileSync).toHaveBeenCalledTimes(1)
    const [cmd, args, opts] = mockedExecFileSync.mock.calls[0]!
    expect(cmd).toBe('npm')
    expect(args).toEqual(['install', '--package-lock-only', '--ignore-scripts'])
    expect(opts).toMatchObject({ cwd: ROOT_DIR, stdio: 'inherit' })
  })
})

describe('createCommit lockfile inclusion (SMI-4775)', () => {
  beforeEach(() => {
    mockedExecFileSync.mockReset()
    mockedExecFileSync.mockReturnValue('' as never)
  })

  it("does NOT add 'package-lock.json' to git add when includeLockfile is omitted (back-compat default)", () => {
    createCommit([corePlan])
    const addCall = mockedExecFileSync.mock.calls.find(
      (c) => c[0] === 'git' && Array.isArray(c[1]) && c[1][0] === 'add'
    )
    expect(addCall).toBeDefined()
    const addArgs = addCall![1] as string[]
    expect(addArgs).not.toContain('package-lock.json')
  })

  it("adds 'package-lock.json' to git add when includeLockfile=true", () => {
    createCommit([corePlan], true)
    const addCall = mockedExecFileSync.mock.calls.find(
      (c) => c[0] === 'git' && Array.isArray(c[1]) && c[1][0] === 'add'
    )
    expect(addCall).toBeDefined()
    const addArgs = addCall![1] as string[]
    expect(addArgs).toContain('package-lock.json')
  })

  it("does NOT add 'package-lock.json' when includeLockfile=false (--no-lockfile-regen path)", () => {
    createCommit([corePlan], false)
    const addCall = mockedExecFileSync.mock.calls.find(
      (c) => c[0] === 'git' && Array.isArray(c[1]) && c[1][0] === 'add'
    )
    const addArgs = addCall![1] as string[]
    expect(addArgs).not.toContain('package-lock.json')
  })
})
