/**
 * @fileoverview Test helper re-exports for cross-package test use
 * @module @skillsmith/core/testkit
 * @see SMI-3218
 *
 * Re-exports database test helpers so sibling packages (CLI, mcp-server)
 * can import via `@skillsmith/core/testkit` instead of relative paths.
 *
 * Boundary: This subpath is for database test setup (createTestDatabase,
 * closeDatabase). For MultiLLMProvider test utilities, use
 * `@skillsmith/core/testing`.
 */

export { createTestDatabase, closeDatabase } from './helpers/database.js'
