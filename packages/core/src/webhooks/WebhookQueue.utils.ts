/**
 * SMI-645: WebhookQueue Utilities
 *
 * Utility constants and functions for the webhook queue system.
 */

import type { QueuePriority } from './WebhookQueue.types.js'

/**
 * Priority values for sorting
 * Higher values = higher priority
 */
export const PRIORITY_VALUES: Record<QueuePriority, number> = {
  high: 3,
  medium: 2,
  low: 1,
}

/**
 * Compare two queue items by priority
 * Returns negative if a has higher priority, positive if b has higher priority
 */
export function comparePriority(a: QueuePriority, b: QueuePriority): number {
  return PRIORITY_VALUES[b] - PRIORITY_VALUES[a]
}

/**
 * Calculate priority score for an item
 * Takes into account priority level and age
 *
 * @param priority - The priority level
 * @param timestamp - The item's creation timestamp
 * @param now - Current timestamp (default: Date.now())
 * @returns Combined priority score
 */
export function calculatePriorityScore(
  priority: QueuePriority,
  timestamp: number,
  now: number = Date.now()
): number {
  const priorityScore = PRIORITY_VALUES[priority]
  // Prefer older items with same priority (age bonus in minutes)
  const ageBonus = (now - timestamp) / (1000 * 60)
  return priorityScore * 1000 + ageBonus
}

/**
 * Calculate exponential backoff delay
 *
 * @param baseDelayMs - Base delay in milliseconds
 * @param retryCount - Current retry attempt (1-based)
 * @returns Delay in milliseconds
 */
export function calculateRetryDelay(baseDelayMs: number, retryCount: number): number {
  return baseDelayMs * Math.pow(2, retryCount - 1)
}

/**
 * Generate a debounce key for a queue item
 * Used to deduplicate rapid updates to the same file
 *
 * @param repoFullName - Repository full name (owner/repo)
 * @param filePath - Path to the file
 * @returns Debounce key string
 */
export function generateDebounceKey(repoFullName: string, filePath: string): string {
  return `${repoFullName}:${filePath}`
}
