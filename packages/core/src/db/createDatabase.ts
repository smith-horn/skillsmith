/**
 * SMI-2180: Database Factory with Auto-Detection
 *
 * Creates database connections with automatic driver selection:
 * 1. Try native better-sqlite3 first (fastest, requires native module)
 * 2. Fall back to sql.js WASM (cross-platform, no native compilation)
 *
 * This enables the MCP server to work on any platform without Docker.
 *
 * @example
 * ```typescript
 * // Auto-detect best driver
 * const db = await createDatabaseAsync('~/.skillsmith/skills.db')
 *
 * // Force specific driver
 * const db = createDatabaseSync(path)  // better-sqlite3 only
 * ```
 */

import type { Database, DatabaseOptions } from './database-interface.js'
import {
  createBetterSqlite3Database,
  isBetterSqlite3Available,
} from './drivers/betterSqlite3Driver.js'
import { createSqlJsDatabase, isSqlJsAvailable } from './drivers/sqljsDriver.js'

/**
 * Driver type used for database connections
 */
export type DriverType = 'better-sqlite3' | 'sql.js'

/**
 * Result of driver detection
 */
export interface DriverInfo {
  type: DriverType
  available: boolean
  reason?: string
}

/**
 * Detect which database drivers are available
 * @returns Array of driver info objects
 */
export function detectAvailableDrivers(): DriverInfo[] {
  const drivers: DriverInfo[] = []

  // Check better-sqlite3
  if (isBetterSqlite3Available()) {
    drivers.push({ type: 'better-sqlite3', available: true })
  } else {
    drivers.push({
      type: 'better-sqlite3',
      available: false,
      reason: 'Native module not available (binary incompatibility or not installed)',
    })
  }

  // Check sql.js (WASM - always available in Node.js)
  if (isSqlJsAvailable()) {
    drivers.push({ type: 'sql.js', available: true })
  } else {
    drivers.push({
      type: 'sql.js',
      available: false,
      reason: 'sql.js package not installed',
    })
  }

  return drivers
}

/**
 * Get the best available driver type
 * @returns The driver type to use, or null if none available
 */
export function getBestDriver(): DriverType | null {
  // Prefer native for performance
  if (isBetterSqlite3Available()) {
    return 'better-sqlite3'
  }

  // Fall back to sql.js WASM
  if (isSqlJsAvailable()) {
    return 'sql.js'
  }

  return null
}

/**
 * Create a database connection synchronously using better-sqlite3
 *
 * Use this when you know native modules are available (e.g., in Docker).
 * For cross-platform code, use createDatabaseAsync instead.
 *
 * @param path - Path to database file, or ':memory:' for in-memory
 * @param options - Database connection options
 * @returns Database instance
 * @throws Error if better-sqlite3 is not available
 */
export function createDatabaseSync(path: string = ':memory:', options?: DatabaseOptions): Database {
  if (!isBetterSqlite3Available()) {
    throw new Error(
      '[Skillsmith] Native SQLite module (better-sqlite3) is not available. ' +
        'This may be due to:\n' +
        '  - Binary compiled for a different platform (Linux vs macOS)\n' +
        '  - Node.js version mismatch\n' +
        '  - Missing native build tools\n\n' +
        'Solutions:\n' +
        '  - Run in Docker: docker compose --profile dev up -d\n' +
        '  - Rebuild native module: npm rebuild better-sqlite3\n' +
        '  - Use createDatabaseAsync() for automatic WASM fallback'
    )
  }

  return createBetterSqlite3Database(path, options)
}

/**
 * Create a database connection with automatic driver selection
 *
 * This is the recommended way to create database connections for
 * cross-platform compatibility. It will:
 * 1. Try better-sqlite3 native module first (fastest)
 * 2. Fall back to sql.js WASM if native is unavailable
 *
 * @param path - Path to database file, or ':memory:' for in-memory
 * @param options - Database connection options
 * @returns Promise resolving to Database instance
 * @throws Error if no database driver is available
 */
export async function createDatabaseAsync(
  path: string = ':memory:',
  options?: DatabaseOptions
): Promise<Database> {
  // Try native first
  if (isBetterSqlite3Available()) {
    return createBetterSqlite3Database(path, options)
  }

  // Fall back to sql.js WASM
  if (isSqlJsAvailable()) {
    console.warn('[Skillsmith] Native SQLite unavailable, using WASM driver')
    return await createSqlJsDatabase(path, options)
  }

  throw new Error(
    '[Skillsmith] No SQLite driver available.\n\n' +
      'Neither better-sqlite3 (native) nor sql.js (WASM) could be loaded.\n\n' +
      'Solutions:\n' +
      '  - Run in Docker: docker compose --profile dev up -d\n' +
      '  - Rebuild native module: npm rebuild better-sqlite3\n' +
      '  - Install sql.js: npm install sql.js'
  )
}

/**
 * @deprecated Use createDatabaseAsync() instead for cross-platform support.
 *
 * createDatabase() only works with native better-sqlite3 and will fail on
 * platforms where native modules aren't available (e.g., macOS without Docker).
 *
 * Migration:
 * ```typescript
 * // Before (synchronous, native only)
 * const db = createDatabase(path)
 *
 * // After (async, with automatic WASM fallback)
 * const db = await createDatabaseAsync(path)
 * ```
 *
 * This alias is maintained for backward compatibility with existing code.
 */
export const createDatabase = createDatabaseSync
