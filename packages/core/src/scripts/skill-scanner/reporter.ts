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
 * ANSI color codes for terminal output
 */
const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
}

/**
 * Check if colors should be used
 */
function useColors(): boolean {
  return process.stdout.isTTY && !process.env.CI && !process.env.NO_COLOR
}

/**
 * Apply color to text if colors are enabled
 */
function colorize(text: string, color: keyof typeof COLORS): string {
  return useColors() ? `${COLORS[color]}${text}${COLORS.reset}` : text
}

/**
 * Create a visual bar for statistics
 */
function createStatBar(value: number, total: number, width: number = 20): string {
  const percentage = total > 0 ? value / total : 0
  const filled = Math.round(width * percentage)
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled)
  return bar
}

/**
 * Log summary statistics to console with improved formatting
 *
 * @param results - Array of scan results
 */
export function logSummary(results: SkillScanResult[]): void {
  const total = results.length
  const { passed, quarantined } = getPassFailStats(results)
  const bySeverity = countBySeverity(results)
  const avgRiskScore = calculateAverageRiskScore(results)
  const maxRiskScore = calculateMaxRiskScore(results)

  const border = '═'.repeat(60)
  const thinBorder = '─'.repeat(60)

  console.log()
  console.log(colorize(border, 'cyan'))
  console.log(colorize('                    SCAN SUMMARY', 'bold'))
  console.log(colorize(border, 'cyan'))
  console.log()

  // Main stats with visual bars
  const passedPct = total > 0 ? ((passed / total) * 100).toFixed(1) : '0.0'
  const quarantinedPct = total > 0 ? ((quarantined / total) * 100).toFixed(1) : '0.0'

  console.log(`  ${colorize('Total Skills Scanned:', 'bold')}  ${total}`)
  console.log()
  console.log(
    `  ${colorize('Safe (Passed):', 'green')}         ${passed.toString().padStart(4)} ${createStatBar(passed, total)} ${passedPct}%`
  )
  console.log(
    `  ${colorize('Quarantined:', 'red')}           ${quarantined.toString().padStart(4)} ${createStatBar(quarantined, total)} ${quarantinedPct}%`
  )
  console.log()
  console.log(colorize(thinBorder, 'dim'))
  console.log()

  // Severity breakdown
  console.log(`  ${colorize('By Severity:', 'bold')}`)
  console.log()
  console.log(
    `    ${colorize('CRITICAL:', 'red')}  ${bySeverity.CRITICAL.toString().padStart(4)} ${createStatBar(bySeverity.CRITICAL, total, 15)}`
  )
  console.log(
    `    ${colorize('HIGH:', 'magenta')}      ${bySeverity.HIGH.toString().padStart(4)} ${createStatBar(bySeverity.HIGH, total, 15)}`
  )
  console.log(
    `    ${colorize('MEDIUM:', 'yellow')}    ${bySeverity.MEDIUM.toString().padStart(4)} ${createStatBar(bySeverity.MEDIUM, total, 15)}`
  )
  console.log(
    `    ${colorize('LOW:', 'cyan')}       ${bySeverity.LOW.toString().padStart(4)} ${createStatBar(bySeverity.LOW, total, 15)}`
  )
  console.log()
  console.log(colorize(thinBorder, 'dim'))
  console.log()

  // Risk score stats
  console.log(`  ${colorize('Risk Scores:', 'bold')}`)
  console.log(`    Average:             ${avgRiskScore.toFixed(1)}`)
  console.log(`    Maximum:             ${maxRiskScore}`)
  console.log()
  console.log(colorize(border, 'cyan'))
  console.log()
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
export function generateQuarantineOutput(results: SkillScanResult[]): QuarantineOutput {
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
export function generateSafeSkillsOutput(results: SkillScanResult[]): SafeSkillsOutput {
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
export function logRecommendations(results: SkillScanResult[], criticalCount: number): void {
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
