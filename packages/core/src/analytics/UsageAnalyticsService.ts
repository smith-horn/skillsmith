/**
 * UsageAnalyticsService - Epic 3: Attribution During Use
 *
 * Implements:
 * - Local SQLite analytics storage
 * - Usage tracking API with 30-day rolling window
 * - Export functionality (JSON, CSV)
 * - Value summary reports
 */

import type { Database as DatabaseType } from 'better-sqlite3'
import { AnalyticsRepository } from './AnalyticsRepository.js'
import type { UsageEvent, UsageEventInput, UsageAnalyticsSummary, ExportFormat } from './types.js'

export interface UsageStatsOptions {
  startDate?: string
  endDate?: string
  skillId?: string
  userId?: string
}

export class UsageAnalyticsService {
  private repo: AnalyticsRepository
  private readonly RETENTION_DAYS = 30

  constructor(db: DatabaseType) {
    this.repo = new AnalyticsRepository(db)
  }

  /**
   * Track a skill usage event
   */
  trackUsage(input: UsageEventInput): UsageEvent {
    return this.repo.recordUsageEvent(input)
  }

  /**
   * Get usage summary for a time period (defaults to last 30 days)
   */
  getUsageSummary(options: UsageStatsOptions = {}): UsageAnalyticsSummary {
    const { startDate, endDate, skillId, userId } = this.getDateRange(options)

    // Get all events in the period
    let events: UsageEvent[]
    if (skillId) {
      events = this.repo.getUsageEventsForSkill(skillId, startDate, endDate)
    } else if (userId) {
      events = this.repo.getUsageEventsForUser(userId, startDate, endDate)
    } else {
      // Get all events (for stakeholder view)
      events = this.getAllEvents(startDate, endDate)
    }

    // Calculate statistics
    const eventsByType = this.groupEventsByType(events)
    const uniqueUsers = new Set(events.map((e) => e.userId)).size
    const uniqueSkills = new Set(events.map((e) => e.skillId)).size
    const avgValueScore = this.calculateAverageValueScore(events)
    const topSkills = this.getTopSkills(events, 10)

    return {
      periodStart: startDate,
      periodEnd: endDate,
      totalEvents: events.length,
      eventsByType,
      uniqueUsers,
      uniqueSkills,
      avgValueScore,
      topSkills,
    }
  }

  /**
   * Get weekly digest for a user
   */
  getWeeklyDigest(userId: string): UsageAnalyticsSummary {
    const endDate = new Date()
    const startDate = new Date(endDate)
    startDate.setDate(startDate.getDate() - 7)

    return this.getUsageSummary({
      userId,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
    })
  }

  /**
   * Get monthly summary for a user
   */
  getMonthlySummary(userId: string): UsageAnalyticsSummary {
    const endDate = new Date()
    const startDate = new Date(endDate)
    startDate.setDate(startDate.getDate() - 30)

    return this.getUsageSummary({
      userId,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
    })
  }

  /**
   * Export usage data in specified format
   */
  exportUsageData(options: UsageStatsOptions & { format: ExportFormat }): string {
    const summary = this.getUsageSummary(options)

    switch (options.format) {
      case 'json':
        return JSON.stringify(summary, null, 2)

      case 'csv':
        return this.convertToCSV(summary)

      case 'pdf':
        throw new Error('PDF export not yet implemented. Use json or csv format.')

      default:
        throw new Error(`Unsupported export format: ${options.format}`)
    }
  }

  /**
   * Clean up events older than retention period
   */
  cleanupOldData(): number {
    return this.repo.cleanupOldEvents(this.RETENTION_DAYS)
  }

  // ==================== Private Helper Methods ====================

  private getDateRange(options: UsageStatsOptions): {
    startDate: string
    endDate: string
    skillId?: string
    userId?: string
  } {
    const endDate = options.endDate || new Date().toISOString()
    let startDate = options.startDate

    if (!startDate) {
      const date = new Date(endDate)
      date.setDate(date.getDate() - this.RETENTION_DAYS)
      startDate = date.toISOString()
    }

    return {
      startDate,
      endDate,
      skillId: options.skillId,
      userId: options.userId,
    }
  }

  private getAllEvents(startDate: string, endDate: string): UsageEvent[] {
    return this.repo.getAllUsageEvents(startDate, endDate)
  }

  private groupEventsByType(events: UsageEvent[]): Record<string, number> {
    const groups: Record<string, number> = {
      activation: 0,
      invocation: 0,
      success: 0,
      failure: 0,
    }

    for (const event of events) {
      groups[event.eventType] = (groups[event.eventType] || 0) + 1
    }

    return groups
  }

  private calculateAverageValueScore(events: UsageEvent[]): number {
    // Filter events that have a valid valueScore (not null or undefined)
    const eventsWithScore = events.filter((e) => e.valueScore != null)
    if (eventsWithScore.length === 0) return 0

    const sum = eventsWithScore.reduce((acc, e) => acc + (e.valueScore || 0), 0)
    return sum / eventsWithScore.length
  }

  private getTopSkills(
    events: UsageEvent[],
    limit: number
  ): Array<{ skillId: string; count: number }> {
    const counts = new Map<string, number>()

    for (const event of events) {
      counts.set(event.skillId, (counts.get(event.skillId) || 0) + 1)
    }

    return Array.from(counts.entries())
      .map(([skillId, count]) => ({ skillId, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit)
  }

  private convertToCSV(summary: UsageAnalyticsSummary): string {
    const lines: string[] = []

    // Header
    lines.push('Metric,Value')

    // Summary stats
    lines.push(`Period Start,${summary.periodStart}`)
    lines.push(`Period End,${summary.periodEnd}`)
    lines.push(`Total Events,${summary.totalEvents}`)
    lines.push(`Unique Users,${summary.uniqueUsers}`)
    lines.push(`Unique Skills,${summary.uniqueSkills}`)
    lines.push(`Average Value Score,${summary.avgValueScore.toFixed(2)}`)

    // Events by type
    lines.push('')
    lines.push('Event Type,Count')
    for (const [type, count] of Object.entries(summary.eventsByType)) {
      lines.push(`${type},${count}`)
    }

    // Top skills
    lines.push('')
    lines.push('Skill ID,Usage Count')
    for (const { skillId, count } of summary.topSkills) {
      lines.push(`${skillId},${count}`)
    }

    return lines.join('\n')
  }
}
