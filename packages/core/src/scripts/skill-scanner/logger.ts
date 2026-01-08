/**
 * SMI-1189: Logger
 *
 * Logging utilities for the security scanner.
 */

import type { SecurityFinding, SecuritySeverity } from '../../security/index.js'

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
  console.log(`  [OK] ${filename} (${count} skills${desc})`)
}
