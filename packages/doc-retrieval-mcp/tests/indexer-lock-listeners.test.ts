/**
 * SMI-4694: Listener-count audit for indexer-lock.
 *
 * Verifies that acquire/release cycles with `registerHandlers: true` do NOT
 * leak SIGINT/SIGTERM/uncaughtException handlers. process.once() self-removes
 * only when the handler fires; happy-path release must explicitly detach the
 * still-pending listeners.
 *
 * Reference pattern: packages/core/tests/api/client.events.test.ts:39-72
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireIndexerLock } from '../src/indexer-lock.js'

describe('SMI-4694: indexer-lock listener-count audit', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'indexer-lock-listeners-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('does NOT leak SIGINT/SIGTERM/uncaughtException listeners across acquire/release cycles', async () => {
    const before = {
      sigint: process.listenerCount('SIGINT'),
      sigterm: process.listenerCount('SIGTERM'),
      uncaught: process.listenerCount('uncaughtException'),
    }

    for (let i = 0; i < 5; i++) {
      const release = await acquireIndexerLock(dir, { registerHandlers: true })
      release()
    }

    const after = {
      sigint: process.listenerCount('SIGINT'),
      sigterm: process.listenerCount('SIGTERM'),
      uncaught: process.listenerCount('uncaughtException'),
    }

    expect(after.sigint).toBe(before.sigint)
    expect(after.sigterm).toBe(before.sigterm)
    expect(after.uncaught).toBe(before.uncaught)
  })

  it('release() is idempotent and does not double-remove listeners', async () => {
    const before = {
      sigint: process.listenerCount('SIGINT'),
      sigterm: process.listenerCount('SIGTERM'),
      uncaught: process.listenerCount('uncaughtException'),
    }

    const release = await acquireIndexerLock(dir, { registerHandlers: true })
    release()
    release()
    release()

    const after = {
      sigint: process.listenerCount('SIGINT'),
      sigterm: process.listenerCount('SIGTERM'),
      uncaught: process.listenerCount('uncaughtException'),
    }

    expect(after.sigint).toBe(before.sigint)
    expect(after.sigterm).toBe(before.sigterm)
    expect(after.uncaught).toBe(before.uncaught)
  })
})
