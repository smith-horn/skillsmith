/**
 * Rate Limit Queue Manager - SMI-1013, SMI-1189
 *
 * Queue management for rate limiting with request waiting.
 */

import { randomUUID } from 'crypto'
import type { RateLimitResult, QueuedRequest } from './types.js'
import { RateLimitQueueTimeoutError, RateLimitQueueFullError } from './errors.js'
import { MAX_UNIQUE_KEYS } from './constants.js'

/**
 * Configuration for the queue manager
 */
export interface QueueManagerConfig {
  maxQueueSize: number
  queueTimeoutMs: number
  debug: boolean
}

/**
 * Manages request queues for rate limiting
 */
export class QueueManager {
  private readonly queues: Map<string, QueuedRequest[]> = new Map()
  private processorInterval: NodeJS.Timeout | null = null
  private isProcessing = false
  private readonly config: QueueManagerConfig
  private readonly log: { debug: (msg: string, data?: Record<string, unknown>) => void }

  constructor(
    config: QueueManagerConfig,
    log?: { debug: (msg: string, data?: Record<string, unknown>) => void }
  ) {
    this.config = config
    this.log = log || { debug: () => {} }
  }

  /**
   * Start the queue processor
   */
  startProcessor(
    tryConsumeToken: (key: string, cost: number) => Promise<RateLimitResult>,
    onSuccess: (key: string, allowed: boolean) => void
  ): void {
    // Check queue every 100ms
    this.processorInterval = setInterval(() => {
      this.processQueues(tryConsumeToken, onSuccess)
    }, 100)
  }

  /**
   * Stop the queue processor
   */
  stopProcessor(): void {
    if (this.processorInterval) {
      clearInterval(this.processorInterval)
      this.processorInterval = null
    }
  }

  /**
   * Process all queues and release waiting requests when tokens become available
   */
  private async processQueues(
    tryConsumeToken: (key: string, cost: number) => Promise<RateLimitResult>,
    onSuccess: (key: string, allowed: boolean) => void
  ): Promise<void> {
    // Prevent concurrent queue processing
    if (this.isProcessing) {
      return
    }
    this.isProcessing = true

    try {
      for (const [key, queue] of this.queues.entries()) {
        if (queue.length === 0) {
          // Clean up empty queues to prevent memory leak
          this.queues.delete(key)
          continue
        }

        // Try to process the first request in the queue
        const request = queue[0]
        const result = await tryConsumeToken(key, request.cost)

        if (result.allowed) {
          // Remove from queue by ID (not by position for safety)
          const index = queue.findIndex((r) => r.id === request.id)
          if (index !== -1) {
            queue.splice(index, 1)
          }
          // Clear timeout
          clearTimeout(request.timeoutHandle)
          // Resolve with queue info
          const queueWaitMs = Date.now() - request.queuedAt
          onSuccess(key, true)
          request.resolve({
            ...result,
            queued: true,
            queueWaitMs,
          })

          if (this.config.debug) {
            this.log.debug(`Queue request released for ${key}`, {
              requestId: request.id,
              queueWaitMs,
              remaining: result.remaining,
            })
          }
        }
      }
    } finally {
      this.isProcessing = false
    }
  }

  /**
   * Queue a request and wait for a token
   */
  async queueRequest(
    key: string,
    cost: number,
    onMetricsUpdate: (allowed: boolean) => void
  ): Promise<RateLimitResult> {
    // Check queue size
    const queue = this.queues.get(key) || []
    if (queue.length >= this.config.maxQueueSize) {
      onMetricsUpdate(false)
      throw new RateLimitQueueFullError(key, this.config.maxQueueSize)
    }

    // Check if adding new queue would exceed max unique keys
    if (!this.queues.has(key) && this.queues.size >= MAX_UNIQUE_KEYS) {
      onMetricsUpdate(false)
      throw new RateLimitQueueFullError(key, this.config.maxQueueSize)
    }

    // Queue the request
    return new Promise<RateLimitResult>((resolve, reject) => {
      // Use UUID for unique identification (not timestamp which can collide)
      const requestId = randomUUID()
      const queuedAt = Date.now()

      // Set up timeout
      const timeoutHandle = setTimeout(() => {
        // Remove from queue by unique ID
        const currentQueue = this.queues.get(key) || []
        const index = currentQueue.findIndex((r) => r.id === requestId)
        if (index !== -1) {
          currentQueue.splice(index, 1)
        }

        onMetricsUpdate(false)
        reject(new RateLimitQueueTimeoutError(key, this.config.queueTimeoutMs))
      }, this.config.queueTimeoutMs)

      const request: QueuedRequest = {
        id: requestId,
        resolve,
        reject,
        cost,
        queuedAt,
        timeoutHandle,
      }

      // Add to queue
      if (!this.queues.has(key)) {
        this.queues.set(key, [])
      }
      this.queues.get(key)!.push(request)

      if (this.config.debug) {
        this.log.debug(`Request queued for ${key}`, {
          requestId,
          queueSize: this.queues.get(key)!.length,
          cost,
          timeoutMs: this.config.queueTimeoutMs,
        })
      }
    })
  }

  /**
   * Get queue status for a key
   */
  getStatus(key?: string): { totalQueued: number; queues: Map<string, number> } | number {
    if (key) {
      return this.queues.get(key)?.length ?? 0
    }

    const queues = new Map<string, number>()
    let totalQueued = 0
    for (const [k, q] of this.queues.entries()) {
      queues.set(k, q.length)
      totalQueued += q.length
    }
    return { totalQueued, queues }
  }

  /**
   * Clear queue for a key
   */
  clear(key?: string): void {
    const clearQueueForKey = (k: string) => {
      const queue = this.queues.get(k)
      if (queue) {
        for (const request of queue) {
          clearTimeout(request.timeoutHandle)
          request.reject(new RateLimitQueueTimeoutError(k, 0))
        }
        this.queues.delete(k)
      }
    }

    if (key) {
      clearQueueForKey(key)
    } else {
      for (const k of this.queues.keys()) {
        clearQueueForKey(k)
      }
    }
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    this.stopProcessor()
    this.clear()
  }
}
