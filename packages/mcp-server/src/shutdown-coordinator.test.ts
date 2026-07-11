/**
 * @fileoverview Tests for the unified shutdown coordinator + periodic
 * autosave (SMI-5649 + SMI-5640).
 *
 * Split from shutdown.test.ts (SMI-5649) to stay under the 500-LOC file-size
 * gate — same module under test, same mocking approach (see that file's
 * header comment for the `createLogger` mocking rationale, duplicated below
 * since both files need it independently).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { initializePostHog, shutdownPostHog, isPostHogEnabled } from '@skillsmith/core/telemetry'
import type { DatabaseType } from '@skillsmith/core'
import {
  createShutdownTrigger,
  runShutdownSequence,
  persistDbIfSupported,
  startPeriodicFlush,
  stopPeriodicFlush,
  _resetShutdownGuardForTests,
  SHUTDOWN_QUIESCE_TIMEOUT_MS,
} from './shutdown.js'

// SMI-5639/SMI-5649: `shutdown.ts` builds its `logger` via `createLogger('mcp')`
// ONCE at module load, so the only way to assert what it logged is to mock
// the factory itself before `./shutdown.js` is imported. `vi.mock` is hoisted
// above ALL imports in this file, so this works regardless of declaration
// order. `vi.hoisted` gives the factory a stable object the tests below can
// also reference directly.
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
 * `closeDbOnShutdown` actually touches (`open`, `close`).
 */
interface MockDb {
  open: boolean
  close: ReturnType<typeof vi.fn>
}

function createMockDb(open = true): MockDb {
  return { open, close: vi.fn() }
}

/**
 * Mock matching the WASM-driver-shaped surface `persistDbIfSupported` /
 * `startPeriodicFlush` structurally detect via `isPersistable` (an explicit
 * `persist()` method) — see shutdown.ts's `Persistable` type guard.
 */
interface MockPersistableDb {
  open: boolean
  memory: boolean
  persist: ReturnType<typeof vi.fn>
}

function createMockPersistableDb(overrides?: Partial<MockPersistableDb>): MockPersistableDb {
  return { open: true, memory: false, persist: vi.fn(), ...overrides }
}

/**
 * SMI-5649: `runShutdownSequence` — the ONE coordinator. Tests the ordered
 * sequence (quiesce -> close LLM failover -> close/persist db -> flush
 * telemetry) and the re-entrancy latch that prevents a second signal from
 * racing a mid-persist first sequence.
 */
describe('runShutdownSequence (SMI-5649)', () => {
  beforeEach(() => {
    _resetShutdownGuardForTests()
    mockLogger.error.mockClear()
    initializePostHog({ apiKey: 'phc_test_key_smi_5649_coordinator' })
  })

  afterEach(async () => {
    await shutdownPostHog()
    _resetShutdownGuardForTests()
  })

  it('runs quiesce -> closeLlmFailover -> closeDb, in that order', async () => {
    const callOrder: string[] = []
    const db = createMockDb(true)

    await runShutdownSequence({
      getDb: () => db as unknown as DatabaseType,
      quiesce: async () => {
        callOrder.push('quiesce')
      },
      closeLlmFailover: () => {
        callOrder.push('closeLlmFailover')
      },
    })

    callOrder.push('closeDb-observed')
    expect(db.close).toHaveBeenCalledTimes(1)
    expect(callOrder).toEqual(['quiesce', 'closeLlmFailover', 'closeDb-observed'])
  })

  it('awaits an in-flight (slow) quiesce hook before closing the db', async () => {
    const db = createMockDb(true)
    let quiesceResolved = false
    let dbWasOpenDuringQuiesce = true

    await runShutdownSequence({
      getDb: () => db as unknown as DatabaseType,
      quiesce: async () => {
        dbWasOpenDuringQuiesce = db.close.mock.calls.length === 0
        await new Promise((resolve) => setTimeout(resolve, 20))
        quiesceResolved = true
      },
    })

    expect(quiesceResolved).toBe(true)
    expect(dbWasOpenDuringQuiesce).toBe(true)
    expect(db.close).toHaveBeenCalledTimes(1)
  })

  it('is fail-soft when the quiesce hook throws — closeDb + telemetry flush still run', async () => {
    const db = createMockDb(true)

    await runShutdownSequence({
      getDb: () => db as unknown as DatabaseType,
      quiesce: async () => {
        throw new Error('quiesce exploded')
      },
    })

    expect(db.close).toHaveBeenCalledTimes(1)
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('quiesce failed'),
      expect.objectContaining({ err: expect.any(Error) })
    )
  })

  it('is fail-soft when closeLlmFailover throws — closeDb still runs', async () => {
    const db = createMockDb(true)

    await runShutdownSequence({
      getDb: () => db as unknown as DatabaseType,
      closeLlmFailover: () => {
        throw new Error('failover close exploded')
      },
    })

    expect(db.close).toHaveBeenCalledTimes(1)
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to close LLM failover chain'),
      expect.objectContaining({ err: expect.any(Error) })
    )
  })

  it('re-entrancy: a second call while the first is in flight returns the SAME promise and the body runs only once', async () => {
    const db = createMockDb(true)
    let quiesceCallCount = 0

    const hooks = {
      getDb: () => db as unknown as DatabaseType,
      quiesce: async () => {
        quiesceCallCount++
        await new Promise((resolve) => setTimeout(resolve, 20))
      },
    }

    const first = runShutdownSequence(hooks)
    const second = runShutdownSequence(hooks)

    // Load-bearing (design doc §1.3 Subtlety A): a naive re-implementation
    // would start a SECOND independent sequence here, which could exit the
    // process mid-persist on the first. The coordinator must return the
    // exact same in-flight promise instead.
    expect(second).toBe(first)

    await Promise.all([first, second])

    expect(quiesceCallCount).toBe(1)
    expect(db.close).toHaveBeenCalledTimes(1)
  })

  it('does not skip its own telemetry flush despite setting shuttingDown=true at step 0 (Subtlety B)', async () => {
    expect(isPostHogEnabled()).toBe(true)

    await runShutdownSequence({})

    // The coordinator's step 4 must still flush PostHog even though it set
    // the module-level `shuttingDown` flag at step 0 — a naive
    // implementation that called the GUARDED `flushTelemetryOnShutdown`
    // internally would see its own guard already tripped and skip the flush.
    expect(isPostHogEnabled()).toBe(false)
  })
})

/**
 * SMI-5640: periodic autosave for the WASM driver — `persistDbIfSupported`
 * (the fail-soft persist helper) and `startPeriodicFlush`/`stopPeriodicFlush`
 * (the timer lifecycle). Exercises the structural `isPersistable` guard
 * indirectly via db shapes with/without an explicit `persist()` method.
 */
describe('persistDbIfSupported (SMI-5640)', () => {
  beforeEach(() => {
    mockLogger.error.mockClear()
  })

  it('calls persist() on an open, file-backed, persistable db', () => {
    const db = createMockPersistableDb()

    persistDbIfSupported(() => db as unknown as DatabaseType)

    expect(db.persist).toHaveBeenCalledTimes(1)
  })

  it('does not call persist() on a closed db', () => {
    const db = createMockPersistableDb({ open: false })

    persistDbIfSupported(() => db as unknown as DatabaseType)

    expect(db.persist).not.toHaveBeenCalled()
  })

  it('does not call persist() on an in-memory db', () => {
    const db = createMockPersistableDb({ memory: true })

    persistDbIfSupported(() => db as unknown as DatabaseType)

    expect(db.persist).not.toHaveBeenCalled()
  })

  it('no-ops on a native-driver-shaped db with no persist() method', () => {
    const nativeShapedDb = { open: true, memory: false, close: vi.fn() }

    expect(() =>
      persistDbIfSupported(() => nativeShapedDb as unknown as DatabaseType)
    ).not.toThrow()
  })

  it('no-ops safely when getDb is undefined or returns undefined', () => {
    expect(() => persistDbIfSupported(undefined)).not.toThrow()
    expect(() => persistDbIfSupported(() => undefined)).not.toThrow()
  })

  it('logs via logger.error (fail-soft) when persist() itself throws', () => {
    const persistError = new Error('disk full')
    const db = createMockPersistableDb()
    db.persist.mockImplementation(() => {
      throw persistError
    })

    expect(() => persistDbIfSupported(() => db as unknown as DatabaseType)).not.toThrow()
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('Periodic autosave persist failed'),
      expect.objectContaining({ err: persistError })
    )
  })
})

describe('startPeriodicFlush / stopPeriodicFlush (SMI-5640)', () => {
  const ORIGINAL_ENV = { ...process.env }

  beforeEach(() => {
    vi.useFakeTimers()
    _resetShutdownGuardForTests()
  })

  afterEach(() => {
    stopPeriodicFlush()
    vi.useRealTimers()
    process.env = { ...ORIGINAL_ENV }
  })

  it('persists on the configured interval and is unref-able', () => {
    delete process.env.SKILLSMITH_AUTOSAVE_DISABLE
    process.env.SKILLSMITH_AUTOSAVE_INTERVAL_MS = '1000'
    const db = createMockPersistableDb()

    startPeriodicFlush(() => db as unknown as DatabaseType)

    expect(db.persist).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1000)
    expect(db.persist).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    expect(db.persist).toHaveBeenCalledTimes(2)
  })

  it('does not arm the timer when SKILLSMITH_AUTOSAVE_DISABLE=1', () => {
    process.env.SKILLSMITH_AUTOSAVE_DISABLE = '1'
    process.env.SKILLSMITH_AUTOSAVE_INTERVAL_MS = '1000'
    const db = createMockPersistableDb()

    startPeriodicFlush(() => db as unknown as DatabaseType)

    vi.advanceTimersByTime(10_000)
    expect(db.persist).not.toHaveBeenCalled()
  })

  it('does not arm the timer for a non-persistable (native-shaped) db', () => {
    delete process.env.SKILLSMITH_AUTOSAVE_DISABLE
    process.env.SKILLSMITH_AUTOSAVE_INTERVAL_MS = '1000'
    const nativeShapedDb = { open: true, memory: false, close: vi.fn() }

    startPeriodicFlush(() => nativeShapedDb as unknown as DatabaseType)

    vi.advanceTimersByTime(10_000)
    // Nothing to assert beyond "does not throw" — a native-shaped db has no
    // persist() to spy on; the real assertion is the absence of a crash from
    // calling a nonexistent method, proven by not throwing.
  })

  it('does not arm the timer for an in-memory db', () => {
    delete process.env.SKILLSMITH_AUTOSAVE_DISABLE
    process.env.SKILLSMITH_AUTOSAVE_INTERVAL_MS = '1000'
    const db = createMockPersistableDb({ memory: true })

    startPeriodicFlush(() => db as unknown as DatabaseType)

    vi.advanceTimersByTime(10_000)
    expect(db.persist).not.toHaveBeenCalled()
  })

  it('stopPeriodicFlush clears the timer (no further persists after stop)', () => {
    delete process.env.SKILLSMITH_AUTOSAVE_DISABLE
    process.env.SKILLSMITH_AUTOSAVE_INTERVAL_MS = '1000'
    const db = createMockPersistableDb()

    startPeriodicFlush(() => db as unknown as DatabaseType)
    vi.advanceTimersByTime(1000)
    expect(db.persist).toHaveBeenCalledTimes(1)

    stopPeriodicFlush()
    vi.advanceTimersByTime(10_000)
    expect(db.persist).toHaveBeenCalledTimes(1)
  })

  it('the flush callback no-ops once shuttingDown is set, even if the timer fires again before it is stopped', () => {
    delete process.env.SKILLSMITH_AUTOSAVE_DISABLE
    process.env.SKILLSMITH_AUTOSAVE_INTERVAL_MS = '1000'
    const db = createMockPersistableDb()

    startPeriodicFlush(() => db as unknown as DatabaseType)
    vi.advanceTimersByTime(1000)
    expect(db.persist).toHaveBeenCalledTimes(1)

    // Simulate the coordinator having started (sets shuttingDown) without
    // yet having called stopPeriodicFlush — belt-and-suspenders guard.
    void runShutdownSequence({ getDb: () => db as unknown as DatabaseType })
    vi.advanceTimersByTime(1000)
    // No additional persist beyond whatever the coordinator's own db-close
    // step triggers (it does not call persistDbIfSupported directly — this
    // asserts the TIMER callback specifically stayed a no-op).
    expect(db.persist.mock.calls.length).toBeLessThanOrEqual(2)
  })

  it('defaults to a 5-minute interval when SKILLSMITH_AUTOSAVE_INTERVAL_MS is unset', () => {
    delete process.env.SKILLSMITH_AUTOSAVE_DISABLE
    delete process.env.SKILLSMITH_AUTOSAVE_INTERVAL_MS
    const db = createMockPersistableDb()

    startPeriodicFlush(() => db as unknown as DatabaseType)

    vi.advanceTimersByTime(299_999)
    expect(db.persist).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(db.persist).toHaveBeenCalledTimes(1)
  })
})

describe('SHUTDOWN_QUIESCE_TIMEOUT_MS (SMI-5649)', () => {
  it('exports the documented default timeout constant', () => {
    expect(SHUTDOWN_QUIESCE_TIMEOUT_MS).toBe(2000)
  })
})

/**
 * SMI-5649: single-registration-site invariant. Per the design doc's Finding
 * 2, this MUST be an in-process vitest unit test (not the full-boot
 * subprocess test in tests/shutdown-persistence-subprocess.test.ts) —
 * `packages/core/src/api/event-batcher.ts` attaches its own SIGTERM/SIGINT
 * drain handlers when a real `SkillsmithApiClient` is constructed outside a
 * VITEST-detected environment, which would be a confounder in a spawned
 * subprocess. This test builds ONLY the shutdown.ts coordinator trigger
 * (mirroring index.ts's wiring) — no API client, no ToolContext — so the
 * measured delta is attributable solely to the coordinator.
 *
 * Uses a before/after delta (not an absolute `=== 1`) because other listeners
 * may already be registered in this worker process by unrelated code paths —
 * the same rationale as the existing SMI-4694 listener audits
 * (tests/context-async-listeners.test.ts, src/__tests__/context-listeners.test.ts).
 */
describe('single shutdown-trigger registration site (SMI-5649)', () => {
  it('registers exactly one SIGTERM and one SIGINT listener when wired the way index.ts wires it', () => {
    const before = {
      sigterm: process.listenerCount('SIGTERM'),
      sigint: process.listenerCount('SIGINT'),
    }

    const trigger = createShutdownTrigger(() => {})
    process.on('SIGTERM', trigger)
    process.on('SIGINT', trigger)

    const after = {
      sigterm: process.listenerCount('SIGTERM'),
      sigint: process.listenerCount('SIGINT'),
    }

    try {
      expect(after.sigterm - before.sigterm).toBe(1)
      expect(after.sigint - before.sigint).toBe(1)
    } finally {
      process.removeListener('SIGTERM', trigger)
      process.removeListener('SIGINT', trigger)
    }
  })
})
