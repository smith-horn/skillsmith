/**
 * SMI-2715: Logout Command Tests
 *
 * Tests for `skillsmith logout` — not-authenticated guard, confirmation prompt,
 * successful logout, and partial failure (keyring error) handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@skillsmith/core', () => ({
  getAuthStatus: vi.fn(),
  clearApiKey: vi.fn(),
}))

vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { createLogoutCommand } from './logout.js'
import { getAuthStatus, clearApiKey } from '@skillsmith/core'
import { confirm } from '@inquirer/prompts'

const mockGetAuthStatus = vi.mocked(getAuthStatus)
const mockClearApiKey = vi.mocked(clearApiKey)
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
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit(${code ?? 0})`)
      })
    vi.clearAllMocks()
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
    it('exits 0 when not authenticated', async () => {
      mockGetAuthStatus.mockResolvedValue({
        authenticated: false,
        keyPrefix: null,
        source: 'none',
      })

      await expect(runCommand()).rejects.toThrow('process.exit(0)')

      const output = consoleLogSpy.mock.calls.flat().join('\n')
      expect(output).toContain('Not authenticated')
      expect(mockClearApiKey).not.toHaveBeenCalled()
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
      const output = consoleLogSpy.mock.calls.flat().join('\n')
      expect(output).toContain('Cancelled')
    })

    it('clears key when user confirms', async () => {
      mockConfirm.mockResolvedValue(true)
      mockClearApiKey.mockResolvedValue({ success: true, source: 'keyring and config file' })

      await expect(runCommand()).rejects.toThrow('process.exit(0)')

      expect(mockClearApiKey).toHaveBeenCalledOnce()
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

    it('prints success message with source', async () => {
      mockClearApiKey.mockResolvedValue({ success: true, source: 'config file' })

      await expect(runCommand()).rejects.toThrow('process.exit(0)')

      const output = consoleLogSpy.mock.calls.flat().join('\n')
      expect(output).toContain('Logged out')
      expect(output).toContain('config file')
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

      await expect(runCommand()).rejects.toThrow('process.exit(0)')

      const output = consoleLogSpy.mock.calls.flat().join('\n')
      expect(output).toContain('access denied')
      expect(output).toContain('OS keyring')
    })
  })
})
