/**
 * SMI-2715: Logout Command Tests
 *
 * Tests for `skillsmith logout` — not-authenticated guard, confirmation prompt,
 * successful logout, partial failure (keyring error) handling, and JWT
 * device-code session detection/clearing (SMI-4402 — the bug where `login`
 * saw a live JWT session but `logout` only checked the legacy API key).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@skillsmith/core', () => ({
  getAuthStatus: vi.fn(),
  clearApiKey: vi.fn(),
  loadCredentials: vi.fn(),
  clearCredentials: vi.fn(),
}))

vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { createLogoutCommand } from './logout.js'
import { getAuthStatus, clearApiKey, loadCredentials, clearCredentials } from '@skillsmith/core'
import { confirm } from '@inquirer/prompts'

const mockGetAuthStatus = vi.mocked(getAuthStatus)
const mockClearApiKey = vi.mocked(clearApiKey)
const mockLoadCredentials = vi.mocked(loadCredentials)
const mockClearCredentials = vi.mocked(clearCredentials)
const mockConfirm = vi.mocked(confirm)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runCommand(args: string[] = []): Promise<void> {
  const cmd = createLogoutCommand()
  await cmd.parseAsync(['node', 'logout', ...args])
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createLogoutCommand', () => {
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

    // Default: no JWT session, and both clear calls succeed. Individual
    // tests override these to exercise the JWT-only / partial-failure paths.
    mockLoadCredentials.mockResolvedValue(null)
    mockClearCredentials.mockResolvedValue({ success: true, source: 'config file' })
  })

  afterEach(() => {
    consoleLogSpy.mockRestore()
    processExitSpy.mockRestore()
  })

  describe('command metadata', () => {
    it('has the correct name', () => {
      expect(createLogoutCommand().name()).toBe('logout')
    })

    it('has a description', () => {
      expect(createLogoutCommand().description()).toBeTruthy()
    })
  })

  describe('not authenticated guard', () => {
    it('exits 0 when not authenticated (no API key, no JWT session)', async () => {
      mockGetAuthStatus.mockResolvedValue({
        authenticated: false,
        keyPrefix: null,
        source: 'none',
      })
      mockLoadCredentials.mockResolvedValue(null)

      await expect(runCommand()).rejects.toThrow('process.exit(0)')

      const output = consoleLogSpy.mock.calls.flat().join('\n')
      expect(output).toContain('Not authenticated')
      expect(mockClearApiKey).not.toHaveBeenCalled()
      expect(mockClearCredentials).not.toHaveBeenCalled()
    })
  })

  describe('JWT-only session (SMI-4402 regression — the reported login/logout mismatch)', () => {
    beforeEach(() => {
      // Exactly the state a device-code login leaves behind: no legacy API
      // key, but a live, unexpired JWT session.
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
      mockConfirm.mockResolvedValue(true)
    })

    // PR review finding (SMI-6235): logout must be able to clear a JWT
    // session even when its access token has expired — an expired access
    // token with a live refresh token is still a session to end, not
    // "nothing to log out of". Distinct from the "not authenticated guard"
    // describe above, which covers loadCredentials() returning null entirely.
    it('proceeds to log out when the stored JWT session has an expired access token', async () => {
      mockLoadCredentials.mockResolvedValue({
        accessToken: 'expired-token',
        refreshToken: 'refresh',
        expiresAt: Date.now() - 1000,
        version: 2,
      })
      mockClearApiKey.mockResolvedValue({ success: true, source: 'config file' })
      mockClearCredentials.mockResolvedValue({ success: true, source: 'keyring and config file' })

      await expect(runCommand()).rejects.toThrow('process.exit(0)')

      const output = consoleLogSpy.mock.calls.flat().join('\n')
      expect(output).not.toContain('Not authenticated')
      expect(output).toContain('Logged out')
      expect(mockClearCredentials).toHaveBeenCalledOnce()
    })

    it('does not print "Not authenticated" and proceeds to log out', async () => {
      mockClearApiKey.mockResolvedValue({ success: true, source: 'config file' })
      mockClearCredentials.mockResolvedValue({ success: true, source: 'keyring and config file' })

      await expect(runCommand()).rejects.toThrow('process.exit(0)')

      const output = consoleLogSpy.mock.calls.flat().join('\n')
      expect(output).not.toContain('Not authenticated')
      expect(output).toContain('Logged out')
    })

    it('clears both the legacy API key store and the JWT session store', async () => {
      mockClearApiKey.mockResolvedValue({ success: true, source: 'config file' })
      mockClearCredentials.mockResolvedValue({ success: true, source: 'keyring and config file' })

      await expect(runCommand()).rejects.toThrow('process.exit(0)')

      expect(mockClearApiKey).toHaveBeenCalledOnce()
      expect(mockClearCredentials).toHaveBeenCalledOnce()
    })
  })

  describe('confirmation prompt', () => {
    beforeEach(() => {
      mockGetAuthStatus.mockResolvedValue({
        authenticated: true,
        keyPrefix: 'sk_live_xxxx',
        source: 'keyring',
      })
    })

    it('cancels without clearing when user declines', async () => {
      mockConfirm.mockResolvedValue(false)

      await expect(runCommand()).rejects.toThrow('process.exit(0)')

      expect(mockClearApiKey).not.toHaveBeenCalled()
      expect(mockClearCredentials).not.toHaveBeenCalled()
      const output = consoleLogSpy.mock.calls.flat().join('\n')
      expect(output).toContain('Cancelled')
    })

    it('clears key when user confirms', async () => {
      mockConfirm.mockResolvedValue(true)
      mockClearApiKey.mockResolvedValue({ success: true, source: 'keyring and config file' })

      await expect(runCommand()).rejects.toThrow('process.exit(0)')

      expect(mockClearApiKey).toHaveBeenCalledOnce()
      expect(mockClearCredentials).toHaveBeenCalledOnce()
    })
  })

  describe('successful logout', () => {
    beforeEach(() => {
      mockGetAuthStatus.mockResolvedValue({
        authenticated: true,
        keyPrefix: 'sk_live_xxxx',
        source: 'config',
      })
      mockConfirm.mockResolvedValue(true)
    })

    it('prints success message with combined sources', async () => {
      mockClearApiKey.mockResolvedValue({ success: true, source: 'config file' })
      mockClearCredentials.mockResolvedValue({ success: true, source: 'config file' })

      await expect(runCommand()).rejects.toThrow('process.exit(0)')

      const output = consoleLogSpy.mock.calls.flat().join('\n')
      expect(output).toContain('Logged out')
      expect(output).toContain('config file')
    })

    // PR review finding (SMI-6235): each result's `source` is itself a
    // composite string ("keyring and config file"), so deduping the two
    // composite strings whole (instead of their individual parts) produced
    // "keyring and config file and config file" whenever they overlapped.
    it('does not repeat an overlapping source location across both results', async () => {
      mockClearApiKey.mockResolvedValue({ success: true, source: 'keyring and config file' })
      mockClearCredentials.mockResolvedValue({ success: true, source: 'config file' })

      await expect(runCommand()).rejects.toThrow('process.exit(0)')

      const output = consoleLogSpy.mock.calls.flat().join('\n')
      expect(output).not.toContain('config file and config file')
      expect(output).toContain('keyring and config file')
    })
  })

  describe('partial failure (keyring error)', () => {
    beforeEach(() => {
      mockGetAuthStatus.mockResolvedValue({
        authenticated: true,
        keyPrefix: 'sk_live_xxxx',
        source: 'keyring',
      })
      mockConfirm.mockResolvedValue(true)
    })

    it('warns about keyring error but still reports logout', async () => {
      mockClearApiKey.mockResolvedValue({
        success: false,
        source: 'config file',
        error: 'access denied',
      })
      mockClearCredentials.mockResolvedValue({ success: true, source: 'config file' })

      await expect(runCommand()).rejects.toThrow('process.exit(0)')

      const output = consoleLogSpy.mock.calls.flat().join('\n')
      expect(output).toContain('access denied')
      expect(output).toContain('OS keyring')
    })

    it('warns about both keyring errors when both clears partially fail', async () => {
      mockClearApiKey.mockResolvedValue({
        success: false,
        source: 'config file',
        error: 'api key keyring error',
      })
      mockClearCredentials.mockResolvedValue({
        success: false,
        source: 'config file',
        error: 'refresh token keyring error',
      })

      await expect(runCommand()).rejects.toThrow('process.exit(0)')

      const output = consoleLogSpy.mock.calls.flat().join('\n')
      expect(output).toContain('api key keyring error')
      expect(output).toContain('refresh token keyring error')
    })
  })
})
