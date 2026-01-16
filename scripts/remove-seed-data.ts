/**
 * Remove Seed Data Script
 *
 * Identifies and removes fake seed skills from Supabase by repo_url patterns.
 *
 * Fake seed patterns (to DELETE):
 * - github.com/skillsmith-community/  - fake community skills
 * - github.com/skillsmith-labs/       - fake experimental skills
 * - github.com/unknown-contributor/   - fake unknown skills
 *
 * Real skills (to KEEP):
 * - github.com/anthropics/
 * - github.com/huggingface/
 * - github.com/vercel-labs/
 *
 * Usage:
 *   varlock run -- npx tsx scripts/remove-seed-data.ts --dry-run
 *   varlock run -- npx tsx scripts/remove-seed-data.ts --backup-only
 *   varlock run -- npx tsx scripts/remove-seed-data.ts
 *
 * Options:
 *   --dry-run      Preview skills to delete without making changes
 *   --backup-only  Create backup file only, no deletion
 *   --force        Skip confirmation prompt
 *   --help, -h     Show help message
 */

import * as fs from 'fs'
import * as path from 'path'
import {
  validateEnv,
  createSupabaseClient,
  formatDuration,
  sleep,
  isRateLimitError,
  type SupabaseSkill,
} from './lib/migration-utils.js'
import type { SupabaseClient } from '@supabase/supabase-js'

// Fake seed patterns to identify and remove
const FAKE_SEED_PATTERNS = [
  'github.com/skillsmith-community/',
  'github.com/skillsmith-labs/',
  'github.com/unknown-contributor/',
]

// Real skill patterns to preserve (for reference/documentation)
const REAL_SKILL_PATTERNS = [
  'github.com/anthropics/',
  'github.com/huggingface/',
  'github.com/vercel-labs/',
]

interface RemovalOptions {
  dryRun: boolean
  backupOnly: boolean
  force: boolean
}

interface RemovalStats {
  totalScanned: number
  seedSkillsFound: number
  backupCreated: boolean
  backupPath: string | null
  deleted: number
  errors: number
}

/**
 * Parse command-line arguments
 */
function parseArgs(): RemovalOptions {
  const args = process.argv.slice(2)

  if (args.includes('--help') || args.includes('-h')) {
    printUsage()
    process.exit(0)
  }

  return {
    dryRun: args.includes('--dry-run'),
    backupOnly: args.includes('--backup-only'),
    force: args.includes('--force'),
  }
}

/**
 * Print usage information
 */
function printUsage(): void {
  console.log(`
Remove Seed Data - Clean fake seed skills from Supabase

Usage:
  varlock run -- npx tsx scripts/remove-seed-data.ts [options]

Options:
  --dry-run      Preview skills to delete without making changes
  --backup-only  Create backup file only, no deletion
  --force        Skip confirmation prompt
  --help, -h     Show this help message

Fake Seed Patterns (will be DELETED):
  - github.com/skillsmith-community/*
  - github.com/skillsmith-labs/*
  - github.com/unknown-contributor/*

Real Skill Patterns (will be KEPT):
  - github.com/anthropics/*
  - github.com/huggingface/*
  - github.com/vercel-labs/*

Examples:
  # Preview what would be deleted
  varlock run -- npx tsx scripts/remove-seed-data.ts --dry-run

  # Create backup without deleting
  varlock run -- npx tsx scripts/remove-seed-data.ts --backup-only

  # Delete seed data (with confirmation)
  varlock run -- npx tsx scripts/remove-seed-data.ts

  # Delete without confirmation
  varlock run -- npx tsx scripts/remove-seed-data.ts --force
`)
}

/**
 * Check if a skill is a fake seed skill based on repo_url pattern
 */
function isFakeSeedSkill(skill: SupabaseSkill): boolean {
  if (!skill.repo_url) return false

  const repoUrl = skill.repo_url.toLowerCase()
  return FAKE_SEED_PATTERNS.some((pattern) => repoUrl.includes(pattern.toLowerCase()))
}

/**
 * Get the pattern that matched (for reporting)
 */
function getMatchedPattern(repoUrl: string): string {
  const url = repoUrl.toLowerCase()
  for (const pattern of FAKE_SEED_PATTERNS) {
    if (url.includes(pattern.toLowerCase())) {
      return pattern
    }
  }
  return 'unknown'
}

/**
 * Fetch all skills from Supabase with pagination
 */
async function fetchAllSkills(supabase: SupabaseClient): Promise<SupabaseSkill[]> {
  const skills: SupabaseSkill[] = []
  let offset = 0
  const pageSize = 1000

  console.log('Fetching skills from Supabase...')

  while (true) {
    const { data, error } = await supabase
      .from('skills')
      .select('*')
      .range(offset, offset + pageSize - 1)
      .order('id')

    if (error) {
      throw new Error(`Failed to fetch from Supabase: ${error.message}`)
    }

    if (!data || data.length === 0) break

    skills.push(...(data as SupabaseSkill[]))
    offset += data.length
    process.stdout.write(`\r  Fetched ${skills.length} skills...`)

    if (data.length < pageSize) break
  }

  console.log(`\n  Total: ${skills.length} skills from Supabase`)
  return skills
}

/**
 * Create backup file with timestamp
 */
function createBackup(skills: SupabaseSkill[], dataDir: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const backupFileName = `seed-backup-${timestamp}.json`
  const backupPath = path.join(dataDir, backupFileName)

  // Ensure data directory exists
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true })
  }

  const backupData = {
    timestamp: new Date().toISOString(),
    description: 'Backup of seed skills before deletion',
    patterns: FAKE_SEED_PATTERNS,
    count: skills.length,
    skills: skills,
  }

  fs.writeFileSync(backupPath, JSON.stringify(backupData, null, 2))
  return backupPath
}

/**
 * Delete skills from Supabase with retry logic
 */
async function deleteSkills(
  supabase: SupabaseClient,
  skillIds: string[],
  dryRun: boolean
): Promise<{ deleted: number; errors: number }> {
  const BATCH_SIZE = 100
  const MAX_RETRIES = 3
  let deleted = 0
  let errors = 0

  console.log(`\nDeleting ${skillIds.length} seed skills...`)

  if (dryRun) {
    console.log('[DRY RUN] Would delete the following skills:')
    for (const id of skillIds.slice(0, 20)) {
      console.log(`  - ${id}`)
    }
    if (skillIds.length > 20) {
      console.log(`  ... and ${skillIds.length - 20} more`)
    }
    return { deleted: skillIds.length, errors: 0 }
  }

  // Process in batches
  for (let i = 0; i < skillIds.length; i += BATCH_SIZE) {
    const batch = skillIds.slice(i, i + BATCH_SIZE)

    let success = false
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const { error } = await supabase.from('skills').delete().in('id', batch)

      if (!error) {
        success = true
        deleted += batch.length
        break
      }

      if (isRateLimitError(error) && attempt < MAX_RETRIES - 1) {
        const delay = Math.pow(2, attempt) * 1000
        console.log(`\n  Rate limited, retrying in ${delay}ms...`)
        await sleep(delay)
        continue
      }

      console.error(`\n  Batch error: ${error.message}`)
      errors += batch.length
      break
    }

    if (success) {
      process.stdout.write(
        `\r  Progress: ${Math.min(i + BATCH_SIZE, skillIds.length)}/${skillIds.length}`
      )
    }
  }

  console.log('')
  return { deleted, errors }
}

/**
 * Prompt for confirmation
 */
async function confirmDeletion(count: number, force: boolean): Promise<boolean> {
  if (force) return true

  console.log('\n' + '='.repeat(60))
  console.log('CONFIRMATION REQUIRED')
  console.log('='.repeat(60))
  console.log(`This will PERMANENTLY DELETE ${count} seed skills from Supabase.`)
  console.log('A backup will be created before deletion.')
  console.log('\nTo proceed, run with --force flag or respond to the prompt below.')

  const readline = await import('readline')
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  return new Promise((resolve) => {
    rl.question('\nProceed with deletion? (yes/no): ', (answer) => {
      rl.close()
      resolve(answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y')
    })
  })
}

/**
 * Main function
 */
async function removeSeedData(): Promise<void> {
  const startTime = Date.now()

  console.log('='.repeat(60))
  console.log('Remove Seed Data Tool')
  console.log('='.repeat(60))

  const options = parseArgs()

  console.log(`\nMode: ${options.dryRun ? 'DRY RUN' : options.backupOnly ? 'BACKUP ONLY' : 'LIVE'}`)

  // Initialize stats
  const stats: RemovalStats = {
    totalScanned: 0,
    seedSkillsFound: 0,
    backupCreated: false,
    backupPath: null,
    deleted: 0,
    errors: 0,
  }

  // Validate environment
  const config = validateEnv()

  // Create Supabase client
  const supabase = createSupabaseClient(config)

  // Fetch all skills
  console.log('\n--- Fetching Skills ---')
  const allSkills = await fetchAllSkills(supabase)
  stats.totalScanned = allSkills.length

  // Identify fake seed skills
  console.log('\n--- Identifying Seed Skills ---')
  const seedSkills = allSkills.filter(isFakeSeedSkill)
  stats.seedSkillsFound = seedSkills.length

  console.log(`\nFound ${seedSkills.length} seed skills to remove:`)

  // Group by pattern for reporting
  const byPattern = new Map<string, SupabaseSkill[]>()
  for (const skill of seedSkills) {
    const pattern = getMatchedPattern(skill.repo_url || '')
    if (!byPattern.has(pattern)) {
      byPattern.set(pattern, [])
    }
    byPattern.get(pattern)!.push(skill)
  }

  const patternEntries = Array.from(byPattern.entries())
  for (const [pattern, skills] of patternEntries) {
    console.log(`  ${pattern}: ${skills.length} skills`)
    // Show first few examples
    for (const skill of skills.slice(0, 3)) {
      console.log(`    - ${skill.id} (${skill.name})`)
    }
    if (skills.length > 3) {
      console.log(`    ... and ${skills.length - 3} more`)
    }
  }

  // Check for real skills that should NOT be deleted
  const realSkillsInResults = seedSkills.filter((s) => {
    if (!s.repo_url) return false
    const url = s.repo_url.toLowerCase()
    return REAL_SKILL_PATTERNS.some((p) => url.includes(p.toLowerCase()))
  })

  if (realSkillsInResults.length > 0) {
    console.error('\n[ERROR] Found real skills that would be deleted! Aborting.')
    console.error('Unexpected matches:')
    for (const skill of realSkillsInResults) {
      console.error(`  - ${skill.id}: ${skill.repo_url}`)
    }
    process.exit(1)
  }

  if (seedSkills.length === 0) {
    console.log('\nNo seed skills found. Database is clean.')
    return
  }

  // Create backup
  console.log('\n--- Creating Backup ---')
  const dataDir = path.join(process.cwd(), 'data')
  const backupPath = createBackup(seedSkills, dataDir)
  stats.backupCreated = true
  stats.backupPath = backupPath
  console.log(`Backup created: ${backupPath}`)

  if (options.backupOnly) {
    console.log('\n[BACKUP ONLY] Backup created. No deletion performed.')
    printSummary(stats, startTime, options)
    return
  }

  // Confirm before deletion
  if (!options.dryRun) {
    const confirmed = await confirmDeletion(seedSkills.length, options.force)
    if (!confirmed) {
      console.log('\nDeletion cancelled.')
      process.exit(0)
    }
  }

  // Delete seed skills
  console.log('\n--- Deleting Seed Skills ---')
  const skillIds = seedSkills.map((s) => s.id)
  const deleteResult = await deleteSkills(supabase, skillIds, options.dryRun)
  stats.deleted = deleteResult.deleted
  stats.errors = deleteResult.errors

  // Print summary
  printSummary(stats, startTime, options)
}

/**
 * Print final summary
 */
function printSummary(stats: RemovalStats, startTime: number, options: RemovalOptions): void {
  const duration = Date.now() - startTime

  console.log('\n' + '='.repeat(60))
  console.log('Summary')
  console.log('='.repeat(60))
  console.log(`  Total scanned:     ${stats.totalScanned}`)
  console.log(`  Seed skills found: ${stats.seedSkillsFound}`)
  console.log(`  Backup created:    ${stats.backupCreated ? 'Yes' : 'No'}`)
  if (stats.backupPath) {
    console.log(`  Backup path:       ${stats.backupPath}`)
  }
  if (!options.backupOnly) {
    console.log(`  Deleted:           ${stats.deleted}`)
    console.log(`  Errors:            ${stats.errors}`)
  }
  console.log(`  Duration:          ${formatDuration(duration)}`)

  if (options.dryRun) {
    console.log('\n[DRY RUN] No changes were made. Remove --dry-run to execute deletion.')
  } else if (options.backupOnly) {
    console.log('\n[BACKUP ONLY] Remove --backup-only to proceed with deletion.')
  } else if (stats.errors === 0) {
    console.log('\nSeed data removal completed successfully!')
  } else {
    console.log('\nSeed data removal completed with errors.')
    process.exit(1)
  }
}

// Run
removeSeedData().catch((err) => {
  console.error('Seed data removal failed:', err)
  process.exit(1)
})
