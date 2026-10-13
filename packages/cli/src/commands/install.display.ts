/**
 * SMI-3484: CLI Install Command — result formatting.
 *
 * SMI-7056: split out of `install.action.ts` (sibling-split convention) when the
 * confirm path pushed that file past the 500-line standard. Re-exported from
 * `install.action.ts` / `install.ts`, so existing import paths are unchanged.
 */

import chalk from 'chalk'
import type { CoreInstallResult } from '@skillsmith/core'
import { getCliLogger } from '../cli-logger.js'

const logger = getCliLogger()

/**
 * Format install result for --json output
 *
 * SMI-5905 Wave 4: exported so `registry-install.action.ts` can reuse this
 * without duplicating output formatting — `CoreInstallResult` is the same
 * type `SkillInstallationService.installFromContent()` returns.
 */
export function formatJsonResult(result: CoreInstallResult): string {
  return JSON.stringify(
    {
      success: result.success,
      skillId: result.skillId,
      installPath: result.installPath,
      error: result.error,
      // SMI-7056: lets a script tell CONFIRMATION_REQUIRED from other failures.
      ...(!result.success && result.errorCode !== undefined && { errorCode: result.errorCode }),
      trustTier: result.trustTier,
      optimization: result.optimization,
      tips: result.tips,
    },
    null,
    2
  )
}

/**
 * Display install result in human-readable format
 *
 * SMI-5905 Wave 4: exported so `registry-install.action.ts` can reuse this
 * without duplicating output formatting — see `formatJsonResult` above.
 */
export function displayResult(result: CoreInstallResult, quiet: boolean): void {
  if (result.success) {
    console.log(chalk.green('\nSkill installed successfully!'))
    console.log(chalk.dim(`  Path: ${result.installPath}`))

    if (result.trustTier) {
      console.log(chalk.dim(`  Trust tier: ${result.trustTier}`))
    }

    if (result.optimization?.optimized && !quiet) {
      console.log(chalk.dim(`  Optimized: ${result.optimization.tokenReductionPercent}% reduction`))
      if (result.optimization.subSkills && result.optimization.subSkills.length > 0) {
        console.log(chalk.dim(`  Sub-skills: ${result.optimization.subSkills.join(', ')}`))
      }
      // SMI-6529 N11 (round 4): `subagentGenerated` is set as soon as content
      // was GENERATED (applyOptimization, before any disk write is even
      // attempted) — it stays true even when the actual write was skipped
      // (M10's companionSkipped: a pre-existing file/symlink already
      // occupied the target on a fresh install). Gate the message on
      // `subagentPath` too — writeInstallFiles only sets it when the file
      // was ACTUALLY written — so this line never claims success for a
      // write that didn't happen.
      if (result.optimization.subagentGenerated && result.optimization.subagentPath) {
        console.log(chalk.dim(`  Companion subagent generated`))
      }
    }

    if (result.contentHashMismatch) {
      console.log(chalk.yellow('\n  Warning: Content has changed since last indexed.'))
      console.log(chalk.yellow("  Review recent changes at the skill's repository before using."))
    }

    if (result.tips && result.tips.length > 0 && !quiet) {
      // Skip the first tip when contentHashMismatch is true — it's the mismatch
      // warning already displayed as chalk.yellow above (added via tips.unshift)
      const startIndex = result.contentHashMismatch ? 1 : 0
      if (startIndex < result.tips.length) {
        console.log()
        for (let i = startIndex; i < result.tips.length; i++) {
          console.log(chalk.dim(`  Tip: ${result.tips[i]}`))
        }
      }
    }
  } else {
    logger.error(chalk.red(`\nInstallation failed: ${result.error}`))

    if (result.securityReport && !result.securityReport.passed) {
      logger.error(chalk.red('  Security scan failed.'))
      for (const finding of result.securityReport.findings) {
        if (finding.severity === 'critical' || finding.severity === 'high') {
          logger.error(chalk.red(`  [${finding.severity}] ${finding.message}`))
        }
      }
    }

    if (result.tips && result.tips.length > 0 && !quiet) {
      console.log()
      for (const tip of result.tips) {
        console.log(chalk.dim(`  ${tip}`))
      }
    }
  }
}
