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
import { getCliLogger } from '../cli-logger.js'
import { withTelemetry } from '@skillsmith/core/telemetry'
import { sendAuditDigest, recordAuditNotify, AuditNotifyAuthError } from '@skillsmith/core'

const logger = getCliLogger()

import {
  runSecurityAudit,
  buildAuditDigestPayload,
  hashDigest,
  type RunSecurityAuditResult,
  type SecurityVerdict,
} from '@skillsmith/mcp-server/audit'

import { sanitizeError } from '../utils/sanitize.js'

interface AuditSecurityOptions {
  json: boolean
  /** Also email the digest via the consent-gated `audit-notify` edge function. */
  email: boolean
}

/** Outcome of an `--email` push (also embedded in `--json` output). */
interface EmailOutcome {
  ok: boolean
  sent: boolean
  /** Server-reported reason when not sent (e.g. `not_consented`). */
  reason?: string
  /** Client-side failure marker (`not_authenticated`) or a transport message. */
  error?: string
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

/**
 * Push the digest through the consent-gated `audit-notify` edge function.
 * Never throws — auth / transport failures are captured into {@link EmailOutcome}
 * so the command still prints the local findings. Skips the network entirely
 * when there is nothing to report.
 */
async function pushDigest(result: RunSecurityAuditResult): Promise<EmailOutcome> {
  if (result.findings.length === 0) {
    // Nothing to email: record a clean state so the background auto-run also
    // treats this as "nothing new" rather than re-scanning + re-deciding.
    recordAuditNotify(
      new Date().toISOString(),
      hashDigest({ hostile: 0, malicious: 0, suspicious: 0, findings: [] })
    )
    return { ok: true, sent: false, reason: 'nothing_to_report' }
  }
  const payload = buildAuditDigestPayload(result)
  try {
    const res = await sendAuditDigest(payload)
    if (res.sent) {
      // Record the SAME hash the background auto-run computes, so a subsequent
      // MCP-server start does not re-email this identical digest.
      recordAuditNotify(new Date().toISOString(), hashDigest(payload))
    }
    return { ok: res.ok, sent: res.sent, ...(res.reason ? { reason: res.reason } : {}) }
  } catch (error) {
    if (error instanceof AuditNotifyAuthError) {
      return { ok: false, sent: false, error: 'not_authenticated' }
    }
    return { ok: false, sent: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Print a one-line, honest summary of the `--email` push outcome. */
function printEmailOutcome(outcome: EmailOutcome): void {
  if (outcome.sent) {
    console.log(`${chalk.green('OK')} Emailed your security digest.`)
    return
  }
  if (outcome.error === 'not_authenticated') {
    console.log(`${chalk.yellow('WARN')} Run \`skillsmith login\` to email your digest.`)
    return
  }
  if (outcome.error) {
    console.log(`${chalk.red('Email failed:')} ${outcome.error}`)
    return
  }
  switch (outcome.reason) {
    case 'nothing_to_report':
      console.log(chalk.dim('No issues to email.'))
      break
    case 'not_consented':
      console.log(
        `${chalk.yellow('WARN')} Audit emails are off. Enable them in your account settings to receive digests.`
      )
      break
    case 'email_not_verified':
      console.log(`${chalk.yellow('WARN')} Verify your email address to receive audit digests.`)
      break
    case 'no_email':
      console.log(`${chalk.yellow('WARN')} No email address is set on your account.`)
      break
    case 'email_send_failed':
      console.log(`${chalk.red('Email failed:')} the server could not send the email. Try again.`)
      break
    default:
      console.log(chalk.dim(`Digest not sent${outcome.reason ? ` (${outcome.reason})` : ''}.`))
  }
}

async function runAuditSecurity(options: AuditSecurityOptions): Promise<void> {
  const result = await runSecurityAudit({})
  const emailOutcome = options.email ? await pushDigest(result) : undefined

  if (options.json) {
    const payload = emailOutcome ? { ...result, email: emailOutcome } : result
    console.log(JSON.stringify(payload, null, 2))
    return
  }

  printFindings(result)
  if (emailOutcome) printEmailOutcome(emailOutcome)
}

// SMI-5128: extracted from the inline .action() closure so withTelemetry can
// wrap it at the export boundary (SMI-5040 coverage gate).
async function securityActionImpl(opts: Record<string, boolean | undefined>): Promise<void> {
  try {
    await runAuditSecurity({ json: opts['json'] === true, email: opts['email'] === true })
  } catch (error) {
    const message = error instanceof Error ? error.message : sanitizeError(error)
    logger.error(`${chalk.red('Error:')} ${message}`)
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
    .option(
      '--email',
      'Also email this digest to your account (requires `skillsmith login` and ' +
        'opt-in; consent is enforced server-side)',
      false
    )
    .action(securityAction)
}

// Internal exports for tests.
export { runAuditSecurity, printFindings, pushDigest, printEmailOutcome }
export type { AuditSecurityOptions, EmailOutcome }

export default createAuditSecuritySubcommand
