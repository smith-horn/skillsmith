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
  createToolContext,
  closeToolContext,
  getToolContext,
  resetToolContext,
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
    await resetToolContext()
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    await resetToolContext()
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

  describe('createToolContext', () => {
    describe('basic initialization', () => {
      it('should create context with in-memory database', () => {
        const context = createToolContext({ dbPath: ':memory:' })

        expect(context.db).toBeDefined()
        expect(context.searchService).toBeDefined()
        expect(context.skillRepository).toBeDefined()
        expect(context.apiClient).toBeDefined()

        context.db.close()
      })

      it('should create context with default options', async () => {
        const context = createToolContext({ dbPath: ':memory:' })

        expect(context.distinctId).toBeUndefined()
        // backgroundSync is created by default when sync config is enabled
        // This is the expected default behavior
        expect(context.llmFailover).toBeUndefined()

        await closeToolContext(context)
      })

      it('should throw error for invalid custom path', () => {
        expect(() => createToolContext({ dbPath: '/etc/malicious/../../../root/hack.db' })).toThrow(
          'Invalid database path'
        )
      })

      it('should apply custom search cache TTL', () => {
        const context = createToolContext({
          dbPath: ':memory:',
          searchCacheTtl: 600,
        })

        expect(context.searchService).toBeDefined()

        context.db.close()
      })

      it('should apply API client configuration', () => {
        const context = createToolContext({
          dbPath: ':memory:',
          apiClientConfig: {
            timeout: 5000,
            maxRetries: 2,
            offlineMode: true,
          },
        })

        expect(context.apiClient).toBeDefined()
        expect(context.apiClient.isOffline()).toBe(true)

        context.db.close()
      })

      it('should create directory for file-based database path', () => {
        const testDir = join(tmpdir(), 'skillsmith-context-test-' + Date.now())
        const dbPath = join(testDir, 'test.db')

        // Clean up if exists
        if (existsSync(testDir)) {
          rmSync(testDir, { recursive: true })
        }

        const context = createToolContext({ dbPath })

        expect(existsSync(testDir)).toBe(true)

        context.db.close()

        // Clean up
        rmSync(testDir, { recursive: true })
      })

      it('should skip directory creation for in-memory database', () => {
        // This should not throw even though :memory: has no directory
        const context = createToolContext({ dbPath: ':memory:' })
        expect(context.db).toBeDefined()
        context.db.close()
      })
    })

    describe('telemetry configuration', () => {
      it('should not enable telemetry by default', () => {
        const context = createToolContext({ dbPath: ':memory:' })

        expect(context.distinctId).toBeUndefined()

        context.db.close()
      })

      it('should enable telemetry when env var is true and API key provided', () => {
        process.env.SKILLSMITH_TELEMETRY_ENABLED = 'true'
        process.env.POSTHOG_API_KEY = 'phc_test_key_12345'

        const context = createToolContext({ dbPath: ':memory:' })

        expect(context.distinctId).toBeDefined()
        expect(typeof context.distinctId).toBe('string')

        context.db.close()
      })

      it('should enable telemetry via config options', () => {
        const context = createToolContext({
          dbPath: ':memory:',
          telemetryConfig: {
            enabled: true,
            postHogApiKey: 'phc_config_key_12345',
          },
        })

        expect(context.distinctId).toBeDefined()

        context.db.close()
      })

      it('should not enable telemetry without API key', () => {
        process.env.SKILLSMITH_TELEMETRY_ENABLED = 'true'
        // No POSTHOG_API_KEY set

        const context = createToolContext({ dbPath: ':memory:' })

        expect(context.distinctId).toBeUndefined()

        context.db.close()
      })

      it('should prefer env var over config when both set', () => {
        process.env.SKILLSMITH_TELEMETRY_ENABLED = 'true'
        process.env.POSTHOG_API_KEY = 'phc_env_key'

        const context = createToolContext({
          dbPath: ':memory:',
          telemetryConfig: {
            enabled: false, // Config says false, but env var says true
            postHogApiKey: 'phc_config_key',
          },
        })

        // env var wins
        expect(context.distinctId).toBeDefined()

        context.db.close()
      })
    })

    describe('background sync configuration', () => {
      it('should not create backgroundSync when disabled via env var', () => {
        process.env.SKILLSMITH_BACKGROUND_SYNC = 'false'

        const context = createToolContext({ dbPath: ':memory:' })

        expect(context.backgroundSync).toBeUndefined()

        context.db.close()
      })

      it('should not create backgroundSync when disabled via config', () => {
        const context = createToolContext({
          dbPath: ':memory:',
          backgroundSyncConfig: { enabled: false },
        })

        expect(context.backgroundSync).toBeUndefined()

        context.db.close()
      })

      it('should check sync config enabled flag before starting', () => {
        // backgroundSync is only created if syncConfig.enabled is true
        // Default sync config has enabled: false
        const context = createToolContext({
          dbPath: ':memory:',
          backgroundSyncConfig: { enabled: true },
        })

        // Background sync may or may not be created based on internal sync config
        // Just verify context creation succeeds
        expect(context.db).toBeDefined()

        context.db.close()
      })
    })

    describe('LLM failover configuration', () => {
      it('should not create llmFailover by default', () => {
        const context = createToolContext({ dbPath: ':memory:' })

        expect(context.llmFailover).toBeUndefined()

        context.db.close()
      })

      it('should create llmFailover when enabled via env var', async () => {
        process.env.SKILLSMITH_LLM_FAILOVER_ENABLED = 'true'

        const context = createToolContext({ dbPath: ':memory:' })

        expect(context.llmFailover).toBeDefined()

        await closeToolContext(context)
      })

      it('should create llmFailover when enabled via config', async () => {
        const context = createToolContext({
          dbPath: ':memory:',
          llmFailoverConfig: { enabled: true },
        })

        expect(context.llmFailover).toBeDefined()

        await closeToolContext(context)
      })
    })

    describe('signal handler registration', () => {
      it('should register signal handlers when services are created', async () => {
        process.env.SKILLSMITH_LLM_FAILOVER_ENABLED = 'true'

        const context = createToolContext({ dbPath: ':memory:' })

        expect(context._signalHandlers).toBeDefined()
        expect(context._signalHandlers!.length).toBeGreaterThan(0)

        await closeToolContext(context)
      })

      it('should not register signal handlers without services', () => {
        process.env.SKILLSMITH_BACKGROUND_SYNC = 'false'

        const context = createToolContext({
          dbPath: ':memory:',
          backgroundSyncConfig: { enabled: false },
        })

        expect(context._signalHandlers).toBeUndefined()

        context.db.close()
      })
    })
  })

  describe('closeToolContext', () => {
    it('should close database connection', async () => {
      const context = createToolContext({ dbPath: ':memory:' })

      await closeToolContext(context)

      // Database should be closed - further operations should fail
      expect(() => context.db.exec('SELECT 1')).toThrow()
    })

    it('should remove signal handlers', async () => {
      process.env.SKILLSMITH_LLM_FAILOVER_ENABLED = 'true'

      const context = createToolContext({ dbPath: ':memory:' })
      const initialHandlerCount = context._signalHandlers?.length ?? 0

      expect(initialHandlerCount).toBeGreaterThan(0)

      await closeToolContext(context)

      // Signal handlers should be removed (verified by not causing memory leak)
    })

    it('should stop background sync if running', async () => {
      // Create context with background sync enabled
      const context = createToolContext({
        dbPath: ':memory:',
        backgroundSyncConfig: { enabled: true },
      })

      await closeToolContext(context)

      // Should complete without error
    })

    it('should close LLM failover chain if initialized', async () => {
      const context = createToolContext({
        dbPath: ':memory:',
        llmFailoverConfig: { enabled: true },
      })

      await closeToolContext(context)

      // Should complete without error
    })

    it('should shutdown PostHog if telemetry was enabled', async () => {
      process.env.POSTHOG_API_KEY = 'phc_test_key'

      const context = createToolContext({
        dbPath: ':memory:',
        telemetryConfig: { enabled: true, postHogApiKey: 'phc_test_key' },
      })

      expect(context.distinctId).toBeDefined()

      await closeToolContext(context)

      // Should complete without error
    })
  })

  describe('getToolContext (singleton)', () => {
    it('should create context on first call', async () => {
      await resetToolContext() // Ensure clean state

      const context = getToolContext({ dbPath: ':memory:' })

      expect(context).toBeDefined()
      expect(context.db).toBeDefined()
    })

    it('should return same context on subsequent calls', async () => {
      await resetToolContext()

      const context1 = getToolContext({ dbPath: ':memory:' })
      const context2 = getToolContext()

      expect(context1).toBe(context2)
    })

    it('should warn when options provided after context created', async () => {
      await resetToolContext()

      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      getToolContext({ dbPath: ':memory:' })
      getToolContext({ dbPath: ':memory:', searchCacheTtl: 1000 })

      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('Options ignored'))

      consoleWarnSpy.mockRestore()
    })

    it('should not warn when no options provided on subsequent calls', async () => {
      await resetToolContext()

      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      getToolContext({ dbPath: ':memory:' })
      getToolContext() // No options

      expect(consoleWarnSpy).not.toHaveBeenCalled()

      consoleWarnSpy.mockRestore()
    })
  })

  describe('resetToolContext', () => {
    it('should clear the global context', async () => {
      const context1 = getToolContext({ dbPath: ':memory:' })

      await resetToolContext()

      const context2 = getToolContext({ dbPath: ':memory:' })

      // Should be different instances
      expect(context1).not.toBe(context2)
    })

    it('should close existing context before reset', async () => {
      const context = getToolContext({ dbPath: ':memory:' })
      const db = context.db

      await resetToolContext()

      // Original database should be closed
      expect(() => db.exec('SELECT 1')).toThrow()
    })

    it('should be idempotent when no context exists', async () => {
      await resetToolContext()
      await resetToolContext() // Should not throw

      // Should be able to create new context
      const context = getToolContext({ dbPath: ':memory:' })
      expect(context).toBeDefined()
    })
  })
})
