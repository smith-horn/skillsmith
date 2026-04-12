/**
 * SMI-4119: EventBatcher unit tests.
 *
 * Covers:
 *  - size flush    : 20 events → 1 POST (single flush)
 *  - time flush    : wait elapses → flush
 *  - exit drain    : `beforeExit` triggers flush
 *  - failure       : first POST fails, retry succeeds
 *  - double-fail   : two consecutive failures drop silently (no throw)
 *  - ordering      : batch is delivered in enqueue order
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventBatcher } from '../../src/api/event-batcher.js'
import type { TelemetryEvent } from '../../src/api/client.js'

const makeEvent = (anonId: string, skillId?: string): TelemetryEvent => ({
  event: 'skill_view',
  anonymous_id: anonId,
  skill_id: skillId,
})

describe('SMI-4119: EventBatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('flushes a single batch when queue reaches maxBatchSize', async () => {
    const flushFn = vi
      .fn<(events: TelemetryEvent[]) => Promise<void>>()
      .mockResolvedValue(undefined)
    const batcher = new EventBatcher(flushFn, {
      maxBatchSize: 20,
      maxWaitMs: 10_000,
      registerExitHandlers: false,
    })

    for (let i = 0; i < 20; i++) batcher.enqueue(makeEvent(`a${i}`))

    // Size-trigger schedules microtask flush; let it run.
    await vi.runAllTimersAsync()
    expect(flushFn).toHaveBeenCalledTimes(1)
    expect(flushFn.mock.calls[0][0]).toHaveLength(20)
    batcher.dispose()
  })

  it('flushes on wall-clock timeout even with < maxBatchSize events', async () => {
    const flushFn = vi
      .fn<(events: TelemetryEvent[]) => Promise<void>>()
      .mockResolvedValue(undefined)
    const batcher = new EventBatcher(flushFn, {
      maxBatchSize: 20,
      maxWaitMs: 10_000,
      registerExitHandlers: false,
    })

    batcher.enqueue(makeEvent('only-one'))
    expect(flushFn).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(10_000)
    expect(flushFn).toHaveBeenCalledTimes(1)
    expect(flushFn.mock.calls[0][0]).toHaveLength(1)
    batcher.dispose()
  })

  it('preserves enqueue order in the delivered batch', async () => {
    const flushFn = vi
      .fn<(events: TelemetryEvent[]) => Promise<void>>()
      .mockResolvedValue(undefined)
    const batcher = new EventBatcher(flushFn, {
      maxBatchSize: 5,
      maxWaitMs: 10_000,
      registerExitHandlers: false,
    })

    const ids = [
      'aaaaaaaaaaaaaaaa',
      'bbbbbbbbbbbbbbbb',
      'cccccccccccccccc',
      'dddddddddddddddd',
      'eeeeeeeeeeeeeeee',
    ]
    for (const id of ids) batcher.enqueue(makeEvent(id))

    await vi.runAllTimersAsync()
    expect(flushFn).toHaveBeenCalledTimes(1)
    expect(flushFn.mock.calls[0][0].map((e) => e.anonymous_id)).toEqual(ids)
    batcher.dispose()
  })

  it('retries once after 2s when first flush fails, then succeeds', async () => {
    const flushFn = vi
      .fn<(events: TelemetryEvent[]) => Promise<void>>()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(undefined)
    const batcher = new EventBatcher(flushFn, {
      maxBatchSize: 2,
      maxWaitMs: 10_000,
      retryDelayMs: 2_000,
      registerExitHandlers: false,
    })

    batcher.enqueue(makeEvent('a1a1a1a1a1a1a1a1'))
    batcher.enqueue(makeEvent('b2b2b2b2b2b2b2b2'))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(2_000)
    await vi.runAllTimersAsync()
    expect(flushFn).toHaveBeenCalledTimes(2)
    batcher.dispose()
  })

  it('drops the batch silently after two consecutive failures', async () => {
    const flushFn = vi
      .fn<(events: TelemetryEvent[]) => Promise<void>>()
      .mockRejectedValue(new Error('network down'))
    const batcher = new EventBatcher(flushFn, {
      maxBatchSize: 1,
      maxWaitMs: 10_000,
      retryDelayMs: 500,
      registerExitHandlers: false,
    })

    batcher.enqueue(makeEvent('a1a1a1a1a1a1a1a1'))
    // Let the initial flush, retry delay, and second attempt all resolve.
    await vi.runAllTimersAsync()

    expect(flushFn).toHaveBeenCalledTimes(2)
    // No unhandled rejections — batcher swallowed both failures.
    batcher.dispose()
  })

  it('drains queued events when flush() is invoked (exit-drain surrogate)', async () => {
    const flushFn = vi
      .fn<(events: TelemetryEvent[]) => Promise<void>>()
      .mockResolvedValue(undefined)
    const batcher = new EventBatcher(flushFn, {
      maxBatchSize: 20,
      maxWaitMs: 10_000,
      registerExitHandlers: false,
    })

    batcher.enqueue(makeEvent('x1x1x1x1x1x1x1x1'))
    batcher.enqueue(makeEvent('y2y2y2y2y2y2y2y2'))
    expect(flushFn).not.toHaveBeenCalled()

    await batcher.flush()
    expect(flushFn).toHaveBeenCalledTimes(1)
    expect(flushFn.mock.calls[0][0]).toHaveLength(2)
    batcher.dispose()
  })

  it('triggers flush on the real `beforeExit` process event', async () => {
    const flushFn = vi
      .fn<(events: TelemetryEvent[]) => Promise<void>>()
      .mockResolvedValue(undefined)
    const batcher = new EventBatcher(flushFn, {
      maxBatchSize: 20,
      maxWaitMs: 10_000,
      drainTimeoutMs: 1_000,
      registerExitHandlers: true,
    })

    batcher.enqueue(makeEvent('z1z1z1z1z1z1z1z1'))
    process.emit('beforeExit', 0 as never)
    // Let the drain promise and its race timeout flush.
    await vi.runAllTimersAsync()
    await Promise.resolve()
    expect(flushFn).toHaveBeenCalledTimes(1)
    batcher.dispose()
  })
})
