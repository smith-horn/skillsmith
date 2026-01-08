/**
 * SMI-1189: Skill Categorizer
 *
 * Skill categorization and severity determination logic.
 */

import type { SecurityFinding } from '../../security/index.js'
import type { SeverityCategory } from './types.js'

// Re-export for convenience
export type { SeverityCategory }

/**
 * Determines the severity category based on the highest severity finding
 *
 * @param findings - Array of security findings
 * @returns The highest severity category found
 */
export function determineSeverityCategory(findings: SecurityFinding[]): SeverityCategory {
  if (findings.some((f) => f.severity === 'critical')) return 'CRITICAL'
  if (findings.some((f) => f.severity === 'high')) return 'HIGH'
  if (findings.some((f) => f.severity === 'medium')) return 'MEDIUM'
  return 'LOW'
}

/**
 * Initialize empty severity counts
 *
 * @returns Record with all severity categories set to 0
 */
export function initializeSeverityCounts(): Record<SeverityCategory, number> {
  return {
    CRITICAL: 0,
    HIGH: 0,
    MEDIUM: 0,
    LOW: 0,
  }
}

/**
 * Count skills by severity category
 *
 * @param results - Array of scan results with severity categories
 * @returns Record mapping severity categories to counts
 */
export function countBySeverity(
  results: Array<{ severityCategory: SeverityCategory }>
): Record<SeverityCategory, number> {
  const counts = initializeSeverityCounts()

  for (const result of results) {
    counts[result.severityCategory]++
  }

  return counts
}

/**
 * Sort severity categories by priority (most severe first)
 */
export const SEVERITY_PRIORITY: SeverityCategory[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']

/**
 * Compare two severity categories
 *
 * @param a - First severity category
 * @param b - Second severity category
 * @returns Negative if a is more severe, positive if b is more severe
 */
export function compareSeverity(a: SeverityCategory, b: SeverityCategory): number {
  return SEVERITY_PRIORITY.indexOf(a) - SEVERITY_PRIORITY.indexOf(b)
}
