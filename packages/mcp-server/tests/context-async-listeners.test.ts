/**
 * SMI-4694: Listener-count audit for context.async.ts (Module 1).
 *
 * Verifies that createToolContextAsync + closeToolContext is symmetric for
 * SIGTERM/SIGINT signal handlers, including when backgroundSync and
 * llmFailover paths are forced on (the only conditions that register
 * handlers — see context.async.ts:236-252).
 *
 * Reference pattern: packages/core/tests/api/client.events.test.ts:39-72
 */

import { describe, it, expect } from 'vitest'
import { SyncConfigRepository } from '@skillsmith/core'
import { createToolContextAsync } from '../src/context.async.js'
import { closeToolContext } from '../src/context.js'

describe('SMI-4694: context.async.ts listener-count audit', () => {
  it('does NOT leak SIGTERM/SIGINT listeners when sync + failover are enabled', async () => {
    const before = {
      sigterm: process.listenerCount('SIGTERM'),
      sigint: process.listenerCount('SIGINT'),
    }

    for (let i = 0; i < 5; i++) {
      // Probe: confirm SyncConfigRepository.enable() does not throw on a
      // fresh in-memory DB. This is a guard against repository signature
      // drift — if the API changes, this audit fails fast.
      const probe = await createToolContextAsync({
        dbPath: ':memory:',
        apiClientConfig: { offlineMode: true },
        backgroundSyncConfig: { enabled: false },
      })
      const repo = new SyncConfigRepository(probe.db)
      repo.enable()
      await closeToolContext(probe)

      // The actual cycle: backgroundSync gates on
      // (env !== 'false' && config.enabled !== false) AND
      // syncConfig.enabled returning true. Fresh DB defaults syncConfig.enabled
      // to TRUE (SyncConfigRepository.ts:96 — 'enabled INTEGER NOT NULL
      // DEFAULT 1'). With backgroundSyncConfig.enabled !== false AND
      // llmFailoverConfig.enabled === true, both branches register handlers.
      const ctx = await createToolContextAsync({
        dbPath: ':memory:',
        apiClientConfig: { offlineMode: true },
        backgroundSyncConfig: { enabled: true },
        llmFailoverConfig: { enabled: true },
      })

      // Sanity: handlers must be registered for the audit to be meaningful.
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
})
