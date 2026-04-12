/**
 * EventBatcher — client-side telemetry batcher
 * @module api/event-batcher
 *
 * SMI-4119: Batch telemetry events to reduce Supabase edge function invocations.
 *
 * Flushes on:
 *  - size   : queue reaches `maxBatchSize` (default 20)
 *  - time   : `maxWaitMs` elapsed since first enqueue in the current batch (default 10s)
 *  - exit   : `beforeExit` / `SIGINT` / `SIGTERM` (drain with `drainTimeoutMs`, default 2s)
 *
 * POSTs to `/events` with `{events: [...]}` and `X-Skillsmith-Batched: true` header.
 * On failure: retry once after `retryDelayMs` (default 2s); on second failure, drop silently
 * (matches the existing "fail silently" contract on telemetry).
 */

import type { TelemetryEvent } from './client.js'

/**
 * Flush function signature. Returns a resolved promise on success, rejects on failure.
 * Must throw / reject on non-2xx responses so the batcher can retry.
 */
export type BatchFlushFn = (events: TelemetryEvent[]) => Promise<void>

/**
 * Construction options for EventBatcher (all optional; defaults documented inline).
 */
export interface EventBatcherOptions {
  /** Max events per batch before forced flush. Default: 20 (aligns with edge function max). */
  maxBatchSize?: number
  /** Max ms to wait after first enqueue before flushing. Default: 10_000. */
  maxWaitMs?: number
  /** Delay before retry on first flush failure. Default: 2_000. */
  retryDelayMs?: number
  /** Max time to wait during process-exit drain. Default: 2_000. */
  drainTimeoutMs?: number
  /** Attach process-exit listeners. Default: true. Disable in tests to avoid handler leaks. */
  registerExitHandlers?: boolean
}

const DEFAULT_MAX_BATCH_SIZE = 20
const DEFAULT_MAX_WAIT_MS = 10_000
const DEFAULT_RETRY_DELAY_MS = 2_000
const DEFAULT_DRAIN_TIMEOUT_MS = 2_000

/**
 * In-memory batcher. Single-process, fire-and-forget.
 */
export class EventBatcher {
  private queue: TelemetryEvent[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private activeFlush: Promise<void> | null = null
  private readonly maxBatchSize: number
  private readonly maxWaitMs: number
  private readonly retryDelayMs: number
  private readonly drainTimeoutMs: number
  private readonly flushFn: BatchFlushFn
  private exitHandlersAttached = false
  private disposed = false

  constructor(flushFn: BatchFlushFn, options: EventBatcherOptions = {}) {
    this.flushFn = flushFn
    this.maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE
    this.maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
    this.drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS

    if (options.registerExitHandlers !== false) {
      this.attachExitHandlers()
    }
  }

  /**
   * Enqueue an event. Flushes immediately if the batch reaches `maxBatchSize`.
   * Fire-and-forget — errors are swallowed.
   */
  enqueue(event: TelemetryEvent): void {
    if (this.disposed) return
    this.queue.push(event)

    if (this.queue.length >= this.maxBatchSize) {
      // Size-based flush: cancel pending timer, fire immediately.
      this.clearTimer()
      void this.flushNow()
      return
    }

    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null
        void this.flushNow()
      }, this.maxWaitMs)
      // Unref so the timer does not keep the event loop alive.
      if (typeof (this.timer as { unref?: () => void }).unref === 'function') {
        ;(this.timer as { unref: () => void }).unref()
      }
    }
  }

  /**
   * Force a flush of any queued events. Resolves when the in-flight POST completes.
   * Used by shutdown paths and tests.
   */
  async flush(): Promise<void> {
    this.clearTimer()
    await this.flushNow()
  }

  /**
   * Current queue depth (observability / tests).
   */
  size(): number {
    return this.queue.length
  }

  /**
   * Detach exit handlers and clear timers. Call when disposing short-lived clients.
   */
  dispose(): void {
    this.disposed = true
    this.clearTimer()
    this.detachExitHandlers()
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private async flushNow(): Promise<void> {
    // Serialize flushes: if one is in flight, chain.
    if (this.activeFlush) {
      await this.activeFlush.catch(() => undefined)
    }
    if (this.queue.length === 0) return

    const batch = this.queue.splice(0, this.maxBatchSize)
    this.activeFlush = this.doFlushWithRetry(batch).finally(() => {
      this.activeFlush = null
    })
    await this.activeFlush.catch(() => undefined)
  }

  private async doFlushWithRetry(batch: TelemetryEvent[]): Promise<void> {
    try {
      await this.flushFn(batch)
      return
    } catch {
      // swallow; retry below
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, this.retryDelayMs)
      if (typeof (t as { unref?: () => void }).unref === 'function') {
        ;(t as { unref: () => void }).unref()
      }
    })
    try {
      await this.flushFn(batch)
    } catch {
      // Second failure: drop silently to match telemetry contract.
    }
  }

  private attachExitHandlers(): void {
    if (this.exitHandlersAttached) return
    if (typeof process === 'undefined' || typeof process.on !== 'function') return
    this.exitHandlersAttached = true
    process.on('beforeExit', this.drainHandler)
    process.on('SIGINT', this.drainHandler)
    process.on('SIGTERM', this.drainHandler)
  }

  private detachExitHandlers(): void {
    if (!this.exitHandlersAttached) return
    if (typeof process === 'undefined' || typeof process.off !== 'function') return
    this.exitHandlersAttached = false
    process.off('beforeExit', this.drainHandler)
    process.off('SIGINT', this.drainHandler)
    process.off('SIGTERM', this.drainHandler)
  }

  private drainHandler = (): void => {
    // Best-effort drain with timeout. Fire-and-forget — callers of beforeExit
    // cannot await async handlers reliably, but attaching starts the work.
    const drain = this.flush()
    const timeout = new Promise<void>((resolve) => {
      const t = setTimeout(resolve, this.drainTimeoutMs)
      if (typeof (t as { unref?: () => void }).unref === 'function') {
        ;(t as { unref: () => void }).unref()
      }
    })
    void Promise.race([drain, timeout]).catch(() => undefined)
  }
}

/**
 * Factory for an EventBatcher bound to a POST function.
 */
export function createEventBatcher(
  flushFn: BatchFlushFn,
  options?: EventBatcherOptions
): EventBatcher {
  return new EventBatcher(flushFn, options)
}
