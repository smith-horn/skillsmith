/**
 * @fileoverview Flag validation + `--accept`/`--revoke` mutation for
 *               `sklx audit security`. (SMI-5883 Wave 2, split out of
 *               audit-security.action.ts per the 500-line file gate.)
 * @module @skillsmith/cli/commands/audit-security.mutate
 */

import chalk from 'chalk'

import {
  acceptFinding,
  isAcceptDisabled,
  isValidAcceptKeyFormat,
  revokeAcceptance,
  type AcceptanceRecord,
  type AcceptanceWarning,
  type RunSecurityAuditResult,
} from '@skillsmith/mcp-server/audit'

import type { AuditSecurityOptions } from './audit-security.types.js'

export type ValidationCode =
  | 'reason_required'
  | 'reason_too_long'
  | 'invalid_key_format'
  | 'conflicting_options'
  | 'all_candidates_requires_json'
  | 'invalid_numeric_option'
  | 'accept_disabled'

export interface ValidationResult {
  ok: boolean
  code?: ValidationCode
  message?: string
}

/** Flag validation (H-17) -- runs BEFORE any audit, any lock, any file touch. */
export function validateOptions(options: AuditSecurityOptions): ValidationResult {
  // Post-merge retro: SKILLSMITH_AUDIT_ACCEPT_DISABLE's own doc comment says
  // it "bypasses the store entirely -- no load, no suppression, no store
  // write" -- but --accept/--revoke previously wrote a real (if dormant)
  // record anyway while the flag was set, printing a false "OK Accepted"/
  // "OK Revoked" success message for a mutation that had no actual effect
  // until the flag was later removed.
  if ((options.accept !== undefined || options.revoke !== undefined) && isAcceptDisabled()) {
    return {
      ok: false,
      code: 'accept_disabled',
      message:
        '--accept/--revoke are disabled while SKILLSMITH_AUDIT_ACCEPT_DISABLE=1 is set (the acceptance store is bypassed entirely).',
    }
  }
  if (options.accept !== undefined && options.revoke !== undefined) {
    return {
      ok: false,
      code: 'conflicting_options',
      message: '--accept and --revoke are mutually exclusive.',
    }
  }
  if (options.accept !== undefined) {
    if (!options.reason || options.reason.length === 0) {
      return { ok: false, code: 'reason_required', message: '--accept requires --reason "<why>".' }
    }
    if (options.reason.length > 500) {
      return { ok: false, code: 'reason_too_long', message: '--reason must be 1..500 characters.' }
    }
    if (!isValidAcceptKeyFormat(options.accept)) {
      return {
        ok: false,
        code: 'invalid_key_format',
        message: '--accept requires the full 64-hex key.',
      }
    }
  }
  if (options.revoke !== undefined && !isValidAcceptKeyFormat(options.revoke)) {
    return {
      ok: false,
      code: 'invalid_key_format',
      message: '--revoke requires the full 64-hex key.',
    }
  }
  if (options.allCandidates && !options.json) {
    return {
      ok: false,
      code: 'all_candidates_requires_json',
      message: '--all-candidates requires --json (human output would be unusable).',
    }
  }
  if (options.allCandidates && options.page !== undefined && options.page !== 1) {
    return {
      ok: false,
      code: 'conflicting_options',
      message: '--all-candidates conflicts with --page.',
    }
  }
  // Code-review round 2 finding: these are Number(<raw CLI string>) upstream
  // with no validation -- a non-numeric, negative, zero, or fractional value
  // previously passed through silently and produced a confusing empty/wrong
  // result (e.g. Array.prototype.slice coercing NaN to 0) rather than a
  // clear error naming the bad flag.
  for (const [flag, value] of [
    ['--limit', options.limit],
    ['--page', options.page],
    ['--page-size', options.pageSize],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
      return {
        ok: false,
        code: 'invalid_numeric_option',
        message: `${flag} must be a positive integer (got ${JSON.stringify(value)}).`,
      }
    }
  }
  return { ok: true }
}

export interface MutationOutcome {
  ok: boolean
  code?: 'key_not_found' | undefined
  acceptKey: string
  /** Code-review round 2 finding 2: carried through so a write failure (etc.) is visible, not silently dropped. */
  warnings: AcceptanceWarning[]
}

/**
 * Resolves `acceptKey` against THIS run's uncapped `candidateIndex` (§3f) --
 * a stale key (content changed since the audit ran) is rejected here, before
 * any lock is taken.
 */
export function applyAcceptance(
  result: RunSecurityAuditResult,
  acceptKey: string,
  reason: string,
  acceptancePath: string
): MutationOutcome {
  const candidate = result.candidateIndex.get(acceptKey)
  if (!candidate) return { ok: false, code: 'key_not_found', acceptKey, warnings: [] }

  const record: AcceptanceRecord = {
    acceptKey: candidate.acceptKey,
    sourcePath: candidate.sourcePath,
    identifier: candidate.identifier,
    contentDigest: candidate.contentDigest,
    findingFingerprint: candidate.findingFingerprint,
    rulesetVersion: candidate.rulesetVersion,
    display: {
      type: candidate.finding.type,
      severity: candidate.finding.severity,
      message: candidate.finding.message,
      location: candidate.finding.location ?? null,
      lineNumber: Number.isInteger(candidate.finding.lineNumber)
        ? (candidate.finding.lineNumber as number)
        : null,
    },
    acceptedAt: new Date().toISOString(),
    reason,
  }
  const outcome = acceptFinding(acceptancePath, record)
  return { ok: outcome.ok, acceptKey, warnings: outcome.warnings }
}

/** Resolves against the STORE, not the candidate index (D-9) -- a record worth revoking is often one whose content already changed. */
export function applyRevoke(acceptKey: string, acceptancePath: string): MutationOutcome {
  const outcome = revokeAcceptance(acceptancePath, acceptKey)
  return { ok: outcome.ok, code: outcome.code, acceptKey, warnings: outcome.warnings }
}

/**
 * Code-review round 2 finding 2: `outcome.warnings` (foreign-revision,
 * ruleset-GC, write-failure, ...) were previously discarded entirely.
 * Printed in the SAME `WARN [<code>] <message>` format used for the audit's
 * own store-load warnings (`printAcceptanceWarnings`, audit-security.action.ts)
 * -- one stable, machine-greppable convention across the whole command.
 */
function printMutationWarnings(outcome: MutationOutcome): void {
  for (const w of outcome.warnings) {
    console.log(chalk.yellow(`WARN [${w.code}] ${w.message}`))
  }
}

export function printAcceptOutcome(outcome: MutationOutcome): void {
  printMutationWarnings(outcome)
  if (outcome.ok) {
    console.log(
      `${chalk.green('OK')} Accepted ${outcome.acceptKey.slice(0, 12)}… — it will be suppressed once every finding on its skill is accepted.`
    )
    return
  }
  console.log(
    `${chalk.red('Error:')} could not accept ${outcome.acceptKey.slice(0, 12)}… [${outcome.code ?? 'unknown'}]. Re-run \`sklx audit security --candidates\` for current keys.`
  )
}

export function printRevokeOutcome(outcome: MutationOutcome): void {
  printMutationWarnings(outcome)
  if (outcome.ok) {
    console.log(`${chalk.green('OK')} Revoked ${outcome.acceptKey.slice(0, 12)}….`)
    return
  }
  console.log(
    `${chalk.red('Error:')} ${outcome.acceptKey.slice(0, 12)}… was not found in the acceptance store [${outcome.code ?? 'unknown'}].`
  )
}

/** `--list-accepted`: the full stored acceptance ledger (<=500 by construction -- no pagination needed). */
export function printAcceptances(records: readonly AcceptanceRecord[]): void {
  if (records.length === 0) {
    console.log(chalk.dim('No stored acceptances.'))
    return
  }
  console.log(chalk.bold.blue(`\n=== Stored acceptances (${records.length}) ===`))
  for (const r of records) {
    console.log(
      `${chalk.bold(r.identifier)}  ${chalk.dim(r.display.severity)}  ${r.acceptedAt.slice(0, 10)}`
    )
    console.log(`  "${r.reason}"`)
    console.log(chalk.dim(`  ${r.acceptKey}`))
  }
}
