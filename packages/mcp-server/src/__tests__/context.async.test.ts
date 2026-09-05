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
    getOrCreateInstallId: vi.fn().mockReturnValue('install-id-abc123'),
    SyncConfigRepository: MockSyncConfigRepository,
    SyncHistoryRepository: MockSyncHistoryRepository,
    SyncEngine: MockSyncEngine,
    SkillVersionRepository: MockSkillVersionRepository,
    BackgroundSyncService: MockBackgroundSyncService,
    getApiKey: vi.fn().mockReturnValue(undefined),
    validateDbPath: actual.validateDbPath,
    // SMI-6362 §1: overridden (not `...actual`) so tests can control exactly
    // when each refresh resolves — needed for the generation-guard
    // regression test below. Defaults to a fast `null` resolution, matching
    // the real function's behaviour in this credential-less test env.
    resolveFreshAccessToken: vi.fn().mockResolvedValue(null),
  }
})

// ---------------------------------------------------------------------------
// Import the module under test AFTER mocks are registered
// ---------------------------------------------------------------------------

import {
  createToolContextAsync,
  getToolContextAsync,
  resetAsyncToolContext,
  _refreshTelemetryIdentityForTests as refreshTelemetryIdentity,
  _getCachedTelemetryIdentityForTests,
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

    it("SMI-6362 (D-7): distinctId is getOrCreateInstallId()'s persisted value, UNCONDITIONALLY — no telemetry/PostHog env vars set at all", async () => {
      const { getOrCreateInstallId, initializePostHog } = await import('@skillsmith/core')
      vi.mocked(getOrCreateInstallId).mockReturnValue('install-id-abc123')
      // This file's convention (see openDatabaseAsync/createDatabaseAsync
      // above) is an explicit mockClear() before an .not.toHaveBeenCalled()
      // assertion, since mock call counts otherwise persist across tests in
      // this file (no blanket vi.clearAllMocks() in beforeEach).
      vi.mocked(initializePostHog).mockClear()

      const ctx = await createToolContextAsync({ dbPath: ':memory:' })

      // Unlike the legacy generateAnonymousId() path, distinctId no longer
      // depends on SKILLSMITH_TELEMETRY_ENABLED or POSTHOG_API_KEY being set
      // — that env gate is exactly what made the pre-SMI-6362 id inert for
      // virtually every real MCP client (D-7).
      expect(ctx.distinctId).toBe('install-id-abc123')
      // The two concerns are orthogonal: PostHog itself stays un-initialized
      // when its own env vars are absent.
      expect(initializePostHog).not.toHaveBeenCalled()
    })

    it('SMI-6362 (D-7): distinctId is the SAME persisted value regardless of whether PostHog is also configured', async () => {
      const { getOrCreateInstallId } = await import('@skillsmith/core')
      vi.mocked(getOrCreateInstallId).mockReturnValue('install-id-abc123')
      vi.stubEnv('SKILLSMITH_TELEMETRY_ENABLED', 'true')
      vi.stubEnv('POSTHOG_API_KEY', 'phc_test-key')

      const ctx = await createToolContextAsync({ dbPath: ':memory:' })

      expect(ctx.distinctId).toBe('install-id-abc123')
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

    it('SMI-6362 (D-7): also calls shutdownPostHog with NO telemetry env vars set — distinctId is now unconditional, so this guard fires every time; shutdownPostHog itself is a safe no-op when PostHog was never initialized', async () => {
      const { shutdownPostHog } = await import('@skillsmith/core')

      await getToolContextAsync({ dbPath: ':memory:' })
      await resetAsyncToolContext()

      expect(shutdownPostHog).toHaveBeenCalled()
    })
  })

  // ---------------------------------------------------------------------------
  // SMI-6362 §1 confirmation round (NEEDLE finding 3): the telemetry identity
  // cache's generation guard. Three refresh triggers exist and can overlap;
  // without the guard, an OLDER in-flight refresh resolving AFTER a NEWER one
  // would clobber the newer (valid) result with its own stale one.
  // ---------------------------------------------------------------------------
  describe('refreshTelemetryIdentity — generation guard', () => {
    it('discards an older refresh that resolves AFTER a newer one, keeping the newer result', async () => {
      const { resolveFreshAccessToken } = await import('@skillsmith/core')
      const mockResolve = vi.mocked(resolveFreshAccessToken)

      let resolveOlder!: (token: string | null) => void
      let resolveNewer!: (token: string | null) => void
      const olderPromise = new Promise<string | null>((resolve) => {
        resolveOlder = resolve
      })
      const newerPromise = new Promise<string | null>((resolve) => {
        resolveNewer = resolve
      })
      mockResolve.mockReturnValueOnce(olderPromise).mockReturnValueOnce(newerPromise)

      // Start the OLDER refresh first (generation 1) — its resolveFreshAccessToken
      // call is now in flight but not yet resolved.
      const olderRefresh = refreshTelemetryIdentity('key-older')
      // Start the NEWER refresh (generation 2) before the older one resolves.
      const newerRefresh = refreshTelemetryIdentity('key-newer')

      // Resolve the NEWER call's token FIRST, then the OLDER one — the
      // reverse of call order, which is exactly the race this guard exists
      // for (e.g. the older being the 5-minute timer, the newer being an
      // invalidation-triggered refresh that legitimately needs to win).
      resolveNewer('token-newer')
      await newerRefresh
      expect(_getCachedTelemetryIdentityForTests()?.accessToken).toBe('token-newer')

      resolveOlder('token-older')
      await olderRefresh
      // The older refresh's result must NOT have overwritten the newer one.
      expect(_getCachedTelemetryIdentityForTests()?.accessToken).toBe('token-newer')
    })

    it('a lone refresh still applies its result normally (guard does not block the common case)', async () => {
      const { resolveFreshAccessToken } = await import('@skillsmith/core')
      vi.mocked(resolveFreshAccessToken).mockResolvedValueOnce('token-solo')

      await refreshTelemetryIdentity('key-solo')

      expect(_getCachedTelemetryIdentityForTests()?.accessToken).toBe('token-solo')
    })
  })
})
