/**
 * Utility functions for the merge-skills script
 *
 * Extracted from merge-skills.ts for file size compliance.
 */

import { existsSync, readFileSync } from 'fs'
import type { MergeOptions } from './merge-types.js'

/**
 * Print usage information
 */
export function printUsage(): void {
  console.log(`
Merge Safe Skills - Database Merge Tool

Usage:
  npx tsx packages/core/src/scripts/merge-skills.ts [options]

Required Arguments:
  --safe-skills, -s <path>     Path to safe skills JSON (from security scan)
  --imported-skills, -i <path> Path to imported skills JSON (full skill data)
  --database, -d <path>        Path to target SQLite database

Options:
  --dry-run, -n                Preview changes without modifying database
  --verbose, -v                Show detailed per-skill output
  --help, -h                   Show usage information

Example:
  npx tsx packages/core/src/scripts/merge-skills.ts \\
    -s data/safe-skills.json \\
    -i data/imported-skills.json \\
    -d data/skills.db \\
    --dry-run
`)
}

/**
 * Parse command line arguments
 */
export function parseArgs(args: string[]): MergeOptions | null {
  const options: MergeOptions = {
    safeSkillsPath: '',
    importedSkillsPath: '',
    databasePath: '',
    dryRun: false,
    verbose: false,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const nextArg = args[i + 1]

    switch (arg) {
      case '--help':
      case '-h':
        printUsage()
        process.exit(0)
        break

      case '--safe-skills':
      case '-s':
        if (!nextArg || nextArg.startsWith('-')) {
          console.error('Error: --safe-skills requires a path argument')
          return null
        }
        options.safeSkillsPath = nextArg
        i++
        break

      case '--imported-skills':
      case '-i':
        if (!nextArg || nextArg.startsWith('-')) {
          console.error('Error: --imported-skills requires a path argument')
          return null
        }
        options.importedSkillsPath = nextArg
        i++
        break

      case '--database':
      case '-d':
        if (!nextArg || nextArg.startsWith('-')) {
          console.error('Error: --database requires a path argument')
          return null
        }
        options.databasePath = nextArg
        i++
        break

      case '--dry-run':
      case '-n':
        options.dryRun = true
        break

      case '--verbose':
      case '-v':
        options.verbose = true
        break

      default:
        if (arg.startsWith('-')) {
          console.error(`Error: Unknown option: ${arg}`)
          printUsage()
          return null
        }
    }
  }

  // Validate required arguments
  const missing: string[] = []
  if (!options.safeSkillsPath) missing.push('--safe-skills (-s)')
  if (!options.importedSkillsPath) missing.push('--imported-skills (-i)')
  if (!options.databasePath) missing.push('--database (-d)')

  if (missing.length > 0) {
    console.error(`Error: Missing required arguments: ${missing.join(', ')}`)
    printUsage()
    return null
  }

  return options
}

/**
 * Validate that all required files exist
 */
export function validateFiles(options: MergeOptions): boolean {
  let valid = true

  if (!existsSync(options.safeSkillsPath)) {
    console.error(`Error: Safe skills file not found: ${options.safeSkillsPath}`)
    valid = false
  }

  if (!existsSync(options.importedSkillsPath)) {
    console.error(`Error: Imported skills file not found: ${options.importedSkillsPath}`)
    valid = false
  }

  if (!existsSync(options.databasePath)) {
    console.error(`Error: Database file not found: ${options.databasePath}`)
    valid = false
  }

  return valid
}

/**
 * Parse a JSON file with error handling
 */
export function parseJsonFile<T>(path: string, description: string): T | null {
  try {
    const content = readFileSync(path, 'utf-8')
    return JSON.parse(content) as T
  } catch (error) {
    if (error instanceof SyntaxError) {
      console.error(`Error: Invalid JSON in ${description}: ${error.message}`)
    } else {
      console.error(`Error: Failed to read ${description}: ${error}`)
    }
    return null
  }
}
