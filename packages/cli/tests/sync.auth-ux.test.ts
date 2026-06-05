/**
 * SMI-4482: CLI `sync` command — actionable auth UX.
 *
 * Covers the fresh-install scenario where `skillsmith sync` runs before
 * `skillsmith login`: the API client reaches the anonymous IP-trial path, the
 * per-IP trial limit is exhausted server-side, and the `skills-search` edge
 * function returns HTTP 401 `{"error":"Authentication required"}`. Previously
 * the CLI printed a bare `Authentication required` with `Σ Total: 0`; it must
 * now print actionable next steps and exit non-zero.
 *
 * Network is fully mocked — no production API calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SyncResult } from '@skillsmith/core'
import { isAuthFailure, formatAuthGuidance } from '../src/commands/sync.helpers.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeResult(overrides: Partial<SyncResult> = {}): SyncResult {
  return {
    success: false,
    skillsAdded: 0,
    skillsUpdated: 0,
    skillsUnchanged: 0,
    totalProcessed: 0,
    errors: [],
    durationMs: 5,
    dryRun: false,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Pure-helper tests
// ---------------------------------------------------------------------------

describe('SMI-4482: isAuthFailure', () => {
  it('detects the server "Authentication required" 401 signal', () => {
    expect(isAuthFailure(makeResult({ errors: ['Authentication required'] }))).toBe(true)
  })

  it('detects an "Unauthorized" variant', () => {
    expect(isAuthFailure(makeResult({ errors: ['Fetch error at offset 0: Unauthorized'] }))).toBe(
      true
    )
  })

  it('is case-insensitive', () => {
    expect(isAuthFailure(makeResult({ errors: ['authentication required'] }))).toBe(true)
  })

  it('returns false for a transient network error (no auth signal)', () => {
    expect(isAuthFailure(makeResult({ errors: ['fetch failed'] }))).toBe(false)
  })

  it('returns false for a successful sync', () => {
    expect(isAuthFailure(makeResult({ success: true, totalProcessed: 12, skillsAdded: 12 }))).toBe(
      false
    )
  })

  it('returns false when partial results were returned even if an auth error is present', () => {
    // A creds-present run that hit a 401 on one page but still synced skills
    // is NOT a "needs login" situation — the user already has access.
    expect(
      isAuthFailure(makeResult({ totalProcessed: 5, errors: ['Authentication required'] }))
    ).toBe(false)
  })

  it('returns false when there are no errors', () => {
    expect(isAuthFailure(makeResult({ errors: [] }))).toBe(false)
  })
})

describe('SMI-4482: formatAuthGuidance', () => {
  it('includes the login command and the headless/CI hint', () => {
    const text = formatAuthGuidance().join('\n')
    expect(text).toContain('skillsmith login')
    expect(text).toContain('Sync requires authentication')
    expect(text).toContain('SKILLSMITH_API_KEY')
  })
})

// ---------------------------------------------------------------------------
// Command-level tests
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  runRegistrySync: vi.fn(),
  dbClose: vi.fn(),
  spinner: {
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
    text: '',
  },
}))

vi.mock('../src/commands/run-registry-sync.js', () => ({
  runRegistrySync: (...args: unknown[]) => mocks.runRegistrySync(...args),
}))

vi.mock('../src/utils/open-database.js', () => ({
  openCliDatabase: () => Promise.resolve({ close: mocks.dbClose }),
}))

vi.mock('ora', () => ({ default: () => mocks.spinner }))

const originalConsoleLog = console.log
const originalConsoleError = console.error
const mockConsoleLog = vi.fn()
const mockConsoleError = vi.fn()

describe('SMI-4482: sync command — no-credentials UX', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    console.log = mockConsoleLog
    console.error = mockConsoleError
    process.exitCode = undefined
  })

  afterEach(() => {
    console.log = originalConsoleLog
    console.error = originalConsoleError
    process.exitCode = undefined
  })

  it('prints actionable login guidance (not a bare error) and exits non-zero', async () => {
    mocks.runRegistrySync.mockResolvedValue(makeResult({ errors: ['Authentication required'] }))

    const { createSyncCommand } = await import('../src/commands/sync.js')
    await createSyncCommand().parseAsync(['node', 'test'])

    const stderr = mockConsoleError.mock.calls.map((c) => String(c[0])).join('\n')
    expect(stderr).toContain('Sync requires authentication')
    expect(stderr).toContain('skillsmith login')
    expect(stderr).toContain('SKILLSMITH_API_KEY')
    expect(process.exitCode).toBe(1)

    // The bad UX must NOT appear: no bare "Σ Total: 0" results block.
    const stdout = mockConsoleLog.mock.calls.map((c) => String(c[0])).join('\n')
    expect(stdout).not.toContain('Total:')
    expect(mocks.dbClose).toHaveBeenCalled()
  })

  it('emits machine-readable JSON and exit code 1 with --json on auth failure', async () => {
    mocks.runRegistrySync.mockResolvedValue(makeResult({ errors: ['Authentication required'] }))

    const { createSyncCommand } = await import('../src/commands/sync.js')
    await createSyncCommand().parseAsync(['node', 'test', '--json'])

    const stdout = mockConsoleLog.mock.calls.map((c) => String(c[0])).join('\n')
    const parsed = JSON.parse(stdout)
    expect(parsed.errors).toContain('Authentication required')
    expect(process.exitCode).toBe(1)
  })

  it('does NOT trigger the guard for a successful (creds-present) sync', async () => {
    mocks.runRegistrySync.mockResolvedValue(
      makeResult({ success: true, totalProcessed: 8, skillsAdded: 8 })
    )

    const { createSyncCommand } = await import('../src/commands/sync.js')
    await createSyncCommand().parseAsync(['node', 'test'])

    expect(mocks.spinner.succeed).toHaveBeenCalled()
    const stdout = mockConsoleLog.mock.calls.map((c) => String(c[0])).join('\n')
    expect(stdout).toContain('Total:')
    const stderr = mockConsoleError.mock.calls.map((c) => String(c[0])).join('\n')
    expect(stderr).not.toContain('Sync requires authentication')
    expect(process.exitCode).toBeUndefined()
  })

  it('does NOT trigger the guard for a non-auth transient failure', async () => {
    mocks.runRegistrySync.mockResolvedValue(makeResult({ errors: ['fetch failed'] }))

    const { createSyncCommand } = await import('../src/commands/sync.js')
    await createSyncCommand().parseAsync(['node', 'test'])

    expect(mocks.spinner.warn).toHaveBeenCalled()
    const stderr = mockConsoleError.mock.calls.map((c) => String(c[0])).join('\n')
    expect(stderr).not.toContain('Sync requires authentication')
  })
})
