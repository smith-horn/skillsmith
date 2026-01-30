/**
 * Tests for version-check utility
 * @see SMI-1952: Add auto-update check to MCP server startup
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  checkForUpdates,
  formatUpdateNotification,
  type VersionCheckResult,
} from './version-check.js'

describe('version-check', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    global.fetch = originalFetch
    vi.useRealTimers()
  })

  describe('checkForUpdates', () => {
    it('returns update available when newer version exists', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ version: '1.2.0' }),
      })

      const result = await checkForUpdates('@skillsmith/mcp-server', '1.0.0')

      expect(result).toEqual({
        currentVersion: '1.0.0',
        latestVersion: '1.2.0',
        updateAvailable: true,
        updateCommand: 'npx @skillsmith/mcp-server@latest',
      })
      expect(fetch).toHaveBeenCalledWith(
        'https://registry.npmjs.org/@skillsmith/mcp-server/latest',
        expect.objectContaining({
          headers: { Accept: 'application/json' },
        })
      )
    })

    it('returns no update when version is current', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ version: '1.0.0' }),
      })

      const result = await checkForUpdates('@skillsmith/mcp-server', '1.0.0')

      expect(result).toEqual({
        currentVersion: '1.0.0',
        latestVersion: '1.0.0',
        updateAvailable: false,
        updateCommand: 'npx @skillsmith/mcp-server@latest',
      })
    })

    it('returns null on HTTP error', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      })

      const result = await checkForUpdates('nonexistent-package', '1.0.0')

      expect(result).toBeNull()
    })

    it('returns null on network error', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('Network error'))

      const result = await checkForUpdates('@skillsmith/mcp-server', '1.0.0')

      expect(result).toBeNull()
    })

    it('returns null on invalid JSON response', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.reject(new Error('Invalid JSON')),
      })

      const result = await checkForUpdates('@skillsmith/mcp-server', '1.0.0')

      expect(result).toBeNull()
    })

    it('returns null when version field is missing', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ name: 'package', description: 'test' }),
      })

      const result = await checkForUpdates('@skillsmith/mcp-server', '1.0.0')

      expect(result).toBeNull()
    })

    it('uses 3 second timeout via AbortSignal', async () => {
      // Mock fetch to extract the signal
      let capturedSignal: AbortSignal | undefined
      global.fetch = vi.fn().mockImplementation((_url, options) => {
        capturedSignal = options?.signal
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ version: '1.0.0' }),
        })
      })

      await checkForUpdates('@skillsmith/mcp-server', '1.0.0')

      // Verify AbortSignal was passed (we can't easily test the exact timeout value)
      expect(capturedSignal).toBeDefined()
    })

    it('handles timeout gracefully', async () => {
      global.fetch = vi.fn().mockImplementation(() => {
        const error = new Error('The operation was aborted')
        error.name = 'AbortError'
        return Promise.reject(error)
      })

      const result = await checkForUpdates('@skillsmith/mcp-server', '1.0.0')

      expect(result).toBeNull()
    })
  })

  describe('formatUpdateNotification', () => {
    it('formats notification message correctly', () => {
      const result: VersionCheckResult = {
        currentVersion: '0.3.0',
        latestVersion: '0.4.0',
        updateAvailable: true,
        updateCommand: 'npx @skillsmith/mcp-server@latest',
      }

      const message = formatUpdateNotification(result)

      expect(message).toBe(
        '[skillsmith] Update available: 0.3.0 → 0.4.0\n' +
          'Restart Claude Code to use the latest version.'
      )
    })
  })
})
