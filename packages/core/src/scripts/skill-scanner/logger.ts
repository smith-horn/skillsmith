/**
 * SMI-1189: Logger
 * SMI-XXX: Improved output format with progress bars and tables
 *
 * Logging utilities for the security scanner.
 */

import type { SecurityFinding, SecuritySeverity } from '../../security/index.js'
import type { SeverityCategory, SkillScanResult } from './types.js'

/**
 * Severity icons for console output
 */
const SEVERITY_ICONS: Record<SecuritySeverity, string> = {
  critical: '[CRITICAL]',
  high: '[HIGH]    ',
  medium: '[MEDIUM]  ',
  low: '[LOW]     ',
}

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
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
}

/**
 * Check if colors should be used (TTY and not CI)
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
 * Get color for severity level
 */
function getSeverityColor(severity: SeverityCategory | SecuritySeverity): keyof typeof COLORS {
  switch (severity.toUpperCase()) {
    case 'CRITICAL':
      return 'red'
    case 'HIGH':
      return 'magenta'
    case 'MEDIUM':
      return 'yellow'
    case 'LOW':
      return 'cyan'
    default:
      return 'white'
  }
}

/**
 * Formats a duration in milliseconds to human-readable string
 *
 * @param ms - Duration in milliseconds
 * @returns Formatted duration string
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

/**
 * Log a section header
 *
 * @param title - Header title
 */
export function logHeader(title: string): void {
  const border = '='.repeat(60)
  console.log(`\n${border}`)
  console.log(`  ${title}`)
  console.log(`${border}\n`)
}

/**
 * Log a security finding
 *
 * @param finding - The security finding to log
 * @param skillId - The skill ID associated with the finding
 */
export function logFinding(finding: SecurityFinding, skillId: string): void {
  console.log(`  ${SEVERITY_ICONS[finding.severity]} ${finding.type}`)
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

/**
 * Log a list of findings with truncation
 *
 * @param findings - Array of findings with skill context
 * @param maxDisplay - Maximum number of findings to display
 * @param title - Section title
 */
export function logFindings(
  findings: Array<SecurityFinding & { skillId: string }>,
  maxDisplay: number,
  title: string
): void {
  if (findings.length === 0) return

  logHeader(title)
  for (const finding of findings.slice(0, maxDisplay)) {
    logFinding(finding, finding.skillId)
  }
  if (findings.length > maxDisplay) {
    console.log(`  ... and ${findings.length - maxDisplay} more findings\n`)
  }
}

/**
 * Log progress update
 *
 * @param processed - Number of items processed
 * @param total - Total number of items
 */
export function logProgress(processed: number, total: number): void {
  console.log(`  Processed ${processed}/${total} skills...`)
}

/**
 * Log completion message
 *
 * @param processed - Number of items processed
 * @param total - Total number of items
 */
export function logCompletion(processed: number, total: number): void {
  console.log(`  Completed: ${processed}/${total} skills\n`)
}

/**
 * Log file output success
 *
 * @param filename - Name of the file
 * @param count - Number of items in the file
 * @param description - Optional description of the file
 */
export function logFileOutput(filename: string, count: number, description?: string): void {
  const desc = description ? ` ${description}` : ''
  const checkmark = colorize('[OK]', 'green')
  console.log(`  ${checkmark} ${filename} (${count} skills${desc})`)
}

/**
 * Log the initial scan summary banner
 *
 * @param skillCount - Total number of skills to scan
 * @param inputPath - Path to input file
 * @param outputDir - Output directory
 */
export function logScanStart(skillCount: number, inputPath: string, outputDir: string): void {
  const border = '='.repeat(60)
  console.log()
  console.log(colorize(border, 'cyan'))
  console.log(colorize('          SKILLSMITH SECURITY SCANNER', 'bold'))
  console.log(colorize(border, 'cyan'))
  console.log()
  console.log(`  ${colorize('Input:', 'dim')}    ${inputPath}`)
  console.log(`  ${colorize('Output:', 'dim')}   ${outputDir}`)
  console.log(
    `  ${colorize('Skills:', 'dim')}   ${colorize(skillCount.toString(), 'bold')} skills to scan`
  )
  console.log()
  console.log(colorize(border, 'cyan'))
  console.log()
}

/**
 * Create a progress bar string
 *
 * @param current - Current progress value
 * @param total - Total value
 * @param width - Width of the progress bar in characters
 * @returns Progress bar string
 */
export function createProgressBar(current: number, total: number, width: number = 30): string {
  const percentage = Math.min(current / total, 1)
  const filled = Math.round(width * percentage)
  const empty = width - filled
  const filledChar = useColors() ? '█' : '#'
  const emptyChar = useColors() ? '░' : '-'
  const bar = filledChar.repeat(filled) + emptyChar.repeat(empty)
  const pct = (percentage * 100).toFixed(1).padStart(5)
  return `[${bar}] ${pct}%`
}

/**
 * Log progress with a visual progress bar
 *
 * @param processed - Number of items processed
 * @param total - Total number of items
 * @param inPlace - Whether to update in place (overwrite previous line)
 */
export function logProgressBar(processed: number, total: number, inPlace: boolean = true): void {
  const bar = createProgressBar(processed, total)
  const status = `${processed.toString().padStart(total.toString().length)}/${total}`

  if (inPlace && process.stdout.isTTY) {
    process.stdout.write(`\r  Scanning: ${bar} ${status}`)
  } else {
    console.log(`  Scanning: ${bar} ${status}`)
  }
}

/**
 * Clear the progress line and move to new line
 */
export function clearProgressLine(): void {
  if (process.stdout.isTTY) {
    process.stdout.write('\r' + ' '.repeat(80) + '\r')
  }
}

/**
 * Truncate a string to a maximum length with ellipsis
 *
 * @param str - String to truncate
 * @param maxLen - Maximum length
 * @returns Truncated string
 */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen - 3) + '...'
}

/**
 * Pad a string to a fixed width
 *
 * @param str - String to pad
 * @param width - Target width
 * @returns Padded string
 */
function padRight(str: string, width: number): string {
  return str.length >= width ? str.slice(0, width) : str + ' '.repeat(width - str.length)
}

/**
 * Log a table of quarantined skills
 *
 * @param results - Array of quarantined scan results
 * @param maxRows - Maximum number of rows to display
 */
export function logQuarantineTable(results: SkillScanResult[], maxRows: number = 20): void {
  const quarantined = results.filter((r) => r.isQuarantined)

  if (quarantined.length === 0) {
    console.log(colorize('  No quarantined skills found.', 'green'))
    return
  }

  // Sort by risk score descending
  const sorted = [...quarantined].sort((a, b) => b.scanReport.riskScore - a.scanReport.riskScore)

  // Column widths
  const colWidths = { skillId: 35, risk: 6, severity: 10, finding: 40 }
  const totalWidth =
    colWidths.skillId + colWidths.risk + colWidths.severity + colWidths.finding + 11

  // Header
  const headerBorder = '-'.repeat(totalWidth)
  console.log(colorize(headerBorder, 'dim'))
  console.log(
    `  ${colorize(padRight('Skill ID', colWidths.skillId), 'bold')} | ` +
      `${colorize(padRight('Risk', colWidths.risk), 'bold')} | ` +
      `${colorize(padRight('Severity', colWidths.severity), 'bold')} | ` +
      `${colorize(padRight('Top Finding', colWidths.finding), 'bold')}`
  )
  console.log(colorize(headerBorder, 'dim'))

  // Rows
  const displayRows = sorted.slice(0, maxRows)
  for (const result of displayRows) {
    const topFinding =
      result.scanReport.findings.length > 0
        ? `${result.scanReport.findings[0].type}: ${result.scanReport.findings[0].message}`
        : 'N/A'

    const severityColored = colorize(
      padRight(result.severityCategory, colWidths.severity),
      getSeverityColor(result.severityCategory)
    )

    console.log(
      `  ${padRight(truncate(result.skillId, colWidths.skillId), colWidths.skillId)} | ` +
        `${padRight(result.scanReport.riskScore.toString(), colWidths.risk)} | ` +
        `${severityColored} | ` +
        `${truncate(topFinding, colWidths.finding)}`
    )
  }

  console.log(colorize(headerBorder, 'dim'))

  // Show remaining count if truncated
  if (quarantined.length > maxRows) {
    console.log(
      colorize(`  ... and ${quarantined.length - maxRows} more quarantined skills`, 'dim')
    )
  }
  console.log()
}

/**
 * Log a summary of safe skills
 *
 * @param results - Array of safe scan results
 * @param maxDisplay - Maximum number to display
 */
export function logSafeSkillsSummary(results: SkillScanResult[], maxDisplay: number = 5): void {
  const safe = results.filter((r) => !r.isQuarantined)

  if (safe.length === 0) {
    console.log(colorize('  No safe skills found.', 'yellow'))
    return
  }

  // Sort by risk score ascending (lowest risk first)
  const sorted = [...safe].sort((a, b) => a.scanReport.riskScore - b.scanReport.riskScore)

  console.log(colorize(`  ${safe.length} skills passed security checks:`, 'green'))
  console.log()

  const displayRows = sorted.slice(0, maxDisplay)
  for (const result of displayRows) {
    const riskLabel =
      result.scanReport.riskScore === 0 ? 'clean' : `risk: ${result.scanReport.riskScore}`
    console.log(`    ${colorize('[SAFE]', 'green')} ${result.skillId} (${riskLabel})`)
  }

  if (safe.length > maxDisplay) {
    console.log(colorize(`    ... and ${safe.length - maxDisplay} more safe skills`, 'dim'))
  }
  console.log()
}

/**
 * Log categorized results by severity
 *
 * @param results - Array of scan results
 */
export function logCategorizedResults(results: SkillScanResult[]): void {
  const categories: Record<SeverityCategory | 'SAFE', SkillScanResult[]> = {
    CRITICAL: [],
    HIGH: [],
    MEDIUM: [],
    LOW: [],
    SAFE: [],
  }

  for (const result of results) {
    if (result.isQuarantined) {
      categories[result.severityCategory].push(result)
    } else {
      categories.SAFE.push(result)
    }
  }

  logHeader('RESULTS BY CATEGORY')

  // Safe skills
  if (categories.SAFE.length > 0) {
    console.log(
      `  ${colorize('[SAFE]', 'green')}     ${categories.SAFE.length} skills - ` +
        colorize('Ready for import', 'dim')
    )
  }

  // Low severity
  if (categories.LOW.length > 0) {
    console.log(
      `  ${colorize('[LOW]', 'cyan')}      ${categories.LOW.length} skills - ` +
        colorize('Minor findings, generally safe', 'dim')
    )
  }

  // Medium severity
  if (categories.MEDIUM.length > 0) {
    console.log(
      `  ${colorize('[MEDIUM]', 'yellow')}   ${categories.MEDIUM.length} skills - ` +
        colorize('Review recommended', 'dim')
    )
  }

  // High severity
  if (categories.HIGH.length > 0) {
    console.log(
      `  ${colorize('[HIGH]', 'magenta')}     ${categories.HIGH.length} skills - ` +
        colorize('Security review required', 'dim')
    )
  }

  // Critical severity
  if (categories.CRITICAL.length > 0) {
    console.log(
      `  ${colorize('[CRITICAL]', 'red')} ${categories.CRITICAL.length} skills - ` +
        colorize('Do NOT import without thorough review', 'dim')
    )
  }

  console.log()
}
