/**
 * @fileoverview `sklx audit collisions` — interactive consumer-namespace audit.
 * @module @skillsmith/cli/commands/audit-collisions
 * @see SMI-4590 Wave 4 PR 5/6 §4 + §9
 *
 * Sibling of `sklx audit advisories` (Step 0a). Wraps the shared
 * `runInventoryAudit` helper from `@skillsmith/mcp-server/audit` (PR 4) so
 * composition logic lives in one place.
 *
 * Flags:
 *   --deep            Opt into the semantic-overlap detector pass.
 *   --json            Emit `RunInventoryAuditResult` as JSON to stdout.
 *                     Bypasses prompts; no file mutation.
 *   --apply-all       Accept every suggestion. Typed-confirmation gate:
 *                     user must type the literal phrase `APPLY ALL`.
 *   --report-only     Write the audit report; no prompts, no apply.
 *   --reset-ledger    Clear `~/.skillsmith/namespace-overrides.json`. Backs
 *                     up to `~/.skillsmith/backups/ledger-<ts>.json` first.
 *                     Typed-confirmation gate: literal phrase `RESET LEDGER`.
 *
 * Typed-confirmation gates are load-bearing UX (plan §235-239). Prompts use
 * `@inquirer/prompts` `input` with strict literal-phrase verification —
 * ANY input other than the exact phrase rejects with a non-zero exit.
 * No fuzzy match, no normalization, no validate-and-retry loop.
 *
 * Default-entry tiebreak: `runInventoryAudit` already picks the most-recently-
 * installed entry (mtime descending) per `buildRenameSuggestions`. The CLI
 * surfaces that target in the prompt copy and lets the user `s`kip to flip
 * to the other entry.
 */

import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { Command } from 'commander'
import chalk from 'chalk'
import { input, select } from '@inquirer/prompts'

import {
  applyRename,
  readLedger,
  runInventoryAudit,
  writeLedger,
  NAMESPACE_OVERRIDES_CURRENT_VERSION,
  type RenameSuggestion,
  type RunInventoryAuditResult,
} from '@skillsmith/mcp-server/audit'

import { sanitizeError } from '../utils/sanitize.js'
import { getLicenseStatus } from '../utils/license.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const APPLY_ALL_PHRASE = 'APPLY ALL'
const RESET_LEDGER_PHRASE = 'RESET LEDGER'

const CONFIRMATION_REJECTED_MESSAGE =
  'Confirmation phrase mismatch — operation aborted. The phrase must match exactly (case-sensitive, including spaces).'

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

interface AuditCollisionsOptions {
  deep: boolean
  json: boolean
  applyAll: boolean
  reportOnly: boolean
  resetLedger: boolean
}

// ---------------------------------------------------------------------------
// Typed-confirmation gate
// ---------------------------------------------------------------------------

/**
 * Read a single line from stdin and require an exact literal match for
 * `expected`. Used for the load-bearing `APPLY ALL` and `RESET LEDGER`
 * gates per plan §235-239.
 *
 * Strict equality only — no fuzzy match, no normalization. Lowercase,
 * abbreviated, or whitespace-stripped input REJECTS with exit non-zero.
 * Tested on both interactive (TTY) and piped-stdin paths.
 */
async function requireConfirmationPhrase(expected: string, prompt: string): Promise<void> {
  const answer = await input({ message: prompt })
  // Strict equality: NO trimming, NO case folding, NO normalization.
  // Two reasons:
  //   1. Plan §237 mandates it ("any other input — including `Y`, `yes`,
  //      `apply all` (lowercase), `APPLYALL` (no space) — rejects").
  //   2. `@inquirer/prompts` `input` does NOT trim by default — verified.
  if (answer !== expected) {
    throw new Error(CONFIRMATION_REJECTED_MESSAGE)
  }
}

// ---------------------------------------------------------------------------
// Ledger reset helpers
// ---------------------------------------------------------------------------

function ledgerPath(): string {
  return join(homedir(), '.skillsmith', 'namespace-overrides.json')
}

function backupsDir(): string {
  return join(homedir(), '.skillsmith', 'backups')
}

/**
 * Backup the ledger file to `~/.skillsmith/backups/ledger-<ts>-<rand>.json`
 * before the reset clears it. The random suffix prevents two concurrent
 * resets from clobbering each other's backup file.
 */
function backupLedgerForReset(): string | null {
  const src = ledgerPath()
  if (!fs.existsSync(src)) return null
  const dir = backupsDir()
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const suffix = crypto.randomBytes(4).toString('hex')
  const backupFile = join(dir, `ledger-${ts}-${suffix}.json`)
  fs.copyFileSync(src, backupFile)
  return backupFile
}

async function runResetLedger(): Promise<void> {
  await requireConfirmationPhrase(
    RESET_LEDGER_PHRASE,
    `Type ${chalk.bold(RESET_LEDGER_PHRASE)} to confirm clearing the namespace-overrides ledger`
  )
  const backupFile = backupLedgerForReset()
  await writeLedger({ version: NAMESPACE_OVERRIDES_CURRENT_VERSION, overrides: [] })
  if (backupFile) {
    console.log(`${chalk.green('OK')} Ledger cleared. Backup: ${backupFile}`)
  } else {
    console.log(`${chalk.green('OK')} Ledger cleared (no prior ledger to back up).`)
  }
}

// ---------------------------------------------------------------------------
// Apply paths
// ---------------------------------------------------------------------------

interface ApplyOutcome {
  collisionId: string
  status: 'applied' | 'skipped' | 'failed'
  message: string
}

async function applyOneSuggestion(
  suggestion: RenameSuggestion,
  auditId: string,
  customName?: string
): Promise<ApplyOutcome> {
  try {
    const result = await applyRename({
      suggestion,
      request: customName ? { action: 'apply', auditId, customName } : { action: 'apply', auditId },
    })
    if (result.success) {
      return {
        collisionId: suggestion.collisionId,
        status: 'applied',
        message: result.summary,
      }
    }
    return {
      collisionId: suggestion.collisionId,
      status: 'failed',
      message: result.error?.message ?? 'rename failed',
    }
  } catch (error) {
    return {
      collisionId: suggestion.collisionId,
      status: 'failed',
      message: sanitizeError(error),
    }
  }
}

async function runApplyAll(audit: RunInventoryAuditResult): Promise<void> {
  await requireConfirmationPhrase(
    APPLY_ALL_PHRASE,
    `Type ${chalk.bold(APPLY_ALL_PHRASE)} to confirm applying every suggestion (${audit.renameSuggestions.length})`
  )
  const outcomes: ApplyOutcome[] = []
  for (const suggestion of audit.renameSuggestions) {
    outcomes.push(await applyOneSuggestion(suggestion, audit.auditId))
  }
  printApplySummary(outcomes)
}

// ---------------------------------------------------------------------------
// Interactive prompt loop
// ---------------------------------------------------------------------------

async function runInteractiveLoop(audit: RunInventoryAuditResult): Promise<void> {
  if (audit.renameSuggestions.length === 0) {
    console.log(chalk.dim('No collisions found.'))
    return
  }

  console.log(chalk.bold.blue(`\n=== Skillsmith — Namespace audit ===`))
  console.log(chalk.dim(`Audit ID: ${audit.auditId}`))
  console.log(chalk.dim(`Report: ${audit.reportPath}`))
  console.log(`Found ${audit.renameSuggestions.length} collision(s).\n`)

  const outcomes: ApplyOutcome[] = []
  let index = 1
  const total = audit.renameSuggestions.length

  for (const suggestion of audit.renameSuggestions) {
    console.log(chalk.bold(`[${index}/${total}] ${suggestion.reason}`))
    console.log(`  Current:   ${suggestion.currentName}`)
    console.log(`  Suggested: ${chalk.cyan(suggestion.suggested)}`)
    console.log(chalk.dim(`  (default target = most-recently-installed entry, mtime desc)`))

    // Default = `skip` (defensive). Plan §235-239 mandates a typed-
    // confirmation gate for batch apply (`APPLY ALL`); per-item interactive
    // apply MUST mirror that posture so an inattentive Enter-press cannot
    // mutate user state. The user explicitly arrows down + Enter to apply.
    const choice = (await select({
      message: 'Action?',
      choices: [
        { name: 'Skip — leave this collision unchanged (default, safe)', value: 'skip' },
        { name: 'Apply — accept the suggested rename', value: 'apply' },
        { name: 'Edit — provide a custom name', value: 'edit' },
        { name: 'Quit — abort the loop', value: 'quit' },
      ],
      default: 'skip',
    })) as 'apply' | 'skip' | 'edit' | 'quit'

    if (choice === 'quit') {
      console.log(chalk.yellow('Aborted by user.'))
      break
    }
    if (choice === 'skip') {
      outcomes.push({
        collisionId: suggestion.collisionId,
        status: 'skipped',
        message: 'skipped by user',
      })
      index += 1
      continue
    }
    if (choice === 'edit') {
      const customName = await input({
        message: 'Enter custom name:',
        validate: (v: string) => v.trim().length > 0 || 'Name cannot be empty',
      })
      outcomes.push(await applyOneSuggestion(suggestion, audit.auditId, customName.trim()))
      index += 1
      continue
    }
    // choice === 'apply'
    outcomes.push(await applyOneSuggestion(suggestion, audit.auditId))
    index += 1
  }

  printApplySummary(outcomes)
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printApplySummary(outcomes: ApplyOutcome[]): void {
  const applied = outcomes.filter((o) => o.status === 'applied').length
  const skipped = outcomes.filter((o) => o.status === 'skipped').length
  const failed = outcomes.filter((o) => o.status === 'failed').length

  console.log(chalk.bold('\nSummary:'))
  console.log(`  ${chalk.green('Applied')}:   ${applied}`)
  console.log(`  ${chalk.yellow('Skipped')}:   ${skipped}`)
  console.log(`  ${chalk.red('Failed')}:    ${failed}`)

  for (const outcome of outcomes) {
    const tag =
      outcome.status === 'applied'
        ? chalk.green('OK')
        : outcome.status === 'skipped'
          ? chalk.yellow('SKIP')
          : chalk.red('FAIL')
    console.log(`  ${tag} ${outcome.collisionId} — ${outcome.message}`)
  }
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

async function runAuditCollisions(options: AuditCollisionsOptions): Promise<void> {
  // --reset-ledger short-circuits before any audit run.
  if (options.resetLedger) {
    // Touch readLedger to surface higher-version errors before clearing.
    // (readLedger throws on namespace.ledger.version_unsupported.)
    await readLedger()
    await runResetLedger()
    return
  }

  // Resolve tier from license status — the detector gates the semantic
  // pass on `audit_mode`, which is tier-defaulted via runInventoryAudit's
  // resolver. We pass the resolved tier through so a Team user gets
  // `power_user` (semantic) by default.
  const status = await getLicenseStatus()
  const tier = status.tier ?? 'community'

  const audit = await runInventoryAudit({ deep: options.deep, tier })

  if (options.json) {
    console.log(JSON.stringify(audit, null, 2))
    return
  }

  if (options.reportOnly) {
    console.log(`${chalk.green('OK')} Audit report written to ${audit.reportPath}`)
    return
  }

  if (options.applyAll) {
    await runApplyAll(audit)
    return
  }

  await runInteractiveLoop(audit)
}

// ---------------------------------------------------------------------------
// Command factory
// ---------------------------------------------------------------------------

/**
 * Build the `audit collisions` subcommand. Registered as a sibling of
 * `audit advisories` in `audit.ts` (Step 0a).
 */
export function createAuditCollisionsSubcommand(): Command {
  return new Command('collisions')
    .description(
      'Detect and resolve consumer-namespace collisions in ~/.claude/ ' +
        '(Default: most-recently-installed entry, mtime descending)'
    )
    .option('--deep', 'Opt into the semantic-overlap detector pass', false)
    .option('--json', 'Emit JSON to stdout; no prompts; no file mutation', false)
    .option(
      '--apply-all',
      'Accept every suggestion (typed-confirmation gate: literal phrase `APPLY ALL`)',
      false
    )
    .option('--report-only', 'Write the audit report; no prompts; no apply', false)
    .option(
      '--reset-ledger',
      'Clear ~/.skillsmith/namespace-overrides.json (typed-confirmation gate: literal phrase `RESET LEDGER`)',
      false
    )
    .action(async (opts: Record<string, boolean | undefined>) => {
      try {
        await runAuditCollisions({
          deep: opts['deep'] === true,
          json: opts['json'] === true,
          applyAll: opts['applyAll'] === true,
          reportOnly: opts['reportOnly'] === true,
          resetLedger: opts['resetLedger'] === true,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : sanitizeError(error)
        // Confirmation rejection is not a stack-trace-worthy failure —
        // print the canonical message and exit non-zero.
        if (message === CONFIRMATION_REJECTED_MESSAGE) {
          console.error(chalk.yellow(message))
        } else {
          console.error(chalk.red('Error:'), message)
        }
        process.exit(1)
      }
    })
}

// Internal exports for tests.
export {
  runAuditCollisions,
  runResetLedger,
  runApplyAll,
  runInteractiveLoop,
  requireConfirmationPhrase,
  applyOneSuggestion,
  APPLY_ALL_PHRASE,
  RESET_LEDGER_PHRASE,
  CONFIRMATION_REJECTED_MESSAGE,
}
export type { AuditCollisionsOptions, ApplyOutcome }

export default createAuditCollisionsSubcommand
