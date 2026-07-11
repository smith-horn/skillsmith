/**
 * SMI-4694 (updated SMI-5649): Listener-count audit for context.async.ts
 * (Module 1).
 *
 * Prior to SMI-5649, `createToolContextAsync` registered its OWN
 * SIGTERM/SIGINT handlers whenever backgroundSync or llmFailover was enabled
 * — this test verified that registration was symmetric with
 * `closeToolContext`. SMI-5649 deleted that registration entirely: it was
 * the root cause of the shutdown race (two independent, unordered handler
 * sets could both fire on the same signal, racing a fire-and-forget
 * `backgroundSync?.stop()` against `index.ts`'s db close). Signal ownership
 * now belongs SOLELY to `index.ts`'s single shutdown coordinator
 * (`shutdown.ts`) — see
 * docs/internal/implementation/mcp-shutdown-followup-hardening-wave-a-design.md
 * §Deliverable 4.
 *
 * This test now asserts the NEW invariant: creating/closing a tool context
 * NEVER touches process-level SIGTERM/SIGINT listeners at all, even with
 * backgroundSync and llmFailover both enabled — that's exactly what makes
 * "exactly one registration site" (the coordinator) true.
 *
 * Reference pattern: packages/core/tests/api/client.events.test.ts:39-72
 */

import { describe, it, expect } from 'vitest'
import { SyncConfigRepository } from '@skillsmith/core'
import { createToolContextAsync } from '../src/context.async.js'
import { closeToolContext } from '../src/context.js'

describe('SMI-4694/SMI-5649: context.async.ts listener-count audit', () => {
  it('never registers SIGTERM/SIGINT listeners, even when sync + failover are enabled', async () => {
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
      // llmFailoverConfig.enabled === true, both services ARE created — but
      // post-SMI-5649, neither registers a process-level signal listener.
      const ctx = await createToolContextAsync({
        dbPath: ':memory:',
        apiClientConfig: { offlineMode: true },
        backgroundSyncConfig: { enabled: true },
        llmFailoverConfig: { enabled: true },
      })

      // Sanity: the services themselves must actually be constructed for
      // this audit to be meaningful (otherwise "no listeners" would be
      // trivially true because nothing was created).
      expect(ctx.backgroundSync).toBeDefined()
      expect(ctx.llmFailover).toBeDefined()

      const mid = {
        sigterm: process.listenerCount('SIGTERM'),
        sigint: process.listenerCount('SIGINT'),
      }
      expect(mid.sigterm).toBe(before.sigterm)
      expect(mid.sigint).toBe(before.sigint)

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
