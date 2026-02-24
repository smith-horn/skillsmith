/**
 * SMI-2715: Login Command Tests
 *
 * Tests for `skillsmith login` — already-authenticated guard, browser/headless
 * URL display, masked input prompting, format validation retries, and storage.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks (declared before module imports so Vitest hoists them)
// ---------------------------------------------------------------------------

vi.mock('@skillsmith/core', () => ({
  getAuthStatus: vi.fn(),
  storeApiKey: vi.fn(),
  isValidApiKeyFormat: vi.fn(),
}))

vi.mock('@inquirer/prompts', () => ({
  password: vi.fn(),
}))

vi.mock('open', () => ({
  default: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { createLoginCommand } from './login.js'
import { getAuthStatus, storeApiKey, isValidApiKeyFormat } from '@skillsmith/core'
import { password } from '@inquirer/prompts'
import openDefault from 'open'

const mockGetAuthStatus = vi.mocked(getAuthStatus)
const mockStoreApiKey = vi.mocked(storeApiKey)
const mockIsValidApiKeyFormat = vi.mocked(isValidApiKeyFormat)
const mockPassword = vi.mocked(password)
const mockOpen = vi.mocked(openDefault)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_KEY = 'sk_live_' + 'a'.repeat(32)

/** Run a command action by parsing fabricated argv */
async function runCommand(args: string[] = []): Promise<void> {
  const cmd = createLoginCommand()
  // Invoke action directly to bypass Commander's process.argv parsing
  await cmd.parseAsync(['node', 'login', ...args])
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('createLoginCommand', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>
  let processExitSpy: ReturnType<typeof vi.spyOn>
  let originalEnv: NodeJS.ProcessEnv

  beforeEach(() => {
    // clearAllMocks resets call history on module-level mocks (declared above).
    // Must run BEFORE setting up spies so the spy implementations are not cleared.
    vi.clearAllMocks()
    originalEnv = { ...process.env }
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit(${code ?? 0})`)
      })
  })

  afterEach(() => {
    process.env = originalEnv
    consoleLogSpy.mockRestore()
    consoleErrorSpy.mockRestore()
    processExitSpy.mockRestore()
  })

  describe('command metadata', () => {
    it('has the correct name', () => {
      expect(createLoginCommand().name()).toBe('login')
    })

    it('has a description', () => {
      expect(createLoginCommand().description()).toBeTruthy()
    })
  })

  describe('already authenticated guard', () => {
    it('exits 0 when already authenticated', async () => {
      mockGetAuthStatus.mockResolvedValue({
        authenticated: true,
        keyPrefix: 'sk_live_xxxx',
        source: 'keyring',
      })

      await expect(runCommand()).rejects.toThrow('process.exit(0)')

      const output = consoleLogSpy.mock.calls.flat().join('\n')
      expect(output).toContain('Already authenticated')
      expect(output).toContain('skillsmith logout')
    })
  })

  describe('URL display', () => {
    beforeEach(() => {
      mockGetAuthStatus.mockResolvedValue({
        authenticated: false,
        keyPrefix: null,
        source: 'none',
      })
      // Default: valid key on first prompt attempt
      mockIsValidApiKeyFormat.mockReturnValue(true)
      mockPassword.mockResolvedValue(VALID_KEY)
      mockStoreApiKey.mockResolvedValue(undefined)
    })

    it('opens browser by default (non-headless)', async () => {
      delete process.env['CI']
      delete process.env['DISPLAY']
      // Simulate macOS (browser-capable)
      const originalPlatform = process.platform
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
      mockOpen.mockResolvedValue(
        undefined as unknown as ReturnType<typeof mockOpen> extends Promise<infer T> ? T : never
      )

      try {
        await expect(runCommand()).rejects.toThrow('process.exit(0)')
        expect(mockOpen).toHaveBeenCalledWith('https://skillsmith.app/account/cli-token')
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
      }
    })

    it('prints URL instead of opening browser when --no-browser is passed', async () => {
      delete process.env['CI']
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })

      await expect(runCommand(['--no-browser'])).rejects.toThrow('process.exit(0)')

      expect(mockOpen).not.toHaveBeenCalled()
      const output = consoleLogSpy.mock.calls.flat().join('\n')
      expect(output).toContain('https://skillsmith.app/account/cli-token')
    })

    it('prints URL when CI=true (headless)', async () => {
      process.env['CI'] = 'true'

      await expect(runCommand()).rejects.toThrow('process.exit(0)')

      expect(mockOpen).not.toHaveBeenCalled()
      const output = consoleLogSpy.mock.calls.flat().join('\n')
      expect(output).toContain('https://skillsmith.app/account/cli-token')
    })

    it('falls back to printing URL when open throws', async () => {
      delete process.env['CI']
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
      mockOpen.mockRejectedValue(new Error('no browser'))

      await expect(runCommand()).rejects.toThrow('process.exit(0)')

      const output = consoleLogSpy.mock.calls.flat().join('\n')
      expect(output).toContain('https://skillsmith.app/account/cli-token')
    })
  })

  describe('API key prompt', () => {
    beforeEach(() => {
      mockGetAuthStatus.mockResolvedValue({
        authenticated: false,
        keyPrefix: null,
        source: 'none',
      })
      delete process.env['CI']
      process.env['CI'] = 'true' // headless so we skip open
    })

    it('stores key and exits 0 on first valid input', async () => {
      mockIsValidApiKeyFormat.mockReturnValue(true)
      mockPassword.mockResolvedValue(VALID_KEY)
      mockStoreApiKey.mockResolvedValue(undefined)

      await expect(runCommand()).rejects.toThrow('process.exit(0)')

      expect(mockStoreApiKey).toHaveBeenCalledWith(VALID_KEY)
      const output = consoleLogSpy.mock.calls.flat().join('\n')
      expect(output).toContain('Logged in successfully')
    })

    it('retries on invalid format and succeeds on second attempt', async () => {
      mockIsValidApiKeyFormat.mockReturnValueOnce(false).mockReturnValueOnce(true)
      mockPassword.mockResolvedValue(VALID_KEY)
      mockStoreApiKey.mockResolvedValue(undefined)

      await expect(runCommand()).rejects.toThrow('process.exit(0)')

      expect(mockPassword).toHaveBeenCalledTimes(2)
      expect(mockStoreApiKey).toHaveBeenCalledOnce()
    })

    it('exits 1 after 3 consecutive format failures', async () => {
      mockIsValidApiKeyFormat.mockReturnValue(false)
      mockPassword.mockResolvedValue('bad-key')

      await expect(runCommand()).rejects.toThrow('process.exit(1)')

      expect(mockPassword).toHaveBeenCalledTimes(3)
      expect(mockStoreApiKey).not.toHaveBeenCalled()

      const errorOutput = consoleErrorSpy.mock.calls.flat().join('\n')
      expect(errorOutput).toContain('Too many invalid attempts')
      expect(errorOutput).toContain('https://skillsmith.app/account/cli-token')
    })

    it('shows retry count message on invalid attempt (not the last)', async () => {
      mockIsValidApiKeyFormat
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(false)
      mockPassword.mockResolvedValue('bad-key')

      await expect(runCommand()).rejects.toThrow('process.exit(1)')

      const errorOutput = consoleErrorSpy.mock.calls.flat().join('\n')
      // Should mention format guidance
      expect(errorOutput).toContain('sk_live_')
    })

    it('reminds user to clear clipboard after successful login', async () => {
      mockIsValidApiKeyFormat.mockReturnValue(true)
      mockPassword.mockResolvedValue(VALID_KEY)
      mockStoreApiKey.mockResolvedValue(undefined)

      await expect(runCommand()).rejects.toThrow('process.exit(0)')

      const output = consoleLogSpy.mock.calls.flat().join('\n')
      expect(output).toContain('clipboard')
    })

    it('exits 1 with message when storeApiKey throws (filesystem error)', async () => {
      mockIsValidApiKeyFormat.mockReturnValue(true)
      mockPassword.mockResolvedValue(VALID_KEY)
      mockStoreApiKey.mockRejectedValue(new Error('EACCES: permission denied'))

      await expect(runCommand()).rejects.toThrow('process.exit(1)')

      const errorOutput = consoleErrorSpy.mock.calls.flat().join('\n')
      expect(errorOutput).toContain('Failed to store credentials')
      expect(errorOutput).toContain('EACCES')
    })

    it('exits 0 cleanly on Ctrl+C (ExitPromptError)', async () => {
      const exitPromptError = Object.assign(new Error('User force closed the prompt'), {
        name: 'ExitPromptError',
      })
      mockPassword.mockRejectedValue(exitPromptError)

      await expect(runCommand()).rejects.toThrow('process.exit(0)')

      expect(mockStoreApiKey).not.toHaveBeenCalled()
      const output = consoleLogSpy.mock.calls.flat().join('\n')
      expect(output).toContain('Cancelled')
    })
  })
})
