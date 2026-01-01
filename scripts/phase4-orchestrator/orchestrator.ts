#!/usr/bin/env npx tsx
/**
 * Phase 4 Orchestrator - Main Entry Point
 *
 * Executes Phase 4: Product Strategy using claude-flow hive mind:
 * 1. Runs 4 epics sequentially
 * 2. Code review after each epic
 * 3. Resolves blocking issues before proceeding
 * 4. Updates Linear throughout
 * 5. Pauses only on critical issues
 *
 * Usage:
 *   npx tsx orchestrator.ts [--dry-run] [--start-from <epic-number>]
 */

import { spawn } from 'child_process'
import { mkdir } from 'fs/promises'
import { join } from 'path'
import { EPICS, CONFIG } from './config.js'
import { createLinearSync, LinearSync } from './linear-sync.js'
import { runEpic } from './epic-runner.js'
import { runCodeReview, resolveBlockers } from './code-reviewer.js'

interface OrchestratorState {
  startTime: Date
  currentEpic: number
  completedEpics: number
  totalIssuesCreated: number
  totalFindings: number
  totalBlockers: number
  criticalPause: boolean
  errors: string[]
}

/**
 * Initialize claude-flow swarm for hive mind coordination
 */
async function initializeHiveMind(dryRun: boolean): Promise<string | null> {
  if (dryRun) {
    console.log('[Orchestrator] [DryRun] Would initialize hive mind swarm')
    return 'dry-run-swarm-id'
  }

  console.log('[Orchestrator] Initializing claude-flow hive mind...')

  return new Promise((resolve) => {
    const proc = spawn(
      'npx',
      [
        'claude-flow',
        'swarm',
        'Phase 4 Product Strategy Execution',
        '--strategy',
        'development',
        '--mode',
        'hierarchical',
        '--max-agents',
        String(CONFIG.maxAgentsPerEpic),
      ],
      {
        cwd: CONFIG.skillsmithPath,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    )

    let output = ''
    proc.stdout?.on('data', (data) => {
      output += data.toString()
    })

    proc.on('close', (code) => {
      if (code === 0) {
        // Extract swarm ID from output
        const match = output.match(/swarm[_-]?id[:\s]+([a-zA-Z0-9-]+)/i)
        resolve(match?.[1] || 'unknown')
      } else {
        console.warn('[Orchestrator] Failed to initialize swarm, proceeding without coordination')
        resolve(null)
      }
    })

    proc.on('error', () => {
      resolve(null)
    })

    // Timeout after 30s
    setTimeout(() => {
      proc.kill()
      resolve(null)
    }, 30000)
  })
}

/**
 * Store orchestrator state in memory for recovery
 */
async function saveState(state: OrchestratorState, dryRun: boolean): Promise<void> {
  if (dryRun) return

  return new Promise((resolve) => {
    const stateJson = JSON.stringify(state)
    const proc = spawn(
      'npx',
      [
        'claude-flow',
        'memory',
        'store',
        'orchestrator-state',
        stateJson,
        '--namespace',
        CONFIG.memoryNamespace,
      ],
      {
        cwd: CONFIG.skillsmithPath,
        stdio: 'inherit',
      }
    )

    proc.on('close', () => resolve())
    proc.on('error', () => resolve())
  })
}

/**
 * Prompt for user confirmation on critical issues
 */
async function promptForContinuation(unresolvedBlockers: string[]): Promise<boolean> {
  console.log('\n' + '!'.repeat(60))
  console.log('CRITICAL ISSUES DETECTED - HUMAN REVIEW REQUIRED')
  console.log('!'.repeat(60))
  console.log('\nThe following critical/high issues could not be auto-resolved:')
  unresolvedBlockers.forEach((b, i) => console.log(`  ${i + 1}. ${b}`))
  console.log('\nOptions:')
  console.log('  1. Review and fix manually, then restart orchestrator')
  console.log('  2. Continue anyway (not recommended)')
  console.log('  3. Abort Phase 4 execution')
  console.log('\nOrchestrator pausing. State saved for recovery.')
  console.log('To continue: npx tsx orchestrator.ts --resume')
  console.log('To restart: npx tsx orchestrator.ts --start-from <epic-number>')

  // In automated mode, we pause and exit
  return false
}

/**
 * Create output directories
 */
async function setupOutputDirs(): Promise<void> {
  for (const epic of EPICS) {
    const dir = join(CONFIG.skillsmithPath, 'output', epic.id)
    await mkdir(dir, { recursive: true })
  }
}

/**
 * Main orchestration loop
 */
async function orchestrate(options: { dryRun: boolean; startFrom: number }): Promise<void> {
  const { dryRun, startFrom } = options

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║          PHASE 4 ORCHESTRATOR - PRODUCT STRATEGY             ║
║                                                              ║
║  Executing ${EPICS.length} epics via claude-flow hive mind             ║
║  Mode: ${dryRun ? 'DRY RUN (no actual changes)' : 'LIVE EXECUTION'}                          ║
║  Starting from: Epic ${startFrom}                                     ║
╚══════════════════════════════════════════════════════════════╝
`)

  // Initialize state
  const state: OrchestratorState = {
    startTime: new Date(),
    currentEpic: startFrom,
    completedEpics: startFrom - 1,
    totalIssuesCreated: 0,
    totalFindings: 0,
    totalBlockers: 0,
    criticalPause: false,
    errors: [],
  }

  // Setup
  await setupOutputDirs()

  // Initialize Linear sync
  let linear: LinearSync | null = null
  try {
    linear = await createLinearSync()
    console.log('[Orchestrator] ✅ Linear sync initialized')
  } catch (err) {
    console.warn('[Orchestrator] ⚠️ Linear sync failed, continuing without updates')
    if (!dryRun) {
      console.error(err)
    }
  }

  // Initialize hive mind
  const swarmId = await initializeHiveMind(dryRun)
  if (swarmId) {
    console.log(`[Orchestrator] ✅ Hive mind initialized: ${swarmId}`)
  }

  // Execute epics
  for (let i = startFrom - 1; i < EPICS.length; i++) {
    const epic = EPICS[i]
    const epicNumber = i + 1
    state.currentEpic = epicNumber

    console.log(`\n${'═'.repeat(60)}`)
    console.log(`EPIC ${epicNumber}/${EPICS.length}: ${epic.title}`)
    console.log(`${'═'.repeat(60)}`)

    // Pre-epic Linear update
    if (linear) {
      await linear.createEpicStartUpdate(epic, epicNumber)
    }

    // Run the epic
    const epicResult = await runEpic(epic, dryRun)

    if (!epicResult.success) {
      state.errors.push(`Epic ${epicNumber} failed: ${epicResult.errors.join(', ')}`)
      console.error(`[Orchestrator] Epic ${epicNumber} failed`)

      if (!dryRun) {
        await saveState(state, dryRun)
        console.log('[Orchestrator] State saved. Resolve issues and restart.')
        return
      }
    }

    // Code review
    console.log('\n[Orchestrator] Running code review...')
    const reviewResult = await runCodeReview(epic, epicResult, dryRun)
    state.totalFindings += reviewResult.findings.length

    // Create Linear issues for findings
    if (linear && reviewResult.findings.length > 0) {
      for (const finding of reviewResult.findings) {
        await linear.createCodeReviewIssue(finding, epic.id)
        state.totalIssuesCreated++
      }
    }

    // Handle blockers
    if (reviewResult.blockers.length > 0) {
      console.log(`\n[Orchestrator] Found ${reviewResult.blockers.length} blocking issues`)

      const { unresolved } = await resolveBlockers(reviewResult.blockers, dryRun)
      state.totalBlockers += unresolved.length

      if (unresolved.length > 0) {
        state.criticalPause = true

        // Post-epic update with blockers
        if (linear) {
          await linear.createEpicCompletionUpdate(
            epic,
            epicNumber,
            reviewResult.findings,
            reviewResult.blockers
          )
        }

        // Pause for human review
        const shouldContinue = await promptForContinuation(unresolved)
        if (!shouldContinue) {
          await saveState(state, dryRun)
          console.log('\n[Orchestrator] Execution paused. Exiting.')
          process.exit(1)
        }
      }
    }

    // Post-epic Linear update (success case)
    if (linear) {
      await linear.createEpicCompletionUpdate(epic, epicNumber, reviewResult.findings, [])
    }

    state.completedEpics = epicNumber
    await saveState(state, dryRun)

    console.log(`\n[Orchestrator] ✅ Epic ${epicNumber} complete`)
  }

  // Final summary
  const duration = (Date.now() - state.startTime.getTime()) / 1000 / 60

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                    PHASE 4 COMPLETE                          ║
╠══════════════════════════════════════════════════════════════╣
║  Epics Completed:     ${state.completedEpics}/${EPICS.length}                                ║
║  Issues Created:      ${state.totalIssuesCreated}                                    ║
║  Code Review Findings:${state.totalFindings}                                    ║
║  Unresolved Blockers: ${state.totalBlockers}                                     ║
║  Duration:            ${duration.toFixed(1)} minutes                            ║
╚══════════════════════════════════════════════════════════════╝
`)

  // Final Linear update
  if (linear) {
    await linear.createPhaseSummary(
      state.completedEpics,
      state.totalIssuesCreated,
      state.totalFindings,
      state.totalBlockers
    )
  }

  if (state.totalBlockers > 0) {
    console.log('\n⚠️  Some blocking issues remain. Review before Phase 5.')
    process.exit(1)
  } else {
    console.log('\n✅ Ready to proceed to Phase 5: Release & Publishing')
  }
}

// Parse CLI arguments
function parseArgs(): { dryRun: boolean; startFrom: number } {
  const args = process.argv.slice(2)
  let dryRun = false
  let startFrom = 1

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') {
      dryRun = true
    } else if (args[i] === '--start-from' && args[i + 1]) {
      startFrom = parseInt(args[i + 1], 10)
      if (isNaN(startFrom) || startFrom < 1 || startFrom > EPICS.length) {
        console.error(`Invalid --start-from value. Must be 1-${EPICS.length}`)
        process.exit(1)
      }
      i++
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Phase 4 Orchestrator

Usage: npx tsx orchestrator.ts [options]

Options:
  --dry-run           Run without making actual changes
  --start-from <n>    Start from epic number (1-${EPICS.length})
  --help, -h          Show this help message

Examples:
  npx tsx orchestrator.ts                    # Run all epics
  npx tsx orchestrator.ts --dry-run          # Preview without changes
  npx tsx orchestrator.ts --start-from 2     # Resume from epic 2
`)
      process.exit(0)
    }
  }

  return { dryRun, startFrom }
}

// Main entry point
const options = parseArgs()
orchestrate(options).catch((err) => {
  console.error('[Orchestrator] Fatal error:', err)
  process.exit(1)
})
