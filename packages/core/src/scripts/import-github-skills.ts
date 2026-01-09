/**
 * GitHub API Import Script for Large-Scale Skill Collection (SMI-860)
 *
 * This file re-exports from the split github-import module for backwards compatibility.
 * See ./github-import/ for the implementation.
 *
 * Usage:
 *   GITHUB_TOKEN=xxx npx tsx packages/core/src/scripts/import-github-skills.ts
 *
 * Options:
 *   --resume     Resume from last checkpoint
 *   --output     Custom output path (default: data/imported-skills.json)
 */

// Re-export everything from the github-import module
export * from './github-import/index.js'

// Import and re-run the CLI if this file is executed directly
import {
  CONFIG,
  SEARCH_QUERIES,
  ImportedSkill,
  ImportStats,
  Checkpoint,
} from './github-import/types.js'
import { log, sleep } from './github-import/utils.js'
import { checkRateLimit, fetchGitHubSearch } from './github-import/github-client.js'
import { saveCheckpoint, loadCheckpoint, clearCheckpoint } from './github-import/checkpoint.js'
import { deduplicateSkills } from './github-import/deduplication.js'
import { saveOutput } from './github-import/output.js'

async function main(): Promise<void> {
  const startTime = Date.now()
  const shouldResume = process.argv.includes('--resume')

  console.log('======================================================================')
  console.log('       GitHub Skills Import (SMI-860)')
  console.log('======================================================================')
  console.log()

  if (CONFIG.GITHUB_TOKEN) {
    log('GITHUB_TOKEN detected')
    await checkRateLimit()
  } else {
    log('No GITHUB_TOKEN - limited to 60 requests/hour', 'warn')
    log('Set GITHUB_TOKEN environment variable for higher limits', 'warn')
  }
  console.log()

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

  let isShuttingDown = false
  process.on('SIGINT', () => {
    if (isShuttingDown) {
      log('Force quitting...', 'warn')
      process.exit(1)
    }
    isShuttingDown = true
    log('\nGraceful shutdown initiated (Ctrl+C again to force)...')
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

    if (i < SEARCH_QUERIES.length - 1) {
      log(`Waiting ${CONFIG.QUERY_DELAY}ms before next query...`)
      await sleep(CONFIG.QUERY_DELAY)
    }
    console.log()
  }

  console.log('======================================================================')
  log('Deduplicating results...')
  const { unique, duplicateCount } = deduplicateSkills(allSkills)
  stats.duplicates_removed = duplicateCount
  stats.total_imported = unique.length
  log(`Removed ${duplicateCount} duplicates`)
  log(`Final count: ${unique.length} unique skills`)
  console.log()

  stats.completed_at = new Date().toISOString()
  stats.duration_ms = Date.now() - startTime

  log('Saving output...')
  saveOutput(unique, stats)
  clearCheckpoint()

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

  if (unique.length >= 500) {
    log(`SUCCESS: Imported ${unique.length} skills (target: 500+)`)
  } else {
    log(`WARNING: Only ${unique.length} skills imported (target: 500+)`, 'warn')
    log('Consider running without rate limits using a GITHUB_TOKEN', 'warn')
  }
}

const isMainModule = process.argv[1]?.includes('import-github-skills')
if (isMainModule) {
  main().catch((error) => {
    log(`Fatal error: ${error}`, 'error')
    process.exit(1)
  })
}
