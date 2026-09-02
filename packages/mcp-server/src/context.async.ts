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
import { createRequire } from 'node:module'
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
  getOrCreateInstallId,
  SyncConfigRepository,
  SyncHistoryRepository,
  SyncEngine,
  SkillVersionRepository,
  CoInstallRepository,
  SkillDependencyRepository,
  BackgroundSyncService,
  getApiKey,
  loadCredentials,
  tryRefreshToken,
  resolveFreshAccessToken,
  setTelemetryIdentityProvider,
  setTelemetryIdentityInvalidationHandler,
  type SyncResult,
  type DatabaseType,
  type TelemetryIdentity,
} from '@skillsmith/core'
import { LLMFailoverChain } from './llm/failover.js'
import { getDefaultDbPath, ensureDbDirectory } from './context.helpers.js'
import type { ToolContext, ToolContextOptions } from './context.types.js'

// ESM-compatible require for reading this package's own package.json version
// (SMI-6362 §1's `sdk_version` field) — mirrors index.startup-helpers.ts's
// established pattern. Read once at module load, not per tool call: this
// value cannot change within a running process.
const require = createRequire(import.meta.url)
let cachedSdkVersion: string | undefined
function readSdkVersion(): string | undefined {
  if (cachedSdkVersion !== undefined) return cachedSdkVersion
  try {
    const pkg = require('../package.json') as { version?: string }
    cachedSdkVersion = pkg.version
  } catch {
    cachedSdkVersion = undefined
  }
  return cachedSdkVersion
}

/**
 * SMI-6362 §1: the `telemetryIdentityProvider` module thunk the plan
 * specifies — background-refreshed, never resolved inline on the emit path.
 * Module-level (not per-context) because `setTelemetryIdentityProvider` in
 * `@skillsmith/core` is itself a process-wide singleton; multiple
 * `createToolContextAsync()` calls in one process (tests) each reinstall it,
 * which is harmless — the last install wins, matching `initializePostHog`'s
 * own already-established singleton behaviour in this same file.
 */
let cachedTelemetryIdentity: TelemetryIdentity | null = null
let telemetryIdentityRefreshTimer: ReturnType<typeof setInterval> | undefined

async function refreshTelemetryIdentity(currentApiKey: string | undefined): Promise<void> {
  try {
    const accessToken = await resolveFreshAccessToken()
    cachedTelemetryIdentity = accessToken
      ? { accessToken, apiKey: currentApiKey, sdkVersion: readSdkVersion() }
      : null
  } catch {
    // Best-effort: a failed refresh just means emitToolCallEvent keeps
    // skipping (skippedNoIdentity) until the next trigger succeeds.
    cachedTelemetryIdentity = null
  }
}

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
  const coInstallRepository = new CoInstallRepository(db)
  const skillDependencyRepository = new SkillDependencyRepository(db)

  // SMI-1851: Use shared config module (handles env var > config file precedence)
  const apiKey = options.apiKey || getApiKey()

  // SMI-4402: If no legacy API key, try JWT from ~/.skillsmith/config.json.
  // Refresh if expired; log a hint if neither credential is present.
  let jwtToken: string | undefined
  if (!apiKey) {
    const creds = await loadCredentials()
    if (creds) {
      if (Date.now() < creds.expiresAt - 60_000) {
        jwtToken = creds.accessToken
      } else {
        const refreshed = await tryRefreshToken()
        if (refreshed) {
          jwtToken = refreshed
        }
      }
    }
    if (!apiKey && !jwtToken) {
      console.error('[skillsmith] No credentials found. Run `skillsmith login` to authenticate.')
    }
  }

  // SMI-1183: Initialize API client with configuration
  const apiClient = new SkillsmithApiClient({
    baseUrl: options.apiClientConfig?.baseUrl,
    anonKey: options.apiClientConfig?.anonKey,
    apiKey,
    jwtToken,
    timeout: options.apiClientConfig?.timeout ?? 10000,
    maxRetries: options.apiClientConfig?.maxRetries ?? 3,
    debug: options.apiClientConfig?.debug,
    offlineMode: options.apiClientConfig?.offlineMode,
  })

  // SMI-6362 (D-7): distinctId is now the PERSISTED, UNCONDITIONAL install id
  // (SMI-5531's getOrCreateInstallId(), wired in here for the first time —
  // it had zero call sites before this). The legacy behaviour generated a
  // FRESH crypto.randomUUID() per process, and only when
  // SKILLSMITH_TELEMETRY_ENABLED + POSTHOG_API_KEY were BOTH set — that env
  // gate is exactly what made the identifier inert for virtually every real
  // MCP client, and is why the consent-resolution rewrite (B-6,
  // middleware/telemetry-consent.ts) could never have found a matching
  // preference row even once the anon-key role/RLS issues were fixed
  // separately. Do not re-couple this to the telemetry/PostHog gate below —
  // consent resolution and the tool_call write path both need a stable id
  // regardless of whether PostHog forwarding is configured.
  const distinctId = getOrCreateInstallId()

  // SMI-6362 §1: install the tool_call identity provider. Fire-and-forget —
  // context creation must not block on a network round-trip (mirrors
  // initializePostHog below never being awaited either); until the first
  // refresh resolves, emitToolCallEvent sees `null` and skips
  // (skippedNoIdentity), self-healing once this completes. Refreshed again
  // on a 401 (`invalid_jwt`) via the invalidation handler, and on a 5-minute
  // timer — the three triggers the plan names.
  void refreshTelemetryIdentity(apiKey)
  setTelemetryIdentityProvider(() => cachedTelemetryIdentity)
  setTelemetryIdentityInvalidationHandler(() => {
    void refreshTelemetryIdentity(apiKey)
  })
  if (telemetryIdentityRefreshTimer) clearInterval(telemetryIdentityRefreshTimer)
  telemetryIdentityRefreshTimer = setInterval(
    () => void refreshTelemetryIdentity(apiKey),
    5 * 60 * 1000
  )
  telemetryIdentityRefreshTimer.unref?.()

  // SMI-1184: Initialize PostHog telemetry (opt-in, privacy first). This
  // gate is now ORTHOGONAL to distinctId's value — it only controls whether
  // the PostHog SDK itself gets initialized, not what id is used to resolve
  // consent or attribute a tool_call event.
  const telemetryEnabled =
    process.env.SKILLSMITH_TELEMETRY_ENABLED === 'true' || options.telemetryConfig?.enabled === true

  const postHogApiKey = process.env.POSTHOG_API_KEY || options.telemetryConfig?.postHogApiKey

  if (telemetryEnabled && postHogApiKey) {
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

  // SMI-5649: this factory no longer registers its own SIGTERM/SIGINT
  // handlers. That was the root cause of the shutdown race — a context
  // factory registering PROCESS-GLOBAL signal handlers on every context
  // creation meant two independent, unordered handler sets could both fire
  // on the same signal, racing a fire-and-forget `backgroundSync?.stop()`
  // against `index.ts`'s db close. Signal ownership now belongs solely to
  // `index.ts`'s single shutdown coordinator (`shutdown.ts`), which performs
  // this same cleanup (`quiesce` + `closeLlmFailover` hooks) in a defined
  // order. See docs/internal/implementation/mcp-shutdown-followup-hardening-wave-a-design.md
  // §Deliverable 4.

  return {
    db,
    searchService,
    skillRepository,
    coInstallRepository,
    skillDependencyRepository,
    sessionInstalledSkillIds: [],
    apiClient,
    distinctId,
    backgroundSync,
    llmFailover,
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
  // SMI-6362 §1: always cleared, even if asyncGlobalContext is already null —
  // refreshTelemetryIdentity/setInterval are installed unconditionally by
  // createToolContextAsync regardless of whether a test later resets the
  // context, so a stray interval must not survive a reset (test isolation:
  // an un-cleared timer keeps calling resolveFreshAccessToken() against a
  // torn-down test double in later, unrelated tests).
  if (telemetryIdentityRefreshTimer) {
    clearInterval(telemetryIdentityRefreshTimer)
    telemetryIdentityRefreshTimer = undefined
  }
  setTelemetryIdentityProvider(null)
  setTelemetryIdentityInvalidationHandler(null)
  cachedTelemetryIdentity = null

  if (asyncGlobalContext) {
    // Inline close to avoid circular import with context.ts
    const context = asyncGlobalContext
    asyncGlobalContext = null

    if (context.backgroundSync) {
      // SMI-5649: stop() is now awaitable (aborts + awaits any in-flight
      // sync) — was fire-and-forget.
      await context.backgroundSync.stop()
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
