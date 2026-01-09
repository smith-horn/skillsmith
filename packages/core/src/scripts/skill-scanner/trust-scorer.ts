/**
 * SMI-1189: Trust Scorer
 *
 * Trust score calculation and quarantine decision logic.
 */

import type { ScanReport } from '../../security/index.js'

/**
 * Configuration for trust scoring
 */
export interface TrustScorerConfig {
  /** Risk threshold for quarantine (skills at or above this are quarantined) */
  quarantineThreshold: number
}

/** Default trust scorer configuration */
export const DEFAULT_TRUST_CONFIG: TrustScorerConfig = {
  quarantineThreshold: 40,
}

/**
 * Determines if a skill should be quarantined based on findings
 *
 * A skill is quarantined if:
 * 1. Has critical or high severity findings
 * 2. Risk score exceeds threshold
 * 3. Scan failed (passed = false)
 *
 * @param report - The scan report for the skill
 * @param config - Trust scorer configuration
 * @returns true if the skill should be quarantined
 */
export function shouldQuarantine(
  report: ScanReport,
  config: TrustScorerConfig = DEFAULT_TRUST_CONFIG
): boolean {
  return (
    !report.passed ||
    report.riskScore >= config.quarantineThreshold ||
    report.findings.some((f) => f.severity === 'critical' || f.severity === 'high')
  )
}

/**
 * Calculate average risk score from results
 *
 * @param results - Array of scan results with risk scores
 * @returns Average risk score (0 if no results)
 */
export function calculateAverageRiskScore(results: Array<{ scanReport: ScanReport }>): number {
  const total = results.length
  if (total === 0) return 0

  const sum = results.reduce((acc, r) => acc + r.scanReport.riskScore, 0)
  return sum / total
}

/**
 * Calculate maximum risk score from results
 *
 * @param results - Array of scan results with risk scores
 * @returns Maximum risk score (0 if no results)
 */
export function calculateMaxRiskScore(results: Array<{ scanReport: ScanReport }>): number {
  if (results.length === 0) return 0
  return Math.max(...results.map((r) => r.scanReport.riskScore))
}

/**
 * Get pass/fail statistics from results
 *
 * @param results - Array of scan results
 * @returns Object with passed and quarantined counts
 */
export function getPassFailStats(results: Array<{ isQuarantined: boolean }>): {
  passed: number
  quarantined: number
} {
  const passed = results.filter((r) => !r.isQuarantined).length
  const quarantined = results.filter((r) => r.isQuarantined).length

  return { passed, quarantined }
}
