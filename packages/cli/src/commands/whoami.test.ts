/**
 * SMI-2715: Whoami Command Tests
 *
 * Tests for `skillsmith whoami` — unauthenticated state, each source label,
 * masked key display, and JWT device-code session detection (SMI-4402 — the
 * bug where `whoami`/`logout` only checked the legacy API key and missed a
 * live JWT session that `login` itself could see).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@skillsmith/core', () => ({
  getAuthStatus: vi.fn(),
  loadCredentials: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { createWhoamiCommand } from './whoami.js'
import { getAuthStatus, loadCredentials } from '@skillsmith/core'

const mockGetAuthStatus = vi.mocked(getAuthStatus)
const mockLoadCredentials = vi.mocked(loadCredentials)

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

    // Default: no JWT session, so existing legacy-API-key tests exercise the
    // getAuthStatus() path unchanged. JWT-specific tests override this.
    mockLoadCredentials.mockResolvedValue(null)
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

  describe('JWT session state (SMI-4402 regression)', () => {
    it('shows device-code session when a live JWT exists, even with no API key configured', async () => {
      // Exactly the state a device-code login leaves behind: getAuthStatus()
      // (legacy API key only) sees nothing, but a live JWT session exists.
      mockGetAuthStatus.mockResolvedValue({
        authenticated: false,
        keyPrefix: null,
        source: 'none',
      })
      mockLoadCredentials.mockResolvedValue({
        accessToken: 'live-access-token',
        refreshToken: 'live-refresh-token',
        expiresAt: Date.now() + 60 * 60 * 1000,
        version: 2,
      })

      await expect(runCommand()).rejects.toThrow('process.exit(0)')

      const output = consoleLogSpy.mock.calls.flat().join('\n')
      expect(output).not.toContain('Not authenticated')
      expect(output).toContain('device-code login')
    })

    // PR review finding (SMI-6235): an expired access token with a live
    // refresh token on file is still shown as a device-code session — it is
    // a session resolveFreshAccessToken() refreshes transparently on next
    // use, not one to report as absent. Distinct from the "no JWT session at
    // all" case (loadCredentials() null), which does fall through below.
    it('still shows device-code session when the access token has expired but a refresh token is on file', async () => {
      mockGetAuthStatus.mockResolvedValue({
        authenticated: true,
        keyPrefix: 'sk_live_xxxx',
        source: 'config',
      })
      mockLoadCredentials.mockResolvedValue({
        accessToken: 'expired-token',
        refreshToken: 'refresh',
        expiresAt: Date.now() - 1000,
        version: 2,
      })

      await expect(runCommand()).rejects.toThrow('process.exit(0)')

      const output = consoleLogSpy.mock.calls.flat().join('\n')
      expect(output).toContain('device-code login')
      expect(output).toContain('expired')
      expect(output).not.toContain('sk_live_xxxx...')
    })

    it('falls through to the legacy API-key check when there is no JWT session at all', async () => {
      mockGetAuthStatus.mockResolvedValue({
        authenticated: true,
        keyPrefix: 'sk_live_xxxx',
        source: 'config',
      })
      mockLoadCredentials.mockResolvedValue(null)

      await expect(runCommand()).rejects.toThrow('process.exit(0)')

      const output = consoleLogSpy.mock.calls.flat().join('\n')
      expect(output).not.toContain('device-code login')
      expect(output).toContain('sk_live_xxxx...')
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
