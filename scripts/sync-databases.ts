/**
 * SMI-xxxx: Bidirectional Database Sync Tool
 *
 * Syncs skills between local SQLite and Supabase PostgreSQL.
 *
 * Features:
 * - Bidirectional sync (push/pull)
 * - Conflict resolution (newer wins based on updated_at)
 * - Dry-run mode for previewing changes
 * - Safety checks before overwriting
 * - Detailed summary of changes
 *
 * Usage:
 *   npx tsx scripts/sync-databases.ts --direction push [--dry-run]
 *   npx tsx scripts/sync-databases.ts --direction pull [--dry-run]
 */

import Database from 'better-sqlite3'
import type { Database as DatabaseType } from 'better-sqlite3'
import {
  validateEnv,
  createSupabaseClient,
  findDatabase,
  transformSkill,
  sleep,
  isRateLimitError,
  formatDuration,
  type SQLiteSkill,
  type SupabaseSkill,
} from './lib/migration-utils.js'
import type { SupabaseClient } from '@supabase/supabase-js'

// Configuration
const BATCH_SIZE = parseInt(process.env.SYNC_BATCH_SIZE || '100', 10)
const MAX_RETRIES = 3

interface SyncOptions {
  direction: 'push' | 'pull'
  dryRun: boolean
  force: boolean
}

interface SyncStats {
  created: number
  updated: number
  skipped: number
  conflicts: number
  errors: number
}

interface SkillDiff {
  id: string
  name: string
  action: 'create' | 'update' | 'skip' | 'conflict'
  reason?: string
  localUpdatedAt?: string
  remoteUpdatedAt?: string
}

/**
 * Parse command-line arguments
 */
function parseArgs(): SyncOptions {
  const args = process.argv.slice(2)

  let direction: 'push' | 'pull' | null = null
  let dryRun = false
  let force = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--direction' && args[i + 1]) {
      const dir = args[i + 1]
      if (dir === 'push' || dir === 'pull') {
        direction = dir
      } else {
        console.error(`Invalid direction: ${dir}. Must be 'push' or 'pull'.`)
        process.exit(1)
      }
      i++
    } else if (arg === '--dry-run') {
      dryRun = true
    } else if (arg === '--force') {
      force = true
    } else if (arg === '--help' || arg === '-h') {
      printUsage()
      process.exit(0)
    }
  }

  if (!direction) {
    console.error('Error: --direction is required (push or pull)')
    printUsage()
    process.exit(1)
  }

  return { direction, dryRun, force }
}

/**
 * Print usage information
 */
function printUsage(): void {
  console.log(`
Database Sync Tool - Bidirectional sync between SQLite and Supabase

Usage:
  npx tsx scripts/sync-databases.ts --direction <push|pull> [options]

Options:
  --direction <push|pull>  Sync direction (required)
                           push: local SQLite -> Supabase (production)
                           pull: Supabase (production) -> local SQLite
  --dry-run                Preview changes without applying them
  --force                  Skip confirmation prompts
  --help, -h               Show this help message

Environment Variables:
  SUPABASE_URL             Supabase project URL (required)
  SUPABASE_SERVICE_ROLE_KEY  Supabase service role key (required)
  SKILLSMITH_DB_PATH       Path to local SQLite database (optional)
  SYNC_BATCH_SIZE          Batch size for sync operations (default: 100)
  DEBUG=true               Enable verbose logging

Examples:
  # Preview pushing local changes to production
  npx tsx scripts/sync-databases.ts --direction push --dry-run

  # Pull production data to local database
  npx tsx scripts/sync-databases.ts --direction pull

  # Force push without confirmation
  npx tsx scripts/sync-databases.ts --direction push --force
`)
}

/**
 * Fetch all skills from Supabase with pagination
 */
async function fetchSupabaseSkills(supabase: SupabaseClient): Promise<Map<string, SupabaseSkill>> {
  const skills = new Map<string, SupabaseSkill>()
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

    for (const skill of data) {
      skills.set(skill.id, skill as SupabaseSkill)
    }

    offset += data.length
    process.stdout.write(`\r  Fetched ${skills.size} skills...`)

    if (data.length < pageSize) break
  }

  console.log(`\n  Total: ${skills.size} skills from Supabase`)
  return skills
}

/**
 * Fetch all skills from SQLite
 */
function fetchSqliteSkills(sqlite: DatabaseType): Map<string, SQLiteSkill> {
  const skills = new Map<string, SQLiteSkill>()

  console.log('Fetching skills from SQLite...')

  const rows = sqlite.prepare('SELECT * FROM skills ORDER BY id').all() as SQLiteSkill[]

  for (const skill of rows) {
    skills.set(skill.id, skill)
  }

  console.log(`  Total: ${skills.size} skills from SQLite`)
  return skills
}

/**
 * Compare timestamps and determine which record is newer
 * Returns: 'local' | 'remote' | 'equal'
 */
function compareTimestamps(
  localUpdatedAt: string | null | undefined,
  remoteUpdatedAt: string | null | undefined
): 'local' | 'remote' | 'equal' {
  const localTime = localUpdatedAt ? new Date(localUpdatedAt).getTime() : 0
  const remoteTime = remoteUpdatedAt ? new Date(remoteUpdatedAt).getTime() : 0

  // Use a small tolerance (1 second) for timestamp comparison
  const tolerance = 1000

  if (Math.abs(localTime - remoteTime) <= tolerance) {
    return 'equal'
  }

  return localTime > remoteTime ? 'local' : 'remote'
}

/**
 * Calculate diff between local and remote skills
 */
function calculateDiff(
  localSkills: Map<string, SQLiteSkill>,
  remoteSkills: Map<string, SupabaseSkill>,
  direction: 'push' | 'pull'
): SkillDiff[] {
  const diffs: SkillDiff[] = []

  if (direction === 'push') {
    // Push: iterate over local skills
    for (const [id, localSkill] of localSkills.entries()) {
      const remoteSkill = remoteSkills.get(id)

      const localUpdatedAt = localSkill.updated_at || localSkill.created_at
      const remoteUpdatedAt = remoteSkill?.updated_at || remoteSkill?.created_at
      const name = localSkill.name

      if (!remoteSkill) {
        diffs.push({
          id,
          name,
          action: 'create',
          reason: 'New skill in local',
          localUpdatedAt: localUpdatedAt ?? undefined,
          remoteUpdatedAt: undefined,
        })
      } else {
        const winner = compareTimestamps(localUpdatedAt ?? null, remoteUpdatedAt ?? null)

        if (winner === 'equal') {
          diffs.push({
            id,
            name,
            action: 'skip',
            reason: 'Records are identical (same updated_at)',
            localUpdatedAt: localUpdatedAt ?? undefined,
            remoteUpdatedAt: remoteUpdatedAt ?? undefined,
          })
        } else if (winner === 'local') {
          diffs.push({
            id,
            name,
            action: 'update',
            reason: 'Source is newer (local wins)',
            localUpdatedAt: localUpdatedAt ?? undefined,
            remoteUpdatedAt: remoteUpdatedAt ?? undefined,
          })
        } else {
          diffs.push({
            id,
            name,
            action: 'conflict',
            reason: 'Target is newer (remote would be overwritten)',
            localUpdatedAt: localUpdatedAt ?? undefined,
            remoteUpdatedAt: remoteUpdatedAt ?? undefined,
          })
        }
      }
    }
  } else {
    // Pull: iterate over remote skills
    for (const [id, remoteSkill] of remoteSkills.entries()) {
      const localSkill = localSkills.get(id)

      const localUpdatedAt = localSkill?.updated_at || localSkill?.created_at
      const remoteUpdatedAt = remoteSkill.updated_at || remoteSkill.created_at
      const name = remoteSkill.name

      if (!localSkill) {
        diffs.push({
          id,
          name,
          action: 'create',
          reason: 'New skill in remote',
          localUpdatedAt: undefined,
          remoteUpdatedAt: remoteUpdatedAt ?? undefined,
        })
      } else {
        const winner = compareTimestamps(localUpdatedAt ?? null, remoteUpdatedAt ?? null)

        if (winner === 'equal') {
          diffs.push({
            id,
            name,
            action: 'skip',
            reason: 'Records are identical (same updated_at)',
            localUpdatedAt: localUpdatedAt ?? undefined,
            remoteUpdatedAt: remoteUpdatedAt ?? undefined,
          })
        } else if (winner === 'remote') {
          diffs.push({
            id,
            name,
            action: 'update',
            reason: 'Source is newer (remote wins)',
            localUpdatedAt: localUpdatedAt ?? undefined,
            remoteUpdatedAt: remoteUpdatedAt ?? undefined,
          })
        } else {
          diffs.push({
            id,
            name,
            action: 'conflict',
            reason: 'Target is newer (local would be overwritten)',
            localUpdatedAt: localUpdatedAt ?? undefined,
            remoteUpdatedAt: remoteUpdatedAt ?? undefined,
          })
        }
      }
    }
  }

  return diffs
}

/**
 * Print diff summary
 */
function printDiffSummary(diffs: SkillDiff[], direction: 'push' | 'pull'): SyncStats {
  const stats: SyncStats = {
    created: 0,
    updated: 0,
    skipped: 0,
    conflicts: 0,
    errors: 0,
  }

  const creates = diffs.filter((d) => d.action === 'create')
  const updates = diffs.filter((d) => d.action === 'update')
  const skips = diffs.filter((d) => d.action === 'skip')
  const conflicts = diffs.filter((d) => d.action === 'conflict')

  stats.created = creates.length
  stats.updated = updates.length
  stats.skipped = skips.length
  stats.conflicts = conflicts.length

  console.log('\n' + '='.repeat(60))
  console.log(`Sync Summary (${direction.toUpperCase()})`)
  console.log('='.repeat(60))
  console.log(`  To create:  ${stats.created}`)
  console.log(`  To update:  ${stats.updated}`)
  console.log(`  Skipped:    ${stats.skipped}`)
  console.log(`  Conflicts:  ${stats.conflicts}`)

  if (creates.length > 0 && creates.length <= 20) {
    console.log('\nNew skills to create:')
    for (const diff of creates.slice(0, 20)) {
      console.log(`  + ${diff.id} (${diff.name})`)
    }
    if (creates.length > 20) {
      console.log(`  ... and ${creates.length - 20} more`)
    }
  }

  if (updates.length > 0 && updates.length <= 20) {
    console.log('\nSkills to update:')
    for (const diff of updates.slice(0, 20)) {
      console.log(`  ~ ${diff.id} (${diff.name})`)
      console.log(
        `    Local: ${diff.localUpdatedAt || 'N/A'} | Remote: ${diff.remoteUpdatedAt || 'N/A'}`
      )
    }
    if (updates.length > 20) {
      console.log(`  ... and ${updates.length - 20} more`)
    }
  }

  if (conflicts.length > 0) {
    console.log('\nConflicts (target is newer, will NOT be overwritten):')
    for (const diff of conflicts.slice(0, 10)) {
      console.log(`  ! ${diff.id} (${diff.name})`)
      console.log(
        `    Local: ${diff.localUpdatedAt || 'N/A'} | Remote: ${diff.remoteUpdatedAt || 'N/A'}`
      )
    }
    if (conflicts.length > 10) {
      console.log(`  ... and ${conflicts.length - 10} more`)
    }
  }

  return stats
}

/**
 * Convert Supabase skill to SQLite format
 */
function transformToSqlite(skill: SupabaseSkill): SQLiteSkill {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    author: skill.author,
    repo_url: skill.repo_url,
    quality_score: skill.quality_score,
    trust_tier: skill.trust_tier,
    tags: JSON.stringify(skill.tags || []),
    source: skill.source,
    stars: skill.stars,
    created_at: skill.created_at,
    updated_at: skill.updated_at,
  }
}

/**
 * Execute push sync (local -> Supabase)
 */
async function executePush(
  supabase: SupabaseClient,
  localSkills: Map<string, SQLiteSkill>,
  diffs: SkillDiff[],
  dryRun: boolean
): Promise<SyncStats> {
  const stats: SyncStats = { created: 0, updated: 0, skipped: 0, conflicts: 0, errors: 0 }

  const toSync = diffs.filter((d) => d.action === 'create' || d.action === 'update')
  stats.skipped = diffs.filter((d) => d.action === 'skip').length
  stats.conflicts = diffs.filter((d) => d.action === 'conflict').length

  if (toSync.length === 0) {
    console.log('\nNo changes to push.')
    return stats
  }

  console.log(`\nPushing ${toSync.length} skills to Supabase...`)

  if (dryRun) {
    console.log('[DRY RUN] Would push:')
    for (const diff of toSync.slice(0, 10)) {
      console.log(`  ${diff.action === 'create' ? '+' : '~'} ${diff.id}`)
    }
    if (toSync.length > 10) {
      console.log(`  ... and ${toSync.length - 10} more`)
    }
    stats.created = diffs.filter((d) => d.action === 'create').length
    stats.updated = diffs.filter((d) => d.action === 'update').length
    return stats
  }

  // Process in batches
  for (let i = 0; i < toSync.length; i += BATCH_SIZE) {
    const batch = toSync.slice(i, i + BATCH_SIZE)
    const skills = batch
      .map((d) => localSkills.get(d.id))
      .filter((s): s is SQLiteSkill => s !== undefined)
      .map(transformSkill)

    let success = false
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const { error } = await supabase.from('skills').upsert(skills, {
        onConflict: 'id',
        ignoreDuplicates: false,
      })

      if (!error) {
        success = true
        break
      }

      if (isRateLimitError(error) && attempt < MAX_RETRIES - 1) {
        const delay = Math.pow(2, attempt) * 1000
        console.log(`\n  Rate limited, retrying in ${delay}ms...`)
        await sleep(delay)
        continue
      }

      console.error(`\n  Batch error: ${error.message}`)
      stats.errors += batch.length
      break
    }

    if (success) {
      for (const diff of batch) {
        if (diff.action === 'create') stats.created++
        else stats.updated++
      }
    }

    process.stdout.write(
      `\r  Progress: ${Math.min(i + BATCH_SIZE, toSync.length)}/${toSync.length}`
    )
  }

  console.log('')
  return stats
}

/**
 * Execute pull sync (Supabase -> local)
 */
function executePull(
  sqlite: DatabaseType,
  remoteSkills: Map<string, SupabaseSkill>,
  diffs: SkillDiff[],
  dryRun: boolean
): SyncStats {
  const stats: SyncStats = { created: 0, updated: 0, skipped: 0, conflicts: 0, errors: 0 }

  const toSync = diffs.filter((d) => d.action === 'create' || d.action === 'update')
  stats.skipped = diffs.filter((d) => d.action === 'skip').length
  stats.conflicts = diffs.filter((d) => d.action === 'conflict').length

  if (toSync.length === 0) {
    console.log('\nNo changes to pull.')
    return stats
  }

  console.log(`\nPulling ${toSync.length} skills to SQLite...`)

  if (dryRun) {
    console.log('[DRY RUN] Would pull:')
    for (const diff of toSync.slice(0, 10)) {
      console.log(`  ${diff.action === 'create' ? '+' : '~'} ${diff.id}`)
    }
    if (toSync.length > 10) {
      console.log(`  ... and ${toSync.length - 10} more`)
    }
    stats.created = diffs.filter((d) => d.action === 'create').length
    stats.updated = diffs.filter((d) => d.action === 'update').length
    return stats
  }

  // Prepare upsert statement
  const upsert = sqlite.prepare(`
    INSERT INTO skills (id, name, description, author, repo_url, quality_score, trust_tier, tags, source, stars, created_at, updated_at)
    VALUES (@id, @name, @description, @author, @repo_url, @quality_score, @trust_tier, @tags, @source, @stars, @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      author = excluded.author,
      repo_url = excluded.repo_url,
      quality_score = excluded.quality_score,
      trust_tier = excluded.trust_tier,
      tags = excluded.tags,
      source = excluded.source,
      stars = excluded.stars,
      updated_at = excluded.updated_at
  `)

  // Process in transaction
  const transaction = sqlite.transaction((skills: SQLiteSkill[]) => {
    for (const skill of skills) {
      try {
        upsert.run(skill)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`\n  Error syncing ${skill.id}: ${msg}`)
        stats.errors++
      }
    }
  })

  // Process in batches
  for (let i = 0; i < toSync.length; i += BATCH_SIZE) {
    const batch = toSync.slice(i, i + BATCH_SIZE)
    const skills = batch
      .map((d) => remoteSkills.get(d.id))
      .filter((s): s is SupabaseSkill => s !== undefined)
      .map(transformToSqlite)

    const beforeErrors = stats.errors
    transaction(skills)
    const successCount = batch.length - (stats.errors - beforeErrors)

    for (let j = 0; j < successCount; j++) {
      const diff = batch[j]
      if (diff.action === 'create') stats.created++
      else stats.updated++
    }

    process.stdout.write(
      `\r  Progress: ${Math.min(i + BATCH_SIZE, toSync.length)}/${toSync.length}`
    )
  }

  console.log('')
  return stats
}

/**
 * Prompt for confirmation (returns true in non-interactive mode with --force)
 */
async function confirmSync(options: SyncOptions, stats: SyncStats): Promise<boolean> {
  if (options.force) return true
  if (options.dryRun) return true

  const changeCount = stats.created + stats.updated

  if (changeCount === 0) return true

  console.log('\n' + '='.repeat(60))
  console.log('SAFETY CHECK')
  console.log('='.repeat(60))

  if (options.direction === 'push') {
    console.log(`This will modify ${changeCount} records in PRODUCTION (Supabase).`)
  } else {
    console.log(`This will modify ${changeCount} records in LOCAL database.`)
  }

  if (stats.conflicts > 0) {
    console.log(`\nNote: ${stats.conflicts} conflicts will be SKIPPED (target is newer).`)
  }

  console.log('\nTo proceed, run with --force flag or respond to the prompt below.')

  // Simple stdin confirmation
  const readline = await import('readline')
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  return new Promise((resolve) => {
    rl.question('\nProceed with sync? (yes/no): ', (answer) => {
      rl.close()
      resolve(answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y')
    })
  })
}

/**
 * Main sync function
 */
async function sync(): Promise<void> {
  const startTime = Date.now()

  console.log('='.repeat(60))
  console.log('Database Sync Tool')
  console.log('='.repeat(60))

  const options = parseArgs()

  console.log(`\nDirection: ${options.direction.toUpperCase()}`)
  console.log(`Mode: ${options.dryRun ? 'DRY RUN (preview only)' : 'LIVE'}`)

  // Validate environment
  const config = validateEnv()

  // Find local database
  const dbPath = findDatabase()
  const sqlite = new Database(dbPath, { readonly: options.direction === 'push' })

  // Create Supabase client
  const supabase = createSupabaseClient(config)

  // Fetch all skills from both sources
  console.log('\n--- Fetching Data ---')
  const [localSkills, remoteSkills] = await Promise.all([
    Promise.resolve(fetchSqliteSkills(sqlite)),
    fetchSupabaseSkills(supabase),
  ])

  // Calculate diff
  console.log('\n--- Calculating Differences ---')
  const diffs = calculateDiff(localSkills, remoteSkills, options.direction)

  // Print summary
  const preStats = printDiffSummary(diffs, options.direction)

  // Confirm before proceeding
  const confirmed = await confirmSync(options, preStats)
  if (!confirmed) {
    console.log('\nSync cancelled.')
    sqlite.close()
    process.exit(0)
  }

  // Execute sync
  console.log('\n--- Executing Sync ---')
  let finalStats: SyncStats

  if (options.direction === 'push') {
    finalStats = await executePush(supabase, localSkills, diffs, options.dryRun)
  } else {
    // Reopen database with write access for pull
    sqlite.close()
    const writableSqlite = new Database(dbPath)
    finalStats = executePull(writableSqlite, remoteSkills, diffs, options.dryRun)
    writableSqlite.close()
  }

  if (options.direction === 'push') {
    sqlite.close()
  }

  // Final report
  const duration = Date.now() - startTime

  console.log('\n' + '='.repeat(60))
  console.log('Sync Complete')
  console.log('='.repeat(60))
  console.log(`  Direction:  ${options.direction}`)
  console.log(`  Created:    ${finalStats.created}`)
  console.log(`  Updated:    ${finalStats.updated}`)
  console.log(`  Skipped:    ${finalStats.skipped}`)
  console.log(`  Conflicts:  ${finalStats.conflicts}`)
  console.log(`  Errors:     ${finalStats.errors}`)
  console.log(`  Duration:   ${formatDuration(duration)}`)

  if (options.dryRun) {
    console.log('\n[DRY RUN] No changes were made. Remove --dry-run to execute.')
  } else if (finalStats.errors === 0) {
    console.log('\nSync completed successfully!')
  } else {
    console.log('\nSync completed with errors.')
    process.exit(1)
  }
}

// Run
sync().catch((err) => {
  console.error('Sync failed:', err)
  process.exit(1)
})
