/**
 * @fileoverview MCP Server Tool Context - Database initialization and shared services
 * @module @skillsmith/mcp-server/context
 * @see SMI-792: Add database initialization to MCP server
 * @see SMI-898: Path traversal protection for DB_PATH
 *
 * Provides shared context for MCP tool handlers including:
 * - SQLite database connection with FTS5 search
 * - SearchService for skill discovery
 * - SkillRepository for CRUD operations
 * - Secure path validation for database paths
 *
 * @example
 * // Initialize context at server startup
 * const context = createToolContext();
 *
 * // Pass to tool handlers
 * const result = await executeSearch(input, context);
 */

import { homedir } from 'os'
import { join, dirname } from 'path'
import { mkdirSync, existsSync } from 'fs'
import type { Database as DatabaseType } from 'better-sqlite3'
import {
  createDatabase,
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
  BackgroundSyncService,
  type ApiClientConfig,
} from '@skillsmith/core'
import { LLMFailoverChain, type LLMFailoverConfig } from './llm/failover.js'

/**
 * Shared context for MCP tool handlers
 * SMI-1183: Added apiClient for live API access with local fallback
 * SMI-1184: Added distinctId for telemetry tracking
 * SMI-1524: Added llmFailover for multi-LLM support with circuit breaker
 */
export interface ToolContext {
  /** SQLite database connection */
  db: DatabaseType
  /** Search service with FTS5/BM25 (fallback) */
  searchService: SearchService
  /** Skill repository for CRUD operations (fallback) */
  skillRepository: SkillRepository
  /** API client for live Supabase API (primary) */
  apiClient: SkillsmithApiClient
  /** Anonymous user ID for telemetry (undefined if telemetry disabled) */
  distinctId?: string
  /** Background sync service (if enabled) */
  backgroundSync?: BackgroundSyncService
  /** LLM failover chain for multi-provider support (SMI-1524) */
  llmFailover?: LLMFailoverChain
  /** Internal: Signal handlers for cleanup (prevents memory leaks) */
  _signalHandlers?: Array<{ signal: NodeJS.Signals; handler: () => void }>
}

/**
 * Telemetry configuration for PostHog (SMI-1184)
 * Privacy-first: disabled by default (opt-in)
 */
export interface TelemetryConfig {
  /**
   * Enable telemetry collection (default: false for privacy)
   * Can also be set via SKILLSMITH_TELEMETRY_ENABLED env var
   */
  enabled?: boolean
  /**
   * PostHog API key (starts with phc_)
   * Can also be set via POSTHOG_API_KEY env var
   */
  postHogApiKey?: string
  /**
   * PostHog host URL (default: https://app.posthog.com)
   */
  postHogHost?: string
}

/**
 * Background sync configuration
 */
export interface BackgroundSyncConfig {
  /**
   * Enable background sync during MCP server sessions
   * Can also be set via SKILLSMITH_BACKGROUND_SYNC env var
   * Default: true (syncs if config.enabled is true)
   */
  enabled?: boolean
  /**
   * Enable debug logging for sync operations
   */
  debug?: boolean
}

/**
 * Options for creating tool context
 */
export interface ToolContextOptions {
  /** Custom database path (defaults to ~/.skillsmith/skills.db) */
  dbPath?: string
  /** Search cache TTL in seconds (default: 300) */
  searchCacheTtl?: number
  /** API client configuration (SMI-1183) */
  apiClientConfig?: ApiClientConfig
  /**
   * Telemetry configuration (SMI-1184)
   * Privacy-first: telemetry is OPT-IN and disabled by default
   */
  telemetryConfig?: TelemetryConfig
  /**
   * Background sync configuration
   * Enables automatic registry sync during MCP server sessions
   */
  backgroundSyncConfig?: BackgroundSyncConfig
  /**
   * LLM failover chain configuration (SMI-1524)
   * Enables multi-provider LLM support with automatic failover
   * Disabled by default - set enabled: true to activate
   */
  llmFailoverConfig?: LLMFailoverConfig
}

/**
 * Get the default database path
 * Respects SKILLSMITH_DB_PATH environment variable
 *
 * @see SMI-898: Path traversal protection
 * - Validates SKILLSMITH_DB_PATH against path traversal attacks
 * - Rejects paths with ".." traversal sequences
 * - Ensures path is within allowed directories
 *
 * @throws Error if SKILLSMITH_DB_PATH contains path traversal attempt
 */
export function getDefaultDbPath(): string {
  const envPath = process.env.SKILLSMITH_DB_PATH

  if (envPath) {
    // SMI-898: Validate environment variable path for path traversal
    const validation = validateDbPath(envPath, {
      allowInMemory: true,
      allowTempDir: true,
    })

    if (!validation.valid) {
      throw new Error(
        `Invalid SKILLSMITH_DB_PATH: ${validation.error}. ` +
          'Path must be within ~/.skillsmith, ~/.claude, or temp directories.'
      )
    }

    return validation.resolvedPath!
  }

  return join(homedir(), '.skillsmith', 'skills.db')
}

/**
 * Ensure the database directory exists
 */
function ensureDbDirectory(dbPath: string): void {
  const dir = dirname(dbPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

/**
 * Create the shared tool context with database and services
 *
 * @param options - Configuration options
 * @returns Initialized tool context
 *
 * @see SMI-898: Path traversal protection
 * - Custom dbPath is validated for path traversal attacks
 * - Rejects paths with ".." or outside allowed directories
 *
 * @example
 * // With default path (~/.skillsmith/skills.db)
 * const context = createToolContext();
 *
 * @example
 * // With custom path (must be in allowed directory)
 * const context = createToolContext({ dbPath: '~/.skillsmith/custom.db' });
 *
 * @example
 * // For testing with in-memory database
 * const context = createToolContext({ dbPath: ':memory:' });
 *
 * @throws Error if dbPath contains path traversal attempt
 */
export function createToolContext(options: ToolContextOptions = {}): ToolContext {
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

  // Create database with schema
  const db = createDatabase(dbPath)

  // Initialize services
  const searchService = new SearchService(db, {
    cacheTtl: options.searchCacheTtl ?? 300,
  })

  const skillRepository = new SkillRepository(db)

  // SMI-1183: Initialize API client with configuration
  // API is primary data source; local DB is fallback
  const apiClient = new SkillsmithApiClient({
    baseUrl: options.apiClientConfig?.baseUrl,
    anonKey: options.apiClientConfig?.anonKey,
    timeout: options.apiClientConfig?.timeout ?? 10000, // 10s default
    maxRetries: options.apiClientConfig?.maxRetries ?? 3,
    debug: options.apiClientConfig?.debug,
    offlineMode: options.apiClientConfig?.offlineMode,
  })

  // SMI-1184: Initialize PostHog telemetry (opt-in, privacy first)
  let distinctId: string | undefined

  // Check env vars first, then fall back to config
  const telemetryEnabled =
    process.env.SKILLSMITH_TELEMETRY_ENABLED === 'true' || options.telemetryConfig?.enabled === true

  const postHogApiKey = process.env.POSTHOG_API_KEY || options.telemetryConfig?.postHogApiKey

  if (telemetryEnabled && postHogApiKey) {
    // Generate anonymous user ID for telemetry
    distinctId = generateAnonymousId()

    // Initialize PostHog client
    initializePostHog({
      apiKey: postHogApiKey,
      host: options.telemetryConfig?.postHogHost,
      disabled: false,
    })
  }

  // Initialize background sync service if enabled
  let backgroundSync: BackgroundSyncService | undefined

  // Check env var first, then config option (default: true)
  const backgroundSyncEnabled =
    process.env.SKILLSMITH_BACKGROUND_SYNC !== 'false' &&
    options.backgroundSyncConfig?.enabled !== false

  if (backgroundSyncEnabled) {
    const syncConfigRepo = new SyncConfigRepository(db)
    const syncHistoryRepo = new SyncHistoryRepository(db)

    // Only start if user has auto-sync enabled in their config
    const syncConfig = syncConfigRepo.getConfig()
    if (syncConfig.enabled) {
      const syncEngine = new SyncEngine(apiClient, skillRepository, syncConfigRepo, syncHistoryRepo)

      backgroundSync = new BackgroundSyncService(syncEngine, syncConfigRepo, {
        syncOnStart: true,
        debug: options.backgroundSyncConfig?.debug ?? false,
        onSyncComplete: (result) => {
          if (options.backgroundSyncConfig?.debug) {
            console.log(
              `[skillsmith] Background sync complete: ${result.skillsAdded} added, ${result.skillsUpdated} updated`
            )
          }
        },
        onSyncError: (error) => {
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

  // Check env var first (SKILLSMITH_LLM_FAILOVER_ENABLED), then config
  const llmFailoverEnabled =
    process.env.SKILLSMITH_LLM_FAILOVER_ENABLED === 'true' ||
    options.llmFailoverConfig?.enabled === true

  if (llmFailoverEnabled) {
    llmFailover = new LLMFailoverChain({
      ...options.llmFailoverConfig,
      enabled: true,
      debug: options.llmFailoverConfig?.debug ?? false,
    })

    // Initialize in background (non-blocking)
    // Always log errors to prevent silent failures
    llmFailover.initialize().catch((error) => {
      console.error(`[skillsmith] LLM failover initialization error: ${error.message}`)
    })

    if (options.llmFailoverConfig?.debug) {
      console.log('[skillsmith] LLM failover chain initialized')
    }
  }

  // Create signal handlers for cleanup (stored for removal to prevent memory leaks)
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
 * Close the tool context and release resources
 * SMI-1184: Also shuts down PostHog telemetry if initialized
 * SMI-1524: Also closes LLM failover chain
 *
 * @param context - Tool context to close
 */
export async function closeToolContext(context: ToolContext): Promise<void> {
  // Remove signal handlers to prevent memory leaks
  if (context._signalHandlers) {
    for (const { signal, handler } of context._signalHandlers) {
      process.removeListener(signal, handler)
    }
  }

  // Stop background sync service if running
  if (context.backgroundSync) {
    context.backgroundSync.stop()
  }

  // SMI-1524: Close LLM failover chain if initialized
  if (context.llmFailover) {
    context.llmFailover.close()
  }

  // Close database connection
  context.db.close()

  // SMI-1184: Shutdown PostHog if telemetry was enabled
  if (context.distinctId) {
    await shutdownPostHog()
  }
}

// Singleton context for the MCP server
let globalContext: ToolContext | null = null

/**
 * Get or create the global tool context
 * Uses singleton pattern for MCP server lifecycle
 *
 * Note: Options are only applied on first call. Subsequent calls
 * return the cached context and ignore any options.
 *
 * @param options - Configuration options (only used on first call)
 * @returns The global tool context
 */
export function getToolContext(options?: ToolContextOptions): ToolContext {
  if (!globalContext) {
    globalContext = createToolContext(options)
  } else if (options) {
    // Warn if options are provided after context is already created
    console.warn(
      '[skillsmith] getToolContext called with options after context was already initialized. Options ignored.'
    )
  }
  return globalContext
}

/**
 * Reset the global context (for testing)
 * SMI-1184: Made async to properly shutdown PostHog
 */
export async function resetToolContext(): Promise<void> {
  if (globalContext) {
    await closeToolContext(globalContext)
    globalContext = null
  }
}
