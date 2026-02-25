/**
 * Tests for async tool context creation with WASM fallback
 *
 * @see SMI-2756: Wave 3 coverage — async context lifecycle
 * @see SMI-2207: Async database functions with WASM fallback
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'

// ---------------------------------------------------------------------------
// Hoisted mock state — must be declared with vi.hoisted() so they are
// accessible in the vi.mock() factory closures (hoisted to top of file).
// ---------------------------------------------------------------------------

const { mockExistsSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn().mockReturnValue(false),
}))

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, existsSync: mockExistsSync }
})

vi.mock('../context.helpers.js', () => ({
  getDefaultDbPath: vi.fn().mockReturnValue(':memory:'),
  ensureDbDirectory: vi.fn(),
}))

vi.mock('../llm/failover.js', () => {
  class MockLLMFailoverChain {
    initialize = vi.fn().mockResolvedValue(undefined)
    close = vi.fn()
  }
  return { LLMFailoverChain: MockLLMFailoverChain }
})

vi.mock('@skillsmith/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@skillsmith/core')>()

  function makeMockDb(name = ':memory:') {
    return {
      close: vi.fn(),
      exec: vi.fn(),
      prepare: vi.fn().mockReturnValue({
        run: vi.fn().mockReturnValue({ changes: 0, lastInsertRowid: 0 }),
        get: vi.fn().mockReturnValue(undefined),
        all: vi.fn().mockReturnValue([]),
      }),
      transaction: vi.fn().mockImplementation((fn) => fn),
      pragma: vi.fn(),
      open: true,
      name,
      memory: name === ':memory:',
      readonly: false,
    }
  }

  class MockSearchService {}
  class MockSkillRepository {}
  class MockSkillsmithApiClient {
    isOffline() {
      return true
    }
  }
  class MockSyncConfigRepository {
    getConfig() {
      return { enabled: false }
    }
  }
  class MockSyncHistoryRepository {}
  class MockSyncEngine {}
  class MockSkillVersionRepository {}
  class MockBackgroundSyncService {
    start = vi.fn()
    stop = vi.fn()
  }

  return {
    ...actual,
    createDatabaseAsync: vi.fn().mockResolvedValue(makeMockDb(':memory:')),
    openDatabaseAsync: vi.fn().mockResolvedValue(makeMockDb('existing.db')),
    initializeSchema: vi.fn(),
    SearchService: MockSearchService,
    SkillRepository: MockSkillRepository,
    SkillsmithApiClient: MockSkillsmithApiClient,
    initializePostHog: vi.fn(),
    shutdownPostHog: vi.fn().mockResolvedValue(undefined),
    generateAnonymousId: vi.fn().mockReturnValue('anon-id-123'),
    SyncConfigRepository: MockSyncConfigRepository,
    SyncHistoryRepository: MockSyncHistoryRepository,
    SyncEngine: MockSyncEngine,
    SkillVersionRepository: MockSkillVersionRepository,
    BackgroundSyncService: MockBackgroundSyncService,
    getApiKey: vi.fn().mockReturnValue(undefined),
    validateDbPath: actual.validateDbPath,
  }
})

// ---------------------------------------------------------------------------
// Import the module under test AFTER mocks are registered
// ---------------------------------------------------------------------------

import {
  createToolContextAsync,
  getToolContextAsync,
  resetAsyncToolContext,
} from '../context.async.js'

describe('context.async', () => {
  beforeEach(async () => {
    await resetAsyncToolContext()
    // Disable background sync by default so tests don't hit SyncConfigRepository.getConfig()
    vi.stubEnv('SKILLSMITH_BACKGROUND_SYNC', 'false')
    mockExistsSync.mockReturnValue(false)
  })

  afterEach(async () => {
    await resetAsyncToolContext()
    vi.unstubAllEnvs()
  })

  // -------------------------------------------------------------------------
  // createToolContextAsync
  // -------------------------------------------------------------------------

  describe('createToolContextAsync', () => {
    it('creates context with in-memory database path', async () => {
      const ctx = await createToolContextAsync({ dbPath: ':memory:' })

      expect(ctx).toBeDefined()
      expect(ctx.db).toBeDefined()
      expect(ctx.searchService).toBeDefined()
      expect(ctx.skillRepository).toBeDefined()
      expect(ctx.apiClient).toBeDefined()
    })

    it('throws for path traversal in dbPath', async () => {
      await expect(createToolContextAsync({ dbPath: '/etc/../../tmp/evil.db' })).rejects.toThrow(
        /Invalid database path/
      )
    })

    it('skips ensureDbDirectory for :memory: path', async () => {
      const { ensureDbDirectory } = await import('../context.helpers.js')

      await createToolContextAsync({ dbPath: ':memory:' })

      expect(ensureDbDirectory).not.toHaveBeenCalled()
    })

    it('uses openDatabaseAsync when database file already exists', async () => {
      const { openDatabaseAsync, createDatabaseAsync } = await import('@skillsmith/core')

      const dbPath = join(tmpdir(), 'test-existing.db')
      mockExistsSync.mockReturnValue(true)

      // Reset call counts before this test's assertion
      vi.mocked(openDatabaseAsync).mockClear()
      vi.mocked(createDatabaseAsync).mockClear()

      await createToolContextAsync({ dbPath })

      expect(openDatabaseAsync).toHaveBeenCalledWith(dbPath)
      expect(createDatabaseAsync).not.toHaveBeenCalled()
    })

    it('calls initializePostHog when telemetry env var is true', async () => {
      const { initializePostHog } = await import('@skillsmith/core')

      vi.stubEnv('SKILLSMITH_TELEMETRY_ENABLED', 'true')
      vi.stubEnv('POSTHOG_API_KEY', 'phc_test-key')

      await createToolContextAsync({ dbPath: ':memory:' })

      expect(initializePostHog).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: 'phc_test-key' })
      )
    })

    it('does not create BackgroundSyncService when SKILLSMITH_BACKGROUND_SYNC is false', async () => {
      vi.stubEnv('SKILLSMITH_BACKGROUND_SYNC', 'false')

      const ctx = await createToolContextAsync({ dbPath: ':memory:' })

      expect(ctx.backgroundSync).toBeUndefined()
    })

    it('creates LLMFailoverChain when SKILLSMITH_LLM_FAILOVER_ENABLED is true', async () => {
      vi.stubEnv('SKILLSMITH_LLM_FAILOVER_ENABLED', 'true')

      const ctx = await createToolContextAsync({ dbPath: ':memory:' })

      expect(ctx.llmFailover).toBeDefined()
    })
  })

  // -------------------------------------------------------------------------
  // getToolContextAsync
  // -------------------------------------------------------------------------

  describe('getToolContextAsync', () => {
    it('caches context on second call (returns same instance)', async () => {
      const ctx1 = await getToolContextAsync({ dbPath: ':memory:' })
      const ctx2 = await getToolContextAsync()

      expect(ctx1).toBe(ctx2)
    })

    it('warns when options are provided after first initialisation', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      await getToolContextAsync({ dbPath: ':memory:' })
      // Second call with options — should warn and ignore them
      await getToolContextAsync({ dbPath: ':memory:' })

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('already initialized'))
      warnSpy.mockRestore()
    })
  })

  // -------------------------------------------------------------------------
  // resetAsyncToolContext
  // -------------------------------------------------------------------------

  describe('resetAsyncToolContext', () => {
    it('calls backgroundSync.stop() when backgroundSync is present', async () => {
      vi.stubEnv('SKILLSMITH_BACKGROUND_SYNC', 'true')

      const core = await import('@skillsmith/core')
      const stopFn = vi.fn()

      // Override SyncConfigRepository so the sync engine actually starts
      const _OrigSyncConfig = core.SyncConfigRepository
      vi.spyOn(core, 'SyncConfigRepository').mockImplementationOnce(function () {
        return { getConfig: () => ({ enabled: true }) }
      } as unknown as typeof _OrigSyncConfig)

      // Override BackgroundSyncService to capture the stop method
      const _OrigBgSync = core.BackgroundSyncService
      vi.spyOn(core, 'BackgroundSyncService').mockImplementationOnce(function () {
        return { start: vi.fn(), stop: stopFn }
      } as unknown as typeof _OrigBgSync)

      await getToolContextAsync({ dbPath: ':memory:' })
      await resetAsyncToolContext()

      expect(stopFn).toHaveBeenCalled()
    })

    it('calls llmFailover.close() when llmFailover is present', async () => {
      vi.stubEnv('SKILLSMITH_LLM_FAILOVER_ENABLED', 'true')

      const failoverModule = await import('../llm/failover.js')
      const closeFn = vi.fn()

      vi.spyOn(failoverModule, 'LLMFailoverChain').mockImplementationOnce(function () {
        return { initialize: vi.fn().mockResolvedValue(undefined), close: closeFn }
      } as unknown as typeof failoverModule.LLMFailoverChain)

      await getToolContextAsync({ dbPath: ':memory:' })
      await resetAsyncToolContext()

      expect(closeFn).toHaveBeenCalled()
    })

    it('calls shutdownPostHog when distinctId is set', async () => {
      const { shutdownPostHog } = await import('@skillsmith/core')

      vi.stubEnv('SKILLSMITH_TELEMETRY_ENABLED', 'true')
      vi.stubEnv('POSTHOG_API_KEY', 'phc_test-key')

      await getToolContextAsync({ dbPath: ':memory:' })
      await resetAsyncToolContext()

      expect(shutdownPostHog).toHaveBeenCalled()
    })
  })
})
