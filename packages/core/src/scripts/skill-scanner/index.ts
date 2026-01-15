/**
 * SMI-864: Security Scanner for Imported Skills
 * SMI-1189: Refactored into modular structure
 * SMI-XXX: Improved output format with progress bars, tables, and JSON support
 *
 * Scans all skills from imported-skills.json for security vulnerabilities
 * and categorizes them by severity level.
 *
 * Usage: npx tsx packages/core/src/scripts/skill-scanner/index.ts [options] [path-to-imported-skills.json]
 *
 * Options:
 *   --json      Output results in JSON format (machine-readable, CI-friendly)
 *   --verbose   Show detailed output including all findings
 *   --quiet     Minimal output (only errors and final summary)
 *   --help      Show this help message
 *
 * Output Files:
 * - data/security-report.json: Full security report with all findings
 * - data/quarantine-skills.json: Skills with HIGH/CRITICAL findings (blocked)
 * - data/safe-skills.json: Skills approved for import (passed security scan)
 */

import { scanImportedSkills, DEFAULT_CONFIG } from './scanner.js'
import type { ScannerCliOptions } from './types.js'

// Re-export all public types and functions
export * from './types.js'
export * from './categorizer.js'
export * from './trust-scorer.js'
export * from './file-scanner.js'
export * from './logger.js'
export * from './reporter.js'
export { scanImportedSkills, DEFAULT_CONFIG, DEFAULT_CLI_OPTIONS } from './scanner.js'

/**
 * Parse command line arguments
 *
 * @param args - Command line arguments (process.argv.slice(2))
 * @returns Parsed CLI options and input path
 */
function parseArgs(args: string[]): { options: Partial<ScannerCliOptions>; inputPath: string } {
  const options: Partial<ScannerCliOptions> = {}
  let inputPath = DEFAULT_CONFIG.defaultInput

  for (const arg of args) {
    if (arg === '--json') {
      options.json = true
    } else if (arg === '--verbose' || arg === '-v') {
      options.verbose = true
    } else if (arg === '--quiet' || arg === '-q') {
      options.quiet = true
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else if (!arg.startsWith('-')) {
      inputPath = arg
    } else {
      console.error(`Unknown option: ${arg}`)
      console.error('Use --help for usage information')
      process.exit(1)
    }
  }

  // Validate conflicting options
  if (options.verbose && options.quiet) {
    console.error('Error: --verbose and --quiet cannot be used together')
    process.exit(1)
  }

  return { options, inputPath }
}

/**
 * Print help message
 */
function printHelp(): void {
  console.log(`
Skillsmith Security Scanner

Usage: npx tsx packages/core/src/scripts/scan-imported-skills.ts [options] [input-file]

Options:
  --json      Output results in JSON format (machine-readable, CI-friendly)
  --verbose   Show detailed output including all findings
  --quiet     Minimal output (only errors and final summary)
  --help, -h  Show this help message

Arguments:
  input-file  Path to imported-skills.json (default: ./data/imported-skills.json)

Examples:
  # Basic scan with human-readable output
  npx tsx packages/core/src/scripts/scan-imported-skills.ts

  # JSON output for CI pipelines
  npx tsx packages/core/src/scripts/scan-imported-skills.ts --json

  # Scan specific file
  npx tsx packages/core/src/scripts/scan-imported-skills.ts ./custom-skills.json

  # JSON output to file
  npx tsx packages/core/src/scripts/scan-imported-skills.ts --json > results.json

Output Files:
  - data/security-report.json     Full security report with all findings
  - data/quarantine-skills.json   Skills with HIGH/CRITICAL findings (blocked)
  - data/safe-skills.json         Skills approved for import (passed security scan)
`)
}

/**
 * CLI entry point
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const { options, inputPath } = parseArgs(args)

  try {
    await scanImportedSkills(inputPath, DEFAULT_CONFIG, options)
  } catch (error) {
    if (options.json) {
      console.log(
        JSON.stringify({
          success: false,
          error: (error as Error).message,
        })
      )
    } else {
      console.error('Fatal error:', (error as Error).message)
      console.error((error as Error).stack)
    }
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('Unhandled error:', error)
  process.exit(1)
})
