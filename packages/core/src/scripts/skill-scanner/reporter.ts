/**
 * SMI-1189: Reporter
 *
 * Report generation and summary output.
 */

import type { SecuritySeverity } from '../../security/index.js'
import type {
  SkillScanResult,
  SecurityReportOutput,
  QuarantineOutput,
  SafeSkillsOutput,
  FindingWithContext,
} from './types.js'
import { countBySeverity } from './categorizer.js'
import {
  calculateAverageRiskScore,
  calculateMaxRiskScore,
  getPassFailStats,
} from './trust-scorer.js'

/**
 * Log summary statistics to console
 *
 * @param results - Array of scan results
 */
export function logSummary(results: SkillScanResult[]): void {
  const total = results.length
  const { passed, quarantined } = getPassFailStats(results)
  const bySeverity = countBySeverity(results)
  const avgRiskScore = calculateAverageRiskScore(results)
  const maxRiskScore = calculateMaxRiskScore(results)

  console.log('\n' + '='.repeat(60))
  console.log('                    SCAN SUMMARY')
  console.log('='.repeat(60))
  console.log(`  Total Skills Scanned:  ${total}`)
  console.log(`  Passed (Safe):         ${passed} (${((passed / total) * 100).toFixed(1)}%)`)
  console.log(
    `  Quarantined:           ${quarantined} (${((quarantined / total) * 100).toFixed(1)}%)`
  )
  console.log()
  console.log('  By Severity:')
  console.log(`    CRITICAL:            ${bySeverity.CRITICAL}`)
  console.log(`    HIGH:                ${bySeverity.HIGH}`)
  console.log(`    MEDIUM:              ${bySeverity.MEDIUM}`)
  console.log(`    LOW:                 ${bySeverity.LOW}`)
  console.log()
  console.log(`  Average Risk Score:    ${avgRiskScore.toFixed(1)}`)
  console.log(`  Maximum Risk Score:    ${maxRiskScore}`)
  console.log('='.repeat(60) + '\n')
}

/**
 * Calculate top findings by type
 *
 * @param findings - Array of findings with context
 * @param limit - Maximum number of top findings to return
 * @returns Array of top findings with counts
 */
export function calculateTopFindings(
  findings: FindingWithContext[],
  limit: number = 10
): Array<{ type: string; count: number; severity: SecuritySeverity }> {
  const findingCounts = new Map<string, { count: number; severity: SecuritySeverity }>()

  for (const finding of findings) {
    const existing = findingCounts.get(finding.type)
    if (existing) {
      existing.count++
      // Keep the highest severity seen for this type
      if (
        finding.severity === 'critical' ||
        (finding.severity === 'high' && existing.severity !== 'critical') ||
        (finding.severity === 'medium' &&
          existing.severity !== 'critical' &&
          existing.severity !== 'high')
      ) {
        existing.severity = finding.severity
      }
    } else {
      findingCounts.set(finding.type, { count: 1, severity: finding.severity })
    }
  }

  return Array.from(findingCounts.entries())
    .map(([type, data]) => ({ type, count: data.count, severity: data.severity }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
}

/**
 * Generate the full security report
 *
 * @param results - Array of scan results
 * @param findings - Array of findings with context
 * @param inputPath - Path to the input file
 * @returns SecurityReportOutput object
 */
export function generateSecurityReport(
  results: SkillScanResult[],
  findings: FindingWithContext[],
  inputPath: string
): SecurityReportOutput {
  const total = results.length
  const { passed, quarantined } = getPassFailStats(results)
  const bySeverity = countBySeverity(results)
  const avgRiskScore = calculateAverageRiskScore(results)
  const maxRiskScore = calculateMaxRiskScore(results)
  const topFindings = calculateTopFindings(findings)

  return {
    scanDate: new Date().toISOString(),
    inputFile: inputPath,
    summary: {
      totalScanned: total,
      passed,
      quarantined,
      bySeverity,
      averageRiskScore: Math.round(avgRiskScore * 100) / 100,
      maxRiskScore,
    },
    results,
    topFindings,
  }
}

/**
 * Generate the quarantine output
 *
 * @param results - Array of quarantined scan results
 * @returns QuarantineOutput object
 */
export function generateQuarantineOutput(
  results: SkillScanResult[]
): QuarantineOutput {
  const quarantinedSkills = results.filter((r) => r.isQuarantined)

  return {
    generatedAt: new Date().toISOString(),
    reason: 'Skills with HIGH or CRITICAL security findings, or risk score >= 40',
    count: quarantinedSkills.length,
    skills: quarantinedSkills.map((r) => ({
      skillId: r.skillId,
      skillName: r.skillName,
      author: r.author,
      riskScore: r.scanReport.riskScore,
      severityCategory: r.severityCategory,
      topFindings: r.scanReport.findings
        .filter((f) => f.severity === 'critical' || f.severity === 'high')
        .slice(0, 5)
        .map((f) => `${f.type}: ${f.message}`),
    })),
  }
}

/**
 * Generate the safe skills output
 *
 * @param results - Array of scan results
 * @returns SafeSkillsOutput object
 */
export function generateSafeSkillsOutput(
  results: SkillScanResult[]
): SafeSkillsOutput {
  const safeSkills = results.filter((r) => !r.isQuarantined)

  return {
    generatedAt: new Date().toISOString(),
    count: safeSkills.length,
    skills: safeSkills.map((r) => ({
      skillId: r.skillId,
      skillName: r.skillName,
      author: r.author,
      source: r.source,
      riskScore: r.scanReport.riskScore,
    })),
  }
}

/**
 * Log recommendations based on scan results
 *
 * @param results - Array of scan results
 * @param criticalCount - Number of critical findings
 */
export function logRecommendations(
  results: SkillScanResult[],
  criticalCount: number
): void {
  const { passed, quarantined } = getPassFailStats(results)

  console.log('RECOMMENDATIONS:')
  if (quarantined > 0) {
    console.log(`  - ${quarantined} skills have been quarantined`)
    console.log('  - Review quarantine-skills.json for manual triage')
    console.log('  - Critical/high findings require security review before import')
  }
  if (criticalCount > 0) {
    console.log(`  - ${criticalCount} CRITICAL findings detected`)
    console.log('  - These skills should NOT be imported without thorough review')
  }
  if (passed > 0) {
    console.log(`  - ${passed} skills passed security checks`)
    console.log('  - These are ready for import from safe-skills.json')
  }
  console.log()
}
