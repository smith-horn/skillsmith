/**
 * SMI-4694 (updated SMI-5649): Listener-count audit for the tool-context
 * factories (Module 2).
 *
 * Prior to SMI-5649, the tool-context factories registered their OWN
 * SIGTERM/SIGINT handlers whenever backgroundSync or llmFailover was
 * enabled — this test verified that registration was symmetric with
 * `closeToolContext`/`disposeTestContext`. SMI-5649 deleted that
 * registration entirely (both the async factory AND its sync sibling,
 * `createToolContext` in context.ts — the sync sibling's identical latent
 * bug found during the Wave A design pass): it was the root cause of the
 * shutdown race (two independent, unordered handler sets could both fire on
 * the same signal, racing a fire-and-forget `backgroundSync?.stop()`
 * against `index.ts`'s db close). Signal ownership now belongs SOLELY to
 * `index.ts`'s single shutdown coordinator (`shutdown.ts`) — see
 * docs/internal/implementation/mcp-shutdown-followup-hardening-wave-a-design.md
 * §Deliverable 4.
 *
 * These tests now assert the NEW invariant: creating/closing/disposing a
 * tool context NEVER touches process-level SIGTERM/SIGINT listeners at all,
 * even with backgroundSync and llmFailover both enabled.
 *
 * Reference pattern: packages/core/tests/api/client.events.test.ts:39-72
 */

import { describe, it, expect } from 'vitest'
import { SyncConfigRepository } from '@skillsmith/core'
import { closeToolContext, createToolContextAsync } from '../context.js'
import { createTestContext, disposeTestContext } from './test-utils.js'

describe('SMI-4694/SMI-5649: context.ts listener-count audit', () => {
  it('never registers SIGTERM/SIGINT listeners, even when sync + failover are enabled', async () => {
    const before = {
      sigterm: process.listenerCount('SIGTERM'),
      sigint: process.listenerCount('SIGINT'),
    }

    for (let i = 0; i < 5; i++) {
      // Bootstrap: create a context just so we can flip the syncConfig flag
      // on its in-memory DB, then close it. The "real" cycle below uses a
      // fresh DB whose SyncConfigRepository.enable() runs against a NEW
      // in-memory DB inline. Forcing this requires per-cycle bootstrap
      // because :memory: DBs do not persist between createToolContextAsync calls.
      // SMI-4756: Use createToolContextAsync for WASM fallback in post-merge-verify CI.
      const seed = await createToolContextAsync({
        dbPath: ':memory:',
        apiClientConfig: { offlineMode: true },
        backgroundSyncConfig: { enabled: false },
      })
      const repo = new SyncConfigRepository(seed.db)
      repo.enable()
      await closeToolContext(seed)

      // Note: createToolContextAsync re-creates the DB; the seed above is mostly
      // a sanity probe that SyncConfigRepository.enable() does not throw.
      // Service construction is gated on syncConfig.enabled returning true,
      // which is the default for fresh DBs created with ensureTable() — see
      // SyncConfigRepository.ts:174 ('enabled BOOLEAN DEFAULT 1'). With
      // backgroundSyncConfig.enabled !== false AND llmFailoverConfig.enabled
      // === true, both services ARE created — but post-SMI-5649, neither
      // registers a process-level signal listener.
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

  it('disposeTestContext is symmetric with createTestContext (no listeners registered or leaked)', async () => {
    const before = {
      sigterm: process.listenerCount('SIGTERM'),
      sigint: process.listenerCount('SIGINT'),
    }

    for (let i = 0; i < 5; i++) {
      const ctx = await createTestContext()
      await disposeTestContext(ctx)
    }

    const after = {
      sigterm: process.listenerCount('SIGTERM'),
      sigint: process.listenerCount('SIGINT'),
    }

    // createTestContext uses offline mode; backgroundSync default is on and
    // syncConfig.enabled defaults to TRUE (DB schema default), so the
    // service IS constructed — but post-SMI-5649 it no longer registers a
    // process-level signal listener. disposeTestContext still must not leak
    // (trivially true now, but kept as a regression guard).
    expect(after.sigterm).toBe(before.sigterm)
    expect(after.sigint).toBe(before.sigint)
  })
})
