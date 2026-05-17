#!/usr/bin/env npx tsx
/**
 * Batch Skill Transformation CLI
 * SMI-1840: Pre-transform skills using TransformationService
 * SMI-2200: Checkpoint-based resumability
 * SMI-2203: Dynamic rate limiting
 *
 * Processes skills through the transformation pipeline:
 * 1. Fetches skills from Supabase in batches
 * 2. Fetches SKILL.md content from GitHub
 * 3. Runs TransformationService on each skill
 * 4. Saves results to skill_transformations table
 *
 * Usage:
 *   varlock run -- npx tsx scripts/batch-transform-skills.ts --dry-run --limit 10
 *   varlock run -- npx tsx scripts/batch-transform-skills.ts --verbose
 *   varlock run -- npx tsx scripts/batch-transform-skills.ts --resume
 *   docker exec skillsmith-dev-1 varlock run -- npx tsx scripts/batch-transform-skills.ts
 *
 * Run with --help for the full option reference.
 *
 * SMI-4935: the implementation is split across sibling modules to keep every
 * file under the 500-line limit:
 *   - batch-transform-skills.types.ts       shared interfaces
 *   - batch-transform-skills.progress.ts    progress reporters
 *   - batch-transform-skills.cli.ts         arg parsing, help, env validation
 *   - batch-transform-skills.checkpoint.ts  checkpoint management
 *   - batch-transform-skills.filters.ts     filter validation + dry-run preview
 *   - batch-transform-skills.pipeline.ts    DB access, fetch, per-skill transform
 */

import { randomUUID } from 'crypto'
import { createClient } from '@supabase/supabase-js'
import { TransformationService } from '@skillsmith/core'
import { GitHubRateLimiter } from './lib/migration-utils'
import { GITHUB_API_BASE_DELAY } from './lib/constants'
import type {
  BatchTransformCheckpoint,
  JsonOutput,
  SkillFilters,
  TransformStats,
} from './batch-transform-skills.types'
import { parseCliArgs, printHelp, validateEnv } from './batch-transform-skills.cli'
import { createProgressReporter } from './batch-transform-skills.progress'
import {
  clearBatchTransformCheckpoint,
  loadBatchTransformCheckpoint,
  promptConfirmation,
  saveBatchTransformCheckpoint,
} from './batch-transform-skills.checkpoint'
import {
  getFilterPreview,
  hasActiveFilters,
  printFilterPreview,
  validateFilters,
} from './batch-transform-skills.filters'
import { fetchSkillsBatch, processSkill, writeAuditLog } from './batch-transform-skills.pipeline'

async function main(): Promise<void> {
  const options = parseCliArgs()

  if (options.help) {
    printHelp()
    process.exit(0)
  }

  // Validate flag combinations
  if (options.resume && options.offset > 0) {
    console.error('Error: --resume and --offset are mutually exclusive')
    process.exit(1)
  }

  // SMI-2201: Validate filter options
  const filterErrors = validateFilters(options)
  if (filterErrors.length > 0) {
    console.error('\nError: Invalid filter options:')
    filterErrors.forEach((e) => console.error(`  - ${e}`))
    process.exit(1)
  }

  const config = validateEnv()

  // Handle --reset
  if (options.reset) {
    const checkpoint = loadBatchTransformCheckpoint()
    if (checkpoint) {
      if (!options.force) {
        const confirmed = await promptConfirmation(
          `This will clear checkpoint with ${checkpoint.processedCount} processed records. Continue?`
        )
        if (!confirmed) {
          console.log('Aborted.')
          process.exit(0)
        }
      }
    }
    clearBatchTransformCheckpoint()
    if (!options.resume) {
      // If just --reset without other operations, exit
      process.exit(0)
    }
  }

  // Handle --resume
  let checkpoint: BatchTransformCheckpoint | null = null
  let startOffset = options.offset
  const runId = randomUUID()

  if (options.resume) {
    checkpoint = loadBatchTransformCheckpoint()
    if (checkpoint) {
      startOffset = checkpoint.lastProcessedOffset
      console.log(`\n🔄 Resuming from offset ${startOffset}`)
    } else {
      console.log('\n📍 No checkpoint found, starting fresh')
    }
  }

  // Create rate limiter
  const rateLimiter = options.noRateLimit
    ? new GitHubRateLimiter(50) // Fixed 50ms for testing
    : new GitHubRateLimiter(GITHUB_API_BASE_DELAY)

  console.log('\n' + '='.repeat(60))
  console.log('Skillsmith Batch Transformation')
  console.log('='.repeat(60))
  console.log('')
  console.log('Configuration:')
  console.log('-'.repeat(50))
  console.log(`  Run ID:     ${runId.slice(0, 8)}...`)
  console.log(`  Limit:      ${options.limit === Infinity ? 'all' : options.limit}`)
  console.log(`  Offset:     ${startOffset}`)
  console.log(`  Dry Run:    ${options.dryRun}`)
  console.log(`  Verbose:    ${options.verbose}`)
  console.log(`  GitHub:     ${config.githubToken ? 'authenticated' : 'anonymous'}`)
  console.log(
    `  Rate Limit: ${options.noRateLimit ? 'disabled (50ms)' : `dynamic (base: ${GITHUB_API_BASE_DELAY}ms)`}`
  )
  console.log(`  Checkpoint: every ${options.checkpointInterval} skills`)

  // SMI-2201: Show active filters
  if (hasActiveFilters(options)) {
    console.log('')
    console.log('Active Filters:')
    if (options.retryFailed) console.log('  --retry-failed')
    if (options.retrySkipped) console.log('  --retry-skipped')
    if (options.onlyMissing) console.log('  --only-missing')
    if (options.since) console.log(`  --since ${options.since}`)
    if (options.trustTier) console.log(`  --trust-tier ${options.trustTier}`)
    if (options.monorepoSkills) console.log('  --monorepo-skills')
  }
  console.log('-'.repeat(50))

  // Create Supabase client
  const supabase = createClient(config.supabaseUrl, config.supabaseServiceKey, {
    auth: { persistSession: false },
  })

  // SMI-2201: Show filter preview in dry-run mode
  if (options.dryRun && hasActiveFilters(options)) {
    const { total, breakdown } = await getFilterPreview(supabase, options)
    printFilterPreview(breakdown, total)

    if (total === 0) {
      console.log('No skills match the specified filters. Nothing to process.')
      process.exit(0)
    }
  }

  // Create transformation service (no database caching)
  const service = new TransformationService(undefined, {
    enableCache: false,
    version: '1.0.0',
  })

  // Statistics
  const stats: TransformStats = {
    processed: checkpoint?.processedCount ?? 0,
    transformed: checkpoint?.successCount ?? 0,
    skipped: 0,
    failed: checkpoint?.errorCount ?? 0,
    errors: checkpoint?.errors ?? [],
    failedSkillIds: checkpoint?.failedSkillIds ?? [],
    skippedSkillIds: checkpoint?.skippedSkillIds ?? [],
  }

  const startTime = Date.now()

  // Write audit log: start
  if (!options.dryRun) {
    await writeAuditLog(supabase, {
      event_type: 'batch-transform:start',
      metadata: {
        run_id: runId,
        options: {
          limit: options.limit === Infinity ? 'all' : options.limit,
          offset: startOffset,
          dry_run: options.dryRun,
          checkpoint_interval: options.checkpointInterval,
          resumed_from: checkpoint?.runId,
        },
      },
    })
  }

  const batchSize = 100
  let batchNumber = 0
  let skillsSinceCheckpoint = 0

  // SMI-2204: Create progress reporter
  const progressReporter = createProgressReporter(options)
  progressReporter.start(options.limit === Infinity ? null : options.limit, options)

  // SMI-2201: Build filter configuration
  const filters: SkillFilters = {
    retryFailed: options.retryFailed,
    retrySkipped: options.retrySkipped,
    onlyMissing: options.onlyMissing,
    since: options.since,
    trustTier: options.trustTier,
    monorepoSkills: options.monorepoSkills,
  }

  try {
    // Process skills in batches
    for await (const batch of fetchSkillsBatch(
      supabase,
      batchSize,
      startOffset,
      options.limit,
      filters
    )) {
      batchNumber++
      const batchStartIdx = (batchNumber - 1) * batchSize + startOffset + 1
      const batchEndIdx = batchStartIdx + batch.length - 1

      progressReporter.batchStart(batchNumber, batchStartIdx, batchEndIdx)

      for (const skill of batch) {
        stats.processed++
        skillsSinceCheckpoint++

        const result = await processSkill(skill, service, supabase, rateLimiter, options, config)

        // Update stats based on result
        switch (result.status) {
          case 'transformed':
            stats.transformed++
            break
          case 'skipped':
            stats.skipped++
            stats.skippedSkillIds.push(skill.id)
            break
          case 'failed':
            stats.failed++
            stats.failedSkillIds.push(skill.id)
            stats.errors.push(`${skill.id}: ${result.error}`)
            break
        }

        // Report progress via reporter
        progressReporter.update(skill, result, stats)

        // Save checkpoint at intervals
        if (skillsSinceCheckpoint >= options.checkpointInterval && !options.dryRun) {
          const checkpointData: BatchTransformCheckpoint = {
            lastProcessedOffset: startOffset + stats.processed,
            lastProcessedId: skill.id,
            processedCount: stats.processed,
            successCount: stats.transformed,
            errorCount: stats.failed,
            errors: stats.errors.slice(-100), // Keep last 100 errors
            timestamp: new Date().toISOString(),
            dbPath: 'supabase',
            failedSkillIds: stats.failedSkillIds.slice(-500),
            skippedSkillIds: stats.skippedSkillIds.slice(-500),
            runId,
          }
          saveBatchTransformCheckpoint(checkpointData)

          // Write audit log: progress
          await writeAuditLog(supabase, {
            event_type: 'batch-transform:progress',
            metadata: {
              run_id: runId,
              stats: {
                processed: stats.processed,
                transformed: stats.transformed,
                skipped: stats.skipped,
                failed: stats.failed,
              },
              checkpoint_offset: startOffset + stats.processed,
            },
          })

          skillsSinceCheckpoint = 0
          progressReporter.checkpoint(startOffset + stats.processed)
        }
      }

      progressReporter.batchEnd()
    }
  } catch (error) {
    // Save checkpoint on error
    if (!options.dryRun) {
      const checkpointData: BatchTransformCheckpoint = {
        lastProcessedOffset: startOffset + stats.processed,
        processedCount: stats.processed,
        successCount: stats.transformed,
        errorCount: stats.failed,
        errors: stats.errors.slice(-100),
        timestamp: new Date().toISOString(),
        dbPath: 'supabase',
        failedSkillIds: stats.failedSkillIds.slice(-500),
        skippedSkillIds: stats.skippedSkillIds.slice(-500),
        runId,
      }
      saveBatchTransformCheckpoint(checkpointData)
      console.log(`\n📍 Checkpoint saved after error at offset ${startOffset + stats.processed}`)
    }
    throw error
  }

  const duration = Date.now() - startTime

  // Write audit log: complete
  if (!options.dryRun) {
    await writeAuditLog(supabase, {
      event_type: 'batch-transform:complete',
      result: stats.failed === 0 ? 'success' : 'partial',
      metadata: {
        run_id: runId,
        stats: {
          processed: stats.processed,
          transformed: stats.transformed,
          skipped: stats.skipped,
          failed: stats.failed,
        },
        duration_ms: duration,
        failed_skill_ids: stats.failedSkillIds,
      },
    })

    // Clear checkpoint on successful completion
    if (stats.failed === 0) {
      clearBatchTransformCheckpoint()
    }
  }

  // SMI-2204: Finish progress reporter and get JSON output if applicable
  const jsonOutput = progressReporter.finish(stats, duration, runId)

  // SMI-2204: Output JSON if --json flag is set
  if (options.json) {
    const output: JsonOutput = jsonOutput ?? {
      processed: stats.processed,
      transformed: stats.transformed,
      skipped: stats.skipped,
      failed: stats.failed,
      duration_ms: duration,
      checkpoint: null,
      failed_skills: stats.failedSkillIds,
      skipped_skills: stats.skippedSkillIds.map((id) => ({ id, reason: 'Unknown' })),
    }

    // Add checkpoint info if exists
    const checkpoint = loadBatchTransformCheckpoint()
    if (checkpoint) {
      output.checkpoint = {
        offset: checkpoint.lastProcessedOffset,
        timestamp: checkpoint.timestamp,
      }
    }

    // Output final JSON
    console.log(JSON.stringify({ type: 'summary', ...output }, null, 2))
    process.exit(stats.failed > 0 ? 1 : 0)
  }

  // Print human-readable summary (non-JSON mode)
  console.log('\n' + '='.repeat(60))
  console.log(options.dryRun ? 'DRY RUN SUMMARY' : 'TRANSFORMATION SUMMARY')
  console.log('='.repeat(60))
  console.log('')
  console.log('Results:')
  console.log('-'.repeat(50))
  console.log(`  Run ID:      ${runId.slice(0, 8)}...`)
  console.log(`  Duration:    ${(duration / 1000).toFixed(1)}s`)
  console.log(`  Processed:   ${stats.processed}`)
  console.log(`  Transformed: ${stats.transformed}`)
  console.log(`  Skipped:     ${stats.skipped}`)
  console.log(`  Failed:      ${stats.failed}`)
  console.log(`  Rate Limit:  ${rateLimiter.getRemaining()} remaining`)
  console.log('-'.repeat(50))

  if (stats.errors.length > 0) {
    console.log('')
    console.log('Errors:')
    stats.errors.slice(0, 10).forEach((err, idx) => {
      console.log(`  ${idx + 1}. ${err}`)
    })
    if (stats.errors.length > 10) {
      console.log(`  ... and ${stats.errors.length - 10} more`)
    }
  }

  console.log('')
  const statusColor = stats.failed === 0 ? '\x1b[32m' : '\x1b[33m'
  const status = stats.failed === 0 ? 'SUCCESS' : 'COMPLETED WITH ERRORS'
  console.log(`Status: ${statusColor}${status}\x1b[0m`)
  console.log('='.repeat(60))

  // Exit with error code if there were failures
  process.exit(stats.failed > 0 ? 1 : 0)
}

// Only run main() when executed directly, not when imported as a module
const isMainModule = import.meta.url === `file://${process.argv[1]}`
if (isMainModule) {
  main().catch((error) => {
    console.error('\nFatal error:', error)
    process.exit(1)
  })
}
