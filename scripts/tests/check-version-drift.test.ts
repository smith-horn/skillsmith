/**
 * SMI-4205: Tests for check-version-drift.mjs.
 *
 * Mocking pattern mirrors Wave B's prepare-release.test.ts — ESM-safe
 * vi.mock('node:child_process', ...) declared before SUT import, with
 * per-test vi.mocked(execFileSync).mockReturnValueOnce / mockImplementationOnce.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { execFileSync } from 'node:child_process'

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) }
})

// Import the SUT after the mock is registered.
// @ts-expect-error -- plain ESM module, no .d.ts
import { runDriftCheck, semverLt, loadPackages } from '../check-version-drift.mjs'

const mockedExecFileSync = vi.mocked(execFileSync)

interface DriftEntry {
  pkg: string
  local: string
  npmLatest?: string
  note?: string
  error?: string
  stderr?: string
}
interface Report {
  drifted: DriftEntry[]
  clean: DriftEntry[]
  errors: DriftEntry[]
}

beforeEach(() => {
  mockedExecFileSync.mockReset()
})

describe('semverLt', () => {
  it('returns true when a < b on major, minor, or patch', () => {
    expect(semverLt('0.5.1', '0.5.2')).toBe(true)
    expect(semverLt('0.4.9', '0.5.0')).toBe(true)
    expect(semverLt('0.9.9', '1.0.0')).toBe(true)
  })

  it('returns false when equal or a > b', () => {
    expect(semverLt('0.5.1', '0.5.1')).toBe(false)
    expect(semverLt('1.0.0', '0.9.9')).toBe(false)
  })

  it('returns false (safe default) on invalid input', () => {
    expect(semverLt('not-a-version', '1.0.0')).toBe(false)
    expect(semverLt('1.0', '1.0.0')).toBe(false)
  })
})

describe('runDriftCheck', () => {
  it('returns clean state with no drift and no errors', () => {
    mockedExecFileSync.mockReturnValueOnce('0.5.1\n')
    const report = runDriftCheck([
      { name: '@skillsmith/core', version: '0.5.1', dir: 'core' },
    ]) as Report
    expect(report.drifted).toHaveLength(0)
    expect(report.errors).toHaveLength(0)
    expect(report.clean).toHaveLength(1)
    expect(report.clean[0]).toMatchObject({
      pkg: '@skillsmith/core',
      local: '0.5.1',
      npmLatest: '0.5.1',
    })
  })

  it('flags a single-package drift', () => {
    mockedExecFileSync.mockReturnValueOnce('0.5.2\n')
    const report = runDriftCheck([
      { name: '@skillsmith/core', version: '0.5.1', dir: 'core' },
    ]) as Report
    expect(report.drifted).toHaveLength(1)
    expect(report.drifted[0]).toMatchObject({
      pkg: '@skillsmith/core',
      local: '0.5.1',
      npmLatest: '0.5.2',
    })
    expect(report.clean).toHaveLength(0)
    expect(report.errors).toHaveLength(0)
  })

  it('flags drift on multiple packages', () => {
    mockedExecFileSync.mockReturnValueOnce('0.5.2\n').mockReturnValueOnce('0.5.5\n')
    const report = runDriftCheck([
      { name: '@skillsmith/core', version: '0.5.1', dir: 'core' },
      { name: '@skillsmith/cli', version: '0.5.4', dir: 'cli' },
    ]) as Report
    expect(report.drifted).toHaveLength(2)
    expect(report.drifted.map((d) => d.pkg)).toEqual(['@skillsmith/core', '@skillsmith/cli'])
  })

  it('treats npm 404 (E404) as clean with note:unpublished', () => {
    mockedExecFileSync.mockImplementationOnce(() => {
      const err = new Error('npm ERR! code E404') as NodeJS.ErrnoException & {
        stderr?: string
        status?: number
      }
      err.stderr = 'npm ERR! 404 Not Found - GET https://registry.npmjs.org/@skillsmith%2fnewthing'
      err.status = 1
      throw err
    })
    const report = runDriftCheck([
      { name: '@skillsmith/newthing', version: '0.1.0', dir: 'newthing' },
    ]) as Report
    expect(report.clean).toHaveLength(1)
    expect(report.clean[0]).toMatchObject({ pkg: '@skillsmith/newthing', note: 'unpublished' })
    expect(report.errors).toHaveLength(0)
  })

  it('treats ENOTFOUND network error as a hard error', () => {
    mockedExecFileSync.mockImplementationOnce(() => {
      const err = new Error('getaddrinfo ENOTFOUND registry.npmjs.org') as NodeJS.ErrnoException & {
        stderr?: string
        status?: number
      }
      err.stderr = 'npm ERR! network getaddrinfo ENOTFOUND registry.npmjs.org'
      err.status = 1
      throw err
    })
    const report = runDriftCheck([
      { name: '@skillsmith/core', version: '0.5.1', dir: 'core' },
    ]) as Report
    expect(report.errors).toHaveLength(1)
    expect(report.errors[0].pkg).toBe('@skillsmith/core')
    expect(report.clean).toHaveLength(0)
    expect(report.drifted).toHaveLength(0)
  })

  it('treats EACCES auth failure as a hard error', () => {
    mockedExecFileSync.mockImplementationOnce(() => {
      const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException & {
        stderr?: string
        status?: number
      }
      err.stderr = 'npm ERR! code EACCES\nnpm ERR! auth required'
      err.status = 1
      throw err
    })
    const report = runDriftCheck([
      { name: '@skillsmith/core', version: '0.5.1', dir: 'core' },
    ]) as Report
    expect(report.errors).toHaveLength(1)
    expect(report.errors[0].pkg).toBe('@skillsmith/core')
  })
})

describe('loadPackages', () => {
  it('filters private packages out', () => {
    // This reads the real packages/ dir; the website package is private:true
    // and must be absent from the result. All public packages expose name+version.
    const pkgs = loadPackages()
    expect(pkgs.length).toBeGreaterThan(0)
    const names = pkgs.map((p: { name: string }) => p.name)
    expect(names).not.toContain('@skillsmith/website')
    for (const p of pkgs as Array<{ name: string; version: string }>) {
      expect(typeof p.name).toBe('string')
      expect(typeof p.version).toBe('string')
    }
  })
})
