/**
 * @fileoverview Tests for the shutdown-coordinator helpers extracted from
 * index.ts (SMI-5649).
 *
 * `quiesceBackgroundSync` is the bounded-timeout wrapper `index.ts` passes
 * as the coordinator's `quiesce` hook. It has no top-level side effects
 * (unlike `index.ts` itself), so it can be imported and unit-tested
 * directly — this is the in-process complement to the subprocess proof in
 * `tests/shutdown-persistence-subprocess.test.ts` (which exercises the same
 * bound end-to-end against a real stalled network call, but isn't captured
 * by source-file coverage since it runs the compiled binary in a separate
 * process).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { BackgroundSyncService } from '@skillsmith/core'

// SMI-5649: index.shutdown-helpers.ts builds its `logger` via
// `createLogger('mcp')` ONCE at module load, so the only way to assert what
// it logged is to mock the factory before the module under test is
// imported. Mirrors the identical pattern in shutdown.test.ts.
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

import { quiesceBackgroundSync } from './index.shutdown-helpers.js'
import { SHUTDOWN_QUIESCE_TIMEOUT_MS } from './shutdown.js'

/** Minimal mock matching the slice of BackgroundSyncService's surface
 * quiesceBackgroundSync actually calls. */
function createMockBg(stopImpl: () => Promise<void>): BackgroundSyncService {
  return { stop: vi.fn(stopImpl) } as unknown as BackgroundSyncService
}

describe('quiesceBackgroundSync (SMI-5649)', () => {
  beforeEach(() => {
    mockLogger.error.mockClear()
  })

  it('resolves immediately (no-op) when bg is undefined', async () => {
    await expect(quiesceBackgroundSync(undefined)).resolves.toBeUndefined()
    expect(mockLogger.error).not.toHaveBeenCalled()
  })

  it('resolves promptly when bg.stop() settles well within the bound, without logging', async () => {
    const bg = createMockBg(() => Promise.resolve())

    await quiesceBackgroundSync(bg)

    expect(bg.stop).toHaveBeenCalledTimes(1)
    expect(mockLogger.error).not.toHaveBeenCalled()
  })

  it('proceeds and logs once the bound elapses when bg.stop() never settles', async () => {
    vi.useFakeTimers()
    try {
      // A stop() that never resolves — mirrors the real scenario where the
      // in-flight sync is parked on a stuck network await (design doc §2.3):
      // the bound must still let the coordinator proceed to close the db.
      const bg = createMockBg(() => new Promise<void>(() => {}))

      const quiescePromise = quiesceBackgroundSync(bg)
      await vi.advanceTimersByTimeAsync(SHUTDOWN_QUIESCE_TIMEOUT_MS)
      await quiescePromise

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('did not quiesce within the shutdown bound'),
        expect.anything()
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not log when bg.stop() settles exactly at the bound (race-tolerant)', async () => {
    vi.useFakeTimers()
    try {
      let resolveStop!: () => void
      const bg = createMockBg(
        () =>
          new Promise<void>((resolve) => {
            resolveStop = resolve
          })
      )

      const quiescePromise = quiesceBackgroundSync(bg)
      resolveStop()
      await vi.advanceTimersByTimeAsync(0)
      await quiescePromise

      expect(mockLogger.error).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
