/**
 * Tests for version-check utility
 * @see SMI-1952: Add auto-update check to MCP server startup
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkForUpdates,
  formatUpdateNotification,
  resolveUpdateNotificationClient,
  agentInstallRemediationCommand,
  checkCursorMcpArtifact,
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

  describe('formatUpdateNotification (SMI-5893 Wave 10)', () => {
    const result: VersionCheckResult = {
      currentVersion: '0.3.0',
      latestVersion: '0.4.0',
      updateAvailable: true,
      updateCommand: 'npx @skillsmith/mcp-server@latest',
    }

    // Exact-match, not toContain(): pins line ordering/newline placement so
    // a future edit that drops or reorders a line still fails a test
    // (code-review finding on the prior toContain()-only assertions).
    it('names the version bump, the actual upgrade command, and both artifact-refresh commands — exact message, no client', () => {
      const message = formatUpdateNotification(result)

      expect(message).toBe(
        '[skillsmith] Update available: 0.3.0 → 0.4.0\n' +
          'Run `npx @skillsmith/mcp-server@latest` to use the new version.\n' +
          'Note: upgrading does not refresh onboarding artifacts already on disk —\n' +
          'run `skillsmith setup --force` to refresh the bundled skill, and\n' +
          '`skillsmith agent install` to refresh hooks/MCP registration.'
      )
      expect(message).not.toContain('Claude Code')
      expect(message).not.toContain('Restart')
    })

    it('threads a resolved client into the setup command, not the agent-install command (which has no --client flag) — exact message', () => {
      const message = formatUpdateNotification(result, 'cursor')

      expect(message).toBe(
        '[skillsmith] Update available: 0.3.0 → 0.4.0\n' +
          'Run `npx @skillsmith/mcp-server@latest` to use the new version.\n' +
          'Note: upgrading does not refresh onboarding artifacts already on disk —\n' +
          'run `skillsmith setup --force --client cursor` to refresh the bundled skill, and\n' +
          '`skillsmith agent install` to refresh hooks/MCP registration.'
      )
    })

    it('uses whatever updateCommand the caller passes in, not a hardcoded npx string', () => {
      const message = formatUpdateNotification({
        ...result,
        updateCommand: 'npm install -g @skillsmith/mcp-server',
      })

      expect(message).toContain(
        'Run `npm install -g @skillsmith/mcp-server` to use the new version.'
      )
    })
  })

  describe('resolveUpdateNotificationClient (SMI-5893 Wave 10, code-review finding)', () => {
    it('returns undefined when the env var is unset — does not default to claude-code', () => {
      expect(resolveUpdateNotificationClient(undefined)).toBeUndefined()
    })

    it('returns undefined for an empty string', () => {
      expect(resolveUpdateNotificationClient('')).toBeUndefined()
    })

    it('resolves a valid client id', () => {
      expect(resolveUpdateNotificationClient('cursor')).toBe('cursor')
      expect(resolveUpdateNotificationClient('claude-code')).toBe('claude-code')
    })

    it('returns undefined (never throws) for an invalid client value', () => {
      expect(() => resolveUpdateNotificationClient('totally-bogus-client')).not.toThrow()
      expect(resolveUpdateNotificationClient('totally-bogus-client')).toBeUndefined()
    })
  })

  describe('agentInstallRemediationCommand (SMI-6279 Wave 9)', () => {
    it('returns the exact command formatUpdateNotification embeds', () => {
      expect(agentInstallRemediationCommand()).toBe('skillsmith agent install')
    })
  })

  describe('checkCursorMcpArtifact (SMI-6279 Wave 9)', () => {
    let tempDir: string

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'skillsmith-cursor-mcp-check-'))
    })

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true })
    })

    function mcpJsonPath(): string {
      return join(tempDir, 'mcp.json')
    }

    function write(content: unknown): void {
      writeFileSync(mcpJsonPath(), JSON.stringify(content, null, 2))
    }

    it('reports not-stale, entry-not-found for a missing file', () => {
      const result = checkCursorMcpArtifact(mcpJsonPath())
      expect(result).toEqual({
        path: mcpJsonPath(),
        exists: false,
        entryFound: false,
        usesNpxForm: false,
        hasClientEnv: false,
        stale: false,
      })
    })

    it('flags the broken npx form (missing SKILLSMITH_CLIENT) as stale with the shared remediation command', () => {
      write({
        mcpServers: {
          skillsmith: {
            command: 'npx',
            args: ['-y', '@skillsmith/mcp-server'],
            env: { SKILLSMITH_TOOL_PROFILE: 'agent' },
          },
        },
      })

      const result = checkCursorMcpArtifact(mcpJsonPath())

      expect(result.exists).toBe(true)
      expect(result.entryFound).toBe(true)
      expect(result.entryKey).toBe('skillsmith')
      expect(result.usesNpxForm).toBe(true)
      expect(result.hasClientEnv).toBe(false)
      expect(result.stale).toBe(true)
      expect(result.remediation).toBe(agentInstallRemediationCommand())
    })

    it('passes a fresh resolved-binary-path entry under the @skillsmith/mcp-server key', () => {
      write({
        mcpServers: {
          '@skillsmith/mcp-server': {
            command: '/usr/local/bin/skillsmith-mcp',
            env: { SKILLSMITH_TOOL_PROFILE: 'agent', SKILLSMITH_CLIENT: 'cursor' },
          },
        },
      })

      const result = checkCursorMcpArtifact(mcpJsonPath())

      expect(result.exists).toBe(true)
      expect(result.entryFound).toBe(true)
      expect(result.entryKey).toBe('@skillsmith/mcp-server')
      expect(result.usesNpxForm).toBe(false)
      expect(result.hasClientEnv).toBe(true)
      expect(result.stale).toBe(false)
      expect(result.remediation).toBeUndefined()
    })

    it('flags an entry that has SKILLSMITH_CLIENT but is still on the npx form', () => {
      write({
        mcpServers: {
          '@skillsmith/mcp-server': {
            command: 'npx',
            args: ['-y', '@skillsmith/mcp-server'],
            env: { SKILLSMITH_CLIENT: 'cursor' },
          },
        },
      })

      const result = checkCursorMcpArtifact(mcpJsonPath())
      expect(result.usesNpxForm).toBe(true)
      expect(result.hasClientEnv).toBe(true)
      expect(result.stale).toBe(true)
    })

    it('does not flag staleness when the file exists but has no Skillsmith entry at all', () => {
      write({ mcpServers: { 'some-other-tool': { command: 'foo' } } })

      const result = checkCursorMcpArtifact(mcpJsonPath())
      expect(result.exists).toBe(true)
      expect(result.entryFound).toBe(false)
      expect(result.stale).toBe(false)
    })

    it('does not throw and reports not-found for an unparsable file', () => {
      writeFileSync(mcpJsonPath(), '{not valid json')
      expect(() => checkCursorMcpArtifact(mcpJsonPath())).not.toThrow()
      const result = checkCursorMcpArtifact(mcpJsonPath())
      expect(result.exists).toBe(true)
      expect(result.entryFound).toBe(false)
      expect(result.stale).toBe(false)
    })

    it('checks an arbitrary independent path — proving global vs project-scoped are evaluated separately', () => {
      const otherDir = mkdtempSync(join(tmpdir(), 'skillsmith-cursor-mcp-check-other-'))
      try {
        mkdirSync(otherDir, { recursive: true })
        const otherPath = join(otherDir, 'mcp.json')
        writeFileSync(
          otherPath,
          JSON.stringify({
            mcpServers: {
              '@skillsmith/mcp-server': {
                command: '/usr/local/bin/skillsmith-mcp',
                env: { SKILLSMITH_TOOL_PROFILE: 'agent', SKILLSMITH_CLIENT: 'cursor' },
              },
            },
          })
        )
        write({
          mcpServers: {
            skillsmith: { command: 'npx', args: ['-y', '@skillsmith/mcp-server'], env: {} },
          },
        })

        const freshResult = checkCursorMcpArtifact(otherPath)
        const staleResult = checkCursorMcpArtifact(mcpJsonPath())

        expect(freshResult.stale).toBe(false)
        expect(staleResult.stale).toBe(true)
        expect(existsSync(otherPath)).toBe(true)
      } finally {
        rmSync(otherDir, { recursive: true, force: true })
      }
    })
  })
})
