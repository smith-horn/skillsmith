/**
 * SMI-645: WebhookQueue Types
 *
 * Type definitions for the webhook event queue system:
 * - Queue item types and priorities
 * - Processing results and statistics
 * - Queue configuration options
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
