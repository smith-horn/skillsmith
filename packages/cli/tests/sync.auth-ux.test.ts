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
  getSyncApiClient: vi.fn(),
  requireTier: vi.fn(async (_tier: string): Promise<void> => undefined),
  confirm: vi.fn(),
  dbClose: vi.fn(),
  spinner: {
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
    text: '',
  },
  // `sync config` mocks — used only by the tier-gate tests below.
  syncConfigEnable: vi.fn(),
  syncConfigDisable: vi.fn(),
  syncConfigSetFrequency: vi.fn(),
  syncConfigGetConfig: vi.fn(() => ({
    enabled: false,
    frequency: 'daily',
    intervalMs: 86_400_000,
    lastSyncAt: null,
    nextSyncAt: null,
    lastSyncError: null,
  })),
}))

vi.mock('../src/commands/run-registry-sync.js', () => ({
  runRegistrySync: (...args: unknown[]) => mocks.runRegistrySync(...args),
  getSyncApiClient: (...args: unknown[]) => mocks.getSyncApiClient(...args),
}))

vi.mock('../src/utils/require-tier.js', () => ({
  requireTier: (tier: string) => mocks.requireTier(tier),
}))

vi.mock('@inquirer/prompts', () => ({
  confirm: (...args: unknown[]) => mocks.confirm(...args),
}))

vi.mock('../src/utils/open-database.js', () => ({
  openCliDatabase: () => Promise.resolve({ close: mocks.dbClose }),
}))

// SyncConfigRepository/SyncHistoryRepository are the only `@skillsmith/core`
// exports `sync config`'s actions touch — mocked so the `--enable` tier-gate
// tests below can assert `enable()`/`disable()` were (not) reached, without
// exercising the real SQLite-backed repository against the fake `db` object
// the `openCliDatabase` mock above returns.
vi.mock('@skillsmith/core', () => ({
  SyncConfigRepository: function SyncConfigRepository(this: unknown, _db: unknown) {
    ;(this as { enable: () => void }).enable = mocks.syncConfigEnable
    ;(this as { disable: () => void }).disable = mocks.syncConfigDisable
    ;(this as { getConfig: () => unknown }).getConfig = mocks.syncConfigGetConfig
    ;(this as { setFrequency: (freq: string) => void }).setFrequency = mocks.syncConfigSetFrequency
  },
  SyncHistoryRepository: function SyncHistoryRepository(this: unknown, _db: unknown) {},
}))

vi.mock('ora', () => ({ default: () => mocks.spinner }))

const originalConsoleLog = console.log
const originalConsoleError = console.error
const mockConsoleLog = vi.fn()
const mockConsoleError = vi.fn()

// Shared defaults for every test in this file: requireTier passes, the
// confirmation prompt auto-accepts, and the count-fetch resolves a fixed
// stats payload. Individual tests override these to exercise the gate/
// prompt/decline/failure paths explicitly. Runs before each describe's own
// (narrower) beforeEach, which only clears call counts — not implementations.
beforeEach(() => {
  mocks.requireTier.mockResolvedValue(undefined)
  mocks.confirm.mockResolvedValue(true)
  mocks.getSyncApiClient.mockResolvedValue({
    getStats: vi.fn().mockResolvedValue({
      data: { skillCount: 12345, githubTotal: 20000, lastUpdated: '2026-01-01T00:00:00.000Z' },
    }),
  })
})

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

// ---------------------------------------------------------------------------
// SMI-registry-sync-tier-gate: `sync` is Team-tier gated, with a live
// record-count confirmation prompt before running (skippable for automation).
// ---------------------------------------------------------------------------

describe('SMI-registry-sync-tier-gate: sync command — tier gate + confirmation prompt', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    console.log = mockConsoleLog
    console.error = mockConsoleError
    process.exitCode = undefined
    // `requireTier`'s rejection path routes through the existing catch
    // block's `process.exit(1)` — mock it to throw so tests never actually
    // terminate the runner, matching the audit-restructure.test.ts convention.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as never)
  })

  afterEach(() => {
    console.log = originalConsoleLog
    console.error = originalConsoleError
    process.exitCode = undefined
    exitSpy.mockRestore()
  })

  it('blocks sync below Team tier, never calling runRegistrySync', async () => {
    mocks.requireTier.mockRejectedValue(
      new Error(
        'This feature requires team tier or higher ($25/user/month). ' +
          'You are currently on the community tier. ' +
          'Upgrade at https://skillsmith.app/upgrade?tier=team'
      )
    )

    const { createSyncCommand } = await import('../src/commands/sync.js')
    await expect(createSyncCommand().parseAsync(['node', 'test'])).rejects.toThrow(
      'process.exit called'
    )

    expect(mocks.runRegistrySync).not.toHaveBeenCalled()
    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(exitSpy).toHaveBeenCalledWith(1)
    const stderr = mockConsoleError.mock.calls.map((c) => String(c[0])).join('\n')
    expect(stderr).toContain('team tier or higher')
  })

  it('shows a confirmation prompt with the fetched count, and cancels (without exiting non-zero) on decline', async () => {
    mocks.confirm.mockResolvedValue(false)

    const { createSyncCommand } = await import('../src/commands/sync.js')
    await createSyncCommand().parseAsync(['node', 'test'])

    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('12,345'),
        default: false,
      })
    )
    expect(mocks.runRegistrySync).not.toHaveBeenCalled()
    expect(process.exitCode).toBeUndefined()
    expect(mocks.dbClose).toHaveBeenCalled()

    const stdout = mockConsoleLog.mock.calls.map((c) => String(c[0])).join('\n')
    expect(stdout).toContain('Sync cancelled.')
  })

  it('skips the prompt with --yes and runs sync directly', async () => {
    mocks.runRegistrySync.mockResolvedValue(
      makeResult({ success: true, totalProcessed: 3, skillsAdded: 3 })
    )

    const { createSyncCommand } = await import('../src/commands/sync.js')
    await createSyncCommand().parseAsync(['node', 'test', '--yes'])

    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(mocks.runRegistrySync).toHaveBeenCalled()
  })

  it('skips the prompt when --json is passed without --yes (implied yes)', async () => {
    mocks.runRegistrySync.mockResolvedValue(
      makeResult({ success: true, totalProcessed: 3, skillsAdded: 3 })
    )

    const { createSyncCommand } = await import('../src/commands/sync.js')
    await createSyncCommand().parseAsync(['node', 'test', '--json'])

    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(mocks.runRegistrySync).toHaveBeenCalled()
  })

  it('falls back to a generic message when the count fetch fails, and still proceeds on confirm', async () => {
    mocks.getSyncApiClient.mockResolvedValue({
      getStats: vi.fn().mockRejectedValue(new Error('network error')),
    })
    mocks.confirm.mockResolvedValue(true)
    mocks.runRegistrySync.mockResolvedValue(
      makeResult({ success: true, totalProcessed: 3, skillsAdded: 3 })
    )

    const { createSyncCommand } = await import('../src/commands/sync.js')
    await createSyncCommand().parseAsync(['node', 'test'])

    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'This will download the full skill registry. Continue?',
      })
    )
    expect(mocks.runRegistrySync).toHaveBeenCalled()
  })

  it('gates `sync config --enable` below Team tier and never calls syncConfigRepo.enable', async () => {
    mocks.requireTier.mockRejectedValue(
      new Error('This feature requires team tier or higher ($25/user/month).')
    )

    const { createSyncCommand } = await import('../src/commands/sync.js')
    await expect(
      createSyncCommand().parseAsync(['node', 'test', 'config', '--enable'])
    ).rejects.toThrow('process.exit called')

    expect(mocks.syncConfigEnable).not.toHaveBeenCalled()
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('does NOT gate `sync config --disable` regardless of tier', async () => {
    // requireTier is never even called for --disable — proven by making it
    // reject and confirming --disable still succeeds.
    mocks.requireTier.mockRejectedValue(new Error('requireTier must not be called for --disable'))

    const { createSyncCommand } = await import('../src/commands/sync.js')
    await createSyncCommand().parseAsync(['node', 'test', 'config', '--disable'])

    expect(mocks.syncConfigDisable).toHaveBeenCalled()
    expect(mocks.syncConfigEnable).not.toHaveBeenCalled()
  })
})
