/**
 * SMI-866: Import validated skills to test database
 *
 * This script imports skills from a validated-skills.json file into the SQLite database,
 * builds the FTS5 search index, and generates an import report.
 *
 * Usage:
 *   npx tsx packages/core/src/scripts/import-to-database.ts [input-file] [--db path]
 *
 * Arguments:
 *   input-file    Path to validated-skills.json (default: ./validated-skills.json)
 *   --db          Path to output database (default: packages/core/data/skills.db)
 *
 * Output:
 *   - SQLite database with imported skills
 *   - FTS5 search index populated
 *   - data/import-report.json with statistics
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { createDatabase, openDatabase, FTS5_MIGRATION_SQL } from '../db/schema.js'
import { SkillRepository } from '../repositories/SkillRepository.js'
import { SearchService } from '../services/SearchService.js'
import type { SkillCreateInput, TrustTier } from '../types/skill.js'

/**
 * Validated skill input format from the validation pipeline
 */
interface ValidatedSkillInput {
  id?: string
  name: string
  description?: string | null
  author?: string | null
  repoUrl?: string | null
  repo_url?: string | null // Alternative snake_case format
  qualityScore?: number | null
  quality_score?: number | null // Alternative snake_case format
  trustTier?: TrustTier
  trust_tier?: TrustTier // Alternative snake_case format
  tags?: string[]
  source?: string
  stars?: number
}

/**
 * Structure of the validated-skills.json file
 */
interface ValidatedSkillsFile {
  description?: string
  version?: string
  skills: ValidatedSkillInput[]
  metadata?: {
    validatedAt?: string
    totalCount?: number
    [key: string]: unknown
  }
}

/**
 * Import report structure
 */
interface ImportReport {
  success: boolean
  timestamp: string
  inputFile: string
  databasePath: string
  stats: {
    inputCount: number
    importedCount: number
    skippedCount: number
    duplicateCount: number
    ftsIndexCount: number
    qualityScoresCalculated: number
  }
  verification: {
    recordCountMatch: boolean
    ftsIndexPopulated: boolean
    allRequiredFieldsPresent: boolean
    orphanedRecords: number
    searchTestPassed: boolean
    searchTestQuery: string
    searchTestResults: number
  }
  errors: Array<{
    skill: string
    error: string
  }>
  warnings: string[]
  duration: number
}

/**
 * Calculate a default quality score based on available metadata
 */
function calculateQualityScore(skill: ValidatedSkillInput): number {
  let score = 0.5 // Base score

  // Has description (+0.15)
  if (skill.description && skill.description.length > 20) {
    score += 0.15
  }

  // Has tags (+0.1)
  if (skill.tags && skill.tags.length > 0) {
    score += 0.1
  }

  // Has author (+0.05)
  if (skill.author) {
    score += 0.05
  }

  // Has repo URL (+0.1)
  if (skill.repoUrl || skill.repo_url) {
    score += 0.1
  }

  // Has stars bonus (up to +0.1)
  if (skill.stars && skill.stars > 0) {
    const starsBonus = Math.min(skill.stars / 1000, 0.1)
    score += starsBonus
  }

  // Cap at 1.0
  return Math.min(score, 1.0)
}

/**
 * Normalize skill input to SkillCreateInput format
 */
function normalizeSkillInput(input: ValidatedSkillInput): SkillCreateInput {
  const qualityScore = input.qualityScore ?? input.quality_score ?? calculateQualityScore(input)

  return {
    id: input.id,
    name: input.name,
    description: input.description ?? null,
    author: input.author ?? null,
    repoUrl: input.repoUrl ?? input.repo_url ?? null,
    qualityScore,
    trustTier: input.trustTier ?? input.trust_tier ?? 'unknown',
    tags: input.tags ?? [],
  }
}

/**
 * Parse command line arguments
 */
function parseArgs(args: string[]): { inputFile: string; dbPath: string } {
  let inputFile = './validated-skills.json'
  let dbPath = './packages/core/data/skills.db'

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--db' && args[i + 1]) {
      dbPath = args[i + 1]
      i++
    } else if (!args[i].startsWith('--')) {
      inputFile = args[i]
    }
  }

  return { inputFile, dbPath }
}

/**
 * Import validated skills to the database
 */
export async function importToDatabase(inputFile: string, dbPath: string): Promise<ImportReport> {
  const startTime = Date.now()
  const report: ImportReport = {
    success: false,
    timestamp: new Date().toISOString(),
    inputFile: resolve(inputFile),
    databasePath: resolve(dbPath),
    stats: {
      inputCount: 0,
      importedCount: 0,
      skippedCount: 0,
      duplicateCount: 0,
      ftsIndexCount: 0,
      qualityScoresCalculated: 0,
    },
    verification: {
      recordCountMatch: false,
      ftsIndexPopulated: false,
      allRequiredFieldsPresent: true,
      orphanedRecords: 0,
      searchTestPassed: false,
      searchTestQuery: '',
      searchTestResults: 0,
    },
    errors: [],
    warnings: [],
    duration: 0,
  }

  try {
    // Read and parse input file
    if (!existsSync(inputFile)) {
      throw new Error(`Input file not found: ${inputFile}`)
    }

    const rawContent = readFileSync(inputFile, 'utf-8')
    const data: ValidatedSkillsFile = JSON.parse(rawContent)

    if (!data.skills || !Array.isArray(data.skills)) {
      throw new Error('Invalid input file: missing or invalid "skills" array')
    }

    report.stats.inputCount = data.skills.length
    console.log(`[SMI-866] Found ${data.skills.length} skills to import`)

    // Ensure database directory exists
    const dbDir = dirname(dbPath)
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true })
      console.log(`[SMI-866] Created directory: ${dbDir}`)
    }

    // Create or open database
    let db
    if (existsSync(dbPath)) {
      console.log(`[SMI-866] Opening existing database: ${dbPath}`)
      db = openDatabase(dbPath)
    } else {
      console.log(`[SMI-866] Creating new database: ${dbPath}`)
      db = createDatabase(dbPath)
    }

    // Initialize repository
    const skillRepo = new SkillRepository(db)

    // Normalize and validate skills
    const normalizedSkills: SkillCreateInput[] = []
    let qualityScoresCalculated = 0

    for (const skill of data.skills) {
      // Validate required fields
      if (!skill.name) {
        report.errors.push({
          skill: skill.id ?? 'unknown',
          error: 'Missing required field: name',
        })
        report.stats.skippedCount++
        continue
      }

      const normalized = normalizeSkillInput(skill)

      // Track if quality score was calculated
      if (!skill.qualityScore && !skill.quality_score) {
        qualityScoresCalculated++
      }

      normalizedSkills.push(normalized)
    }

    report.stats.qualityScoresCalculated = qualityScoresCalculated
    console.log(`[SMI-866] Normalized ${normalizedSkills.length} skills`)

    // Batch insert skills
    const batchSize = 500
    let totalImported = 0

    for (let i = 0; i < normalizedSkills.length; i += batchSize) {
      const batch = normalizedSkills.slice(i, i + batchSize)
      const imported = skillRepo.createBatch(batch)
      totalImported += imported.length
      report.stats.duplicateCount += batch.length - imported.length
      console.log(
        `[SMI-866] Imported batch ${Math.floor(i / batchSize) + 1}: ${imported.length}/${batch.length} skills`
      )
    }

    report.stats.importedCount = totalImported
    console.log(`[SMI-866] Total imported: ${totalImported} skills`)

    // Ensure FTS5 index is populated
    try {
      db.exec(FTS5_MIGRATION_SQL)
      console.log('[SMI-866] FTS5 index rebuilt')
    } catch (error) {
      // FTS5 may already be populated via triggers
      report.warnings.push(`FTS5 rebuild warning: ${error}`)
    }

    // Verify FTS5 index count
    const ftsCountResult = db.prepare('SELECT COUNT(*) as count FROM skills_fts').get() as {
      count: number
    }
    report.stats.ftsIndexCount = ftsCountResult.count
    console.log(`[SMI-866] FTS5 index contains ${ftsCountResult.count} entries`)

    // Verification checks
    const dbCount = skillRepo.count()
    report.verification.recordCountMatch = dbCount === totalImported
    report.verification.ftsIndexPopulated = ftsCountResult.count > 0

    // Check for orphaned records (skills without FTS entries)
    const orphanedResult = db
      .prepare(
        `
      SELECT COUNT(*) as count FROM skills s
      LEFT JOIN skills_fts f ON s.rowid = f.rowid
      WHERE f.rowid IS NULL
    `
      )
      .get() as { count: number }
    report.verification.orphanedRecords = orphanedResult.count

    // Test search functionality
    const searchService = new SearchService(db)
    const testQuery = 'test'

    // Find a searchable term from the imported skills
    const sampleSkill = normalizedSkills.find((s) => s.name && s.name.length > 2)
    const searchQuery = sampleSkill?.name?.split(/\s+/)[0] ?? testQuery

    report.verification.searchTestQuery = searchQuery

    try {
      const searchResults = searchService.search({
        query: searchQuery,
        limit: 10,
      })
      report.verification.searchTestResults = searchResults.total
      report.verification.searchTestPassed = searchResults.total > 0
      console.log(`[SMI-866] Search test "${searchQuery}": ${searchResults.total} results`)
    } catch (error) {
      report.warnings.push(`Search test failed: ${error}`)
    }

    // Close database
    db.close()

    // Calculate duration
    report.duration = Date.now() - startTime
    report.success =
      report.verification.recordCountMatch &&
      report.verification.ftsIndexPopulated &&
      report.errors.length === 0

    console.log(`[SMI-866] Import completed in ${report.duration}ms`)
    console.log(`[SMI-866] Success: ${report.success}`)
  } catch (error) {
    report.errors.push({
      skill: 'N/A',
      error: error instanceof Error ? error.message : String(error),
    })
    report.duration = Date.now() - startTime
    console.error(`[SMI-866] Import failed:`, error)
  }

  return report
}

/**
 * Save import report to file
 */
export function saveReport(report: ImportReport, outputPath: string): void {
  const dir = dirname(outputPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  writeFileSync(outputPath, JSON.stringify(report, null, 2))
  console.log(`[SMI-866] Report saved to: ${outputPath}`)
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const { inputFile, dbPath } = parseArgs(args)

  console.log('[SMI-866] Starting skill import')
  console.log(`[SMI-866] Input: ${inputFile}`)
  console.log(`[SMI-866] Database: ${dbPath}`)

  const report = await importToDatabase(inputFile, dbPath)

  // Save report to data directory
  const reportPath = resolve(dirname(dbPath), 'import-report.json')
  saveReport(report, reportPath)

  // Print summary
  console.log('\n=== Import Summary ===')
  console.log(`Input skills: ${report.stats.inputCount}`)
  console.log(`Imported: ${report.stats.importedCount}`)
  console.log(`Skipped: ${report.stats.skippedCount}`)
  console.log(`Duplicates: ${report.stats.duplicateCount}`)
  console.log(`FTS5 entries: ${report.stats.ftsIndexCount}`)
  console.log(`Quality scores calculated: ${report.stats.qualityScoresCalculated}`)
  console.log(`\nVerification:`)
  console.log(`  Record count match: ${report.verification.recordCountMatch}`)
  console.log(`  FTS5 populated: ${report.verification.ftsIndexPopulated}`)
  console.log(`  Search test passed: ${report.verification.searchTestPassed}`)
  console.log(`  Orphaned records: ${report.verification.orphanedRecords}`)

  if (report.errors.length > 0) {
    console.log(`\nErrors (${report.errors.length}):`)
    report.errors.slice(0, 5).forEach((e) => console.log(`  - ${e.skill}: ${e.error}`))
    if (report.errors.length > 5) {
      console.log(`  ... and ${report.errors.length - 5} more`)
    }
  }

  if (report.warnings.length > 0) {
    console.log(`\nWarnings (${report.warnings.length}):`)
    report.warnings.forEach((w) => console.log(`  - ${w}`))
  }

  console.log(`\nDuration: ${report.duration}ms`)
  console.log(`Success: ${report.success}`)

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
