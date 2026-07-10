/**
 * @fileoverview Tests for flush-on-shutdown wiring (SMI-5479 Step 3, pass 2).
 *
 * `shutdown.ts` has no top-level side effects (unlike `index.ts`, which runs
 * `main().catch(...)` at module scope), so it can be imported directly.
 *
 * Observation seam: same as `call-tool-handler.test.ts` /
 * `middleware/__tests__/license.gate.test.ts`'s T2 block — a real PostHog
 * client with a test key, `shutdownPostHog` spied directly (not the
 * `capture` method here — this suite tests the shutdown TIMING contract, not
 * emission).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { initializePostHog, shutdownPostHog, isPostHogEnabled } from '@skillsmith/core/telemetry'
import type { DatabaseType } from '@skillsmith/core'
import {
  flushTelemetryOnShutdown,
  createShutdownTrigger,
  closeDbOnShutdown,
  _resetShutdownGuardForTests,
  TELEMETRY_SHUTDOWN_FLUSH_TIMEOUT_MS,
} from './shutdown.js'

// SMI-5639: `shutdown.ts` builds its `logger` via `createLogger('mcp')` ONCE at
// module load (`const logger = createLogger('mcp')`), so the only way to
// assert what it logged is to mock the factory itself before `./shutdown.js`
// is imported. `vi.mock` is hoisted above ALL imports in this file (including
// the one above), so this works regardless of where it's declared textually.
// `vi.hoisted` gives the factory a stable object the tests below can also
// reference directly.
const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}))

vi.mock('@skillsmith/core/logging', () => ({
  createLogger: vi.fn(() => mockLogger),
}))

/**
 * Minimal mutable mock matching the slice of the `Database` interface
 * `closeDbOnShutdown` actually touches (`open`, `close`). `open` is a plain
 * mutable property (not a getter) so idempotency tests can flip it inside a
 * `close()` mock the same way the real WASM/native drivers flip their own
 * internal `_open` flag.
 */
interface MockDb {
  open: boolean
  close: ReturnType<typeof vi.fn>
}

function createMockDb(open = true): MockDb {
  return { open, close: vi.fn() }
}

describe('flushTelemetryOnShutdown (SMI-5479)', () => {
  beforeEach(() => {
    _resetShutdownGuardForTests()
    initializePostHog({ apiKey: 'phc_test_key_smi_5479_shutdown' })
  })

  afterEach(async () => {
    // shutdownPostHog is frequently already-called by the test itself; a
    // second call is a safe no-op (posthogInstance is null after the first).
    await shutdownPostHog()
    _resetShutdownGuardForTests()
  })

  it('calls shutdownPostHog and resolves promptly when the flush completes normally', async () => {
    expect(isPostHogEnabled()).toBe(true)

    await flushTelemetryOnShutdown()

    expect(isPostHogEnabled()).toBe(false)
  })

  it('resolves within the timeout even when the underlying flush hangs forever', async () => {
    // Re-initialize so we have a live client, then make its `shutdown()`
    // hang indefinitely (never resolves/rejects) to simulate a stuck
    // network call. A short timeoutMs proves the bound is honored without
    // slowing the test suite down.
    const { getPostHog } = await import('@skillsmith/core/telemetry')
    const hangingShutdown = vi
      .spyOn(getPostHog()!, 'shutdown')
      .mockImplementation(() => new Promise(() => {}))

    try {
      const start = Date.now()
      await flushTelemetryOnShutdown(50)
      const elapsed = Date.now() - start

      // Bounded by the timeout, not by the (never-resolving) real shutdown.
      expect(elapsed).toBeLessThan(2000)
    } finally {
      // Promise.race abandons the loser, not cancels it — the real
      // `shutdownPostHog()` call `flushTelemetryOnShutdown` kicked off is
      // still in flight, forever awaiting this mock. Restore it BEFORE this
      // test's `afterEach` calls the real (unmocked) `shutdownPostHog()`,
      // or that call would hang on the same mock too.
      hangingShutdown.mockRestore()
    }
  })

  it('is idempotent — a second call while/after a flush is a no-op (does not throw, does not re-invoke shutdownPostHog)', async () => {
    await flushTelemetryOnShutdown()
    // Second call after the guard has been set — must not throw and must
    // not attempt a second shutdown (posthogInstance is already null; a
    // naive re-implementation calling shutdownPostHog() again would still
    // just no-op internally, but the guard means we don't even try).
    await expect(flushTelemetryOnShutdown()).resolves.toBeUndefined()
  })

  it('exports the documented default timeout constant', () => {
    expect(TELEMETRY_SHUTDOWN_FLUSH_TIMEOUT_MS).toBe(2000)
  })
})

describe('createShutdownTrigger (SMI-5479)', () => {
  beforeEach(() => {
    _resetShutdownGuardForTests()
    initializePostHog({ apiKey: 'phc_test_key_smi_5479_shutdown_trigger' })
  })

  afterEach(async () => {
    await shutdownPostHog()
    _resetShutdownGuardForTests()
  })

  it('calls onDone exactly once after the flush settles', async () => {
    const onDone = vi.fn()
    const trigger = createShutdownTrigger(onDone)

    trigger()

    // Poll briefly for the async chain to settle (trigger() is
    // fire-and-forget by design — it mirrors index.ts's SIGTERM/SIGINT
    // listener signature, which is synchronous).
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
  })

  it('calling the trigger twice in quick succession still calls onDone once each, without a double-flush throwing', async () => {
    const onDoneA = vi.fn()
    const onDoneB = vi.fn()
    const triggerA = createShutdownTrigger(onDoneA)
    const triggerB = createShutdownTrigger(onDoneB)

    triggerA()
    triggerB()

    await vi.waitFor(() => {
      expect(onDoneA).toHaveBeenCalledTimes(1)
      expect(onDoneB).toHaveBeenCalledTimes(1)
    })
  })
})

/**
 * SMI-5639 Wave 2 Step 1 (part 1): direct coverage of the `closeDbOnShutdown`
 * export itself, independent of `createShutdownTrigger`'s wiring. This is
 * the fail-soft synchronous close that persists the WASM driver's in-memory
 * database to disk on shutdown (`sqljsDriver.ts`'s `close()` -> `persist()`).
 */
describe('closeDbOnShutdown (SMI-5639)', () => {
  beforeEach(() => {
    mockLogger.error.mockClear()
  })

  it('calls db.close() when the db is open', () => {
    const db = createMockDb(true)

    closeDbOnShutdown(() => db as unknown as DatabaseType)

    expect(db.close).toHaveBeenCalledTimes(1)
  })

  it('does not call close() when db.open is already false', () => {
    const db = createMockDb(false)

    closeDbOnShutdown(() => db as unknown as DatabaseType)

    expect(db.close).not.toHaveBeenCalled()
  })

  it('no-ops safely when getDb is undefined', () => {
    expect(() => closeDbOnShutdown(undefined)).not.toThrow()
  })

  it('no-ops safely when getDb returns undefined (toolContext not yet assigned)', () => {
    expect(() => closeDbOnShutdown(() => undefined)).not.toThrow()
  })

  it('no-ops safely when getDb itself throws — the error never propagates', () => {
    const getDb = vi.fn(() => {
      throw new Error('toolContext accessor exploded')
    })

    expect(() => closeDbOnShutdown(getDb)).not.toThrow()
    expect(getDb).toHaveBeenCalledTimes(1)
  })

  it('logs via logger.error (not .debug/.info) when db.close() itself throws, and does not rethrow', () => {
    const closeError = new Error('database is locked')
    const db = createMockDb(true)
    db.close.mockImplementation(() => {
      throw closeError
    })

    expect(() => closeDbOnShutdown(() => db as unknown as DatabaseType)).not.toThrow()

    // Per SMI-5615, a failed persist must be visible on stderr — logger.error
    // (not .debug/.info, which are disk-only) is the only level that
    // guarantees that. Assert the specific level, not just "some log call".
    expect(mockLogger.error).toHaveBeenCalledTimes(1)
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to close database'),
      expect.objectContaining({ err: closeError })
    )
    expect(mockLogger.debug).not.toHaveBeenCalled()
    expect(mockLogger.info).not.toHaveBeenCalled()
  })
})

/**
 * SMI-5639 Wave 2 Step 1 (part 2): `createShutdownTrigger`'s new `getDb`
 * wiring — the db close/persist runs SYNCHRONOUSLY, before the (async)
 * telemetry flush is even kicked off, so these assertions can check
 * `db.close()` immediately after calling `trigger()` without needing to wait.
 */
describe('createShutdownTrigger — getDb wiring (SMI-5639)', () => {
  beforeEach(() => {
    _resetShutdownGuardForTests()
    mockLogger.error.mockClear()
    initializePostHog({ apiKey: 'phc_test_key_smi_5639_shutdown_getdb' })
  })

  afterEach(async () => {
    await shutdownPostHog()
    _resetShutdownGuardForTests()
  })

  it('closes an open mock db when the trigger fires', async () => {
    const db = createMockDb(true)
    const onDone = vi.fn()
    const trigger = createShutdownTrigger(onDone, () => db as unknown as DatabaseType)

    trigger()

    // Synchronous — closeDbOnShutdown runs to completion before the trigger
    // even kicks off flushTelemetryOnShutdown, let alone awaits it.
    expect(db.close).toHaveBeenCalledTimes(1)

    await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
  })

  it('no-ops safely when getDb is undefined — onDone still fires via the telemetry flush', async () => {
    const onDone = vi.fn()
    const trigger = createShutdownTrigger(onDone)

    expect(() => trigger()).not.toThrow()

    await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
  })

  it('no-ops safely when getDb itself throws — does not propagate, onDone still fires', async () => {
    const onDone = vi.fn()
    const getDb = vi.fn(() => {
      throw new Error('toolContext not ready')
    })
    const trigger = createShutdownTrigger(onDone, getDb)

    expect(() => trigger()).not.toThrow()

    await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
  })

  it('no-ops safely when db.close() itself throws — logs via logger.error, does not hang, onDone still fires', async () => {
    const closeError = new Error('database is locked')
    const db = createMockDb(true)
    db.close.mockImplementation(() => {
      throw closeError
    })
    const onDone = vi.fn()
    const trigger = createShutdownTrigger(onDone, () => db as unknown as DatabaseType)

    const start = Date.now()
    expect(() => trigger()).not.toThrow()
    const elapsed = Date.now() - start

    // closeDbOnShutdown is fully synchronous (try/catch, no await) and runs
    // BEFORE the telemetry flush is even started, so a regression that made
    // the close-on-error path hang (e.g. awaiting something inside the catch)
    // would blow well past this bound. This is a distinct assertion from the
    // telemetry flush's own 2000ms timeout bound (TELEMETRY_SHUTDOWN_FLUSH_TIMEOUT_MS) —
    // it pins the SYNCHRONOUS close path specifically.
    expect(elapsed).toBeLessThan(100)

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to close database'),
      expect.objectContaining({ err: closeError })
    )

    await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
  })

  it('same-instance reuse: calling the SAME trigger instance twice only closes the db once (db.open flips false after the first close)', async () => {
    // Scope note: this test covers a single trigger closure being invoked
    // twice (e.g. transport.onclose firing after a signal already fired the
    // same registered listener). Cross-instance/racing-trigger scenarios —
    // two INDEPENDENTLY created triggers firing concurrently (e.g. SIGTERM
    // racing SIGINT) — are Wave 3's manual verification scope, not this test.
    const db = createMockDb(true)
    db.close.mockImplementation(() => {
      db.open = false
    })
    const onDone = vi.fn()
    const trigger = createShutdownTrigger(onDone, () => db as unknown as DatabaseType)

    trigger()
    trigger()

    expect(db.close).toHaveBeenCalledTimes(1)

    await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(2))
  })
})

/**
 * SMI-5639 Wave 2 Step 5: native-driver (better-sqlite3-shaped) regression
 * coverage. `closeDbOnShutdown` must behave identically for a driver that
 * has no persist-on-close semantics — a future refactor that special-cased
 * WASM behavior here could otherwise silently break the native path the same
 * way the original bug went unnoticed on WASM for months.
 */
describe('closeDbOnShutdown — native driver shape (SMI-5639 Wave 2 Step 5)', () => {
  it('calls close() exactly once for a native-driver-shaped db (boolean-backed open getter, no persist side effects) and throws nothing', () => {
    let isOpen = true
    const nativeShapedDb = {
      get open() {
        return isOpen
      },
      close: vi.fn(() => {
        isOpen = false
      }),
    }

    expect(() => closeDbOnShutdown(() => nativeShapedDb as unknown as DatabaseType)).not.toThrow()
    expect(nativeShapedDb.close).toHaveBeenCalledTimes(1)

    // A second call (e.g. a racing trigger) must not call close() again now
    // that `open` correctly reflects the closed state — same guard behavior
    // as the WASM-shaped mocks above, confirming closeDbOnShutdown doesn't
    // special-case either driver.
    expect(() => closeDbOnShutdown(() => nativeShapedDb as unknown as DatabaseType)).not.toThrow()
    expect(nativeShapedDb.close).toHaveBeenCalledTimes(1)
  })
})
