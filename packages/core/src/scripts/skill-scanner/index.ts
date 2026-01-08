/**
 * SMI-864: Security Scanner for Imported Skills
 * SMI-1189: Refactored into modular structure
 *
 * Scans all skills from imported-skills.json for security vulnerabilities
 * and categorizes them by severity level.
 *
 * Usage: npx tsx packages/core/src/scripts/skill-scanner/index.ts [path-to-imported-skills.json]
 *
 * Output Files:
 * - data/security-report.json: Full security report with all findings
 * - data/quarantine-skills.json: Skills with HIGH/CRITICAL findings (blocked)
 * - data/safe-skills.json: Skills approved for import (passed security scan)
 */

import { scanImportedSkills, DEFAULT_CONFIG } from './scanner.js'

// Re-export all public types and functions
export * from './types.js'
export * from './categorizer.js'
export * from './trust-scorer.js'
export * from './file-scanner.js'
export * from './logger.js'
export * from './reporter.js'
export { scanImportedSkills, DEFAULT_CONFIG } from './scanner.js'

/**
 * CLI entry point
 */
async function main(): Promise<void> {
  // Get input file from command line args or use default
  const inputPath = process.argv[2] || DEFAULT_CONFIG.defaultInput

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
