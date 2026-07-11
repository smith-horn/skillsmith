/**
 * SMI-5649: BackgroundSyncService — abort + awaitable stop(), and the new
 * logs-by-default onSyncError.
 *
 * Split from BackgroundSyncService.test.ts to stay under the 500-LOC
 * file-size gate. Reuses that file's mock factories (createMockSyncEngine,
 * createMockConfigRepo, createMockSyncResult — exported there for this
 * purpose).
 *
 * The shutdown coordinator relies on `stop()` resolving only once any
 * in-flight sync has settled, and on the `AbortSignal` it threads into
 * `syncEngine.sync()` actually being aborted synchronously by `stop()` (so
 * `SyncEngine`'s abort checkpoints see it before the process ever gets to
 * `db.close()`).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SyncEngine, SyncResult } from '../../src/sync/SyncEngine.js'

// SMI-5649: BackgroundSyncService.ts builds its default `onSyncError` logger
// via `createLogger('mcp')` (`../logging/index.js`, relative from
// `packages/core/src/sync/`) ONCE at module load, so asserting what it logs
// requires mocking the factory before the module under test is imported.
// `vi.mock` is hoisted above all imports (including the one below), so this
// works regardless of declaration order. Mirrors the identical pattern in
// `packages/mcp-server/src/shutdown.test.ts`.
const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}))

vi.mock('../../src/logging/index.js', () => ({
  createLogger: vi.fn(() => mockLogger),
}))

import { BackgroundSyncService } from '../../src/sync/BackgroundSyncService.js'
import {
  createMockSyncResult,
  createMockSyncEngine,
  createMockConfigRepo,
} from './BackgroundSyncService.test.js'

/**
 * SMI-5649: abort + awaitable stop(). The shutdown coordinator relies on
 * `stop()` resolving only once any in-flight sync has settled, and on the
 * `AbortSignal` it threads into `syncEngine.sync()` actually being aborted
 * synchronously by `stop()` (so `SyncEngine`'s abort checkpoints see it
 * before the process ever gets to `db.close()`).
 */
describe('stop() — abort + awaitable settlement (SMI-5649)', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })
  afterEach(() => {
    vi.useFakeTimers()
  })

  it('passes an AbortSignal into syncEngine.sync()', async () => {
    // start() is what creates the abortController (design doc §2.2) — the
    // production path always calls start() before any sync can occur
    // (createToolContextAsync calls `backgroundSync.start()` immediately
    // after construction), so tests exercising the abort-signal plumbing
    // must too.
    const engine = createMockSyncEngine()
    const service = new BackgroundSyncService(engine, createMockConfigRepo(), {
      syncOnStart: false,
    })
    service.start()

    await service.manualSync()

    expect(engine.sync).toHaveBeenCalledWith(
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    await service.stop()
  })

  it('stop() returns a Promise and resolves only after an in-flight sync settles', async () => {
    let resolveSync!: () => void
    const engine = {
      sync: vi.fn().mockReturnValue(
        new Promise<SyncResult>((resolve) => {
          resolveSync = () => resolve(createMockSyncResult())
        })
      ),
    } as unknown as SyncEngine

    const service = new BackgroundSyncService(engine, createMockConfigRepo(), {
      syncOnStart: false,
    })
    service.start()

    const inFlight = service.manualSync()
    let stopSettled = false
    const stopPromise = service.stop().then(() => {
      stopSettled = true
    })

    // Give the microtask queue a chance to run — stop() must NOT resolve
    // while the sync is still pending.
    await new Promise((resolve) => setImmediate(resolve))
    expect(stopSettled).toBe(false)

    resolveSync()
    await stopPromise
    expect(stopSettled).toBe(true)

    await inFlight.catch(() => {})
  })

  it("aborts the in-flight sync's AbortSignal when stop() is called", async () => {
    let capturedSignal: AbortSignal | undefined
    let resolveSync!: () => void
    const engine = {
      sync: vi.fn().mockImplementation(({ signal }: { signal?: AbortSignal }) => {
        capturedSignal = signal
        return new Promise<SyncResult>((resolve) => {
          resolveSync = () => resolve(createMockSyncResult())
        })
      }),
    } as unknown as SyncEngine

    const service = new BackgroundSyncService(engine, createMockConfigRepo(), {
      syncOnStart: false,
    })
    service.start()

    const inFlight = service.manualSync()
    expect(capturedSignal?.aborted).toBe(false)

    const stopPromise = service.stop()
    expect(capturedSignal?.aborted).toBe(true)

    resolveSync()
    await stopPromise
    await inFlight.catch(() => {})
  })

  it('stop() still clears the timer and flips isStarted synchronously for non-awaiting callers', () => {
    vi.useFakeTimers()
    const service = new BackgroundSyncService(createMockSyncEngine(), createMockConfigRepo(), {
      syncOnStart: false,
    })

    service.start()
    expect(service.isServiceStarted()).toBe(true)

    // Fire-and-forget — the original callers of stop() never awaited it.
    void service.stop()
    expect(service.isServiceStarted()).toBe(false)
    vi.useRealTimers()
  })

  it('stop() resolves cleanly (no unhandled rejection) even when the in-flight sync rejects', async () => {
    let rejectSync!: (err: Error) => void
    const engine = {
      sync: vi.fn().mockReturnValue(
        new Promise<SyncResult>((_resolve, reject) => {
          rejectSync = reject
        })
      ),
    } as unknown as SyncEngine

    const service = new BackgroundSyncService(engine, createMockConfigRepo(), {
      syncOnStart: false,
      onSyncError: () => {},
    })

    const inFlight = service.manualSync().catch(() => {})
    const stopPromise = service.stop()

    rejectSync(new Error('network exploded'))

    await expect(stopPromise).resolves.toBeUndefined()
    await inFlight
  })
})

/**
 * SMI-5649: sync errors were previously invisible by default (a no-op
 * `onSyncError`) — this asserts the new default logs via the shared
 * logger at error level, mirroring `closeDbOnShutdown`'s SMI-5615
 * stderr-visibility rationale.
 */
describe('default onSyncError logs by default (SMI-5649)', () => {
  beforeEach(() => {
    vi.useRealTimers()
    mockLogger.error.mockClear()
  })
  afterEach(() => {
    vi.useFakeTimers()
  })

  it('logs via logger.error when no onSyncError override is provided', async () => {
    const engine = {
      sync: vi.fn().mockRejectedValue(new Error('Network timeout')),
    } as unknown as SyncEngine

    const service = new BackgroundSyncService(engine, createMockConfigRepo(), {
      syncOnStart: false,
    })

    await service.manualSync().catch(() => {})

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('Background sync failed'),
      expect.objectContaining({ err: expect.any(Error) })
    )
  })

  it('does not log via the default when a caller-provided onSyncError override is given', async () => {
    const onError = vi.fn()
    const engine = {
      sync: vi.fn().mockRejectedValue(new Error('Network timeout')),
    } as unknown as SyncEngine

    const service = new BackgroundSyncService(engine, createMockConfigRepo(), {
      syncOnStart: false,
      onSyncError: onError,
    })

    await service.manualSync().catch(() => {})

    expect(onError).toHaveBeenCalled()
    expect(mockLogger.error).not.toHaveBeenCalled()
  })
})
