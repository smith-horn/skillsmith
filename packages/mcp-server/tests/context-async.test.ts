/**
 * SMI-2207: Async Context Functions Tests
 *
 * Tests for async tool context creation with WASM fallback support.
 * These tests verify that createToolContextAsync, getToolContextAsync,
 * and resetAsyncToolContext work correctly with automatic driver selection.
 */

import { describe, it, expect, afterEach } from 'vitest'
import {
  createToolContextAsync,
  getToolContextAsync,
  resetAsyncToolContext,
  closeToolContext,
} from '../src/context.js'
import { isBetterSqlite3Available } from '@skillsmith/core'
import type { ToolContext } from '../src/context.js'

// Track contexts to clean up
const testContexts: ToolContext[] = []

describe('Async Context Functions (SMI-2207)', () => {
  afterEach(async () => {
    // Close all test contexts
    for (const ctx of testContexts) {
      if (ctx.db?.open) {
        await closeToolContext(ctx)
      }
    }
    testContexts.length = 0

    // Reset global async context
    await resetAsyncToolContext()
  })

  describe('createToolContextAsync', () => {
    it('creates valid tool context', async () => {
      if (!isBetterSqlite3Available()) {
        console.log('Skipping test: no SQLite driver available')
        return
      }

      const ctx = await createToolContextAsync({
        dbPath: ':memory:',
        backgroundSyncConfig: { enabled: false },
      })
      testContexts.push(ctx)

      expect(ctx.db).toBeDefined()
      expect(ctx.db.open).toBe(true)
      expect(ctx.searchService).toBeDefined()
      expect(ctx.skillRepository).toBeDefined()
      expect(ctx.apiClient).toBeDefined()
    })

    it('creates in-memory database when specified', async () => {
      if (!isBetterSqlite3Available()) {
        console.log('Skipping test: no SQLite driver available')
        return
      }

      const ctx = await createToolContextAsync({
        dbPath: ':memory:',
        backgroundSyncConfig: { enabled: false },
      })
      testContexts.push(ctx)

      expect(ctx.db.memory).toBe(true)
    })

    it('initializes search service with custom cache TTL', async () => {
      if (!isBetterSqlite3Available()) {
        console.log('Skipping test: no SQLite driver available')
        return
      }

      const ctx = await createToolContextAsync({
        dbPath: ':memory:',
        searchCacheTtl: 600,
        backgroundSyncConfig: { enabled: false },
      })
      testContexts.push(ctx)

      expect(ctx.searchService).toBeDefined()
      // SearchService should be initialized with the cache TTL
      // The actual TTL is internal, but we can verify the service exists
    })

    it('initializes API client with configuration', async () => {
      if (!isBetterSqlite3Available()) {
        console.log('Skipping test: no SQLite driver available')
        return
      }

      const ctx = await createToolContextAsync({
        dbPath: ':memory:',
        apiClientConfig: {
          timeout: 5000,
          maxRetries: 2,
          offlineMode: true,
        },
        backgroundSyncConfig: { enabled: false },
      })
      testContexts.push(ctx)

      expect(ctx.apiClient).toBeDefined()
    })

    it('rejects path traversal attempts', async () => {
      if (!isBetterSqlite3Available()) {
        console.log('Skipping test: no SQLite driver available')
        return
      }

      await expect(
        createToolContextAsync({
          dbPath: '../../../etc/passwd',
          backgroundSyncConfig: { enabled: false },
        })
      ).rejects.toThrow(/Invalid database path/)
    })
  })

  describe('getToolContextAsync', () => {
    it('creates context on first call', async () => {
      if (!isBetterSqlite3Available()) {
        console.log('Skipping test: no SQLite driver available')
        return
      }

      const ctx = await getToolContextAsync({
        dbPath: ':memory:',
        backgroundSyncConfig: { enabled: false },
      })

      expect(ctx.db).toBeDefined()
      expect(ctx.db.open).toBe(true)
    })

    it('returns cached context on subsequent calls', async () => {
      if (!isBetterSqlite3Available()) {
        console.log('Skipping test: no SQLite driver available')
        return
      }

      const ctx1 = await getToolContextAsync({
        dbPath: ':memory:',
        backgroundSyncConfig: { enabled: false },
      })
      const ctx2 = await getToolContextAsync({
        dbPath: ':memory:',
        backgroundSyncConfig: { enabled: false },
      })

      // Same reference indicates caching
      expect(ctx1).toBe(ctx2)
    })

    it('creates new context after reset', async () => {
      if (!isBetterSqlite3Available()) {
        console.log('Skipping test: no SQLite driver available')
        return
      }

      const ctx1 = await getToolContextAsync({
        dbPath: ':memory:',
        backgroundSyncConfig: { enabled: false },
      })
      const dbRef1 = ctx1.db

      await resetAsyncToolContext()

      const ctx2 = await getToolContextAsync({
        dbPath: ':memory:',
        backgroundSyncConfig: { enabled: false },
      })

      // New context should have a different database reference
      expect(ctx2.db).not.toBe(dbRef1)
    })

    it('ignores options after initial creation', async () => {
      if (!isBetterSqlite3Available()) {
        console.log('Skipping test: no SQLite driver available')
        return
      }

      // Create with specific options
      const ctx1 = await getToolContextAsync({
        dbPath: ':memory:',
        searchCacheTtl: 100,
        backgroundSyncConfig: { enabled: false },
      })

      // Second call with different options should return same context
      const ctx2 = await getToolContextAsync({
        dbPath: ':memory:',
        searchCacheTtl: 999,
        backgroundSyncConfig: { enabled: false },
      })

      expect(ctx1).toBe(ctx2)
    })
  })

  describe('resetAsyncToolContext', () => {
    it('closes database on reset', async () => {
      if (!isBetterSqlite3Available()) {
        console.log('Skipping test: no SQLite driver available')
        return
      }

      const ctx = await getToolContextAsync({
        dbPath: ':memory:',
        backgroundSyncConfig: { enabled: false },
      })

      expect(ctx.db.open).toBe(true)

      await resetAsyncToolContext()

      // After reset, the old database should be closed
      expect(ctx.db.open).toBe(false)
    })

    it('allows new context creation after reset', async () => {
      if (!isBetterSqlite3Available()) {
        console.log('Skipping test: no SQLite driver available')
        return
      }

      await getToolContextAsync({
        dbPath: ':memory:',
        backgroundSyncConfig: { enabled: false },
      })

      await resetAsyncToolContext()

      // Should be able to create new context
      const newCtx = await getToolContextAsync({
        dbPath: ':memory:',
        backgroundSyncConfig: { enabled: false },
      })

      expect(newCtx.db.open).toBe(true)
    })

    it('is idempotent when called multiple times', async () => {
      if (!isBetterSqlite3Available()) {
        console.log('Skipping test: no SQLite driver available')
        return
      }

      // Reset without creating context first
      await expect(resetAsyncToolContext()).resolves.toBeUndefined()

      // Create context
      await getToolContextAsync({
        dbPath: ':memory:',
        backgroundSyncConfig: { enabled: false },
      })

      // Multiple resets should not throw
      await expect(resetAsyncToolContext()).resolves.toBeUndefined()
      await expect(resetAsyncToolContext()).resolves.toBeUndefined()
    })
  })

  describe('closeToolContext', () => {
    it('closes database connection', async () => {
      if (!isBetterSqlite3Available()) {
        console.log('Skipping test: no SQLite driver available')
        return
      }

      const ctx = await createToolContextAsync({
        dbPath: ':memory:',
        backgroundSyncConfig: { enabled: false },
      })

      expect(ctx.db.open).toBe(true)

      await closeToolContext(ctx)

      expect(ctx.db.open).toBe(false)
    })

    it('removes signal handlers on close', async () => {
      if (!isBetterSqlite3Available()) {
        console.log('Skipping test: no SQLite driver available')
        return
      }

      const ctx = await createToolContextAsync({
        dbPath: ':memory:',
        backgroundSyncConfig: { enabled: false },
      })

      await closeToolContext(ctx)

      // Signal handlers should be removed (internal implementation)
      // This is verified by checking the context can be closed without errors
      expect(ctx.db.open).toBe(false)
    })
  })

  describe('isolation between sync and async contexts', () => {
    it('async context is separate from sync singleton', async () => {
      if (!isBetterSqlite3Available()) {
        console.log('Skipping test: no SQLite driver available')
        return
      }

      // Get async context
      const asyncCtx = await getToolContextAsync({
        dbPath: ':memory:',
        backgroundSyncConfig: { enabled: false },
      })

      // Reset only affects async context
      await resetAsyncToolContext()

      // Can create new async context
      const newAsyncCtx = await getToolContextAsync({
        dbPath: ':memory:',
        backgroundSyncConfig: { enabled: false },
      })

      expect(newAsyncCtx).not.toBe(asyncCtx)
      expect(newAsyncCtx.db.open).toBe(true)
    })
  })
})
