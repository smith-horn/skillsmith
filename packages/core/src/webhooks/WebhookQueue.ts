/**
 * SMI-645: WebhookQueue - Queue webhook events for processing
 *
 * Provides:
 * - Priority queue for webhook events
 * - Debouncing for rapid updates to the same repository
 * - Retry mechanism for failed processing
 * - Processing with configurable concurrency
 */

/**
 * Types of queue items
 */
export type QueueItemType = 'index' | 'remove' | 'remove_all' | 'archive' | 'reactivate'

/**
 * Priority levels for queue items
 */
export type QueuePriority = 'high' | 'medium' | 'low'

/**
 * A single item in the webhook queue
 */
export interface WebhookQueueItem {
  /**
   * Unique identifier for this queue item
   */
  id: string

  /**
   * Type of operation to perform
   */
  type: QueueItemType

  /**
   * Repository URL
   */
  repoUrl: string

  /**
   * Repository full name (owner/repo)
   */
  repoFullName: string

  /**
   * Path to the file (or '*' for repo-wide operations)
   */
  filePath: string

  /**
   * Commit SHA that triggered this item
   */
  commitSha: string

  /**
   * Timestamp when this item was created
   */
  timestamp: number

  /**
   * Priority level
   */
  priority: QueuePriority

  /**
   * Number of retry attempts
   */
  retries: number

  /**
   * Error from last attempt (if any)
   */
  lastError?: string

  /**
   * Next retry time (if scheduled)
   */
  nextRetryAt?: number
}

/**
 * Queue processing result
 */
export interface QueueProcessResult {
  /**
   * Item that was processed
   */
  item: WebhookQueueItem

  /**
   * Whether processing succeeded
   */
  success: boolean

  /**
   * Error message if failed
   */
  error?: string

  /**
   * Duration of processing in ms
   */
  durationMs: number
}

/**
 * Queue statistics
 */
export interface QueueStats {
  /**
   * Total items in queue
   */
  total: number

  /**
   * Items by priority
   */
  byPriority: Record<QueuePriority, number>

  /**
   * Items by type
   */
  byType: Record<QueueItemType, number>

  /**
   * Items currently being processed
   */
  processing: number

  /**
   * Items waiting for retry
   */
  pendingRetry: number
}

/**
 * Queue options
 */
export interface WebhookQueueOptions {
  /**
   * Maximum number of concurrent processors
   */
  concurrency?: number

  /**
   * Debounce time in ms for same-repo updates
   */
  debounceMs?: number

  /**
   * Maximum retry attempts
   */
  maxRetries?: number

  /**
   * Base retry delay in ms (exponential backoff)
   */
  retryDelayMs?: number

  /**
   * Maximum queue size
   */
  maxSize?: number

  /**
   * Processor function to handle queue items
   */
  processor?: (item: WebhookQueueItem) => Promise<void>

  /**
   * Callback when processing completes
   */
  onProcessed?: (result: QueueProcessResult) => void

  /**
   * Callback for logging
   */
  onLog?: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void
}

/**
 * Priority values for sorting
 */
const PRIORITY_VALUES: Record<QueuePriority, number> = {
  high: 3,
  medium: 2,
  low: 1,
}

/**
 * Webhook event queue with priority, debouncing, and retry support
 */
export class WebhookQueue {
  private items: Map<string, WebhookQueueItem> = new Map()
  private processing: Set<string> = new Set()
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map()
  private isProcessing = false
  private processingPromise: Promise<void> | null = null

  private concurrency: number
  private debounceMs: number
  private maxRetries: number
  private retryDelayMs: number
  private maxSize: number
  private processor?: (item: WebhookQueueItem) => Promise<void>
  private onProcessed?: (result: QueueProcessResult) => void
  private log: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void

  constructor(options: WebhookQueueOptions = {}) {
    this.concurrency = options.concurrency ?? 2
    this.debounceMs = options.debounceMs ?? 5000 // 5 seconds default
    this.maxRetries = options.maxRetries ?? 3
    this.retryDelayMs = options.retryDelayMs ?? 1000
    this.maxSize = options.maxSize ?? 1000
    this.processor = options.processor
    this.onProcessed = options.onProcessed
    this.log = options.onLog ?? (() => {})
  }

  /**
   * Add an item to the queue
   * Returns true if added, false if debounced or queue full
   */
  async add(item: WebhookQueueItem): Promise<boolean> {
    // Check queue size
    if (this.items.size >= this.maxSize) {
      this.log('warn', 'Queue full, dropping item', { id: item.id })
      return false
    }

    // Create debounce key (repo + file path)
    const debounceKey = `${item.repoFullName}:${item.filePath}`

    // Check if we have a pending debounce for this key
    const existingTimer = this.debounceTimers.get(debounceKey)
    if (existingTimer) {
      // Cancel existing timer and update item
      clearTimeout(existingTimer)
      this.debounceTimers.delete(debounceKey)
      this.log('info', 'Debouncing update', { key: debounceKey })
    }

    // Check if item already exists with same or newer commit
    const existingItem = this.items.get(item.id)
    if (existingItem && existingItem.timestamp >= item.timestamp) {
      this.log('info', 'Item already in queue with same or newer commit', {
        id: item.id,
      })
      return false
    }

    // Set debounce timer
    const timer = setTimeout(() => {
      this.debounceTimers.delete(debounceKey)
      this.items.set(item.id, item)
      this.log('info', 'Item added to queue after debounce', {
        id: item.id,
        priority: item.priority,
      })
      this.triggerProcessing()
    }, this.debounceMs)

    this.debounceTimers.set(debounceKey, timer)
    return true
  }

  /**
   * Add an item immediately without debouncing
   */
  addImmediate(item: WebhookQueueItem): boolean {
    if (this.items.size >= this.maxSize) {
      this.log('warn', 'Queue full, dropping item', { id: item.id })
      return false
    }

    // Cancel any pending debounce
    const debounceKey = `${item.repoFullName}:${item.filePath}`
    const existingTimer = this.debounceTimers.get(debounceKey)
    if (existingTimer) {
      clearTimeout(existingTimer)
      this.debounceTimers.delete(debounceKey)
    }

    this.items.set(item.id, item)
    this.log('info', 'Item added to queue immediately', {
      id: item.id,
      priority: item.priority,
    })
    this.triggerProcessing()
    return true
  }

  /**
   * Remove an item from the queue
   */
  remove(id: string): boolean {
    return this.items.delete(id)
  }

  /**
   * Get the next item to process based on priority
   */
  private getNextItem(): WebhookQueueItem | null {
    const now = Date.now()
    let bestItem: WebhookQueueItem | null = null
    let bestScore = -1

    for (const item of this.items.values()) {
      // Skip if already being processed
      if (this.processing.has(item.id)) {
        continue
      }

      // Skip if waiting for retry
      if (item.nextRetryAt && item.nextRetryAt > now) {
        continue
      }

      // Calculate priority score
      const priorityScore = PRIORITY_VALUES[item.priority]

      // Prefer older items with same priority
      const ageBonus = (now - item.timestamp) / (1000 * 60) // Minutes old

      const score = priorityScore * 1000 + ageBonus

      if (score > bestScore) {
        bestScore = score
        bestItem = item
      }
    }

    return bestItem
  }

  /**
   * Trigger processing if not already running
   */
  private triggerProcessing(): void {
    if (!this.processor) {
      return
    }

    if (this.isProcessing) {
      return
    }

    this.isProcessing = true
    this.processingPromise = this.processQueue().finally(() => {
      this.isProcessing = false
      this.processingPromise = null
    })
  }

  /**
   * Process items in the queue
   */
  private async processQueue(): Promise<void> {
    while (true) {
      // Wait for available processing slots
      while (this.processing.size >= this.concurrency) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }

      const item = this.getNextItem()
      if (!item) {
        // Check if there are items waiting for retry
        const hasRetrying = Array.from(this.items.values()).some(
          (i) => i.nextRetryAt && i.nextRetryAt > Date.now()
        )

        if (hasRetrying) {
          // Wait a bit and try again
          await new Promise((resolve) => setTimeout(resolve, 1000))
          continue
        }

        // No more items to process
        break
      }

      // Process item concurrently
      this.processing.add(item.id)
      this.processItem(item).catch((error) => {
        this.log('error', 'Error processing item', {
          id: item.id,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }
  }

  /**
   * Process a single item
   */
  private async processItem(item: WebhookQueueItem): Promise<void> {
    const startTime = Date.now()

    try {
      if (this.processor) {
        await this.processor(item)
      }

      // Success - remove from queue
      this.items.delete(item.id)
      this.processing.delete(item.id)

      const result: QueueProcessResult = {
        item,
        success: true,
        durationMs: Date.now() - startTime,
      }

      this.log('info', 'Item processed successfully', {
        id: item.id,
        durationMs: result.durationMs,
      })

      if (this.onProcessed) {
        this.onProcessed(result)
      }
    } catch (error) {
      this.processing.delete(item.id)
      const errorMessage = error instanceof Error ? error.message : String(error)

      // Update retry info
      item.retries++
      item.lastError = errorMessage

      if (item.retries >= this.maxRetries) {
        // Max retries exceeded - remove from queue
        this.items.delete(item.id)

        const result: QueueProcessResult = {
          item,
          success: false,
          error: `Max retries exceeded: ${errorMessage}`,
          durationMs: Date.now() - startTime,
        }

        this.log('error', 'Item failed after max retries', {
          id: item.id,
          retries: item.retries,
          error: errorMessage,
        })

        if (this.onProcessed) {
          this.onProcessed(result)
        }
      } else {
        // Schedule retry with exponential backoff
        const delay = this.retryDelayMs * Math.pow(2, item.retries - 1)
        item.nextRetryAt = Date.now() + delay

        this.log('warn', 'Item processing failed, scheduling retry', {
          id: item.id,
          retries: item.retries,
          nextRetryIn: delay,
          error: errorMessage,
        })
      }
    }
  }

  /**
   * Get queue statistics
   */
  getStats(): QueueStats {
    const stats: QueueStats = {
      total: this.items.size,
      byPriority: { high: 0, medium: 0, low: 0 },
      byType: { index: 0, remove: 0, remove_all: 0, archive: 0, reactivate: 0 },
      processing: this.processing.size,
      pendingRetry: 0,
    }

    const now = Date.now()

    for (const item of this.items.values()) {
      stats.byPriority[item.priority]++
      stats.byType[item.type]++

      if (item.nextRetryAt && item.nextRetryAt > now) {
        stats.pendingRetry++
      }
    }

    return stats
  }

  /**
   * Get all items in the queue
   */
  getItems(): WebhookQueueItem[] {
    return Array.from(this.items.values())
  }

  /**
   * Clear all items from the queue
   */
  clear(): void {
    // Clear debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer)
    }
    this.debounceTimers.clear()

    // Clear items (except those being processed)
    for (const id of this.items.keys()) {
      if (!this.processing.has(id)) {
        this.items.delete(id)
      }
    }

    this.log('info', 'Queue cleared')
  }

  /**
   * Wait for all current processing to complete
   */
  async waitForProcessing(): Promise<void> {
    if (this.processingPromise) {
      await this.processingPromise
    }

    // Wait for any remaining items being processed
    while (this.processing.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  /**
   * Set the processor function
   */
  setProcessor(processor: (item: WebhookQueueItem) => Promise<void>): void {
    this.processor = processor
  }

  /**
   * Check if queue has pending items
   */
  hasPendingItems(): boolean {
    return this.items.size > 0 || this.debounceTimers.size > 0
  }

  /**
   * Get count of items being processed
   */
  getProcessingCount(): number {
    return this.processing.size
  }
}

export default WebhookQueue
