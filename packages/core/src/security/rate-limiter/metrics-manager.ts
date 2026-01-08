/**
 * Rate Limit Metrics Manager - SMI-730, SMI-1189
 *
 * Metrics tracking and management for rate limiting.
 */

import type { RateLimitMetrics } from './types.js'
import { MAX_UNIQUE_KEYS, METRICS_TTL_MS } from './constants.js'

/**
 * Manages rate limit metrics with bounds checking and cleanup
 */
export class MetricsManager {
  private readonly metrics: Map<string, RateLimitMetrics> = new Map()
  private cleanupInterval: NodeJS.Timeout | null = null
  private readonly debug: boolean
  private readonly log: { debug: (msg: string) => void }

  constructor(debug = false, log?: { debug: (msg: string) => void }) {
    this.debug = debug
    this.log = log || { debug: () => {} }
  }

  /**
   * Start periodic cleanup of stale metrics
   */
  startCleanup(): void {
    // Clean up stale metrics every 5 minutes
    this.cleanupInterval = setInterval(
      () => {
        this.cleanupStaleMetrics()
      },
      5 * 60 * 1000
    )
  }

  /**
   * Stop metrics cleanup
   */
  stopCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
  }

  /**
   * Clean up metrics older than METRICS_TTL_MS
   */
  private cleanupStaleMetrics(): void {
    const now = new Date()
    let cleaned = 0

    for (const [key, metrics] of this.metrics.entries()) {
      if (now.getTime() - metrics.lastUpdated.getTime() > METRICS_TTL_MS) {
        this.metrics.delete(key)
        cleaned++
      }
    }

    // Also enforce MAX_UNIQUE_KEYS limit if somehow exceeded
    if (this.metrics.size > MAX_UNIQUE_KEYS) {
      // Sort by lastUpdated and remove oldest entries
      const entries = Array.from(this.metrics.entries()).sort(
        (a, b) => a[1].lastUpdated.getTime() - b[1].lastUpdated.getTime()
      )
      const toRemove = entries.slice(0, this.metrics.size - MAX_UNIQUE_KEYS)
      for (const [key] of toRemove) {
        this.metrics.delete(key)
        cleaned++
      }
    }

    if (cleaned > 0 && this.debug) {
      this.log.debug(`Cleaned up ${cleaned} stale metric entries`)
    }
  }

  /**
   * Update metrics for a key with bounds checking
   */
  update(key: string, allowed: boolean, error = false): void {
    // Check if we've hit the max unique keys limit
    if (!this.metrics.has(key) && this.metrics.size >= MAX_UNIQUE_KEYS) {
      // Evict oldest entry before adding new one
      let oldestKey: string | null = null
      let oldestTime = Infinity

      for (const [k, m] of this.metrics.entries()) {
        if (m.lastUpdated.getTime() < oldestTime) {
          oldestTime = m.lastUpdated.getTime()
          oldestKey = k
        }
      }

      if (oldestKey) {
        this.metrics.delete(oldestKey)
        if (this.debug) {
          this.log.debug(`Evicted oldest metrics entry: ${oldestKey}`)
        }
      }
    }

    const now = new Date()
    const existing = this.metrics.get(key) || {
      allowed: 0,
      blocked: 0,
      errors: 0,
      lastReset: now,
      lastUpdated: now,
    }

    if (error) {
      existing.errors++
      // Also track allowed/blocked for error cases (fail-open vs fail-closed)
      if (allowed) {
        existing.allowed++
      } else {
        existing.blocked++
      }
    } else if (allowed) {
      existing.allowed++
    } else {
      existing.blocked++
    }

    existing.lastUpdated = now
    this.metrics.set(key, existing)
  }

  /**
   * Get metrics for a specific key
   */
  get(key: string): RateLimitMetrics | undefined {
    return this.metrics.get(key)
  }

  /**
   * Get all metrics
   */
  getAll(): Map<string, RateLimitMetrics> {
    return new Map(this.metrics)
  }

  /**
   * Delete metrics for a key
   */
  delete(key: string): void {
    this.metrics.delete(key)
  }

  /**
   * Clear all metrics
   */
  clear(): void {
    this.metrics.clear()
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    this.stopCleanup()
    this.clear()
  }
}
