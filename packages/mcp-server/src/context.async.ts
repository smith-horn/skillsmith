/**
 * @fileoverview Async Tool Context Creation with WASM Fallback
 * @module @skillsmith/mcp-server/context.async
 * @see SMI-2207: Async database functions with WASM fallback
 * @see SMI-2741: Split from context.ts to meet 500-line standard
 *
 * Provides async context creation for cross-platform compatibility:
 * 1. Try better-sqlite3 native module first (fastest)
 * 2. Fall back to sql.js WASM if native is unavailable
 */

import { existsSync } from 'fs'
import {
  createDatabaseAsync,
  openDatabaseAsync,
  initializeSchema,
  SearchService,
  SkillRepository,
  validateDbPath,
  SkillsmithApiClient,
  initializePostHog,
  shutdownPostHog,
  generateAnonymousId,
  SyncConfigRepository,
  SyncHistoryRepository,
  SyncEngine,
  SkillVersionRepository,
  BackgroundSyncService,
  getApiKey,
  type SyncResult,
  type DatabaseType,
} from '@skillsmith/core'
import { LLMFailoverChain } from './llm/failover.js'
import { getDefaultDbPath, ensureDbDirectory } from './context.helpers.js'
import type { ToolContext, ToolContextOptions } from './context.types.js'

// Separate singleton for async context (prevents caching conflict with sync)
let asyncGlobalContext: ToolContext | null = null

/**
 * Create the shared tool context asynchronously with WASM fallback
 *
 * This is the recommended way to initialize context for cross-platform
 * compatibility. It will:
 * 1. Try better-sqlite3 native module first (fastest)
 * 2. Fall back to sql.js WASM if native is unavailable
 *
 * @param options - Configuration options
 * @returns Promise resolving to initialized tool context
 *
 * @see SMI-898: Path traversal protection
 * @see SMI-2207: Async initialization for WASM fallback
 *
 * @example
 * // Initialize with WASM fallback support
 * const context = await createToolContextAsync();
 *
 * @throws Error if dbPath contains path traversal attempt
 * @throws Error if no database driver is available
 */
export async function createToolContextAsync(
  options: ToolContextOptions = {}
): Promise<ToolContext> {
  let dbPath: string

  if (options.dbPath) {
    // SMI-898: Validate custom path for path traversal
    const validation = validateDbPath(options.dbPath, {
      allowInMemory: true,
      allowTempDir: true,
    })

    if (!validation.valid) {
      throw new Error(
        `Invalid database path: ${validation.error}. ` +
          'Path must be within ~/.skillsmith, ~/.claude, or temp directories.'
      )
    }

    dbPath = validation.resolvedPath!
  } else {
    dbPath = getDefaultDbPath()
  }

  // Ensure directory exists (skip for in-memory)
  if (dbPath !== ':memory:') {
    ensureDbDirectory(dbPath)
  }

  // SMI-2207: Use async database creation with WASM fallback
  let db: DatabaseType
  if (dbPath !== ':memory:' && existsSync(dbPath)) {
    db = await openDatabaseAsync(dbPath)
  } else {
    db = await createDatabaseAsync(dbPath)
    // SMI-2207: createDatabaseAsync returns a bare connection (no schema).
    // openDatabaseAsync runs runMigrationsSafe internally; for new/in-memory
    // databases we must call initializeSchema explicitly to match the sync path.
    initializeSchema(db)
  }

  // Initialize services
  const searchService = new SearchService(db, {
    cacheTtl: options.searchCacheTtl ?? 300,
  })

  const skillRepository = new SkillRepository(db)

  // SMI-1851: Use shared config module (handles env var > config file precedence)
  const apiKey = options.apiKey || getApiKey()

  // SMI-1183: Initialize API client with configuration
  const apiClient = new SkillsmithApiClient({
    baseUrl: options.apiClientConfig?.baseUrl,
    anonKey: options.apiClientConfig?.anonKey,
    apiKey,
    timeout: options.apiClientConfig?.timeout ?? 10000,
    maxRetries: options.apiClientConfig?.maxRetries ?? 3,
    debug: options.apiClientConfig?.debug,
    offlineMode: options.apiClientConfig?.offlineMode,
  })

  // SMI-1184: Initialize PostHog telemetry (opt-in, privacy first)
  let distinctId: string | undefined

  const telemetryEnabled =
    process.env.SKILLSMITH_TELEMETRY_ENABLED === 'true' || options.telemetryConfig?.enabled === true

  const postHogApiKey = process.env.POSTHOG_API_KEY || options.telemetryConfig?.postHogApiKey

  if (telemetryEnabled && postHogApiKey) {
    distinctId = generateAnonymousId()
    initializePostHog({
      apiKey: postHogApiKey,
      host: options.telemetryConfig?.postHogHost,
      disabled: false,
    })
  }

  // Initialize background sync service if enabled
  let backgroundSync: BackgroundSyncService | undefined

  const backgroundSyncEnabled =
    process.env.SKILLSMITH_BACKGROUND_SYNC !== 'false' &&
    options.backgroundSyncConfig?.enabled !== false

  if (backgroundSyncEnabled) {
    const syncConfigRepo = new SyncConfigRepository(db)
    const syncHistoryRepo = new SyncHistoryRepository(db)
    const skillVersionRepo = new SkillVersionRepository(db)

    const syncConfig = syncConfigRepo.getConfig()
    if (syncConfig.enabled) {
      const syncEngine = new SyncEngine(
        apiClient,
        skillRepository,
        syncConfigRepo,
        syncHistoryRepo,
        skillVersionRepo
      )

      backgroundSync = new BackgroundSyncService(syncEngine, syncConfigRepo, {
        syncOnStart: true,
        debug: options.backgroundSyncConfig?.debug ?? false,
        onSyncComplete: (result: SyncResult) => {
          if (options.backgroundSyncConfig?.debug) {
            console.log(
              `[skillsmith] Background sync complete: ${result.skillsAdded} added, ${result.skillsUpdated} updated`
            )
          }
        },
        onSyncError: (error: Error) => {
          if (options.backgroundSyncConfig?.debug) {
            console.error(`[skillsmith] Background sync error: ${error.message}`)
          }
        },
      })

      backgroundSync.start()
    }
  }

  // SMI-1524: Initialize LLM failover chain if enabled
  let llmFailover: LLMFailoverChain | undefined

  const llmFailoverEnabled =
    process.env.SKILLSMITH_LLM_FAILOVER_ENABLED === 'true' ||
    options.llmFailoverConfig?.enabled === true

  if (llmFailoverEnabled) {
    llmFailover = new LLMFailoverChain({
      ...options.llmFailoverConfig,
      enabled: true,
      debug: options.llmFailoverConfig?.debug ?? false,
    })

    llmFailover.initialize().catch((error) => {
      console.error(`[skillsmith] LLM failover initialization error: ${error.message}`)
    })

    if (options.llmFailoverConfig?.debug) {
      console.log('[skillsmith] LLM failover chain initialized')
    }
  }

  // Create signal handlers for cleanup
  const signalHandlers: Array<{ signal: NodeJS.Signals; handler: () => void }> = []

  if (backgroundSync || llmFailover) {
    const cleanup = () => {
      backgroundSync?.stop()
      llmFailover?.close()
    }

    const sigTermHandler = () => cleanup()
    const sigIntHandler = () => cleanup()

    process.on('SIGTERM', sigTermHandler)
    process.on('SIGINT', sigIntHandler)

    signalHandlers.push(
      { signal: 'SIGTERM', handler: sigTermHandler },
      { signal: 'SIGINT', handler: sigIntHandler }
    )
  }

  return {
    db,
    searchService,
    skillRepository,
    apiClient,
    distinctId,
    backgroundSync,
    llmFailover,
    _signalHandlers: signalHandlers.length > 0 ? signalHandlers : undefined,
  }
}

/**
 * Get or create the global async tool context
 *
 * Uses a separate singleton from the sync version to prevent caching issues
 * where the sync path might be triggered first and cached.
 *
 * @param options - Configuration options (only used on first call)
 * @returns Promise resolving to the global tool context
 */
export async function getToolContextAsync(options?: ToolContextOptions): Promise<ToolContext> {
  if (!asyncGlobalContext) {
    asyncGlobalContext = await createToolContextAsync(options)
  } else if (options) {
    console.warn(
      '[skillsmith] getToolContextAsync called with options after context was already initialized. Options ignored.'
    )
  }
  return asyncGlobalContext
}

/**
 * Reset the async global context (for testing)
 */
export async function resetAsyncToolContext(): Promise<void> {
  if (asyncGlobalContext) {
    // Inline close to avoid circular import with context.ts
    const context = asyncGlobalContext
    asyncGlobalContext = null

    if (context._signalHandlers) {
      for (const { signal, handler } of context._signalHandlers) {
        process.removeListener(signal, handler)
      }
    }
    if (context.backgroundSync) {
      context.backgroundSync.stop()
    }
    if (context.llmFailover) {
      context.llmFailover.close()
    }
    context.db.close()
    if (context.distinctId) {
      await shutdownPostHog()
    }
  }
}
