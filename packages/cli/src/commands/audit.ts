/**
 * @fileoverview skillsmith audit command — CLI security advisory checker
 * @module @skillsmith/cli/commands/audit
 * @see SMI-skill-version-tracking Wave 3
 *
 * Lists active security advisories for installed skills in npm-audit style
 * output. The advisory system is in early access — the Skillsmith team
 * publishes advisories as security issues are identified.
 *
 * Tier gate: Team (via requireTier).
 * Use --fix to attempt `skillsmith update <skill>` for each advisory with a patch.
 */

import { Command } from 'commander'
import chalk from 'chalk'
import { createDatabaseAsync, AdvisoryRepository, type SkillAdvisory } from '@skillsmith/core'
import { DEFAULT_DB_PATH } from '../config.js'
import { sanitizeError } from '../utils/sanitize.js'
import { requireTier } from '../utils/require-tier.js'

// ============================================================================
// Severity display helpers
// ============================================================================

const SEVERITY_COLORS: Record<string, (text: string) => string> = {
  critical: chalk.bgRed.white.bold,
  high: chalk.red.bold,
  medium: chalk.yellow.bold,
  low: chalk.cyan,
}

function colorSeverity(severity: string): string {
  const colorFn = SEVERITY_COLORS[severity] ?? chalk.white
  return colorFn(severity.padEnd(8))
}

// ============================================================================
// Output formatting
// ============================================================================

/**
 * Print advisories in npm-audit style format
 */
function printAdvisories(advisories: SkillAdvisory[]): void {
  for (const adv of advisories) {
    const fixLabel = adv.patchedVersions
      ? chalk.green(`Fix: skillsmith update ${adv.skillId}`)
      : chalk.dim('No fix available')

    console.log(
      `${colorSeverity(adv.severity)}  ${chalk.bold(adv.title)}\n` +
        `          ${chalk.dim(adv.id)}\n` +
        `          ${fixLabel}\n`
    )
  }
}

/**
 * Print severity summary
 */
function printSummary(counts: Record<string, number>): void {
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  console.log(chalk.bold('Summary:'))
  if (counts['critical'])
    console.log(`  ${chalk.bgRed.white.bold('critical')}  ${counts['critical']}`)
  if (counts['high']) console.log(`  ${chalk.red.bold('high    ')}  ${counts['high']}`)
  if (counts['medium']) console.log(`  ${chalk.yellow.bold('medium  ')}  ${counts['medium']}`)
  if (counts['low']) console.log(`  ${chalk.cyan('low     ')}  ${counts['low']}`)
  console.log(`  ${'total   '.padEnd(10)}  ${total}`)
}

// ============================================================================
// Command action
// ============================================================================

async function runAudit(options: { db: string; fix: boolean }): Promise<void> {
  // Team tier required for security advisories
  await requireTier('team')

  const db = await createDatabaseAsync(options.db)

  try {
    const advisoryRepo = new AdvisoryRepository(db)
    const advisories = advisoryRepo.getActiveAdvisories()

    if (advisories.length === 0) {
      console.log(chalk.dim('\nNo advisories in database.'))
      console.log(
        chalk.dim(
          'Advisory system is in early access — the Skillsmith team publishes advisories as\n' +
            'security issues are identified. Run `skillsmith sync` to fetch the latest.'
        )
      )
      console.log()
      return
    }

    console.log(chalk.bold.blue('\n=== Skill Security Audit ===\n'))
    printAdvisories(advisories)

    // Count by severity
    const counts: Record<string, number> = {}
    for (const adv of advisories) {
      counts[adv.severity] = (counts[adv.severity] ?? 0) + 1
    }
    printSummary(counts)
    console.log()

    if (options.fix) {
      const fixable = advisories.filter((a: SkillAdvisory) => a.patchedVersions)
      if (fixable.length === 0) {
        console.log(chalk.yellow('No fixable advisories found.'))
        return
      }

      console.log(chalk.bold(`\nAttempting to fix ${fixable.length} advisory(s)...\n`))

      const skillsToUpdate = [...new Set(fixable.map((a: SkillAdvisory) => a.skillId))]
      for (const skillId of skillsToUpdate) {
        console.log(chalk.cyan(`  Running: skillsmith update ${skillId}`))
        // Wave 2 will implement full update logic; this surfaces the intent clearly
        console.log(
          chalk.dim(`    (update for ${skillId} — requires Wave 2 update implementation)`)
        )
      }
    }
  } finally {
    db.close()
  }
}

// ============================================================================
// Command factory
// ============================================================================

/**
 * Create the audit command
 */
export function createAuditCommand(): Command {
  return new Command('audit')
    .description('Check installed skills for known security advisories (Team tier required)')
    .option('-d, --db <path>', 'Database file path', DEFAULT_DB_PATH)
    .option('--fix', 'Attempt to update skills with available patches')
    .action(async (opts: Record<string, string | boolean | undefined>) => {
      try {
        await runAudit({
          db: opts['db'] as string,
          fix: (opts['fix'] as boolean) ?? false,
        })
      } catch (error) {
        console.error(chalk.red('Error:'), sanitizeError(error))
        process.exit(1)
      }
    })
}

export default createAuditCommand
