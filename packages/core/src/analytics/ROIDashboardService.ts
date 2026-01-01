/**
 * ROIDashboardService - Epic 4: ROI Dashboard
 *
 * Implements:
 * - User ROI view with personal metrics
 * - Stakeholder aggregate view with system-wide metrics
 * - Automated data refresh and computation
 * - Export to JSON/CSV (PDF planned for future)
 */

import type { Database as DatabaseType } from 'better-sqlite3'
import { AnalyticsRepository } from './AnalyticsRepository.js'
import type { ROIDashboard, ROIMetrics, ExportFormat, UsageEvent } from './types.js'

export interface ROIComputeOptions {
  userId?: string
  skillId?: string
  startDate?: string
  endDate?: string
}

export class ROIDashboardService {
  private repo: AnalyticsRepository
  private readonly TIME_SAVED_PER_SUCCESS = 5 // minutes (configurable)
  private readonly VALUE_PER_MINUTE = 2 // USD (rough estimate)

  constructor(db: DatabaseType) {
    this.repo = new AnalyticsRepository(db)
  }

  /**
   * Get user ROI dashboard data
   */
  getUserROI(userId: string, days: number = 30): ROIDashboard['user'] {
    const { startDate, endDate } = this.getDateRange(days)

    // Get user's usage events
    const events = this.repo.getUsageEventsForUser(userId, startDate, endDate)

    // Calculate total time saved
    const totalTimeSaved = this.calculateTimeSaved(events)

    // Estimate value in USD
    const estimatedValueUsd = totalTimeSaved * this.VALUE_PER_MINUTE

    // Get top skills for this user
    const skillUsage = this.groupBySkill(events)
    const topSkills = Object.entries(skillUsage)
      .map(([skillId, skillEvents]) => ({
        skillId,
        skillName: skillId, // In production, lookup skill name from skills table
        timeSaved: this.calculateTimeSaved(skillEvents),
      }))
      .sort((a, b) => b.timeSaved - a.timeSaved)
      .slice(0, 5)

    // Calculate weekly trend
    const weeklyTrend = this.calculateWeeklyTrend(events, startDate, endDate)

    return {
      userId,
      totalTimeSaved,
      estimatedValueUsd,
      topSkills,
      weeklyTrend,
    }
  }

  /**
   * Get stakeholder aggregate ROI dashboard
   */
  getStakeholderROI(days: number = 30): ROIDashboard['stakeholder'] {
    const { startDate, endDate } = this.getDateRange(days)

    // Get ROI metrics for the period
    const metrics = this.repo.getROIMetrics('daily', startDate, endDate)

    if (metrics.length === 0) {
      // No precomputed metrics, compute on-the-fly (slower)
      return this.computeStakeholderROIOnTheFly(startDate, endDate)
    }

    // Aggregate from precomputed metrics
    const totalActivations = metrics.reduce((sum, m) => sum + m.totalActivations, 0)
    const uniqueUsers = new Set(metrics.map((m) => m.entityId).filter((id) => id !== null)).size
    const totalTimeSaved = metrics.reduce((sum, m) => sum + m.estimatedTimeSaved, 0)
    const totalEstimatedValue = metrics.reduce((sum, m) => sum + m.estimatedValueUsd, 0)
    const avgTimeSavedPerUser = uniqueUsers > 0 ? totalTimeSaved / uniqueUsers : 0

    // Calculate adoption rate (users with activations / total users)
    // In production, get total user count from user table
    const adoptionRate = 0 // Placeholder

    // Get skill leaderboard
    const skillMetrics = this.repo.getROIMetrics('skill', startDate, endDate)
    const skillLeaderboard = skillMetrics
      .map((m) => ({
        skillId: m.entityId || 'unknown',
        skillName: m.entityId || 'unknown', // Lookup from skills table
        userCount: 0, // Would need to aggregate from events
        totalValue: m.estimatedValueUsd,
      }))
      .sort((a, b) => b.totalValue - a.totalValue)
      .slice(0, 10)

    return {
      totalUsers: uniqueUsers,
      totalActivations,
      avgTimeSavedPerUser,
      totalEstimatedValue,
      adoptionRate,
      skillLeaderboard,
    }
  }

  /**
   * Compute and store ROI metrics for a period
   * This should be run periodically (e.g., daily) to maintain the dashboard
   */
  computeROIMetrics(options: ROIComputeOptions = {}): ROIMetrics[] {
    const { startDate, endDate } =
      options.startDate && options.endDate
        ? { startDate: options.startDate, endDate: options.endDate }
        : this.getDateRange(1) // Default to last day

    const computed: ROIMetrics[] = []

    if (options.userId) {
      // Compute for specific user
      const metrics = this.computeUserMetrics(options.userId, startDate, endDate)
      computed.push(this.repo.storeROIMetrics(metrics))
    } else if (options.skillId) {
      // Compute for specific skill
      const metrics = this.computeSkillMetrics(options.skillId, startDate, endDate)
      computed.push(this.repo.storeROIMetrics(metrics))
    } else {
      // Compute daily aggregate
      const metrics = this.computeDailyMetrics(startDate, endDate)
      computed.push(this.repo.storeROIMetrics(metrics))
    }

    return computed
  }

  /**
   * Export ROI dashboard data
   */
  exportROIDashboard(userId: string | null, format: ExportFormat, days: number = 30): string {
    const data = userId
      ? { user: this.getUserROI(userId, days) }
      : { stakeholder: this.getStakeholderROI(days) }

    switch (format) {
      case 'json':
        return JSON.stringify(data, null, 2)

      case 'csv':
        return this.convertROIToCSV(data)

      case 'pdf':
        throw new Error('PDF export not yet implemented')

      default:
        throw new Error(`Unsupported export format: ${format}`)
    }
  }

  /**
   * Refresh ROI metrics (run this periodically)
   */
  refreshMetrics(): void {
    const { startDate, endDate } = this.getDateRange(1)

    // Compute daily aggregate
    this.computeROIMetrics({ startDate, endDate })

    // In production, also compute per-user and per-skill metrics
  }

  // ==================== Private Helper Methods ====================

  private getDateRange(days: number): { startDate: string; endDate: string } {
    const endDate = new Date()
    const startDate = new Date(endDate)
    startDate.setDate(startDate.getDate() - days)

    return {
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
    }
  }

  private calculateTimeSaved(events: UsageEvent[]): number {
    const successCount = events.filter((e) => e.eventType === 'success').length
    return successCount * this.TIME_SAVED_PER_SUCCESS
  }

  private groupBySkill(events: UsageEvent[]): Record<string, UsageEvent[]> {
    const groups: Record<string, UsageEvent[]> = {}
    for (const event of events) {
      if (!groups[event.skillId]) {
        groups[event.skillId] = []
      }
      groups[event.skillId].push(event)
    }
    return groups
  }

  private calculateWeeklyTrend(
    events: UsageEvent[],
    startDate: string,
    endDate: string
  ): Array<{ week: string; timeSaved: number }> {
    // Group events by week
    const weeklyGroups: Record<string, UsageEvent[]> = {}

    for (const event of events) {
      const weekStart = this.getWeekStart(event.timestamp)
      if (!weeklyGroups[weekStart]) {
        weeklyGroups[weekStart] = []
      }
      weeklyGroups[weekStart].push(event)
    }

    // Calculate time saved per week
    return Object.entries(weeklyGroups)
      .map(([week, weekEvents]) => ({
        week,
        timeSaved: this.calculateTimeSaved(weekEvents),
      }))
      .sort((a, b) => a.week.localeCompare(b.week))
  }

  private getWeekStart(timestamp: string): string {
    const date = new Date(timestamp)
    const day = date.getDay()
    const diff = date.getDate() - day + (day === 0 ? -6 : 1) // Adjust for Sunday
    const weekStart = new Date(date.setDate(diff))
    return weekStart.toISOString().split('T')[0]
  }

  private computeStakeholderROIOnTheFly(
    startDate: string,
    endDate: string
  ): ROIDashboard['stakeholder'] {
    // This is a simplified version - in production, query events directly
    return {
      totalUsers: 0,
      totalActivations: 0,
      avgTimeSavedPerUser: 0,
      totalEstimatedValue: 0,
      adoptionRate: 0,
      skillLeaderboard: [],
    }
  }

  private computeUserMetrics(
    userId: string,
    startDate: string,
    endDate: string
  ): Omit<ROIMetrics, 'id' | 'createdAt'> {
    const events = this.repo.getUsageEventsForUser(userId, startDate, endDate)

    const totalActivations = events.filter((e) => e.eventType === 'activation').length
    const totalInvocations = events.filter((e) => e.eventType === 'invocation').length
    const totalSuccesses = events.filter((e) => e.eventType === 'success').length
    const totalFailures = events.filter((e) => e.eventType === 'failure').length

    const valueScores = events.filter((e) => e.valueScore != null).map((e) => e.valueScore!)
    const avgValueScore =
      valueScores.length > 0 ? valueScores.reduce((sum, s) => sum + s, 0) / valueScores.length : 0

    const estimatedTimeSaved = totalSuccesses * this.TIME_SAVED_PER_SUCCESS
    const estimatedValueUsd = estimatedTimeSaved * this.VALUE_PER_MINUTE

    return {
      metricType: 'user',
      entityId: userId,
      periodStart: startDate,
      periodEnd: endDate,
      totalActivations,
      totalInvocations,
      totalSuccesses,
      totalFailures,
      avgValueScore,
      estimatedTimeSaved,
      estimatedValueUsd,
      computedAt: new Date().toISOString(),
    }
  }

  private computeSkillMetrics(
    skillId: string,
    startDate: string,
    endDate: string
  ): Omit<ROIMetrics, 'id' | 'createdAt'> {
    const events = this.repo.getUsageEventsForSkill(skillId, startDate, endDate)

    const totalActivations = events.filter((e) => e.eventType === 'activation').length
    const totalInvocations = events.filter((e) => e.eventType === 'invocation').length
    const totalSuccesses = events.filter((e) => e.eventType === 'success').length
    const totalFailures = events.filter((e) => e.eventType === 'failure').length

    const valueScores = events.filter((e) => e.valueScore != null).map((e) => e.valueScore!)
    const avgValueScore =
      valueScores.length > 0 ? valueScores.reduce((sum, s) => sum + s, 0) / valueScores.length : 0

    const estimatedTimeSaved = totalSuccesses * this.TIME_SAVED_PER_SUCCESS
    const estimatedValueUsd = estimatedTimeSaved * this.VALUE_PER_MINUTE

    return {
      metricType: 'skill',
      entityId: skillId,
      periodStart: startDate,
      periodEnd: endDate,
      totalActivations,
      totalInvocations,
      totalSuccesses,
      totalFailures,
      avgValueScore,
      estimatedTimeSaved,
      estimatedValueUsd,
      computedAt: new Date().toISOString(),
    }
  }

  private computeDailyMetrics(
    startDate: string,
    endDate: string
  ): Omit<ROIMetrics, 'id' | 'createdAt'> {
    // In production, aggregate from all events
    // For now, return empty metrics
    return {
      metricType: 'daily',
      periodStart: startDate,
      periodEnd: endDate,
      totalActivations: 0,
      totalInvocations: 0,
      totalSuccesses: 0,
      totalFailures: 0,
      avgValueScore: 0,
      estimatedTimeSaved: 0,
      estimatedValueUsd: 0,
      computedAt: new Date().toISOString(),
    }
  }

  private convertROIToCSV(data: Partial<ROIDashboard>): string {
    const lines: string[] = []

    if (data.user) {
      lines.push('User ROI Dashboard')
      lines.push('')
      lines.push('Metric,Value')
      lines.push(`User ID,${data.user.userId}`)
      lines.push(`Total Time Saved (min),${data.user.totalTimeSaved.toFixed(1)}`)
      lines.push(`Estimated Value (USD),${data.user.estimatedValueUsd.toFixed(2)}`)
      lines.push('')
      lines.push('Top Skills')
      lines.push('Skill ID,Skill Name,Time Saved (min)')
      for (const skill of data.user.topSkills) {
        lines.push(`${skill.skillId},${skill.skillName},${skill.timeSaved.toFixed(1)}`)
      }
    }

    if (data.stakeholder) {
      lines.push('Stakeholder ROI Dashboard')
      lines.push('')
      lines.push('Metric,Value')
      lines.push(`Total Users,${data.stakeholder.totalUsers}`)
      lines.push(`Total Activations,${data.stakeholder.totalActivations}`)
      lines.push(`Avg Time Saved Per User (min),${data.stakeholder.avgTimeSavedPerUser.toFixed(1)}`)
      lines.push(`Total Estimated Value (USD),${data.stakeholder.totalEstimatedValue.toFixed(2)}`)
      lines.push(`Adoption Rate (%),${(data.stakeholder.adoptionRate * 100).toFixed(1)}`)
      lines.push('')
      lines.push('Skill Leaderboard')
      lines.push('Skill ID,Skill Name,User Count,Total Value (USD)')
      for (const skill of data.stakeholder.skillLeaderboard) {
        lines.push(
          `${skill.skillId},${skill.skillName},${skill.userCount},${skill.totalValue.toFixed(2)}`
        )
      }
    }

    return lines.join('\n')
  }
}
