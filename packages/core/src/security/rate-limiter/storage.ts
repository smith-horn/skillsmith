/**
 * Rate Limiter Storage - SMI-730, SMI-1189
 *
 * Storage implementations for rate limiting.
 */

import { createLogger } from '../../utils/logger.js'
import type { RateLimitStorage, TokenBucket } from './types.js'

const log = createLogger('RateLimiter')

/**
 * In-memory storage implementation
 */
export class InMemoryRateLimitStorage implements RateLimitStorage {
  private store = new Map<string, { bucket: TokenBucket; expiresAt: number }>()
  private cleanupInterval: NodeJS.Timeout | null = null

  constructor(cleanupIntervalMs = 60000) {
    // Periodic cleanup of expired entries
    this.cleanupInterval = setInterval(() => {
      this.cleanup()
    }, cleanupIntervalMs)
  }

  async get(key: string): Promise<TokenBucket | null> {
    const entry = this.store.get(key)
    if (!entry) return null

    // Check expiration
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key)
      return null
    }

    return entry.bucket
  }

  async set(key: string, value: TokenBucket, ttlMs: number): Promise<void> {
    this.store.set(key, {
      bucket: value,
      expiresAt: Date.now() + ttlMs,
    })
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key)
  }

  async clear(): Promise<void> {
    this.store.clear()
  }

  /**
   * Clean up expired entries
   */
  private cleanup(): void {
    const now = Date.now()
    let cleaned = 0

    // Use Array.from to avoid downlevelIteration requirement
    Array.from(this.store.entries()).forEach(([key, entry]) => {
      if (now > entry.expiresAt) {
        this.store.delete(key)
        cleaned++
      }
    })

    if (cleaned > 0) {
      log.debug(`Cleaned up ${cleaned} expired rate limit entries`)
    }
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
    this.store.clear()
  }

  /**
   * Get storage stats (for testing/monitoring)
   */
  getStats(): { size: number; keys: string[] } {
    return {
      size: this.store.size,
      keys: Array.from(this.store.keys()),
    }
  }
}
