/**
 * SMI-2204: Progress reporting for the Batch Skill Transformation CLI.
 *
 * Extracted from batch-transform-skills.ts (SMI-4935) to keep each module
 * under the 500-line limit. See batch-transform-skills.ts for the entrypoint.
 */

import type {
  CliOptions,
  JsonOutput,
  ProcessResult,
  ProgressMode,
  ProgressReporter,
  SkillRecord,
  TransformStats,
} from './batch-transform-skills.types'

/**
 * Validate that a string is a valid progress mode
 * Exported for use in tests
 */
export function validateProgressMode(mode: string): boolean {
  return ['dots', 'bar', 'json'].includes(mode)
}

/**
 * Detect if running in TTY (interactive terminal) vs CI/pipe
 * Exported for use in tests
 */
export function isTTY(): boolean {
  return process.stdout.isTTY === true
}

/**
 * Get default progress mode based on environment
 * Exported for use in tests
 */
export function getDefaultProgressMode(): ProgressMode {
  // In TTY, use bar; in CI/pipe, use dots
  return isTTY() ? 'bar' : 'dots'
}

/**
 * Dots progress reporter (default for CI)
 * Outputs: . for success, s for skip, F for failure
 */
class DotsProgressReporter implements ProgressReporter {
  private verbose = false

  start(_total: number | null, options: CliOptions): void {
    this.verbose = options.verbose
    if (!options.json) {
      console.log('\nProcessing skills...\n')
    }
  }

  batchStart(batchNum: number, startIdx: number, endIdx: number): void {
    if (!this.verbose) {
      console.log(`Batch ${batchNum}: Skills ${startIdx}-${endIdx}`)
    }
  }

  update(skill: SkillRecord, result: ProcessResult, stats: TransformStats): void {
    if (this.verbose) {
      console.log(`\n  [${stats.processed}] ${skill.id}`)
      console.log(`    Name: ${skill.name}`)
      console.log(`    Author: ${skill.author ?? 'unknown'}`)
      if (result.status === 'skipped') {
        console.log(`    Skipped: ${result.error}`)
      } else if (result.status === 'failed') {
        console.log(`    FAILED: ${result.error}`)
      }
    } else {
      switch (result.status) {
        case 'transformed':
          process.stdout.write('.')
          break
        case 'skipped':
          process.stdout.write('s')
          break
        case 'failed':
          process.stdout.write('F')
          break
      }
    }
  }

  checkpoint(offset: number): void {
    if (this.verbose) {
      console.log(`    📍 Checkpoint saved at offset ${offset}`)
    }
  }

  batchEnd(): void {
    if (!this.verbose) {
      console.log('') // Newline after progress dots
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  finish(stats: TransformStats, duration: number, runId: string): null {
    return null
  }
}

/**
 * Progress bar reporter (default for TTY)
 * Shows: [=====>     ] 47% (235/500) | 2.3/s | ETA: 3m 22s
 */
class BarProgressReporter implements ProgressReporter {
  private total: number | null = null
  private startTime = 0
  private verbose = false
  private lastRender = 0
  private renderInterval = 100 // ms between renders

  start(total: number | null, options: CliOptions): void {
    this.total = total
    this.startTime = Date.now()
    this.verbose = options.verbose
    if (!options.json) {
      console.log('\nProcessing skills...\n')
    }
  }

  batchStart(batchNum: number, startIdx: number, endIdx: number): void {
    if (this.verbose) {
      console.log(`Batch ${batchNum}: Skills ${startIdx}-${endIdx}`)
    }
  }

  update(skill: SkillRecord, result: ProcessResult, stats: TransformStats): void {
    if (this.verbose) {
      console.log(`\n  [${stats.processed}] ${skill.id}`)
      console.log(`    Name: ${skill.name}`)
      console.log(`    Author: ${skill.author ?? 'unknown'}`)
      if (result.status === 'skipped') {
        console.log(`    Skipped: ${result.error}`)
      } else if (result.status === 'failed') {
        console.log(`    FAILED: ${result.error}`)
      }
      return
    }

    // Throttle renders to avoid flickering
    const now = Date.now()
    if (now - this.lastRender < this.renderInterval) {
      return
    }
    this.lastRender = now

    this.renderProgressBar(stats, skill.name)
  }

  private renderProgressBar(stats: TransformStats, currentSkill: string): void {
    const elapsed = (Date.now() - this.startTime) / 1000
    const rate = stats.processed / elapsed
    const percent = this.total ? Math.round((stats.processed / this.total) * 100) : 0
    const eta = this.total && rate > 0 ? Math.round((this.total - stats.processed) / rate) : 0

    // Build progress bar
    const barWidth = 30
    const filled = this.total ? Math.round((stats.processed / this.total) * barWidth) : 0
    const bar =
      '='.repeat(filled) +
      (filled < barWidth ? '>' : '') +
      ' '.repeat(Math.max(0, barWidth - filled - 1))

    // Format ETA
    const etaStr = eta > 0 ? `${Math.floor(eta / 60)}m ${eta % 60}s` : '--'

    // Build status line
    const countStr = this.total ? `(${stats.processed}/${this.total})` : `(${stats.processed})`
    const statusLine = `Transforming [${bar}] ${percent}% ${countStr} | ${rate.toFixed(1)}/s | ETA: ${etaStr}`

    // Clear line and write
    process.stdout.write('\r' + ' '.repeat(80) + '\r')
    process.stdout.write(statusLine)

    // Show current skill on next line if space
    if (currentSkill.length > 40) {
      currentSkill = currentSkill.slice(0, 37) + '...'
    }
    process.stdout.write(`\n  Processing: ${currentSkill}`)
    process.stdout.write('\x1b[1A') // Move cursor up
  }

  checkpoint(offset: number): void {
    if (this.verbose) {
      console.log(`\n📍 Checkpoint saved at offset ${offset}`)
    }
  }

  batchEnd(): void {
    // Clear progress bar line
    if (!this.verbose) {
      process.stdout.write('\r' + ' '.repeat(80) + '\r')
      process.stdout.write('\r' + ' '.repeat(80) + '\r\n')
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  finish(stats: TransformStats, duration: number, runId: string): null {
    // Clear any remaining progress bar
    process.stdout.write('\r' + ' '.repeat(80) + '\r')
    return null
  }
}

/**
 * JSON progress reporter (for scripting)
 * Outputs NDJSON lines per skill
 */
class JsonProgressReporter implements ProgressReporter {
  private skippedReasons: Map<string, string> = new Map()

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  start(total: number | null, options: CliOptions): void {
    // No header output for clean NDJSON
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  batchStart(batchNum: number, startIdx: number, endIdx: number): void {
    // No batch markers in JSON mode
  }

  update(skill: SkillRecord, result: ProcessResult, stats: TransformStats): void {
    // Track skipped reasons for final output
    if (result.status === 'skipped' && result.error) {
      this.skippedReasons.set(skill.id, result.error)
    }

    // Output NDJSON line for each skill
    const line = {
      type: 'progress',
      skill_id: skill.id,
      skill_name: skill.name,
      status: result.status,
      error: result.error ?? null,
      stats: {
        processed: stats.processed,
        transformed: stats.transformed,
        skipped: stats.skipped,
        failed: stats.failed,
      },
    }
    console.log(JSON.stringify(line))
  }

  checkpoint(offset: number): void {
    const line = {
      type: 'checkpoint',
      offset,
      timestamp: new Date().toISOString(),
    }
    console.log(JSON.stringify(line))
  }

  batchEnd(): void {
    // No batch end markers
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  finish(stats: TransformStats, duration: number, runId: string): JsonOutput {
    return {
      processed: stats.processed,
      transformed: stats.transformed,
      skipped: stats.skipped,
      failed: stats.failed,
      duration_ms: duration,
      checkpoint: null, // Filled by caller if exists
      failed_skills: stats.failedSkillIds,
      skipped_skills: stats.skippedSkillIds.map((id) => ({
        id,
        reason: this.skippedReasons.get(id) ?? 'Unknown',
      })),
    }
  }
}

/**
 * Create appropriate progress reporter based on options
 */
export function createProgressReporter(options: CliOptions): ProgressReporter {
  switch (options.progress) {
    case 'json':
      return new JsonProgressReporter()
    case 'bar':
      // Fall back to dots if not in TTY
      return isTTY() ? new BarProgressReporter() : new DotsProgressReporter()
    case 'dots':
    default:
      return new DotsProgressReporter()
  }
}
