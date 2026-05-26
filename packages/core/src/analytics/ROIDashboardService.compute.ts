/**
 * ROI Dashboard computation helpers — extracted from ROIDashboardService.ts
 * to keep the main service file under the 500-line governance limit.
 */

import type { AnalyticsRepository } from './AnalyticsRepository.js'
import type { ROIDashboard, ROIMetrics, UsageEvent } from './types.js'

export function calculateTimeSaved(events: UsageEvent[], timeSavedPerSuccess: number): number {
  const successCount = events.filter((e) => e.eventType === 'success').length
  return successCount * timeSavedPerSuccess
}

export function groupBySkill(events: UsageEvent[]): Record<string, UsageEvent[]> {
  const groups: Record<string, UsageEvent[]> = {}
  for (const event of events) {
    if (!groups[event.skillId]) {
      groups[event.skillId] = []
    }
    groups[event.skillId].push(event)
  }
  return groups
}

export function calculateWeeklyTrend(
  events: UsageEvent[],
  startDate: string,
  endDate: string,
  timeSavedPerSuccess: number
): Array<{ week: string; timeSaved: number }> {
  // Filter events to the requested inclusive range (SMI-1683 / GitHub #603).
  // ISO-8601 timestamps sort lexicographically, so string comparison is correct.
  const filtered = events.filter(
    (event) => event.timestamp >= startDate && event.timestamp <= endDate
  )

  // Group filtered events by week
  const weeklyGroups: Record<string, UsageEvent[]> = {}

  for (const event of filtered) {
    const weekStart = getWeekStart(event.timestamp)
    if (!weeklyGroups[weekStart]) {
      weeklyGroups[weekStart] = []
    }
    weeklyGroups[weekStart].push(event)
  }

  // Calculate time saved per week
  return Object.entries(weeklyGroups)
    .map(([week, weekEvents]) => ({
      week,
      timeSaved: calculateTimeSaved(weekEvents, timeSavedPerSuccess),
    }))
    .sort((a, b) => a.week.localeCompare(b.week))
}

function getWeekStart(timestamp: string): string {
  const date = new Date(timestamp)
  const day = date.getDay()
  const diff = date.getDate() - day + (day === 0 ? -6 : 1) // Adjust for Sunday
  const weekStart = new Date(date.setDate(diff))
  return weekStart.toISOString().split('T')[0]
}

export function computeStakeholderROIOnTheFly(
  repo: AnalyticsRepository,
  startDate: string,
  endDate: string,
  assertRange: (s: string, e: string) => void
): ROIDashboard['stakeholder'] {
  // SMI-1683 scope: validate the date range even though the on-the-fly branch
  // still returns zeroed stakeholder data. This guards callers from passing
  // malformed ranges while the event-query implementation remains deferred.
  //
  // DESCOPE: The actual event aggregation (users, activations, time saved,
  // leaderboard) lands in SMI-4296. Until then this method intentionally
  // returns a zeroed struct regardless of the events present in the range,
  // and the unit test for this branch asserts the zeroed shape to document
  // the incompleteness.
  assertRange(startDate, endDate)

  return {
    totalUsers: 0,
    totalActivations: 0,
    avgTimeSavedPerUser: 0,
    totalEstimatedValue: 0,
    adoptionRate: 0,
    skillLeaderboard: [],
  }
}

export function computeUserMetrics(
  repo: AnalyticsRepository,
  userId: string,
  startDate: string,
  endDate: string,
  timeSavedPerSuccess: number,
  valuePerMinute: number
): Omit<ROIMetrics, 'id' | 'createdAt'> {
  const events = repo.getUsageEventsForUser(userId, startDate, endDate)

  const totalActivations = events.filter((e) => e.eventType === 'activation').length
  const totalInvocations = events.filter((e) => e.eventType === 'invocation').length
  const totalSuccesses = events.filter((e) => e.eventType === 'success').length
  const totalFailures = events.filter((e) => e.eventType === 'failure').length

  const valueScores = events.filter((e) => e.valueScore != null).map((e) => e.valueScore!)
  const avgValueScore =
    valueScores.length > 0 ? valueScores.reduce((sum, s) => sum + s, 0) / valueScores.length : 0

  const estimatedTimeSaved = totalSuccesses * timeSavedPerSuccess
  const estimatedValueUsd = estimatedTimeSaved * valuePerMinute

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

export function computeSkillMetrics(
  repo: AnalyticsRepository,
  skillId: string,
  startDate: string,
  endDate: string,
  timeSavedPerSuccess: number,
  valuePerMinute: number
): Omit<ROIMetrics, 'id' | 'createdAt'> {
  const events = repo.getUsageEventsForSkill(skillId, startDate, endDate)

  const totalActivations = events.filter((e) => e.eventType === 'activation').length
  const totalInvocations = events.filter((e) => e.eventType === 'invocation').length
  const totalSuccesses = events.filter((e) => e.eventType === 'success').length
  const totalFailures = events.filter((e) => e.eventType === 'failure').length

  const valueScores = events.filter((e) => e.valueScore != null).map((e) => e.valueScore!)
  const avgValueScore =
    valueScores.length > 0 ? valueScores.reduce((sum, s) => sum + s, 0) / valueScores.length : 0

  const estimatedTimeSaved = totalSuccesses * timeSavedPerSuccess
  const estimatedValueUsd = estimatedTimeSaved * valuePerMinute

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

export function computeDailyMetrics(
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
