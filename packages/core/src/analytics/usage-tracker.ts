/**
 * SMI-914: Usage Tracker
 *
 * High-level API for tracking skill usage events.
 * Handles:
 * - Start/end tracking for duration measurement
 * - User ID anonymization
 * - Context hashing
 * - Periodic cleanup of old events
 */

import { AnalyticsStorage } from './storage.js'
import { anonymizeUserId, hashProjectContext } from './anonymizer.js'
import type { SkillUsageEvent, SkillUsageOutcome, SkillMetrics } from './types.js'

/**
 * Pending tracking state
 */
interface PendingTracking {
  skillId: string
  startTime: number
  rawUserId: string
}

/**
 * UsageTracker configuration options
 */
export interface UsageTrackerOptions {
  /**
   * Custom database path (defaults to ~/.skillsmith/analytics.db)
   */
  dbPath?: string

  /**
   * Auto-cleanup interval in milliseconds (0 to disable, default: 1 hour)
   */
  cleanupInterval?: number
}

/**
 * High-level usage tracking API
 *
 * @example
 * ```typescript
 * const tracker = new UsageTracker();
 *
 * // Start tracking a skill invocation
 * const trackingId = tracker.startTracking('anthropic/commit', 'user123');
 *
 * // ... skill execution ...
 *
 * // End tracking with outcome
 * tracker.endTracking(trackingId, 'success', { framework: 'react' });
 *
 * // Get metrics
 * const metrics = tracker.getMetrics('anthropic/commit');
 *
 * // Cleanup when done
 * tracker.close();
 * ```
 */
export class UsageTracker {
  private storage: AnalyticsStorage
  private pendingEvents: Map<string, PendingTracking>
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  /**
   * Create a usage tracker instance
   *
   * @param options - Configuration options
   */
  constructor(options: UsageTrackerOptions = {}) {
    this.storage = new AnalyticsStorage(options.dbPath)
    this.pendingEvents = new Map()

    // Setup auto-cleanup (default: every hour)
    const cleanupInterval = options.cleanupInterval ?? 60 * 60 * 1000
    if (cleanupInterval > 0) {
      this.cleanupTimer = setInterval(() => this.cleanup(), cleanupInterval)
      // Don't block Node.js from exiting
      if (this.cleanupTimer.unref) {
        this.cleanupTimer.unref()
      }
    }
  }

  /**
   * Start tracking a skill invocation
   *
   * @param skillId - The skill identifier (e.g., 'anthropic/commit')
   * @param userId - Raw user identifier (will be anonymized)
   * @returns Tracking ID to use when ending tracking
   */
  startTracking(skillId: string, userId: string): string {
    const trackingId = `${skillId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    this.pendingEvents.set(trackingId, {
      skillId,
      startTime: Date.now(),
      rawUserId: userId,
    })

    return trackingId
  }

  /**
   * End tracking and record the event
   *
   * @param trackingId - The tracking ID from startTracking
   * @param outcome - The outcome of the skill invocation
   * @param context - Optional project context (will be hashed)
   */
  endTracking(
    trackingId: string,
    outcome: SkillUsageOutcome,
    context: Record<string, unknown> = {}
  ): void {
    const pending = this.pendingEvents.get(trackingId)
    if (!pending) {
      // Silently ignore unknown tracking IDs (could be from a previous session)
      return
    }

    const event: SkillUsageEvent = {
      skillId: pending.skillId,
      userId: anonymizeUserId(pending.rawUserId),
      timestamp: Date.now(),
      taskDuration: Date.now() - pending.startTime,
      outcome,
      contextHash: hashProjectContext(context),
    }

    this.storage.recordEvent(event)
    this.pendingEvents.delete(trackingId)
  }

  /**
   * Record a complete event directly (for events that don't need start/end tracking)
   *
   * @param skillId - The skill identifier
   * @param userId - Raw user identifier (will be anonymized)
   * @param taskDuration - Duration in milliseconds
   * @param outcome - The outcome
   * @param context - Optional project context
   */
  recordEvent(
    skillId: string,
    userId: string,
    taskDuration: number,
    outcome: SkillUsageOutcome,
    context: Record<string, unknown> = {}
  ): void {
    const event: SkillUsageEvent = {
      skillId,
      userId: anonymizeUserId(userId),
      timestamp: Date.now(),
      taskDuration,
      outcome,
      contextHash: hashProjectContext(context),
    }

    this.storage.recordEvent(event)
  }

  /**
   * Get metrics for a skill
   *
   * @param skillId - The skill identifier
   * @returns Aggregated metrics or null if no data
   */
  getMetrics(skillId: string): SkillMetrics | null {
    return this.storage.getMetricsForSkill(skillId)
  }

  /**
   * Get events for a skill
   *
   * @param skillId - The skill identifier
   * @param limit - Maximum number of events
   * @returns Array of usage events
   */
  getEvents(skillId: string, limit: number = 100): SkillUsageEvent[] {
    return this.storage.getEventsForSkill(skillId, limit)
  }

  /**
   * Get total event count
   *
   * @returns Number of stored events
   */
  getEventCount(): number {
    return this.storage.getEventCount()
  }

  /**
   * Get count of pending (unfinished) trackings
   *
   * @returns Number of pending trackings
   */
  getPendingCount(): number {
    return this.pendingEvents.size
  }

  /**
   * Clean up events older than 30 days
   *
   * @returns Number of deleted events
   */
  cleanup(): number {
    return this.storage.cleanup()
  }

  /**
   * Close the tracker and release resources
   */
  close(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
    this.storage.close()
  }
}
