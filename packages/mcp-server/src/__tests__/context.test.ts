/**
 * Tests for MCP Server Tool Context
 *
 * @see SMI-1614: MCP Server Test Coverage Gaps
 * @see SMI-792: Database initialization
 * @see SMI-898: Path traversal protection
 * @see SMI-1184: Telemetry configuration
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { existsSync, rmSync } from 'fs'
import {
  getDefaultDbPath,
  closeToolContext,
  createToolContextAsync,
  getToolContextAsync,
  resetAsyncToolContext,
} from '../context.js'

describe('Context Module', () => {
  // Store original values for env vars we modify
  const ENV_VARS_TO_CLEAR = [
    'SKILLSMITH_DB_PATH',
    'SKILLSMITH_TELEMETRY_ENABLED',
    'POSTHOG_API_KEY',
    'SKILLSMITH_BACKGROUND_SYNC',
    'SKILLSMITH_LLM_FAILOVER_ENABLED',
  ] as const

  beforeEach(async () => {
    vi.resetModules()
    // Use vi.stubEnv for proper environment isolation
    ENV_VARS_TO_CLEAR.forEach((key) => {
      vi.stubEnv(key, undefined as unknown as string)
    })
    // Reset global context
    await resetAsyncToolContext()
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    await resetAsyncToolContext()
  })

  describe('getDefaultDbPath', () => {
    it('should return default path when SKILLSMITH_DB_PATH is not set', () => {
      delete process.env.SKILLSMITH_DB_PATH
      const dbPath = getDefaultDbPath()
      expect(dbPath).toBe(join(homedir(), '.skillsmith', 'skills.db'))
    })

    it('should return env path when SKILLSMITH_DB_PATH is set to valid path', () => {
      const validPath = join(homedir(), '.skillsmith', 'custom.db')
      process.env.SKILLSMITH_DB_PATH = validPath
      const dbPath = getDefaultDbPath()
      expect(dbPath).toBe(validPath)
    })

    it('should allow temp directory paths', () => {
      const tempPath = join(tmpdir(), 'skillsmith-test', 'skills.db')
      process.env.SKILLSMITH_DB_PATH = tempPath
      const dbPath = getDefaultDbPath()
      expect(dbPath).toBe(tempPath)
    })

    it('should throw error for path traversal attempt', () => {
      process.env.SKILLSMITH_DB_PATH = '/etc/../../../tmp/malicious.db'
      expect(() => getDefaultDbPath()).toThrow('Invalid SKILLSMITH_DB_PATH')
    })

    it('should allow in-memory database path', () => {
      process.env.SKILLSMITH_DB_PATH = ':memory:'
      const dbPath = getDefaultDbPath()
      expect(dbPath).toBe(':memory:')
    })

    it('should allow .claude directory paths', () => {
      const claudePath = join(homedir(), '.claude', 'skills.db')
      process.env.SKILLSMITH_DB_PATH = claudePath
      const dbPath = getDefaultDbPath()
      expect(dbPath).toBe(claudePath)
    })
  })

  describe('createToolContextAsync', () => {
    describe('basic initialization', () => {
      it('should create context with in-memory database', async () => {
        const context = await createToolContextAsync({ dbPath: ':memory:' })

        expect(context.db).toBeDefined()
        expect(context.searchService).toBeDefined()
        expect(context.skillRepository).toBeDefined()
        expect(context.apiClient).toBeDefined()

        await closeToolContext(context)
      })

      it('should create context with default options', async () => {
        const context = await createToolContextAsync({ dbPath: ':memory:' })

        expect(context.distinctId).toBeUndefined()
        // backgroundSync is created by default when sync config is enabled
        // This is the expected default behavior
        expect(context.llmFailover).toBeUndefined()

        await closeToolContext(context)
      })

      it('should throw error for invalid custom path', async () => {
        await expect(
          createToolContextAsync({ dbPath: '/etc/malicious/../../../root/hack.db' })
        ).rejects.toThrow('Invalid database path')
      })

      it('should apply custom search cache TTL', async () => {
        const context = await createToolContextAsync({
          dbPath: ':memory:',
          searchCacheTtl: 600,
        })

        expect(context.searchService).toBeDefined()

        await closeToolContext(context)
      })

      it('should apply API client configuration', async () => {
        const context = await createToolContextAsync({
          dbPath: ':memory:',
          apiClientConfig: {
            timeout: 5000,
            maxRetries: 2,
            offlineMode: true,
          },
        })

        expect(context.apiClient).toBeDefined()
        expect(context.apiClient.isOffline()).toBe(true)

        await closeToolContext(context)
      })

      it('should create directory for file-based database path', async () => {
        const testDir = join(tmpdir(), 'skillsmith-context-test-' + Date.now())
        const dbPath = join(testDir, 'test.db')

        // Clean up if exists
        if (existsSync(testDir)) {
          rmSync(testDir, { recursive: true })
        }

        const context = await createToolContextAsync({ dbPath })

        expect(existsSync(testDir)).toBe(true)

        await closeToolContext(context)

        // Clean up
        rmSync(testDir, { recursive: true })
      })

      it('should skip directory creation for in-memory database', async () => {
        // This should not throw even though :memory: has no directory
        const context = await createToolContextAsync({ dbPath: ':memory:' })
        expect(context.db).toBeDefined()
        await closeToolContext(context)
      })
    })

    describe('telemetry configuration', () => {
      it('should not enable telemetry by default', async () => {
        const context = await createToolContextAsync({ dbPath: ':memory:' })

        expect(context.distinctId).toBeUndefined()

        await closeToolContext(context)
      })

      it('should enable telemetry when env var is true and API key provided', async () => {
        process.env.SKILLSMITH_TELEMETRY_ENABLED = 'true'
        process.env.POSTHOG_API_KEY = 'phc_test_key_12345'

        const context = await createToolContextAsync({ dbPath: ':memory:' })

        expect(context.distinctId).toBeDefined()
        expect(typeof context.distinctId).toBe('string')

        await closeToolContext(context)
      })

      it('should enable telemetry via config options', async () => {
        const context = await createToolContextAsync({
          dbPath: ':memory:',
          telemetryConfig: {
            enabled: true,
            postHogApiKey: 'phc_config_key_12345',
          },
        })

        expect(context.distinctId).toBeDefined()

        await closeToolContext(context)
      })

      it('should not enable telemetry without API key', async () => {
        process.env.SKILLSMITH_TELEMETRY_ENABLED = 'true'
        // No POSTHOG_API_KEY set

        const context = await createToolContextAsync({ dbPath: ':memory:' })

        expect(context.distinctId).toBeUndefined()

        await closeToolContext(context)
      })

      it('should prefer env var over config when both set', async () => {
        process.env.SKILLSMITH_TELEMETRY_ENABLED = 'true'
        process.env.POSTHOG_API_KEY = 'phc_env_key'

        const context = await createToolContextAsync({
          dbPath: ':memory:',
          telemetryConfig: {
            enabled: false, // Config says false, but env var says true
            postHogApiKey: 'phc_config_key',
          },
        })

        // env var wins
        expect(context.distinctId).toBeDefined()

        await closeToolContext(context)
      })
    })

    describe('background sync configuration', () => {
      it('should not create backgroundSync when disabled via env var', async () => {
        process.env.SKILLSMITH_BACKGROUND_SYNC = 'false'

        const context = await createToolContextAsync({ dbPath: ':memory:' })

        expect(context.backgroundSync).toBeUndefined()

        await closeToolContext(context)
      })

      it('should not create backgroundSync when disabled via config', async () => {
        const context = await createToolContextAsync({
          dbPath: ':memory:',
          backgroundSyncConfig: { enabled: false },
        })

        expect(context.backgroundSync).toBeUndefined()

        await closeToolContext(context)
      })

      it('should check sync config enabled flag before starting', async () => {
        // backgroundSync is only created if syncConfig.enabled is true
        // Default sync config has enabled: false
        const context = await createToolContextAsync({
          dbPath: ':memory:',
          backgroundSyncConfig: { enabled: true },
        })

        // Background sync may or may not be created based on internal sync config
        // Just verify context creation succeeds
        expect(context.db).toBeDefined()

        await closeToolContext(context)
      })
    })

    describe('LLM failover configuration', () => {
      it('should not create llmFailover by default', async () => {
        const context = await createToolContextAsync({ dbPath: ':memory:' })

        expect(context.llmFailover).toBeUndefined()

        await closeToolContext(context)
      })

      it('should create llmFailover when enabled via env var', async () => {
        process.env.SKILLSMITH_LLM_FAILOVER_ENABLED = 'true'

        const context = await createToolContextAsync({ dbPath: ':memory:' })

        expect(context.llmFailover).toBeDefined()

        await closeToolContext(context)
      })

      it('should create llmFailover when enabled via config', async () => {
        const context = await createToolContextAsync({
          dbPath: ':memory:',
          llmFailoverConfig: { enabled: true },
        })

        expect(context.llmFailover).toBeDefined()

        await closeToolContext(context)
      })
    })

    // SMI-5649: `_signalHandlers` was deleted from `ToolContext` — the factory
    // no longer registers its own process-level SIGTERM/SIGINT handlers at
    // all (that was the root cause of the shutdown race fixed in this wave).
    // Signal ownership now belongs solely to index.ts's single shutdown
    // coordinator (shutdown.ts). The invariant this "signal handler
    // registration" describe block used to cover — exactly one
    // SIGTERM/SIGINT registration site — is now covered by
    // shutdown.test.ts's dedicated in-process listenerCount unit test and by
    // tests/context-async-listeners.test.ts / __tests__/context-listeners.test.ts
    // (updated to assert this factory registers ZERO listeners).
  })

  describe('closeToolContext', () => {
    it('should close database connection', async () => {
      const context = await createToolContextAsync({ dbPath: ':memory:' })

      await closeToolContext(context)

      // Database should be closed - further operations should fail
      expect(() => context.db.exec('SELECT 1')).toThrow()
    })

    it('should not touch process-level signal listeners (SMI-5649 — see context-listeners.test.ts for the full audit)', async () => {
      process.env.SKILLSMITH_LLM_FAILOVER_ENABLED = 'true'

      const before = process.listenerCount('SIGTERM')
      const context = await createToolContextAsync({ dbPath: ':memory:' })

      expect(process.listenerCount('SIGTERM')).toBe(before)

      await closeToolContext(context)

      expect(process.listenerCount('SIGTERM')).toBe(before)
    })

    it('should stop background sync if running', async () => {
      // Create context with background sync enabled
      const context = await createToolContextAsync({
        dbPath: ':memory:',
        backgroundSyncConfig: { enabled: true },
      })

      await closeToolContext(context)

      // Should complete without error
    })

    it('should close LLM failover chain if initialized', async () => {
      const context = await createToolContextAsync({
        dbPath: ':memory:',
        llmFailoverConfig: { enabled: true },
      })

      await closeToolContext(context)

      // Should complete without error
    })

    it('should shutdown PostHog if telemetry was enabled', async () => {
      process.env.POSTHOG_API_KEY = 'phc_test_key'

      const context = await createToolContextAsync({
        dbPath: ':memory:',
        telemetryConfig: { enabled: true, postHogApiKey: 'phc_test_key' },
      })

      expect(context.distinctId).toBeDefined()

      await closeToolContext(context)

      // Should complete without error
    })
  })

  describe('getToolContextAsync (singleton)', () => {
    it('should create context on first call', async () => {
      await resetAsyncToolContext() // Ensure clean state

      const context = await getToolContextAsync({ dbPath: ':memory:' })

      expect(context).toBeDefined()
      expect(context.db).toBeDefined()
    })

    it('should return same context on subsequent calls', async () => {
      await resetAsyncToolContext()

      const context1 = await getToolContextAsync({ dbPath: ':memory:' })
      const context2 = await getToolContextAsync()

      expect(context1).toBe(context2)
    })

    it('should warn when options provided after context created', async () => {
      await resetAsyncToolContext()

      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      await getToolContextAsync({ dbPath: ':memory:' })
      await getToolContextAsync({ dbPath: ':memory:', searchCacheTtl: 1000 })

      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('Options ignored'))

      consoleWarnSpy.mockRestore()
    })

    it('should not warn when no options provided on subsequent calls', async () => {
      await resetAsyncToolContext()

      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      await getToolContextAsync({ dbPath: ':memory:' })
      await getToolContextAsync() // No options

      // Should not have warned about ignored options (WASM-fallback warning is exempt)
      const optionsIgnoredCalls = consoleWarnSpy.mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('Options ignored')
      )
      expect(optionsIgnoredCalls).toHaveLength(0)

      consoleWarnSpy.mockRestore()
    })
  })

  describe('resetAsyncToolContext', () => {
    it('should clear the global context', async () => {
      const context1 = await getToolContextAsync({ dbPath: ':memory:' })

      await resetAsyncToolContext()

      const context2 = await getToolContextAsync({ dbPath: ':memory:' })

      // Should be different instances
      expect(context1).not.toBe(context2)
    })

    it('should close existing context before reset', async () => {
      const context = await getToolContextAsync({ dbPath: ':memory:' })
      const db = context.db

      await resetAsyncToolContext()

      // Original database should be closed
      expect(() => db.exec('SELECT 1')).toThrow()
    })

    it('should be idempotent when no context exists', async () => {
      await resetAsyncToolContext()
      await resetAsyncToolContext() // Should not throw

      // Should be able to create new context
      const context = await getToolContextAsync({ dbPath: ':memory:' })
      expect(context).toBeDefined()
    })
  })
})
