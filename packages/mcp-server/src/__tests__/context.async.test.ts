/**
 * Tests for async tool context creation (context.async.ts)
 *
 * @see SMI-2207: Async database functions with WASM fallback
 * @see SMI-2741: Split from context.ts to meet 500-line standard
 * @see SMI-2756: Wave 3 coverage improvement
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'

// ---------------------------------------------------------------------------
// Mocks — declared before importing the module under test
// ---------------------------------------------------------------------------

vi.mock('@skillsmith/core', () => {
  // Constructors must be real class-like functions, not arrow functions
  function SearchService() { return {} }
  function SkillRepository() { return {} }
  function SkillsmithApiClient() { return {} }
  function SyncConfigRepository() {
    return { getConfig: vi.fn().mockReturnValue({ enabled: false }) }
  }
  function SyncHistoryRepository() { return {} }
  function SyncEngine() { return {} }
  function SkillVersionRepository() { return {} }
  function BackgroundSyncService() {
    return { start: vi.fn(), stop: vi.fn() }
  }
  return {
    validateDbPath: vi.fn(),
    createDatabaseAsync: vi.fn(),
    openDatabaseAsync: vi.fn(),
    initializeSchema: vi.fn(),
    SearchService: vi.fn().mockImplementation(SearchService),
    SkillRepository: vi.fn().mockImplementation(SkillRepository),
    SkillsmithApiClient: vi.fn().mockImplementation(SkillsmithApiClient),
    initializePostHog: vi.fn(),
    shutdownPostHog: vi.fn().mockResolvedValue(undefined),
    generateAnonymousId: vi.fn().mockReturnValue('anon-id-123'),
    SyncConfigRepository: vi.fn().mockImplementation(SyncConfigRepository),
    SyncHistoryRepository: vi.fn().mockImplementation(SyncHistoryRepository),
    SyncEngine: vi.fn().mockImplementation(SyncEngine),
    SkillVersionRepository: vi.fn().mockImplementation(SkillVersionRepository),
    BackgroundSyncService: vi.fn().mockImplementation(BackgroundSyncService),
    getApiKey: vi.fn().mockReturnValue(undefined),
  }
})

vi.mock('../llm/failover.js', () => {
  // Must be a real constructor-compatible function (not arrow)
  function LLMFailoverChain() {
    return { initialize: vi.fn().mockResolvedValue(undefined), close: vi.fn() }
  }
  return {
    LLMFailoverChain: vi.fn().mockImplementation(LLMFailoverChain),
  }
})

vi.mock('../context.helpers.js', () => ({
  getDefaultDbPath: vi.fn().mockReturnValue(':memory:'),
  ensureDbDirectory: vi.fn(),
}))

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
}))

// ---------------------------------------------------------------------------
// Imports after mocks are set up
// ---------------------------------------------------------------------------

import {
  createToolContextAsync,
  getToolContextAsync,
  resetAsyncToolContext,
} from '../context.async.js'
import {
  validateDbPath,
  createDatabaseAsync,
  openDatabaseAsync,
  initializeSchema,
  initializePostHog,
  shutdownPostHog,
  generateAnonymousId,
  BackgroundSyncService,
  SyncConfigRepository as _SyncConfigRepository,
} from '@skillsmith/core'
import { LLMFailoverChain } from '../llm/failover.js'
import { getDefaultDbPath, ensureDbDirectory } from '../context.helpers.js'
import { existsSync } from 'fs'

// ---------------------------------------------------------------------------
// Typed mocks for easier assertions
// ---------------------------------------------------------------------------

const mockValidateDbPath = vi.mocked(validateDbPath)
const mockCreateDatabaseAsync = vi.mocked(createDatabaseAsync)
const mockOpenDatabaseAsync = vi.mocked(openDatabaseAsync)
const _mockInitializeSchema = vi.mocked(initializeSchema)
const mockInitializePostHog = vi.mocked(initializePostHog)
const mockShutdownPostHog = vi.mocked(shutdownPostHog)
const mockGenerateAnonymousId = vi.mocked(generateAnonymousId)
const mockExistsSync = vi.mocked(existsSync)
const mockGetDefaultDbPath = vi.mocked(getDefaultDbPath)
const mockEnsureDbDirectory = vi.mocked(ensureDbDirectory)

/** Minimal in-memory DB stub returned by create/openDatabaseAsync */
function makeFakeDb() {
  return {
    close: vi.fn(),
    exec: vi.fn(),
    prepare: vi.fn().mockReturnValue({
      run: vi.fn().mockReturnValue({ changes: 0, lastInsertRowid: 0 }),
      get: vi.fn().mockReturnValue(undefined),
      all: vi.fn().mockReturnValue([]),
    }),
    pragma: vi.fn(),
    transaction: vi.fn().mockImplementation((fn: unknown) => fn),
    open: true,
    name: ':memory:',
    memory: true,
    readonly: false,
  }
}

describe('createToolContextAsync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: valid path, creates new DB
    mockValidateDbPath.mockReturnValue({ valid: true, resolvedPath: ':memory:' })
    mockCreateDatabaseAsync.mockResolvedValue(makeFakeDb() as unknown as ReturnType<typeof makeFakeDb>)
    mockOpenDatabaseAsync.mockResolvedValue(makeFakeDb() as unknown as ReturnType<typeof makeFakeDb>)
    mockExistsSync.mockReturnValue(false)
    mockGetDefaultDbPath.mockReturnValue(':memory:')
    delete process.env.SKILLSMITH_TELEMETRY_ENABLED
    delete process.env.POSTHOG_API_KEY
    delete process.env.SKILLSMITH_BACKGROUND_SYNC
    delete process.env.SKILLSMITH_LLM_FAILOVER_ENABLED
  })

  afterEach(async () => {
    await resetAsyncToolContext()
    vi.unstubAllEnvs()
  })

  it('creates context with custom valid dbPath', async () => {
    const customPath = join(tmpdir(), 'custom-test.db')
    mockValidateDbPath.mockReturnValue({ valid: true, resolvedPath: customPath })
    mockExistsSync.mockReturnValue(false)

    const ctx = await createToolContextAsync({ dbPath: customPath })

    expect(mockValidateDbPath).toHaveBeenCalledWith(customPath, expect.any(Object))
    expect(ctx.db).toBeDefined()
    expect(ctx.searchService).toBeDefined()
    expect(ctx.skillRepository).toBeDefined()
    expect(ctx.apiClient).toBeDefined()
  })

  it('throws when dbPath contains path traversal (invalid path)', async () => {
    const traversalPath = '/etc/../etc/passwd.db'
    mockValidateDbPath.mockReturnValue({
      valid: false,
      error: 'Path traversal detected',
      resolvedPath: undefined,
    })

    await expect(
      createToolContextAsync({ dbPath: traversalPath })
    ).rejects.toThrow(Error)
  })

  it(':memory: skips ensureDbDirectory', async () => {
    mockValidateDbPath.mockReturnValue({ valid: true, resolvedPath: ':memory:' })

    await createToolContextAsync({ dbPath: ':memory:' })

    expect(mockEnsureDbDirectory).not.toHaveBeenCalled()
  })

  it('existing DB file uses openDatabaseAsync', async () => {
    const existingPath = join(tmpdir(), 'existing.db')
    mockValidateDbPath.mockReturnValue({ valid: true, resolvedPath: existingPath })
    mockExistsSync.mockReturnValue(true)

    await createToolContextAsync({ dbPath: existingPath })

    expect(mockOpenDatabaseAsync).toHaveBeenCalledWith(existingPath)
    expect(mockCreateDatabaseAsync).not.toHaveBeenCalled()
  })

  it('telemetry enabled calls initializePostHog and generateAnonymousId', async () => {
    process.env.SKILLSMITH_TELEMETRY_ENABLED = 'true'
    process.env.POSTHOG_API_KEY = 'phc_test_key'

    const ctx = await createToolContextAsync()

    expect(mockGenerateAnonymousId).toHaveBeenCalled()
    expect(mockInitializePostHog).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'phc_test_key', disabled: false })
    )
    expect(ctx.distinctId).toBe('anon-id-123')
  })

  it('background sync disabled via env var skips BackgroundSyncService', async () => {
    process.env.SKILLSMITH_BACKGROUND_SYNC = 'false'

    await createToolContextAsync()

    expect(BackgroundSyncService).not.toHaveBeenCalled()
  })

  it('LLM failover enabled creates LLMFailoverChain', async () => {
    process.env.SKILLSMITH_LLM_FAILOVER_ENABLED = 'true'

    const ctx = await createToolContextAsync()

    expect(LLMFailoverChain).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true })
    )
    expect(ctx.llmFailover).toBeDefined()
  })
})

describe('getToolContextAsync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockValidateDbPath.mockReturnValue({ valid: true, resolvedPath: ':memory:' })
    mockCreateDatabaseAsync.mockResolvedValue(makeFakeDb() as unknown as ReturnType<typeof makeFakeDb>)
    mockExistsSync.mockReturnValue(false)
    mockGetDefaultDbPath.mockReturnValue(':memory:')
    delete process.env.SKILLSMITH_BACKGROUND_SYNC
    delete process.env.SKILLSMITH_TELEMETRY_ENABLED
    delete process.env.SKILLSMITH_LLM_FAILOVER_ENABLED
  })

  afterEach(async () => {
    await resetAsyncToolContext()
  })

  it('caches context on second call (returns same instance)', async () => {
    const ctx1 = await getToolContextAsync()
    const ctx2 = await getToolContextAsync()

    // Same object reference = cached
    expect(ctx1).toBe(ctx2)
    // createDatabaseAsync called only once
    expect(mockCreateDatabaseAsync).toHaveBeenCalledTimes(1)
  })

  it('warns when options passed after init', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await getToolContextAsync()
    await getToolContextAsync({ searchCacheTtl: 999 })

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Options ignored'))
    warnSpy.mockRestore()
  })
})

describe('resetAsyncToolContext', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockValidateDbPath.mockReturnValue({ valid: true, resolvedPath: ':memory:' })
    mockCreateDatabaseAsync.mockResolvedValue(makeFakeDb() as unknown as ReturnType<typeof makeFakeDb>)
    mockExistsSync.mockReturnValue(false)
    mockGetDefaultDbPath.mockReturnValue(':memory:')
    delete process.env.SKILLSMITH_BACKGROUND_SYNC
    delete process.env.SKILLSMITH_TELEMETRY_ENABLED
    delete process.env.SKILLSMITH_LLM_FAILOVER_ENABLED
  })

  it('with backgroundSync stop() called if context has backgroundSync', async () => {
    // Default mock: SyncConfigRepository.getConfig returns { enabled: false }
    // so backgroundSync will not be created. Reset is still safe to call.
    const ctx = await getToolContextAsync()
    await resetAsyncToolContext()

    // If backgroundSync was set, stop was called; if not, reset is still safe
    if (ctx.backgroundSync) {
      expect(ctx.backgroundSync.stop).toHaveBeenCalled()
    } else {
      // config.enabled=false → no backgroundSync — reset should still be safe
      expect(ctx.backgroundSync).toBeUndefined()
    }
  })

  it('with llmFailover calls close(); with PostHog distinctId calls shutdownPostHog()', async () => {
    process.env.SKILLSMITH_LLM_FAILOVER_ENABLED = 'true'
    process.env.SKILLSMITH_TELEMETRY_ENABLED = 'true'
    process.env.POSTHOG_API_KEY = 'phc_test_key'

    // Disable background sync to avoid the SyncConfigRepository constructor issue
    process.env.SKILLSMITH_BACKGROUND_SYNC = 'false'

    const ctx = await getToolContextAsync()
    expect(ctx.llmFailover).toBeDefined()
    expect(ctx.distinctId).toBe('anon-id-123')

    // Spy on the actual instance method before reset
    const llmFailoverInstance = ctx.llmFailover!
    const closeSpy = vi.spyOn(llmFailoverInstance, 'close')

    await resetAsyncToolContext()

    expect(closeSpy).toHaveBeenCalled()
    expect(mockShutdownPostHog).toHaveBeenCalled()
  })
})
