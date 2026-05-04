/**
 * SMI-4694: Listener-count audit for context.ts (Module 2).
 *
 * Verifies that createToolContext + closeToolContext is symmetric for
 * SIGTERM/SIGINT signal handlers, including when backgroundSync and
 * llmFailover paths are forced on (the only conditions that register
 * handlers — see context.ts:244-260).
 *
 * Reference pattern: packages/core/tests/api/client.events.test.ts:39-72
 */

import { describe, it, expect } from 'vitest'
import { SyncConfigRepository } from '@skillsmith/core'
import { createToolContext, closeToolContext } from '../context.js'
import { createTestContext, disposeTestContext } from './test-utils.js'

describe('SMI-4694: context.ts listener-count audit', () => {
  it('does NOT leak SIGTERM/SIGINT listeners when sync + failover are enabled', async () => {
    const before = {
      sigterm: process.listenerCount('SIGTERM'),
      sigint: process.listenerCount('SIGINT'),
    }

    for (let i = 0; i < 5; i++) {
      // Bootstrap: create a context just so we can flip the syncConfig flag
      // on its in-memory DB, then close it. The "real" cycle below uses a
      // fresh DB whose SyncConfigRepository.enable() runs against a NEW
      // in-memory DB inline. Forcing this requires per-cycle bootstrap
      // because :memory: DBs do not persist between createToolContext calls.
      const seed = createToolContext({
        dbPath: ':memory:',
        apiClientConfig: { offlineMode: true },
        backgroundSyncConfig: { enabled: false },
      })
      const repo = new SyncConfigRepository(seed.db)
      repo.enable()
      await closeToolContext(seed)

      // Note: createToolContext re-creates the DB; the seed above is mostly
      // a sanity probe that SyncConfigRepository.enable() does not throw.
      // The actual handler registration is gated on syncConfig.enabled
      // returning true, which is the default for fresh DBs created with
      // ensureTable() — see SyncConfigRepository.ts:174 ('enabled BOOLEAN
      // DEFAULT 1'). With backgroundSyncConfig.enabled !== false AND
      // llmFailoverConfig.enabled === true, both branches register handlers.
      const ctx = createToolContext({
        dbPath: ':memory:',
        apiClientConfig: { offlineMode: true },
        backgroundSyncConfig: { enabled: true },
        llmFailoverConfig: { enabled: true },
      })

      // Sanity: at least one handler must be registered for the audit to
      // be meaningful — otherwise the test passes trivially even if dispose
      // is broken.
      const mid = {
        sigterm: process.listenerCount('SIGTERM'),
        sigint: process.listenerCount('SIGINT'),
      }
      expect(mid.sigterm).toBeGreaterThan(before.sigterm)
      expect(mid.sigint).toBeGreaterThan(before.sigint)

      await closeToolContext(ctx)
    }

    const after = {
      sigterm: process.listenerCount('SIGTERM'),
      sigint: process.listenerCount('SIGINT'),
    }

    expect(after.sigterm).toBe(before.sigterm)
    expect(after.sigint).toBe(before.sigint)
  })

  it('disposeTestContext is symmetric with createTestContext', async () => {
    const before = {
      sigterm: process.listenerCount('SIGTERM'),
      sigint: process.listenerCount('SIGINT'),
    }

    for (let i = 0; i < 5; i++) {
      const ctx = createTestContext()
      await disposeTestContext(ctx)
    }

    const after = {
      sigterm: process.listenerCount('SIGTERM'),
      sigint: process.listenerCount('SIGINT'),
    }

    // createTestContext uses offline mode; backgroundSync default is on but
    // syncConfig.enabled defaults to TRUE (DB schema default), so handlers
    // ARE registered. disposeTestContext must remove them symmetrically.
    expect(after.sigterm).toBe(before.sigterm)
    expect(after.sigint).toBe(before.sigint)
  })
})
