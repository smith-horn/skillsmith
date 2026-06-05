/**
 * ROIDashboardService - Epic 4: ROI Dashboard
 *
 * Implements:
 * - User ROI view with personal metrics
 * - Stakeholder aggregate view with system-wide metrics
 * - Automated data refresh and computation
 * - Export to JSON/CSV (PDF planned for future)
 */

import type { Database as DatabaseType } from '../db/database-interface.js'
import { ValidationError } from '../validation/validation-error.js'
import { AnalyticsRepository } from './AnalyticsRepository.js'
import { convertROIToCSV } from './ROIDashboardService.csv.js'
import {
  calculateTimeSaved,
  groupBySkill,
  calculateWeeklyTrend,
  computeStakeholderROIOnTheFly,
  computeUserMetrics,
  computeSkillMetrics,
  computeDailyMetrics,
} from './ROIDashboardService.compute.js'
import type { ROIDashboard, ROIMetrics, ExportFormat } from './types.js'

export interface ROIComputeOptions {
  userId?: string
  skillId?: string
  startDate?: string
  endDate?: string
}

/**
 * Options for the public {@link ROIDashboardService.getDashboard} entrypoint.
 * Both dates must be provided together (or neither, which defaults to the last 30 days).
 */
export interface GetDashboardOptions {
  userId?: string
  startDate?: string
  endDate?: string
}

/** Default window applied by {@link ROIDashboardService.getDashboard} when both dates are omitted. */
const DEFAULT_DASHBOARD_WINDOW_DAYS = 30

/**
 * Strict ISO-8601 / RFC-3339 profile matcher (SMI-4317). Accepts `YYYY-MM-DD`
 * and `YYYY-MM-DDTHH:MM:SS(.sss)?(Z|[+-]HH:MM)`; rejects RFC-2822, slash
 * separators, space-as-T, bare date-time without offset, and any trailing
 * content. Syntactic guard only — calendar validity (e.g., `2026-13-01`) is
 * caught by the paired `Date.parse` check. Exported for tests/reuse.
 */
export const ISO_8601_STRICT =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2}))?$/

export class ROIDashboardService {
  private repo: AnalyticsRepository
  private readonly TIME_SAVED_PER_SUCCESS = 5 // minutes (configurable)
  private readonly VALUE_PER_MINUTE = 2 // USD (rough estimate)

  constructor(db: DatabaseType) {
    this.repo = new AnalyticsRepository(db)
  }

  /**
   * Get user ROI dashboard data for a rolling window (last `days` days).
   * For an explicit ISO-8601 range, use {@link getDashboard}.
   */
  getUserROI(userId: string, days: number = 30): ROIDashboard['user'] {
    const { startDate, endDate } = this.getDateRange(days)
    return this.buildUserROI(userId, startDate, endDate)
  }

  /**
   * Core per-user ROI computation over an explicit ISO-8601 range.
   * Shared between {@link getUserROI} (days-based) and {@link getDashboard}.
   */
  private buildUserROI(userId: string, startDate: string, endDate: string): ROIDashboard['user'] {
    // Get user's usage events
    const events = this.repo.getUsageEventsForUser(userId, startDate, endDate)

    // Calculate total time saved
    const totalTimeSaved = calculateTimeSaved(events, this.TIME_SAVED_PER_SUCCESS)

    // Estimate value in USD
    const estimatedValueUsd = totalTimeSaved * this.VALUE_PER_MINUTE

    // Get top skills for this user
    const skillUsage = groupBySkill(events)
    const topSkills = Object.entries(skillUsage)
      .map(([skillId, skillEvents]) => ({
        skillId,
        skillName: skillId, // In production, lookup skill name from skills table
        timeSaved: calculateTimeSaved(skillEvents, this.TIME_SAVED_PER_SUCCESS),
      }))
      .sort((a, b) => b.timeSaved - a.timeSaved)
      .slice(0, 5)

    // Calculate weekly trend (filtered to [startDate, endDate])
    const weeklyTrend = calculateWeeklyTrend(
      events,
      startDate,
      endDate,
      this.TIME_SAVED_PER_SUCCESS
    )

    return {
      userId,
      totalTimeSaved,
      estimatedValueUsd,
      topSkills,
      weeklyTrend,
    }
  }

  /**
   * Get stakeholder aggregate ROI dashboard for a rolling window (last `days` days).
   * For an explicit ISO-8601 range, use {@link getDashboard}.
   */
  getStakeholderROI(days: number = 30): ROIDashboard['stakeholder'] {
    const { startDate, endDate } = this.getDateRange(days)
    return this.buildStakeholderROI(startDate, endDate)
  }

  /**
   * Core stakeholder ROI computation over an explicit ISO-8601 range.
   * Shared between {@link getStakeholderROI} (days-based) and {@link getDashboard}.
   */
  private buildStakeholderROI(startDate: string, endDate: string): ROIDashboard['stakeholder'] {
    // Get ROI metrics for the period
    const metrics = this.repo.getROIMetrics('daily', startDate, endDate)

    if (metrics.length === 0) {
      // No precomputed metrics, compute on-the-fly (slower)
      return computeStakeholderROIOnTheFly(this.repo, startDate, endDate, (a, b) =>
        this.assertValidRange(a, b)
      )
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
   * Public date-range-aware dashboard entrypoint (SMI-1683 / GitHub #603).
   *
   * Behavior:
   * - Both dates omitted: defaults to the last 30 days ending now.
   * - Exactly one date provided: throws {@link ValidationError} (the range is ambiguous).
   * - `startDate >= endDate`: throws {@link ValidationError}.
   * - `userId` provided: returns `{ user }` with date-filtered per-user metrics.
   * - `userId` omitted: returns `{ stakeholder }` aggregated over the range.
   *
   * @param options.userId    Optional — when supplied, returns the per-user dashboard.
   * @param options.startDate Optional ISO-8601 timestamp; must be paired with `endDate`.
   * @param options.endDate   Optional ISO-8601 timestamp; must be paired with `startDate`.
   */
  getDashboard(options: GetDashboardOptions = {}): ROIDashboard {
    const { startDate, endDate } = this.resolveDashboardRange(options.startDate, options.endDate)

    if (options.userId) {
      return { user: this.buildUserROI(options.userId, startDate, endDate) }
    }

    return { stakeholder: this.buildStakeholderROI(startDate, endDate) }
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
      const metrics = computeUserMetrics(
        this.repo,
        options.userId,
        startDate,
        endDate,
        this.TIME_SAVED_PER_SUCCESS,
        this.VALUE_PER_MINUTE
      )
      computed.push(this.repo.storeROIMetrics(metrics))
    } else if (options.skillId) {
      // Compute for specific skill
      const metrics = computeSkillMetrics(
        this.repo,
        options.skillId,
        startDate,
        endDate,
        this.TIME_SAVED_PER_SUCCESS,
        this.VALUE_PER_MINUTE
      )
      computed.push(this.repo.storeROIMetrics(metrics))
    } else {
      // Compute daily aggregate
      const metrics = computeDailyMetrics(startDate, endDate)
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
        return convertROIToCSV(data)

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

  private getDateRange(days: number): { startDate: string; endDate: string } {
    // SMI-4317: fail fast on non-positive-integer `days`. Without this guard,
    // `getUserROI(userId, -5)` silently inverts the range (start > end), which
    // downstream either yields empty results or throws a confusing
    // "startDate must be before endDate" error.
    if (!Number.isFinite(days) || !Number.isInteger(days) || days <= 0) {
      throw new ValidationError('days must be a positive integer', 'INVALID_DATE_RANGE')
    }

    const endDate = new Date()
    const startDate = new Date(endDate)
    startDate.setDate(startDate.getDate() - days)

    return {
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
    }
  }

  /**
   * Resolve the range for {@link getDashboard}: default to last 30 days when both
   * dates are omitted, validate that exactly-one-date was not supplied, and enforce
   * `startDate < endDate`.
   */
  private resolveDashboardRange(
    startDate: string | undefined,
    endDate: string | undefined
  ): { startDate: string; endDate: string } {
    if (startDate === undefined && endDate === undefined) {
      return this.getDateRange(DEFAULT_DASHBOARD_WINDOW_DAYS)
    }

    if (startDate === undefined || endDate === undefined) {
      throw new ValidationError(
        'Must provide both startDate and endDate, or neither',
        'INVALID_DATE_RANGE'
      )
    }

    this.assertValidRange(startDate, endDate)
    return { startDate, endDate }
  }

  /**
   * Throw a typed {@link ValidationError} when the supplied range is malformed.
   *
   * Validation layers (SMI-4317):
   * 1. Strict ISO-8601 / RFC-3339 regex — rejects shapes like `2026/01/01`,
   *    `2026-01-01 00:00:00` (space), `Jan 1 2026`, or RFC-2822 that
   *    `Date.parse` would otherwise accept.
   * 2. `Date.parse` NaN check — catches syntactically valid but semantically
   *    invalid dates (e.g., `2026-13-01`) that the regex cannot detect.
   * 3. Ordering — rejects when `startDate >= endDate`.
   */
  private assertValidRange(startDate: string, endDate: string): void {
    if (!ISO_8601_STRICT.test(startDate) || !ISO_8601_STRICT.test(endDate)) {
      throw new ValidationError(
        'startDate and endDate must be strict ISO-8601 timestamps (YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS[.sss][Z|±HH:MM])',
        'INVALID_DATE_RANGE'
      )
    }

    const start = Date.parse(startDate)
    const end = Date.parse(endDate)

    if (Number.isNaN(start) || Number.isNaN(end)) {
      throw new ValidationError(
        'startDate and endDate must be parseable ISO-8601 timestamps',
        'INVALID_DATE_RANGE'
      )
    }

    if (start >= end) {
      throw new ValidationError(
        'Invalid range: startDate must be before endDate',
        'INVALID_DATE_RANGE'
      )
    }
  }
}
