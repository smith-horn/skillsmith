/**
 * @fileoverview skillsmith audit command — CLI security advisory checker
 * @module @skillsmith/cli/commands/audit
 * @see SMI-skill-version-tracking Wave 3 (advisories subcommand)
 * @see SMI-4590 Wave 4 Step 0a — restructured into parent `audit` command
 *
 * Lists active security advisories for installed skills in npm-audit style
 * output. Advisories are published by the Skillsmith team as security
 * issues are identified.
 *
 * Tier gate: Team (via requireTier).
 * Use --fix to attempt `skillsmith update <skill>` for each advisory with a patch.
 *
 * Surface (post-SMI-4590 Step 0a):
 * - `sklx audit advisories <skill-id>` (canonical)
 * - `sklx audit <skill-id>` (deprecation alias — emits warning, forwards to advisories)
 * - `sklx audit collisions` is added by SMI-4590 PR 5/6.
 */

import { Command } from 'commander'
import chalk from 'chalk'
import {
  createDatabaseAsync,
  initializeSchema,
  AdvisoryRepository,
  type SkillAdvisory,
} from '@skillsmith/core'
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

const SEVERITY_PREFIXES: Record<string, string> = {
  critical: '[!]',
  high: '[*]',
  medium: '[+]',
  low: '[-]',
}

function colorSeverity(severity: string): string {
  const colorFn = SEVERITY_COLORS[severity] ?? chalk.white
  const prefix = SEVERITY_PREFIXES[severity] ?? '   '
  return colorFn(prefix + ' ' + severity.padEnd(8))
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
    console.log(`  ${chalk.bgRed.white.bold('[!] critical')}  ${counts['critical']}`)
  if (counts['high']) console.log(`  ${chalk.red.bold('[*] high    ')}  ${counts['high']}`)
  if (counts['medium']) console.log(`  ${chalk.yellow.bold('[+] medium  ')}  ${counts['medium']}`)
  if (counts['low']) console.log(`  ${chalk.cyan('[-] low     ')}  ${counts['low']}`)
  console.log(`  ${'    total   '.padEnd(14)}  ${total}`)
}

// ============================================================================
// Command action
// ============================================================================

interface AuditAdvisoriesOptions {
  db: string
  fix: boolean
}

async function runAdvisoriesAudit(options: AuditAdvisoriesOptions): Promise<void> {
  // Team tier required for security advisories
  await requireTier('team')

  const db = await createDatabaseAsync(options.db)
  initializeSchema(db) // SMI-4486

  try {
    const advisoryRepo = new AdvisoryRepository(db)
    const advisories = advisoryRepo.getActiveAdvisories()

    if (advisories.length === 0) {
      console.log(chalk.dim('\nNo advisories found.'))
      console.log(
        chalk.dim(
          'No advisories have been published yet. This does not indicate installed\n' +
            'skills have been reviewed. Run `skillsmith sync` to fetch the latest.'
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
// Command factories
// ============================================================================

/**
 * Build the `advisories` subcommand. Same body as the pre-SMI-4590 flat
 * `audit` command — only the surface (parent + name) changed.
 *
 * @internal exported for tests; consumers should use {@link createAuditCommand}.
 */
export function createAuditAdvisoriesSubcommand(): Command {
  return new Command('advisories')
    .description('Check installed skills for known security advisories (Team tier required)')
    .option('-d, --db <path>', 'Database file path', DEFAULT_DB_PATH)
    .option('--fix', 'Attempt to update skills with available patches')
    .action(async (opts: Record<string, string | boolean | undefined>) => {
      try {
        await runAdvisoriesAudit({
          db: opts['db'] as string,
          fix: (opts['fix'] as boolean) ?? false,
        })
      } catch (error) {
        console.error(chalk.red('Error:'), sanitizeError(error))
        process.exit(1)
      }
    })
}

/**
 * Deprecation warning for top-level `sklx audit <skill-id>` flat invocation.
 * Removal target: next minor release.
 *
 * @internal exported for tests.
 */
export const AUDIT_FLAT_DEPRECATION_NOTICE =
  "[DEPRECATED] sklx audit <skill-id> is deprecated; use 'sklx audit advisories <skill-id>' instead. This alias will be removed in the next minor version."

/**
 * Build the parent `audit` command. Subcommands:
 * - `advisories` — security advisory checker (canonical, Team tier).
 * - `<skill-id>` (positional fallback) — deprecation alias forwarding to
 *   `advisories`. Emits a stderr warning. Removed in next minor release.
 *
 * `sklx audit collisions` is added by SMI-4590 PR 5/6.
 */
export function createAuditCommand(): Command {
  const audit = new Command('audit').description(
    'Audit installed skills (advisories, namespace collisions)'
  )

  audit.addCommand(createAuditAdvisoriesSubcommand())

  // Deprecation alias: `sklx audit <skill-id>` → forward to `advisories`.
  // Implemented as a default-action on the parent: when Commander is invoked
  // with positional args that don't match a registered subcommand, emit the
  // deprecation notice and route to the advisories action.
  //
  // We use `.argument('[skillId]')` + `.action()` to capture the positional
  // fallback. Commander resolves registered subcommands first, so this fires
  // only for unknown subcommand strings (treated as <skill-id>).
  audit
    .argument('[skillId]', 'Legacy positional skill-id (deprecated; use `advisories <skill-id>`)')
    .option('-d, --db <path>', 'Database file path (deprecated alias)', DEFAULT_DB_PATH)
    .option('--fix', 'Attempt to update skills with available patches (deprecated alias)')
    .action(
      async (skillId: string | undefined, opts: Record<string, string | boolean | undefined>) => {
        if (skillId === undefined) {
          // No subcommand and no positional — print parent help.
          audit.help()
          return
        }
        // Emit deprecation warning to stderr; do not pollute stdout.
        console.error(chalk.yellow(AUDIT_FLAT_DEPRECATION_NOTICE))
        try {
          await runAdvisoriesAudit({
            db: opts['db'] as string,
            fix: (opts['fix'] as boolean) ?? false,
          })
        } catch (error) {
          console.error(chalk.red('Error:'), sanitizeError(error))
          process.exit(1)
        }
      }
    )

  return audit
}

export default createAuditCommand
