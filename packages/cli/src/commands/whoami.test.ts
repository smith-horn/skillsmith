/**
 * SMI-2715: Whoami Command Tests
 *
 * Tests for `skillsmith whoami` — unauthenticated state, each source label,
 * and masked key display.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@skillsmith/core', () => ({
  getAuthStatus: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { createWhoamiCommand } from './whoami.js'
import { getAuthStatus } from '@skillsmith/core'

const mockGetAuthStatus = vi.mocked(getAuthStatus)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runCommand(args: string[] = []): Promise<void> {
  const cmd = createWhoamiCommand()
  await cmd.parseAsync(['node', 'whoami', ...args])
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createWhoamiCommand', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>
  let processExitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    // clearAllMocks resets call history on module-level mocks (declared above).
    // Must run BEFORE setting up spies so the spy implementations are not cleared.
    vi.clearAllMocks()
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit(${code ?? 0})`)
      })
  })

  afterEach(() => {
    consoleLogSpy.mockRestore()
    processExitSpy.mockRestore()
  })

  describe('command metadata', () => {
    it('has the correct name', () => {
      expect(createWhoamiCommand().name()).toBe('whoami')
    })

    it('has a description', () => {
      expect(createWhoamiCommand().description()).toBeTruthy()
    })
  })

  describe('unauthenticated state', () => {
    it('prints login suggestion when not authenticated', async () => {
      mockGetAuthStatus.mockResolvedValue({
        authenticated: false,
        keyPrefix: null,
        source: 'none',
      })

      await expect(runCommand()).rejects.toThrow('process.exit(0)')

      const output = consoleLogSpy.mock.calls.flat().join('\n')
      expect(output).toContain('Not authenticated')
      expect(output).toContain('skillsmith login')
    })
  })

  describe('authenticated state', () => {
    it('displays masked key (prefix + ellipsis)', async () => {
      mockGetAuthStatus.mockResolvedValue({
        authenticated: true,
        keyPrefix: 'sk_live_xxxx',
        source: 'keyring',
      })

      await expect(runCommand()).rejects.toThrow('process.exit(0)')

      const output = consoleLogSpy.mock.calls.flat().join('\n')
      expect(output).toContain('sk_live_xxxx...')
    })

    it('shows "OS keyring" source label for keyring source', async () => {
      mockGetAuthStatus.mockResolvedValue({
        authenticated: true,
        keyPrefix: 'sk_live_xxxx',
        source: 'keyring',
      })

      await expect(runCommand()).rejects.toThrow('process.exit(0)')

      const output = consoleLogSpy.mock.calls.flat().join('\n')
      expect(output).toContain('OS keyring')
    })

    it('shows config file source label for config source', async () => {
      mockGetAuthStatus.mockResolvedValue({
        authenticated: true,
        keyPrefix: 'sk_live_xxxx',
        source: 'config',
      })

      await expect(runCommand()).rejects.toThrow('process.exit(0)')

      const output = consoleLogSpy.mock.calls.flat().join('\n')
      expect(output).toContain('config file')
      expect(output).toContain('~/.skillsmith/config.json')
    })

    it('shows env var source label for env source', async () => {
      mockGetAuthStatus.mockResolvedValue({
        authenticated: true,
        keyPrefix: 'sk_live_xxxx',
        source: 'env',
      })

      await expect(runCommand()).rejects.toThrow('process.exit(0)')

      const output = consoleLogSpy.mock.calls.flat().join('\n')
      expect(output).toContain('SKILLSMITH_API_KEY')
    })

    it('shows "Skillsmith CLI" heading when authenticated', async () => {
      mockGetAuthStatus.mockResolvedValue({
        authenticated: true,
        keyPrefix: 'sk_live_xxxx',
        source: 'config',
      })

      await expect(runCommand()).rejects.toThrow('process.exit(0)')

      const output = consoleLogSpy.mock.calls.flat().join('\n')
      expect(output).toContain('Skillsmith CLI')
    })

    it('shows "valid" format indicator', async () => {
      mockGetAuthStatus.mockResolvedValue({
        authenticated: true,
        keyPrefix: 'sk_live_xxxx',
        source: 'config',
      })

      await expect(runCommand()).rejects.toThrow('process.exit(0)')

      const output = consoleLogSpy.mock.calls.flat().join('\n')
      expect(output).toContain('valid')
    })
  })
})
