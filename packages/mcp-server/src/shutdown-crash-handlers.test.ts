/**
 * @fileoverview Tests for installGlobalCrashHandlers (SMI-5787).
 *
 * Split into its own file rather than added to shutdown.test.ts /
 * shutdown-coordinator.test.ts — both are already close to the 500-LOC
 * file-size gate. Same module under test, same `createLogger` mocking
 * approach as those files (see shutdown.test.ts's header comment for the
 * rationale).
 *
 * Tests drive the handlers via `process.emit(...)` directly rather than a
 * real throw/rejection — `installGlobalCrashHandlers` only registers plain
 * listeners, so emitting the event exercises the exact same callback Node
 * would invoke on a real uncaught exception/unhandled rejection, without
 * relying on Node's internal fatal-exception machinery (which only engages
 * for a *real*, unhandled throw — not a manually emitted event on an
 * EventEmitter that already has a listener).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { installGlobalCrashHandlers } from './shutdown.js'

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

describe('installGlobalCrashHandlers (SMI-5787)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    mockLogger.error.mockClear()
    // Never let the test process actually exit — capture the call instead.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
  })

  afterEach(() => {
    // Each test calls installGlobalCrashHandlers() itself — strip the
    // listeners it added so the next test (and the rest of the vitest
    // worker's lifetime) starts clean rather than accumulating pairs.
    process.removeAllListeners('uncaughtException')
    process.removeAllListeners('unhandledRejection')
    exitSpy.mockRestore()
  })

  it('logs to disk (via logger.error) and exits 1 on an uncaught exception', () => {
    installGlobalCrashHandlers()
    const error = new Error('boom')

    process.emit('uncaughtException', error)

    expect(mockLogger.error).toHaveBeenCalledWith(
      '[skillsmith] Uncaught exception — server exiting',
      { err: error }
    )
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('logs to disk and exits 1 on an unhandled rejection with an Error reason', () => {
    installGlobalCrashHandlers()
    const error = new Error('rejected')

    process.emit('unhandledRejection', error, Promise.resolve())

    expect(mockLogger.error).toHaveBeenCalledWith(
      '[skillsmith] Unhandled promise rejection — server exiting',
      { err: error }
    )
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('wraps a non-Error rejection reason in an Error before logging', () => {
    installGlobalCrashHandlers()

    process.emit('unhandledRejection', 'string reason', Promise.resolve())

    expect(mockLogger.error).toHaveBeenCalledWith(
      '[skillsmith] Unhandled promise rejection — server exiting',
      { err: expect.objectContaining({ message: 'string reason' }) }
    )
    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})
