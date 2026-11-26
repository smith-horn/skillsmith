/**
 * @fileoverview Tests for the unified shutdown coordinator (SMI-5649).
 * SMI-7260 removed the SMI-5640 periodic autosave and its tests: the WASM
 * driver no longer writes a database file, so there is nothing to autosave.
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
 * SMI-5649: `runShutdownSequence` — the ONE coordinator. Tests the ordered
 * sequence (quiesce -> close LLM failover -> close db -> flush
 * telemetry) and the re-entrancy latch that prevents a second signal from
 * racing a first sequence that is mid-close.
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
    // process mid-close on the first. The coordinator must return the
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

describe('SHUTDOWN_QUIESCE_TIMEOUT_MS (SMI-5649)', () => {
  it('exports the documented default timeout constant', () => {
    expect(SHUTDOWN_QUIESCE_TIMEOUT_MS).toBe(2000)
  })
})

/**
 * SMI-5649: single-registration-site invariant. Per the design doc's Finding
 * 2, this MUST be an in-process vitest unit test (not a full-boot
 * subprocess test) —
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
