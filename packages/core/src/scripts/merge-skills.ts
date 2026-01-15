/**
 * Merge safe skills into the main database
 *
 * This script merges skills from a safe-skills.json file (security scan output)
 * with full skill data from imported-skills.json into a SQLite database.
 * Only adds skills that don't already exist (by repo_url).
 *
 * Usage:
 *   npx tsx packages/core/src/scripts/merge-skills.ts [options]
 *
 * Required Arguments:
 *   --safe-skills, -s <path>     Path to safe skills JSON (from security scan)
 *   --imported-skills, -i <path> Path to imported skills JSON (full skill data)
 *   --database, -d <path>        Path to target SQLite database
 *
 * Options:
 *   --dry-run, -n                Preview changes without modifying database
 *   --verbose, -v                Show detailed per-skill output
 *   --help, -h                   Show usage information
 *
 * Example:
 *   npx tsx packages/core/src/scripts/merge-skills.ts \
 *     -s data/safe-skills.json \
 *     -i data/imported-skills.json \
 *     -d data/skills.db \
 *     --dry-run
 */

import Database from 'better-sqlite3'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'

// ============================================================================
// Types
// ============================================================================

interface Skill {
  id?: string
  name: string
  description?: string | null
  author?: string | null
  repo_url?: string | null
  repoUrl?: string | null
  quality_score?: number
  qualityScore?: number
  trust_tier?: string
  trustTier?: string
  tags?: string[]
  source?: string
  stars?: number
  created_at?: string
}

interface SafeSkillRef {
  skillId: string
  skillName: string
  author: string
  source: string
  riskScore: number
}

interface SafeSkillsFile {
  skills?: SafeSkillRef[]
  metadata?: {
    scannedAt?: string
    totalScanned?: number
    safeCount?: number
    [key: string]: unknown
  }
}

interface ImportedSkillsFile {
  skills?: Skill[]
  metadata?: {
    importedAt?: string
    totalCount?: number
    [key: string]: unknown
  }
}

interface MergeOptions {
  safeSkillsPath: string
  importedSkillsPath: string
  databasePath: string
  dryRun: boolean
  verbose: boolean
}

interface MergeReport {
  success: boolean
  timestamp: string
  options: MergeOptions
  stats: {
    safeSkillsLoaded: number
    importedSkillsLoaded: number
    skillsWithFullData: number
    existingInDatabase: number
    newSkillsAdded: number
    skippedDuplicates: number
    errors: number
  }
  errors: Array<{
    skillId: string
    error: string
  }>
  duration: number
}

// ============================================================================
// Argument Parsing
// ============================================================================

function printUsage(): void {
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

function parseArgs(args: string[]): MergeOptions | null {
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

// ============================================================================
// File Validation
// ============================================================================

function validateFiles(options: MergeOptions): boolean {
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

// ============================================================================
// JSON Parsing with Error Handling
// ============================================================================

function parseJsonFile<T>(path: string, description: string): T | null {
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

// ============================================================================
// Main Merge Logic
// ============================================================================

export async function mergeSkills(options: MergeOptions): Promise<MergeReport> {
  const startTime = Date.now()
  const report: MergeReport = {
    success: false,
    timestamp: new Date().toISOString(),
    options: {
      ...options,
      safeSkillsPath: resolve(options.safeSkillsPath),
      importedSkillsPath: resolve(options.importedSkillsPath),
      databasePath: resolve(options.databasePath),
    },
    stats: {
      safeSkillsLoaded: 0,
      importedSkillsLoaded: 0,
      skillsWithFullData: 0,
      existingInDatabase: 0,
      newSkillsAdded: 0,
      skippedDuplicates: 0,
      errors: 0,
    },
    errors: [],
    duration: 0,
  }

  const modeLabel = options.dryRun ? '[DRY-RUN]' : '[MERGE]'

  try {
    // ========================================================================
    // Load Safe Skills
    // ========================================================================
    console.log(`${modeLabel} Loading safe skills from: ${options.safeSkillsPath}`)

    const safeSkillsData = parseJsonFile<SafeSkillsFile>(options.safeSkillsPath, 'safe skills file')
    if (!safeSkillsData) {
      throw new Error('Failed to parse safe skills file')
    }

    const safeRefs: SafeSkillRef[] =
      safeSkillsData.skills || (safeSkillsData as unknown as SafeSkillRef[])
    if (!Array.isArray(safeRefs)) {
      throw new Error('Safe skills file must contain a "skills" array or be an array')
    }

    const safeIds = new Set(safeRefs.map((s) => s.skillId))
    report.stats.safeSkillsLoaded = safeIds.size
    console.log(`${modeLabel} Safe skill IDs loaded: ${safeIds.size}`)

    // ========================================================================
    // Load Imported Skills
    // ========================================================================
    console.log(`${modeLabel} Loading imported skills from: ${options.importedSkillsPath}`)

    const importedData = parseJsonFile<ImportedSkillsFile>(
      options.importedSkillsPath,
      'imported skills file'
    )
    if (!importedData) {
      throw new Error('Failed to parse imported skills file')
    }

    const allSkills: Skill[] = importedData.skills || (importedData as unknown as Skill[])
    if (!Array.isArray(allSkills)) {
      throw new Error('Imported skills file must contain a "skills" array or be an array')
    }

    report.stats.importedSkillsLoaded = allSkills.length
    console.log(`${modeLabel} Total imported skills: ${allSkills.length}`)

    // ========================================================================
    // Filter to Safe Skills with Full Data
    // ========================================================================
    const safeSkills = allSkills.filter((s) => safeIds.has(s.id || ''))
    report.stats.skillsWithFullData = safeSkills.length
    console.log(`${modeLabel} Safe skills with full data: ${safeSkills.length}`)

    if (safeSkills.length === 0) {
      console.warn(`${modeLabel} Warning: No skills matched between safe list and imported data`)
    }

    // ========================================================================
    // Open Database and Get Existing Skills
    // ========================================================================
    console.log(`${modeLabel} Opening database: ${options.databasePath}`)

    const db = new Database(options.databasePath, {
      readonly: options.dryRun,
    })

    // Get existing repo URLs to avoid duplicates
    const existingRows = db
      .prepare('SELECT repo_url FROM skills WHERE repo_url IS NOT NULL')
      .all() as { repo_url: string }[]
    const existingUrls = new Set(existingRows.map((row) => row.repo_url?.toLowerCase()))
    report.stats.existingInDatabase = existingUrls.size
    console.log(`${modeLabel} Existing skills in database: ${existingUrls.size}`)

    // ========================================================================
    // Prepare Insert (if not dry-run)
    // ========================================================================
    let insert: Database.Statement | null = null
    if (!options.dryRun) {
      insert = db.prepare(`
        INSERT OR IGNORE INTO skills (id, name, description, author, repo_url, quality_score, trust_tier, tags, source, stars, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
    }

    // ========================================================================
    // Process Skills in Batches
    // ========================================================================
    const batchSize = 500
    let newCount = 0
    let skippedCount = 0
    const totalBatches = Math.ceil(safeSkills.length / batchSize)

    console.log(`${modeLabel} Processing ${safeSkills.length} skills in ${totalBatches} batches...`)

    const processSkills = options.dryRun
      ? () => {
          // Dry-run: just count what would happen
          for (const skill of safeSkills) {
            const repoUrl = (skill.repo_url || skill.repoUrl)?.toLowerCase()
            if (repoUrl && !existingUrls.has(repoUrl)) {
              newCount++
              if (options.verbose) {
                console.log(`  [WOULD ADD] ${skill.name} (${skill.author || 'unknown'})`)
              }
            } else {
              skippedCount++
              if (options.verbose) {
                console.log(`  [WOULD SKIP] ${skill.name} (duplicate)`)
              }
            }
          }
        }
      : db.transaction(() => {
          // Real merge: insert skills in batches
          for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
            const start = batchIndex * batchSize
            const end = Math.min(start + batchSize, safeSkills.length)
            const batch = safeSkills.slice(start, end)
            let batchNew = 0
            let batchSkipped = 0

            for (const skill of batch) {
              const repoUrl = (skill.repo_url || skill.repoUrl)?.toLowerCase()

              if (repoUrl && !existingUrls.has(repoUrl)) {
                try {
                  insert!.run(
                    skill.id || 'github/' + (skill.author || 'unknown') + '/' + skill.name,
                    skill.name,
                    skill.description || null,
                    skill.author || null,
                    skill.repo_url || skill.repoUrl || null,
                    skill.quality_score ?? skill.qualityScore ?? 0.5,
                    skill.trust_tier ?? skill.trustTier ?? 'community',
                    JSON.stringify(skill.tags || []),
                    skill.source || 'github',
                    skill.stars || 0,
                    skill.created_at || new Date().toISOString()
                  )
                  newCount++
                  batchNew++
                  existingUrls.add(repoUrl) // Prevent duplicates within same run

                  if (options.verbose) {
                    console.log(`  [ADDED] ${skill.name} (${skill.author || 'unknown'})`)
                  }
                } catch (error) {
                  report.errors.push({
                    skillId: skill.id || skill.name,
                    error: error instanceof Error ? error.message : String(error),
                  })
                  report.stats.errors++
                }
              } else {
                skippedCount++
                batchSkipped++
                if (options.verbose) {
                  console.log(`  [SKIPPED] ${skill.name} (duplicate)`)
                }
              }
            }

            console.log(
              `${modeLabel} Batch ${batchIndex + 1}/${totalBatches}: ${batchNew} added, ${batchSkipped} skipped`
            )
          }
        })

    processSkills()

    report.stats.newSkillsAdded = newCount
    report.stats.skippedDuplicates = skippedCount

    // ========================================================================
    // Get Final Database Count
    // ========================================================================
    const finalCount = db.prepare('SELECT COUNT(*) as count FROM skills').get() as { count: number }

    // Close database
    db.close()

    // Calculate duration
    report.duration = Date.now() - startTime
    report.success = report.stats.errors === 0

    // ========================================================================
    // Print Summary
    // ========================================================================
    console.log('')
    console.log('='.repeat(50))
    console.log(options.dryRun ? '  DRY-RUN SUMMARY (no changes made)' : '  MERGE SUMMARY')
    console.log('='.repeat(50))
    console.log(`  Safe skills loaded:      ${report.stats.safeSkillsLoaded}`)
    console.log(`  Imported skills loaded:  ${report.stats.importedSkillsLoaded}`)
    console.log(`  Skills with full data:   ${report.stats.skillsWithFullData}`)
    console.log(`  Existing in database:    ${report.stats.existingInDatabase}`)
    console.log(
      `  ${options.dryRun ? 'Would add' : 'New skills added'}:        ${report.stats.newSkillsAdded}`
    )
    console.log(
      `  ${options.dryRun ? 'Would skip' : 'Skipped (duplicates)'}:    ${report.stats.skippedDuplicates}`
    )
    console.log(`  Errors:                  ${report.stats.errors}`)
    console.log(`  Duration:                ${(report.duration / 1000).toFixed(2)}s`)
    if (!options.dryRun) {
      console.log(`  Final skill count:       ${finalCount.count}`)
    }
    console.log('='.repeat(50))

    if (report.errors.length > 0) {
      console.log('')
      console.log(`Errors (${report.errors.length}):`)
      report.errors.slice(0, 10).forEach((e) => console.log(`  - ${e.skillId}: ${e.error}`))
      if (report.errors.length > 10) {
        console.log(`  ... and ${report.errors.length - 10} more`)
      }
    }

    console.log('')
    console.log(`${modeLabel} ${options.dryRun ? 'Dry run complete!' : 'Merge complete!'}`)
  } catch (error) {
    report.errors.push({
      skillId: 'N/A',
      error: error instanceof Error ? error.message : String(error),
    })
    report.stats.errors++
    report.duration = Date.now() - startTime
    console.error(`${modeLabel} Merge failed:`, error)
  }

  return report
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  // Handle no arguments
  if (args.length === 0) {
    printUsage()
    process.exit(1)
  }

  // Parse arguments
  const options = parseArgs(args)
  if (!options) {
    process.exit(1)
  }

  // Validate files exist
  if (!validateFiles(options)) {
    process.exit(1)
  }

  // Run merge
  const report = await mergeSkills(options)

  // Exit with appropriate code
  process.exit(report.success ? 0 : 1)
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Fatal error:', error)
    process.exit(1)
  })
}
