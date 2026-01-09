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
  type ApiClientConfig,
} from '@skillsmith/core'

/**
 * Shared context for MCP tool handlers
 * SMI-1183: Added apiClient for live API access with local fallback
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

  return {
    db,
    searchService,
    skillRepository,
    apiClient,
  }
}

/**
 * Close the tool context and release resources
 *
 * @param context - Tool context to close
 */
export function closeToolContext(context: ToolContext): void {
  context.db.close()
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
 */
export function resetToolContext(): void {
  if (globalContext) {
    closeToolContext(globalContext)
    globalContext = null
  }
}
