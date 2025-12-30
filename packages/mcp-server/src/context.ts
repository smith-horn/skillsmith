/**
 * @fileoverview MCP Server Tool Context - Database initialization and shared services
 * @module @skillsmith/mcp-server/context
 * @see SMI-792: Add database initialization to MCP server
 *
 * Provides shared context for MCP tool handlers including:
 * - SQLite database connection with FTS5 search
 * - SearchService for skill discovery
 * - SkillRepository for CRUD operations
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
import { createDatabase, SearchService, SkillRepository } from '@skillsmith/core'

/**
 * Shared context for MCP tool handlers
 */
export interface ToolContext {
  /** SQLite database connection */
  db: DatabaseType
  /** Search service with FTS5/BM25 */
  searchService: SearchService
  /** Skill repository for CRUD operations */
  skillRepository: SkillRepository
}

/**
 * Options for creating tool context
 */
export interface ToolContextOptions {
  /** Custom database path (defaults to ~/.skillsmith/skills.db) */
  dbPath?: string
  /** Search cache TTL in seconds (default: 300) */
  searchCacheTtl?: number
}

/**
 * Get the default database path
 * Respects SKILLSMITH_DB_PATH environment variable
 */
export function getDefaultDbPath(): string {
  if (process.env.SKILLSMITH_DB_PATH) {
    return process.env.SKILLSMITH_DB_PATH
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
 * @example
 * // With default path (~/.skillsmith/skills.db)
 * const context = createToolContext();
 *
 * @example
 * // With custom path
 * const context = createToolContext({ dbPath: '/custom/path/skills.db' });
 *
 * @example
 * // For testing with in-memory database
 * const context = createToolContext({ dbPath: ':memory:' });
 */
export function createToolContext(options: ToolContextOptions = {}): ToolContext {
  const dbPath = options.dbPath ?? getDefaultDbPath()

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

  return {
    db,
    searchService,
    skillRepository,
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
