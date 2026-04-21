/**
 * SMI-1189: Trust Scorer
 * SMI-4396: Allowlist-aware quarantine predicate.
 *
 * Trust score calculation and quarantine decision logic.
 */

import type { ScanReport } from '../../security/index.js'
import { calculateRiskScore } from '../../security/scanner/SecurityScanner.helpers.js'
import type { AllowlistMatcher } from './types.js'

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
 * Determines if a skill should be quarantined based on findings.
 *
 * SMI-4396: when an allowlist matcher is provided, findings the matcher
 * approves are removed BEFORE the quarantine check runs, and the risk score
 * is recomputed from the filtered set rather than trusting report.riskScore
 * (which was computed pre-allowlist inside SecurityScanner.scan).
 *
 * !report.passed is intentionally NOT part of the predicate: `passed` is
 * also computed pre-allowlist, so keeping it here would re-quarantine every
 * allowlisted skill whose raw scan had critical/high findings — defeating
 * the allowlist's purpose. The new two-clause predicate still covers the old
 * semantics: any scan that was `passed: false` must have had at least one
 * critical/high finding OR score >= threshold, both of which are still caught.
 *
 * A skill is quarantined if ANY of:
 * 1. Post-allowlist findings contain a critical or high severity entry
 * 2. Post-allowlist risk score >= quarantineThreshold
 *
 * @param report - The scan report for the skill
 * @param config - Trust scorer configuration
 * @param allowlist - Optional per-skill allowlist (SMI-4396)
 * @returns true if the skill should be quarantined
 */
export function shouldQuarantine(
  report: ScanReport,
  config: TrustScorerConfig = DEFAULT_TRUST_CONFIG,
  allowlist?: AllowlistMatcher
): boolean {
  const effectiveFindings = allowlist
    ? report.findings.filter((f) => !allowlist.isAllowed(report.skillId, f))
    : report.findings

  if (effectiveFindings.some((f) => f.severity === 'critical' || f.severity === 'high')) {
    return true
  }

  const effectiveRisk = calculateRiskScore(effectiveFindings).total
  return effectiveRisk >= config.quarantineThreshold
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
