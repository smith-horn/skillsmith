/**
 * SMI-864: Security Scanner for Imported Skills
 *
 * Scans all skills from imported-skills.json for security vulnerabilities
 * and categorizes them by severity level.
 *
 * Usage: npx tsx packages/core/src/scripts/scan-imported-skills.ts [path-to-imported-skills.json]
 *
 * Output Files:
 * - data/security-report.json: Full security report with all findings
 * - data/quarantine-skills.json: Skills with HIGH/CRITICAL findings (blocked)
 * - data/safe-skills.json: Skills approved for import (passed security scan)
 */

import * as fs from 'fs/promises'
import { existsSync, mkdirSync } from 'fs'
import * as path from 'path'
import { SecurityScanner } from '../security/scanner.js'
import type { ScanReport, SecurityFinding, SecuritySeverity } from '../security/scanner.js'

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Structure of an imported skill in imported-skills.json
 */
interface ImportedSkill {
  id: string
  name: string
  description?: string
  author?: string
  content?: string
  repo_url?: string
  source?: string
  tags?: string[]
  instructions?: string
  trigger?: string
  metadata?: Record<string, unknown>
}

/**
 * Severity categories for output organization
 */
type SeverityCategory = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'

/**
 * Skill scan result with categorization
 */
interface SkillScanResult {
  skillId: string
  skillName: string
  author: string
  source: string
  scanReport: ScanReport
  severityCategory: SeverityCategory
  isQuarantined: boolean
  scanTimestamp: string
}

/**
 * Full security report output structure
 */
interface SecurityReportOutput {
  scanDate: string
  inputFile: string
  summary: {
    totalScanned: number
    passed: number
    quarantined: number
    bySeverity: Record<SeverityCategory, number>
    averageRiskScore: number
    maxRiskScore: number
  }
  results: SkillScanResult[]
  topFindings: Array<{
    type: string
    count: number
    severity: SecuritySeverity
  }>
}

/**
 * Quarantine list output structure
 */
interface QuarantineOutput {
  generatedAt: string
  reason: string
  count: number
  skills: Array<{
    skillId: string
    skillName: string
    author: string
    riskScore: number
    severityCategory: SeverityCategory
    topFindings: string[]
  }>
}

/**
 * Safe skills list output structure
 */
interface SafeSkillsOutput {
  generatedAt: string
  count: number
  skills: Array<{
    skillId: string
    skillName: string
    author: string
    source: string
    riskScore: number
  }>
}

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  /** Default input file path */
  DEFAULT_INPUT: './data/imported-skills.json',
  /** Output directory for reports */
  OUTPUT_DIR: './data',
  /** Risk threshold for quarantine (skills at or above this are quarantined) */
  QUARANTINE_THRESHOLD: 40,
  /** Scanner options */
  SCANNER_OPTIONS: {
    riskThreshold: 40,
  },
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Determines the severity category based on the highest severity finding
 */
function determineSeverityCategory(findings: SecurityFinding[]): SeverityCategory {
  if (findings.some((f) => f.severity === 'critical')) return 'CRITICAL'
  if (findings.some((f) => f.severity === 'high')) return 'HIGH'
  if (findings.some((f) => f.severity === 'medium')) return 'MEDIUM'
  return 'LOW'
}

/**
 * Determines if a skill should be quarantined based on findings
 */
function shouldQuarantine(report: ScanReport): boolean {
  // Quarantine if:
  // 1. Has critical or high severity findings
  // 2. Risk score exceeds threshold
  // 3. Scan failed (passed = false)
  return (
    !report.passed ||
    report.riskScore >= CONFIG.QUARANTINE_THRESHOLD ||
    report.findings.some((f) => f.severity === 'critical' || f.severity === 'high')
  )
}

/**
 * Extracts scannable content from an imported skill
 * Combines all text fields that should be scanned
 */
function extractScannableContent(skill: ImportedSkill): string {
  const parts: string[] = []

  if (skill.name) parts.push(`# ${skill.name}`)
  if (skill.description) parts.push(skill.description)
  if (skill.content) parts.push(skill.content)
  if (skill.instructions) parts.push(skill.instructions)
  if (skill.trigger) parts.push(skill.trigger)
  if (skill.tags?.length) parts.push(`Tags: ${skill.tags.join(', ')}`)

  // Include metadata if present
  if (skill.metadata) {
    try {
      parts.push(JSON.stringify(skill.metadata))
    } catch {
      // Ignore serialization errors
    }
  }

  return parts.join('\n\n')
}

/**
 * Formats a duration in milliseconds to human-readable string
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

// ============================================================================
// Logging Functions
// ============================================================================

function logHeader(title: string): void {
  const border = '='.repeat(60)
  console.log(`\n${border}`)
  console.log(`  ${title}`)
  console.log(`${border}\n`)
}

function logFinding(finding: SecurityFinding, skillId: string): void {
  const severityIcon: Record<SecuritySeverity, string> = {
    critical: '[CRITICAL]',
    high: '[HIGH]    ',
    medium: '[MEDIUM]  ',
    low: '[LOW]     ',
  }

  console.log(`  ${severityIcon[finding.severity]} ${finding.type}`)
  console.log(`           Skill: ${skillId}`)
  console.log(`           ${finding.message}`)
  if (finding.lineNumber) {
    console.log(`           Line: ${finding.lineNumber}`)
  }
  if (finding.location) {
    console.log(`           Location: ${finding.location.slice(0, 80)}...`)
  }
  console.log()
}

function logSummary(results: SkillScanResult[]): void {
  const total = results.length
  const passed = results.filter((r) => !r.isQuarantined).length
  const quarantined = results.filter((r) => r.isQuarantined).length

  const bySeverity: Record<SeverityCategory, number> = {
    CRITICAL: 0,
    HIGH: 0,
    MEDIUM: 0,
    LOW: 0,
  }

  for (const result of results) {
    bySeverity[result.severityCategory]++
  }

  const avgRiskScore =
    results.reduce((sum, r) => sum + r.scanReport.riskScore, 0) / Math.max(total, 1)
  const maxRiskScore = Math.max(...results.map((r) => r.scanReport.riskScore), 0)

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

// ============================================================================
// Main Scanning Logic
// ============================================================================

async function scanImportedSkills(inputPath: string): Promise<void> {
  const startTime = performance.now()

  logHeader('SMI-864: Security Scanner for Imported Skills')
  console.log(`Input file: ${inputPath}`)
  console.log(`Output directory: ${CONFIG.OUTPUT_DIR}`)
  console.log()

  // Validate input file exists
  if (!existsSync(inputPath)) {
    console.error(`Error: Input file not found: ${inputPath}`)
    console.error(
      'Usage: npx tsx packages/core/src/scripts/scan-imported-skills.ts [path-to-imported-skills.json]'
    )
    process.exit(1)
  }

  // Ensure output directory exists
  if (!existsSync(CONFIG.OUTPUT_DIR)) {
    mkdirSync(CONFIG.OUTPUT_DIR, { recursive: true })
  }

  // Read and parse imported skills
  console.log('Reading imported skills...')
  let skills: ImportedSkill[]
  try {
    const content = await fs.readFile(inputPath, 'utf-8')
    const parsed = JSON.parse(content) as unknown

    // Handle both array format and object with skills property
    if (Array.isArray(parsed)) {
      skills = parsed as ImportedSkill[]
    } else if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'skills' in parsed &&
      Array.isArray((parsed as { skills: unknown }).skills)
    ) {
      skills = (parsed as { skills: ImportedSkill[] }).skills
    } else {
      throw new Error('Invalid format: expected array or object with skills array')
    }
  } catch (error) {
    console.error(`Error reading/parsing input file: ${(error as Error).message}`)
    process.exit(1)
  }

  console.log(`Found ${skills.length} skills to scan\n`)

  // Initialize scanner
  const scanner = new SecurityScanner(CONFIG.SCANNER_OPTIONS)

  // Scan all skills
  const results: SkillScanResult[] = []
  const allFindings: Array<SecurityFinding & { skillId: string }> = []
  let processedCount = 0

  console.log('Scanning skills...')

  for (const skill of skills) {
    processedCount++

    // Extract content to scan
    const content = extractScannableContent(skill)

    // Run security scan
    const report = scanner.scan(skill.id, content)

    // Determine categorization
    const severityCategory = determineSeverityCategory(report.findings)
    const isQuarantined = shouldQuarantine(report)

    // Create result entry
    const result: SkillScanResult = {
      skillId: skill.id,
      skillName: skill.name,
      author: skill.author || 'unknown',
      source: skill.source || 'unknown',
      scanReport: report,
      severityCategory,
      isQuarantined,
      scanTimestamp: new Date().toISOString(),
    }

    results.push(result)

    // Collect findings with skill context
    for (const finding of report.findings) {
      allFindings.push({ ...finding, skillId: skill.id })
    }

    // Log progress every 100 skills
    if (processedCount % 100 === 0) {
      console.log(`  Processed ${processedCount}/${skills.length} skills...`)
    }
  }

  console.log(`  Completed: ${processedCount}/${skills.length} skills\n`)

  // Log critical and high findings
  const criticalFindings = allFindings.filter((f) => f.severity === 'critical')
  const highFindings = allFindings.filter((f) => f.severity === 'high')

  if (criticalFindings.length > 0) {
    logHeader('CRITICAL FINDINGS')
    for (const finding of criticalFindings.slice(0, 20)) {
      logFinding(finding, finding.skillId)
    }
    if (criticalFindings.length > 20) {
      console.log(`  ... and ${criticalFindings.length - 20} more critical findings\n`)
    }
  }

  if (highFindings.length > 0) {
    logHeader('HIGH SEVERITY FINDINGS')
    for (const finding of highFindings.slice(0, 10)) {
      logFinding(finding, finding.skillId)
    }
    if (highFindings.length > 10) {
      console.log(`  ... and ${highFindings.length - 10} more high severity findings\n`)
    }
  }

  // Print summary
  logSummary(results)

  // Calculate top findings by type
  const findingCounts = new Map<string, { count: number; severity: SecuritySeverity }>()
  for (const finding of allFindings) {
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

  const topFindings = Array.from(findingCounts.entries())
    .map(([type, data]) => ({ type, count: data.count, severity: data.severity }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)

  // Calculate summary statistics
  const total = results.length
  const passed = results.filter((r) => !r.isQuarantined).length
  const quarantined = results.filter((r) => r.isQuarantined).length

  const bySeverity: Record<SeverityCategory, number> = {
    CRITICAL: results.filter((r) => r.severityCategory === 'CRITICAL').length,
    HIGH: results.filter((r) => r.severityCategory === 'HIGH').length,
    MEDIUM: results.filter((r) => r.severityCategory === 'MEDIUM').length,
    LOW: results.filter((r) => r.severityCategory === 'LOW').length,
  }

  const avgRiskScore =
    results.reduce((sum, r) => sum + r.scanReport.riskScore, 0) / Math.max(total, 1)
  const maxRiskScore = Math.max(...results.map((r) => r.scanReport.riskScore), 0)

  // Generate output files
  console.log('Generating output files...\n')

  // 1. Full security report
  const securityReport: SecurityReportOutput = {
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

  const reportPath = path.join(CONFIG.OUTPUT_DIR, 'security-report.json')
  await fs.writeFile(reportPath, JSON.stringify(securityReport, null, 2))
  console.log(`  [OK] security-report.json (${total} skills)`)

  // 2. Quarantine list (HIGH/CRITICAL)
  const quarantinedSkills = results.filter((r) => r.isQuarantined)
  const quarantineOutput: QuarantineOutput = {
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

  const quarantinePath = path.join(CONFIG.OUTPUT_DIR, 'quarantine-skills.json')
  await fs.writeFile(quarantinePath, JSON.stringify(quarantineOutput, null, 2))
  console.log(`  [OK] quarantine-skills.json (${quarantinedSkills.length} skills blocked)`)

  // 3. Safe skills list (approved for import)
  const safeSkills = results.filter((r) => !r.isQuarantined)
  const safeOutput: SafeSkillsOutput = {
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

  const safePath = path.join(CONFIG.OUTPUT_DIR, 'safe-skills.json')
  await fs.writeFile(safePath, JSON.stringify(safeOutput, null, 2))
  console.log(`  [OK] safe-skills.json (${safeSkills.length} skills approved)`)

  // Final timing
  const endTime = performance.now()
  const duration = formatDuration(endTime - startTime)

  console.log('\n' + '='.repeat(60))
  console.log('                    SCAN COMPLETE')
  console.log('='.repeat(60))
  console.log(`  Duration:              ${duration}`)
  console.log(`  Skills per second:     ${((total / (endTime - startTime)) * 1000).toFixed(1)}`)
  console.log()
  console.log('  Output files:')
  console.log(`    - ${reportPath}`)
  console.log(`    - ${quarantinePath}`)
  console.log(`    - ${safePath}`)
  console.log('='.repeat(60) + '\n')

  // Recommendations
  console.log('RECOMMENDATIONS:')
  if (quarantinedSkills.length > 0) {
    console.log(`  - ${quarantinedSkills.length} skills have been quarantined`)
    console.log('  - Review quarantine-skills.json for manual triage')
    console.log('  - Critical/high findings require security review before import')
  }
  if (criticalFindings.length > 0) {
    console.log(`  - ${criticalFindings.length} CRITICAL findings detected`)
    console.log('  - These skills should NOT be imported without thorough review')
  }
  if (safeSkills.length > 0) {
    console.log(`  - ${safeSkills.length} skills passed security checks`)
    console.log('  - These are ready for import from safe-skills.json')
  }
  console.log()
}

// ============================================================================
// Entry Point
// ============================================================================

async function main(): Promise<void> {
  // Get input file from command line args or use default
  const inputPath = process.argv[2] || CONFIG.DEFAULT_INPUT

  try {
    await scanImportedSkills(inputPath)
  } catch (error) {
    console.error('Fatal error:', (error as Error).message)
    console.error((error as Error).stack)
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('Unhandled error:', error)
  process.exit(1)
})
