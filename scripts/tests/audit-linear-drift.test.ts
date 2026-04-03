/**
 * Tests for Linear Drift Audit (SMI-3542, SMI-3826)
 *
 * Tests core verification logic with mocked git/gh CLI calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { readFileSync, existsSync } from 'fs'

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}))

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
}))

const mockedExecFileSync = vi.mocked(execFileSync)
const mockedReadFileSync = vi.mocked(readFileSync)
const mockedExistsSync = vi.mocked(existsSync)

// Dynamic import to get the module after mocks are set up
async function importModule() {
  // Clear module cache to pick up fresh mocks
  const mod = await import('../audit-linear-drift.mjs')
  return mod
}

describe('SMI-3542: Linear Drift Audit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('loadAllowlist', () => {
    it('should return empty set when file does not exist', async () => {
      mockedExistsSync.mockReturnValue(false)
      const { loadAllowlist } = await importModule()
      const result = loadAllowlist()
      expect(result).toBeInstanceOf(Set)
      expect(result.size).toBe(0)
    })

    it('should parse valid issue IDs and ignore comments', async () => {
      mockedExistsSync.mockReturnValue(true)
      mockedReadFileSync.mockReturnValue(
        '# Comment line\nSMI-100\n# Another comment\nSMI-200\n\nSMI-300\n'
      )
      const { loadAllowlist } = await importModule()
      const result = loadAllowlist()
      expect(result.size).toBe(3)
      expect(result.has('SMI-100')).toBe(true)
      expect(result.has('SMI-200')).toBe(true)
      expect(result.has('SMI-300')).toBe(true)
    })

    it('should handle inline comments', async () => {
      mockedExistsSync.mockReturnValue(true)
      mockedReadFileSync.mockReturnValue('SMI-100  # docs-only task\n')
      const { loadAllowlist } = await importModule()
      const result = loadAllowlist()
      expect(result.size).toBe(1)
      expect(result.has('SMI-100')).toBe(true)
    })

    it('should skip blank lines', async () => {
      mockedExistsSync.mockReturnValue(true)
      mockedReadFileSync.mockReturnValue('\n\n\nSMI-100\n\n')
      const { loadAllowlist } = await importModule()
      const result = loadAllowlist()
      expect(result.size).toBe(1)
    })
  })

  describe('hasGitCommitWithSource', () => {
    it('should return true when git log finds a matching commit', async () => {
      mockedExecFileSync.mockReturnValue('abc123def456\n')
      const { hasGitCommitWithSource } = await importModule()
      expect(hasGitCommitWithSource('SMI-100')).toBe(true)
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['--grep=SMI-100']),
        expect.any(Object)
      )
    })

    it('should return false when git log returns empty', async () => {
      mockedExecFileSync.mockReturnValue('')
      const { hasGitCommitWithSource } = await importModule()
      expect(hasGitCommitWithSource('SMI-100')).toBe(false)
    })

    it('should return false when git log throws', async () => {
      mockedExecFileSync.mockImplementation(() => {
        throw new Error('git error')
      })
      const { hasGitCommitWithSource } = await importModule()
      expect(hasGitCommitWithSource('SMI-100')).toBe(false)
    })
  })

  describe('hasMergedPr', () => {
    it('should return true when gh search finds merged PRs', async () => {
      mockedExecFileSync.mockReturnValue('1\n')
      const { hasMergedPr } = await importModule()
      expect(hasMergedPr('SMI-100')).toBe(true)
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'gh',
        expect.arrayContaining(['search', 'prs', 'SMI-100']),
        expect.any(Object)
      )
    })

    it('should return false when no merged PRs found', async () => {
      mockedExecFileSync.mockReturnValue('0\n')
      const { hasMergedPr } = await importModule()
      expect(hasMergedPr('SMI-100')).toBe(false)
    })

    it('should return false when gh CLI throws', async () => {
      mockedExecFileSync.mockImplementation(() => {
        throw new Error('gh error')
      })
      const { hasMergedPr } = await importModule()
      expect(hasMergedPr('SMI-100')).toBe(false)
    })
  })

  describe('hasAnyGitCommit', () => {
    it('should return true when any commit mentions the issue', async () => {
      mockedExecFileSync.mockReturnValue('abc123\n')
      const { hasAnyGitCommit } = await importModule()
      expect(hasAnyGitCommit('SMI-100')).toBe(true)
    })

    it('should return false when no commit mentions the issue', async () => {
      mockedExecFileSync.mockReturnValue('')
      const { hasAnyGitCommit } = await importModule()
      expect(hasAnyGitCommit('SMI-100')).toBe(false)
    })

    it('should return false on error', async () => {
      mockedExecFileSync.mockImplementation(() => {
        throw new Error('git error')
      })
      const { hasAnyGitCommit } = await importModule()
      expect(hasAnyGitCommit('SMI-100')).toBe(false)
    })
  })

  describe('verifyIssue', () => {
    it('should return verified when source-glob commit exists', async () => {
      // First call (hasGitCommitWithSource) returns a hit
      mockedExecFileSync.mockReturnValueOnce('abc123\n')
      const { verifyIssue } = await importModule()
      const result = verifyIssue('SMI-100', false)
      expect(result.status).toBe('verified')
      expect(result.reason).toBe('source-commit')
    })

    it('should return verified when merged PR exists', async () => {
      // First call (hasGitCommitWithSource) returns empty
      mockedExecFileSync.mockReturnValueOnce('')
      // Second call (hasMergedPr) returns 1
      mockedExecFileSync.mockReturnValueOnce('1\n')
      const { verifyIssue } = await importModule()
      const result = verifyIssue('SMI-100', false)
      expect(result.status).toBe('verified')
      expect(result.reason).toBe('merged-pr')
    })

    it('should return mention-only when only non-source commit exists', async () => {
      // hasGitCommitWithSource → miss
      mockedExecFileSync.mockReturnValueOnce('')
      // hasMergedPr → miss
      mockedExecFileSync.mockReturnValueOnce('0\n')
      // hasAnyGitCommit → hit
      mockedExecFileSync.mockReturnValueOnce('def456\n')
      const { verifyIssue } = await importModule()
      const result = verifyIssue('SMI-100', false)
      expect(result.status).toBe('mention-only')
      expect(result.reason).toBe('commit-exists-no-source-glob')
    })

    it('should return unverified when no commit or PR exists', async () => {
      // hasGitCommitWithSource → miss
      mockedExecFileSync.mockReturnValueOnce('')
      // hasMergedPr → miss
      mockedExecFileSync.mockReturnValueOnce('0\n')
      // hasAnyGitCommit → miss
      mockedExecFileSync.mockReturnValueOnce('')
      const { verifyIssue } = await importModule()
      const result = verifyIssue('SMI-100', false)
      expect(result.status).toBe('unverified')
      expect(result.reason).toBe('no-commit-found')
    })
  })

  describe('parseArgs', () => {
    const originalArgv = process.argv

    afterEach(() => {
      process.argv = originalArgv
    })

    it('should default to 30 days ago and no flags', async () => {
      process.argv = ['node', 'audit-linear-drift.mjs']
      const { parseArgs } = await importModule()
      const result = parseArgs()
      expect(result.jsonMode).toBe(false)
      expect(result.verbose).toBe(false)
      expect(result.since).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    })

    it('should parse --json flag', async () => {
      process.argv = ['node', 'audit-linear-drift.mjs', '--json']
      const { parseArgs } = await importModule()
      const result = parseArgs()
      expect(result.jsonMode).toBe(true)
    })

    it('should parse --verbose flag', async () => {
      process.argv = ['node', 'audit-linear-drift.mjs', '--verbose']
      const { parseArgs } = await importModule()
      const result = parseArgs()
      expect(result.verbose).toBe(true)
    })

    it('should parse --since with custom date', async () => {
      process.argv = ['node', 'audit-linear-drift.mjs', '--since', '2026-01-01']
      const { parseArgs } = await importModule()
      const result = parseArgs()
      expect(result.since).toBe('2026-01-01')
    })

    it('should handle all flags together', async () => {
      process.argv = [
        'node',
        'audit-linear-drift.mjs',
        '--json',
        '--verbose',
        '--since',
        '2026-03-01',
      ]
      const { parseArgs } = await importModule()
      const result = parseArgs()
      expect(result.jsonMode).toBe(true)
      expect(result.verbose).toBe(true)
      expect(result.since).toBe('2026-03-01')
    })
  })
})
