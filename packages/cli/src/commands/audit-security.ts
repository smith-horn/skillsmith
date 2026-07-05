/**
 * @fileoverview `sklx audit security` — local rug-pull / malicious-content scan.
 * @module @skillsmith/cli/commands/audit-security
 * @see SMI-5541 R0 Wave 2C (Option 1 — client-side continuous audit engine)
 *
 * Sibling of `sklx audit collisions` / `sklx audit advisories`. Wraps the
 * shared `runSecurityAudit` helper from `@skillsmith/mcp-server/audit` so the
 * scan runs where the skill content actually lives — the user's machine.
 * Nothing leaves the device: the inventory data plane is metadata-only
 * (ADR-124), so a server-side scan is impossible; this is the audit engine.
 *
 * It reads each installed skill's content, scans it with `@skillsmith/core`'s
 * `SecurityScanner`, and — against a per-skill baseline persisted across runs
 * — reports rug-pulls (a benign→malicious update), currently-failing skills,
 * and material worsenings.
 */

import { Command } from 'commander'
import chalk from 'chalk'
import { withTelemetry } from '@skillsmith/core/telemetry'

import {
  runSecurityAudit,
  type RunSecurityAuditResult,
  type SecurityVerdict,
} from '@skillsmith/mcp-server/audit'

import { sanitizeError } from '../utils/sanitize.js'

interface AuditSecurityOptions {
  json: boolean
}

/** Sort key — strongest verdict first when listing findings. */
function verdictOrder(verdict: SecurityVerdict): number {
  switch (verdict) {
    case 'hostile':
      return 0
    case 'malicious':
      return 1
    case 'suspicious':
      return 2
    default: {
      const exhaustive: never = verdict
      return exhaustive
    }
  }
}

/** Human tag per verdict (plain text — matches the `OK`/`FAIL` house style). */
function verdictTag(verdict: SecurityVerdict): string {
  switch (verdict) {
    case 'hostile':
      return chalk.red.bold('RUG-PULL')
    case 'malicious':
      return chalk.red('FAILING')
    case 'suspicious':
      return chalk.yellow('SUSPECT')
    default: {
      const exhaustive: never = verdict
      return exhaustive
    }
  }
}

/** Warn when some skills could not be scanned — coverage was not complete. */
function printUnreadableWarning(unreadable: number): void {
  if (unreadable > 0) {
    console.log(
      chalk.yellow(
        `WARN ${unreadable} skill(s) could not be scanned this run (unreadable content) — coverage was incomplete.`
      )
    )
  }
}

function printFindings(result: RunSecurityAuditResult): void {
  const { findings, summary } = result
  const covered = summary.scanned + summary.unchanged

  if (findings.length === 0) {
    console.log(
      `${chalk.green('OK')} No security issues found in ${covered} scanned skill manifest(s).`
    )
    printUnreadableWarning(summary.unreadable)
    return
  }

  console.log(chalk.bold.blue('\n=== Skillsmith — Security audit ==='))
  console.log(
    chalk.dim(
      `Scanned ${summary.scanned}, unchanged ${summary.unchanged}, unreadable ${summary.unreadable}.`
    )
  )
  console.log(
    `Found ${findings.length} issue(s): ` +
      `${chalk.red.bold(String(summary.hostile))} rug-pull, ` +
      `${chalk.red(String(summary.malicious))} failing, ` +
      `${chalk.yellow(String(summary.suspicious))} suspicious.\n`
  )

  const sorted = [...findings].sort((a, b) => verdictOrder(a.verdict) - verdictOrder(b.verdict))
  for (const f of sorted) {
    console.log(
      `${verdictTag(f.verdict)} ${chalk.bold(f.entry.identifier)} ${chalk.dim(`(${f.entry.kind})`)}`
    )
    console.log(`  ${f.reason}`)
    console.log(chalk.dim(`  ${f.entry.source_path}`))
  }

  console.log(
    chalk.dim(
      '\nReview flagged skills before trusting them. Remove one with `sklx uninstall <skill>`, ' +
        'or re-install it from a trusted source to reset its baseline.'
    )
  )
  printUnreadableWarning(summary.unreadable)
}

async function runAuditSecurity(options: AuditSecurityOptions): Promise<void> {
  const result = await runSecurityAudit({})
  if (options.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  printFindings(result)
}

// SMI-5128: extracted from the inline .action() closure so withTelemetry can
// wrap it at the export boundary (SMI-5040 coverage gate).
async function securityActionImpl(opts: Record<string, boolean | undefined>): Promise<void> {
  try {
    await runAuditSecurity({ json: opts['json'] === true })
  } catch (error) {
    const message = error instanceof Error ? error.message : sanitizeError(error)
    console.error(chalk.red('Error:'), message)
    process.exit(1)
  }
}

export const securityAction = withTelemetry(securityActionImpl, {
  source: 'cli',
  extractSkillId: () => 'security',
  extractFramework: () => 'cli',
})

/**
 * Build the `audit security` subcommand. Registered as a sibling of
 * `audit collisions` / `audit advisories` in `audit.ts`.
 */
export function createAuditSecuritySubcommand(): Command {
  return new Command('security')
    .description(
      "Scan each installed skill's SKILL.md for malicious content and rug-pull " +
        'updates (runs locally, no content leaves your machine; bundled scripts ' +
        'are not yet scanned)'
    )
    .option('--json', 'Emit the full result as JSON; no formatted output', false)
    .action(securityAction)
}

// Internal exports for tests.
export { runAuditSecurity, printFindings }
export type { AuditSecurityOptions }

export default createAuditSecuritySubcommand
