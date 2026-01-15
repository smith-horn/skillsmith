/**
 * GitHub API Import Script for Large-Scale Skill Collection (SMI-860)
 *
 * Searches GitHub for Claude-related skills using multiple query strategies:
 * - topic:claude-skill
 * - topic:mcp-server
 * - filename:SKILL.md
 * - topic:anthropic-skills
 *
 * Features:
 * - Exponential backoff retry for rate limit handling
 * - Resume support via checkpoint file
 * - Progress logging
 * - Output to JSON with metadata
 *
 * Usage:
 *   GITHUB_TOKEN=xxx npx tsx packages/core/src/scripts/import-github-skills.ts
 *
 * Options:
 *   --resume     Resume from last checkpoint
 *   --output     Custom output path (default: data/imported-skills.json)
 */

import { CONFIG, SEARCH_QUERIES, ImportedSkill, ImportStats, Checkpoint } from './types.js'
import { log, sleep } from './utils.js'
import { checkRateLimit, fetchGitHubSearch } from './github-client.js'
import { saveCheckpoint, loadCheckpoint, clearCheckpoint } from './checkpoint.js'
import { deduplicateSkills } from './deduplication.js'
import { saveOutput } from './output.js'

// Re-export all types and functions for external use
export * from './types.js'
export * from './utils.js'
export * from './github-client.js'
export * from './checkpoint.js'
export * from './deduplication.js'
export * from './output.js'

/**
 * Main import function.
 * Orchestrates the import process with support for resume.
 */
async function _main(): Promise<void> {
  const startTime = Date.now()
  const shouldResume = process.argv.includes('--resume')

  console.log('======================================================================')
  console.log('       GitHub Skills Import (SMI-860)')
  console.log('======================================================================')
  console.log()

  // Check for token
  if (CONFIG.GITHUB_TOKEN) {
    log('GITHUB_TOKEN detected')
    await checkRateLimit()
  } else {
    log('No GITHUB_TOKEN - limited to 60 requests/hour', 'warn')
    log('Set GITHUB_TOKEN environment variable for higher limits', 'warn')
  }
  console.log()

  // Initialize or load checkpoint
  let allSkills: ImportedSkill[] = []
  let stats: ImportStats = {
    total_found: 0,
    total_imported: 0,
    duplicates_removed: 0,
    queries_completed: [],
    errors: [],
    started_at: new Date().toISOString(),
  }
  let startQueryIndex = 0
  let startPage = 1

  if (shouldResume) {
    const checkpoint = loadCheckpoint()
    if (checkpoint) {
      allSkills = checkpoint.skills
      stats = checkpoint.stats

      // Find the query to resume from
      const lastQueryIndex = SEARCH_QUERIES.findIndex((q) => q.name === checkpoint.last_query)
      if (lastQueryIndex >= 0) {
        startQueryIndex = lastQueryIndex
        startPage = checkpoint.last_page + 1
        log(`Resuming from query: ${checkpoint.last_query}, page: ${startPage}`)
      }
    } else {
      log('No checkpoint found, starting fresh')
    }
  }
  console.log()

  // Graceful shutdown handler
  let isShuttingDown = false
  process.on('SIGINT', () => {
    if (isShuttingDown) {
      log('Force quitting...', 'warn')
      process.exit(1)
    }

    isShuttingDown = true
    log('\nGraceful shutdown initiated (Ctrl+C again to force)...')

    // Save checkpoint
    const checkpoint: Checkpoint = {
      last_query:
        stats.queries_completed[stats.queries_completed.length - 1] || SEARCH_QUERIES[0].name,
      last_page: 1,
      skills: allSkills,
      stats,
      timestamp: new Date().toISOString(),
    }
    saveCheckpoint(checkpoint)

    log('Checkpoint saved. Run with --resume to continue.')
    process.exit(0)
  })

  // Execute search queries
  log('Starting import...')
  console.log()

  for (let i = startQueryIndex; i < SEARCH_QUERIES.length; i++) {
    const query = SEARCH_QUERIES[i]
    const page = i === startQueryIndex ? startPage : 1

    console.log('----------------------------------------------------------------------')
    log(`Query ${i + 1}/${SEARCH_QUERIES.length}: ${query.name}`)
    console.log('----------------------------------------------------------------------')

    try {
      const skills = await fetchGitHubSearch(query, page)
      allSkills.push(...skills)
      stats.total_found += skills.length
      stats.queries_completed.push(query.name)

      // Save checkpoint after each query
      const checkpoint: Checkpoint = {
        last_query: query.name,
        last_page: Math.ceil(skills.length / CONFIG.PER_PAGE),
        skills: allSkills,
        stats,
        timestamp: new Date().toISOString(),
      }
      saveCheckpoint(checkpoint)
    } catch (error) {
      const errorMsg = `Query ${query.name} failed: ${error}`
      log(errorMsg, 'error')
      stats.errors.push(errorMsg)
    }

    // Delay between queries
    if (i < SEARCH_QUERIES.length - 1) {
      log(`Waiting ${CONFIG.QUERY_DELAY}ms before next query...`)
      await sleep(CONFIG.QUERY_DELAY)
    }

    console.log()
  }

  // Deduplicate results
  console.log('======================================================================')
  log('Deduplicating results...')
  const { unique, duplicateCount } = deduplicateSkills(allSkills)
  stats.duplicates_removed = duplicateCount
  stats.total_imported = unique.length
  log(`Removed ${duplicateCount} duplicates`)
  log(`Final count: ${unique.length} unique skills`)
  console.log()

  // Complete stats
  stats.completed_at = new Date().toISOString()
  stats.duration_ms = Date.now() - startTime

  // Save output
  log('Saving output...')
  saveOutput(unique, stats)

  // Clear checkpoint on successful completion
  clearCheckpoint()

  // Print summary
  console.log()
  console.log('======================================================================')
  console.log('                         IMPORT SUMMARY')
  console.log('======================================================================')
  console.log(`  Total Found:        ${stats.total_found}`)
  console.log(`  Duplicates Removed: ${stats.duplicates_removed}`)
  console.log(`  Total Imported:     ${stats.total_imported}`)
  console.log(`  Duration:           ${(stats.duration_ms! / 1000).toFixed(2)}s`)
  console.log(`  Queries Completed:  ${stats.queries_completed.join(', ')}`)
  console.log(`  Output File:        ${CONFIG.OUTPUT_PATH}`)

  if (stats.errors.length > 0) {
    console.log()
    console.log('Errors encountered:')
    for (const error of stats.errors) {
      console.log(`  - ${error}`)
    }
  }

  console.log('======================================================================')

  // Validate expected output
  if (unique.length >= 500) {
    log(`SUCCESS: Imported ${unique.length} skills (target: 500+)`)
  } else {
    log(`WARNING: Only ${unique.length} skills imported (target: 500+)`, 'warn')
    log('Consider running without rate limits using a GITHUB_TOKEN', 'warn')
  }
}

// Note: This module is imported by import-github-skills.ts which has its own main().
// Do not auto-execute here to avoid duplicate output.
