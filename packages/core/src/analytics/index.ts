/**
 * Analytics Module - Phase 4 Product Strategy
 *
 * Exports all analytics infrastructure for:
 * - Epic 3: Skill usage attribution and tracking
 * - Epic 4: A/B testing and experimentation
 * - Epic 4: ROI metrics and dashboards
 * - SMI-914: Skill usage event tracking with anonymization
 */

export * from './types.js'
export * from './schema.js'
export * from './AnalyticsRepository.js'
export * from './UsageAnalyticsService.js'
export * from './ExperimentService.js'
export * from './ROIDashboardService.js'

// SMI-914: Skill usage event tracking
export * from './anonymizer.js'
export { AnalyticsStorage } from './storage.js'
export { UsageTracker, type UsageTrackerOptions } from './usage-tracker.js'
