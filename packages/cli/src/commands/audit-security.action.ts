/**
 * @fileoverview `sklx audit security` action implementations + telemetry wrappers.
 * @module @skillsmith/cli/commands/audit-security.action
 * @see SMI-5541 R0 Wave 2C (Option 1) -- original rug-pull / malicious-content scan.
 * @see SMI-5883 Wave 2 -- local acceptance allowlist (`--accept`/`--revoke`/candidate
 *   listing). Follows the SMI-5127/5128 sibling-split convention: the run*
 *   business logic + `withTelemetry`-wrapped exports live here; the commander
 *   factory stays in `audit-security.ts`. Flag validation + `--accept`/
 *   `--revoke` mutation live in the sibling `audit-security.mutate.ts`
 *   (split for the 500-line file gate); candidate ordering/pagination/
 *   rendering live in `audit-security.candidates.ts`.
 *
 * Wiring (§6): `runAuditSecurity` ALWAYS runs a full audit first -- mutation
 * (`--accept`/`--revoke`) never bypasses it, and always resolves against
 * THIS run's uncapped `candidateIndex`, never a stale caller-held one. On a
 * successful mutation the audit is re-run so the rendered state reflects it
 * (proving the mutation path re-validates against a fresh scan rather than
 * mutating blind).
 */

import chalk from 'chalk'
import { getCliLogger } from '../cli-logger.js'
import { withTelemetry } from '@skillsmith/core/telemetry'
import { sendAuditDigest, recordAuditNotify, AuditNotifyAuthError } from '@skillsmith/core'

const logger = getCliLogger()

import {
  runSecurityAudit,
  buildAuditDigestPayload,
  hashDigest,
  defaultAcceptancePath,
  type RunSecurityAuditResult,
  type SecurityAuditFinding,
  type SecurityVerdict,
} from '@skillsmith/mcp-server/audit'

import { sanitizeError } from '../utils/sanitize.js'
import {
  allCandidatesPagination,
  orderedCandidates,
  paginate,
  printCandidates,
  type Pagination,
} from './audit-security.candidates.js'
import {
  applyAcceptance,
  applyRevoke,
  printAcceptances,
  printAcceptOutcome,
  printRevokeOutcome,
  validateOptions,
} from './audit-security.mutate.js'
import type {
  AuditSecurityCliSeams,
  AuditSecurityOptions,
  EmailOutcome,
} from './audit-security.types.js'

export type {
  AuditSecurityOptions,
  AuditSecurityCliSeams,
  EmailOutcome,
} from './audit-security.types.js'

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

/** Human tag per verdict — an ACCEPTED finding renders distinctly from FAILING even though its verdict is still `malicious` (INV-5). */
function verdictTag(f: SecurityAuditFinding): string {
  if (f.accepted) return chalk.green('ACCEPTED')
  switch (f.verdict) {
    case 'hostile':
      return chalk.red.bold('RUG-PULL')
    case 'malicious':
      return chalk.red('FAILING')
    case 'suspicious':
      return chalk.yellow('SUSPECT')
    default: {
      const exhaustive: never = f.verdict
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

function printAcceptanceWarnings(result: RunSecurityAuditResult): void {
  for (const w of result.warnings) {
    console.log(chalk.yellow(`WARN [${w.code}] ${w.message}`))
  }
}

export function printFindings(result: RunSecurityAuditResult): void {
  const { findings, summary } = result
  const covered = summary.scanned + summary.unchanged

  if (findings.length === 0) {
    console.log(
      `${chalk.green('OK')} No security issues found in ${covered} scanned skill manifest(s).`
    )
    printUnreadableWarning(summary.unreadable)
    printAcceptanceWarnings(result)
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
      `${chalk.yellow(String(summary.suspicious))} suspicious, ` +
      `${chalk.green(String(summary.accepted))} accepted.\n`
  )

  const sorted = [...findings].sort((a, b) => verdictOrder(a.verdict) - verdictOrder(b.verdict))
  for (const f of sorted) {
    console.log(
      `${verdictTag(f)} ${chalk.bold(f.entry.identifier)} ${chalk.dim(`(${f.entry.kind})`)}`
    )
    if (f.accepted) {
      const date = f.accepted.acceptedAt.slice(0, 10)
      console.log(
        `  ${f.accepted.count} finding(s) accepted — reviewed ${date}: "${f.accepted.reason}"`
      )
    } else {
      console.log(`  ${f.reason}`)
    }
    console.log(chalk.dim(`  ${f.entry.source_path}`))
  }

  console.log(
    chalk.dim(
      '\nReview flagged skills before trusting them. Remove one with `sklx uninstall <skill>`, ' +
        're-install it from a trusted source to reset its baseline, or `sklx audit security --accept <key> --reason "<why>"` a reviewed false positive.'
    )
  )
  printUnreadableWarning(summary.unreadable)
  printAcceptanceWarnings(result)
}

/**
 * Push the digest through the consent-gated `audit-notify` edge function.
 * Never throws — auth / transport failures are captured into {@link EmailOutcome}
 * so the command still prints the local findings. Skips the network entirely
 * when there is nothing to report.
 */
export async function pushDigest(result: RunSecurityAuditResult): Promise<EmailOutcome> {
  if (result.findings.length === 0) {
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
export function printEmailOutcome(outcome: EmailOutcome): void {
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

// ---------------------------------------------------------------------------
// JSON payload assembly (§4/§7)
// ---------------------------------------------------------------------------

function buildJsonPayload(
  result: RunSecurityAuditResult,
  options: AuditSecurityOptions,
  emailOutcome?: EmailOutcome
): Record<string, unknown> {
  const all = orderedCandidates(result.candidateIndex)
  let candidates: unknown[]
  let pagination: Pagination
  if (options.allCandidates) {
    candidates = all
    pagination = allCandidatesPagination(all.length)
  } else {
    const page = options.page ?? 1
    const pageSize = options.pageSize ?? 200
    const sliced = paginate(all, page, pageSize)
    candidates = sliced.items
    pagination = sliced.pagination
  }
  return {
    auditId: result.auditId,
    findings: result.findings,
    summary: result.summary,
    candidates,
    pagination,
    acceptances: result.acceptances,
    warnings: result.warnings,
    ...(emailOutcome ? { email: emailOutcome } : {}),
  }
}

function render(
  result: RunSecurityAuditResult,
  options: AuditSecurityOptions,
  emailOutcome?: EmailOutcome
): void {
  if (options.json) {
    console.log(JSON.stringify(buildJsonPayload(result, options, emailOutcome), null, 2))
    return
  }
  printFindings(result)
  if (options.candidates) printCandidates(result.candidateIndex, options.limit)
  if (options.listAccepted) printAcceptances(result.acceptances)
  if (emailOutcome) printEmailOutcome(emailOutcome)
}

/**
 * Builds the seams object passed to `runSecurityAudit`. Keys are OMITTED
 * (not assigned `undefined`) when absent -- `RunSecurityAuditOptions` /
 * `SecurityAuditSeams` on the mcp-server side declare plain `foo?: string`
 * (no explicit `| undefined`), and this repo's `exactOptionalPropertyTypes`
 * setting treats "assigned undefined" and "key omitted" as distinct for an
 * optional property without `| undefined` in its own type. NO explicit
 * return-type annotation here on purpose -- annotating this `AuditSecurityCliSeams`
 * (whose fields are `T | undefined`) would re-widen the inferred
 * "key omitted, never `undefined`" shape the conditional spreads below
 * produce, reintroducing the same mismatch this function exists to avoid.
 */
function passThroughSeams(options: AuditSecurityOptions & AuditSecurityCliSeams) {
  return {
    ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
    ...(options.baselinePath !== undefined ? { baselinePath: options.baselinePath } : {}),
    ...(options.acceptancePath !== undefined ? { acceptancePath: options.acceptancePath } : {}),
    ...(options.inventory !== undefined ? { inventory: options.inventory } : {}),
    ...(options.readContent !== undefined ? { readContent: options.readContent } : {}),
    ...(options.auditId !== undefined ? { auditId: options.auditId } : {}),
    ...(options.scan !== undefined ? { scan: options.scan } : {}),
  }
}

export async function runAuditSecurity(
  options: AuditSecurityOptions & AuditSecurityCliSeams
): Promise<void> {
  const validation = validateOptions(options)
  if (!validation.ok) {
    // The bracketed code is a stable, machine-greppable discriminant (H-17)
    // distinct from the human-readable message that follows it.
    console.log(`${chalk.red('Error:')} [${validation.code}] ${validation.message}`)
    process.exitCode = 1
    return
  }

  const acceptancePath = options.acceptancePath ?? defaultAcceptancePath()

  // 1. ALWAYS run a full audit first -- mutation never bypasses this.
  const result = await runSecurityAudit(passThroughSeams(options))

  // 2/3. Mutate only after step 1, resolving against THIS run's uncapped
  // index, then re-run so displayed state reflects the mutation (R2 fix).
  if (options.accept !== undefined) {
    const outcome = applyAcceptance(
      result,
      options.accept,
      options.reason as string,
      acceptancePath
    )
    printAcceptOutcome(outcome)
    if (!outcome.ok) {
      process.exitCode = 1
      return
    }
    const after = await runSecurityAudit(passThroughSeams(options))
    render(after, options)
    return
  }
  if (options.revoke !== undefined) {
    const outcome = applyRevoke(options.revoke, acceptancePath)
    printRevokeOutcome(outcome)
    if (!outcome.ok) {
      process.exitCode = 1
      return
    }
    const after = await runSecurityAudit(passThroughSeams(options))
    render(after, options)
    return
  }

  const emailOutcome = options.email ? await pushDigest(result) : undefined
  render(result, options, emailOutcome)
}

// SMI-5128: extracted from the inline .action() closure so withTelemetry can
// wrap it at the export boundary (SMI-5040 coverage gate).
async function securityActionImpl(opts: Record<string, unknown>): Promise<void> {
  try {
    await runAuditSecurity({
      json: opts['json'] === true,
      email: opts['email'] === true,
      candidates: opts['candidates'] === true,
      limit: typeof opts['limit'] === 'string' ? Number(opts['limit']) : 20,
      page: typeof opts['page'] === 'string' ? Number(opts['page']) : 1,
      pageSize: typeof opts['pageSize'] === 'string' ? Number(opts['pageSize']) : 200,
      allCandidates: opts['allCandidates'] === true,
      accept: typeof opts['accept'] === 'string' ? opts['accept'] : undefined,
      reason: typeof opts['reason'] === 'string' ? opts['reason'] : undefined,
      revoke: typeof opts['revoke'] === 'string' ? opts['revoke'] : undefined,
      listAccepted: opts['listAccepted'] === true,
    })
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
