/**
 * SMI-7056: shared CLI answer path for core's CONFIRMATION_REQUIRED result.
 *
 * `SkillInstallationService.install()` refuses a registry skill whose trust tier
 * is not one of the reviewed tiers unless `options.confirmed` is true. The CLI
 * answers that gate in exactly one of three ways, used by `install`, the
 * interactive search-install, and `update`:
 *
 *   1. `--yes`               -> `confirmed: true` is passed up front.
 *   2. interactive terminal  -> show the tier + warning, ask y/N (default No),
 *                               retry once with `confirmed: true` on yes.
 *   3. anything else         -> fail with a message naming `--yes`.
 *
 * `--yes` ONLY answers the confirmation. It never touches `skipScan`, so core's
 * SKIP_SCAN_FORBIDDEN refusal and the security scan itself are unaffected.
 */

import { confirm } from '@inquirer/prompts'
import chalk from 'chalk'
import type { CoreInstallResult, InstallOptions } from '@skillsmith/core'

export interface ConfirmOptions {
  /** `--yes`: answer the confirmation up front. */
  yes?: boolean | undefined
  /** Allow an interactive prompt. Callers pass false for `--json`. */
  allowPrompt?: boolean | undefined
  /** Called just before the prompt (e.g. stop a spinner). */
  beforePrompt?: (() => void) | undefined
  /** Called just before the retry install (e.g. restart a spinner). */
  beforeRetry?: (() => void) | undefined
}

/**
 * The install result, plus `declined: true` when a person answered "no" at the
 * prompt. Callers can treat a decline as a cancellation rather than a failure;
 * a non-interactive refusal never sets it.
 */
export type ConfirmedInstallResult = CoreInstallResult & { declined?: true }

/** True when both stdin and stdout are a terminal, i.e. a person can answer. */
export function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY)
}

export function isConfirmationRequired(result: CoreInstallResult): boolean {
  return !result.success && result.errorCode === 'CONFIRMATION_REQUIRED'
}

/** The reason without core's API-flavoured "Re-run with confirmed=true" tail. */
function reasonText(result: CoreInstallResult): string {
  const raw = result.confirmationReason ?? 'This skill has not been reviewed.'
  return raw.replace(/\s*Re-run with confirmed=true to proceed\.?\s*$/, '').trim()
}

function stripConfirmedTips(result: CoreInstallResult): string[] | undefined {
  if (!result.tips) return undefined
  const tips = result.tips.filter((t) => !t.includes('confirmed=true'))
  return tips.length > 0 ? tips : undefined
}

function withError(result: CoreInstallResult, error: string): CoreInstallResult {
  const { tips: _tips, ...rest } = result
  const tips = stripConfirmedTips(result)
  return { ...rest, ...(tips ? { tips } : {}), error }
}

/** Ask y/N (default No). Ctrl-C (`ExitPromptError`) is a "no", as in login.ts. */
async function askToProceed(): Promise<boolean> {
  try {
    return await confirm({ message: 'Install anyway?', default: false })
  } catch (err) {
    if ((err as { name?: string }).name === 'ExitPromptError') return false
    throw err
  }
}

/**
 * Run `install` and, on CONFIRMATION_REQUIRED, apply the confirm path above.
 * `confirmed` is only ever added to the options when it is true, so callers'
 * existing option shapes are unchanged on every other path.
 */
export async function installWithConfirmation(
  install: (options: InstallOptions) => Promise<CoreInstallResult>,
  baseOptions: InstallOptions,
  opts: ConfirmOptions = {}
): Promise<ConfirmedInstallResult> {
  const first = await install(opts.yes ? { ...baseOptions, confirmed: true } : baseOptions)
  if (!isConfirmationRequired(first)) return first

  // `||`, not `??`: an empty-string tier would otherwise print as "-tier".
  const tier = first.trustTier || 'unknown'
  const reason = reasonText(first)

  if (opts.allowPrompt === false || !isInteractiveTerminal()) {
    return withError(
      first,
      `Confirmation required for ${tier}-tier skill. ${reason} ` +
        'Re-run with --yes to confirm (--yes does not skip the security scan).'
    )
  }

  opts.beforePrompt?.()
  console.log(chalk.yellow(`\n  Trust tier: ${tier}`))
  console.log(chalk.yellow(`  ${reason}`))
  if (!(await askToProceed())) {
    // Callers prefix their own verb ("Install cancelled: ...", "Update cancelled: ...").
    return { ...withError(first, `${tier}-tier skill was not confirmed.`), declined: true }
  }

  opts.beforeRetry?.()
  return install({ ...baseOptions, confirmed: true })
}
