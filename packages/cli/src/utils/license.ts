/**
 * License status utilities for Skillsmith CLI
 *
 * Handles license validation, status display, and tier formatting.
 * Supports community (free), team, and enterprise license tiers.
 *
 * When @skillsmith/enterprise is available, uses proper RS256 JWT validation.
 * Otherwise, falls back to community tier (no error).
 *
 * Environment variable: SKILLSMITH_LICENSE_KEY
 *
 * @see SMI-1090: CLI should use enterprise LicenseValidator when available
 */

import chalk from 'chalk'

// Re-export types for backwards compatibility
export type { LicenseTier, QuotaInfo, LicenseStatus, LicensePayload } from './license-types.js'
export { TIER_FEATURES, TIER_QUOTAS } from './license-types.js'

// Re-export validation functions
export {
  tryLoadEnterpriseValidator,
  _resetEnterpriseValidatorCache,
  decodeLicenseKey,
  isExpired,
  getLicenseStatus,
  getLicenseStatusLegacy,
} from './license-validation.js'

// Import types for internal use
import type { LicenseTier, QuotaInfo, LicenseStatus } from './license-types.js'
import { getLicenseStatus } from './license-validation.js'

// ============================================================================
// Display Helpers
// ============================================================================

/**
 * Format a tier badge with color
 *
 * @param tier - License tier
 * @returns Formatted tier badge string
 */
export function formatTierBadge(tier: LicenseTier): string {
  switch (tier) {
    case 'enterprise':
      return chalk.magenta.bold('Enterprise')
    case 'team':
      return chalk.blue.bold('Team')
    case 'individual':
      return chalk.cyan.bold('Individual')
    case 'community':
    default:
      return chalk.yellow('Community')
  }
}

/**
 * Display a progress bar for quota usage
 *
 * @param used - API calls used
 * @param limit - API call limit
 * @returns Formatted progress bar string
 */
export function displayQuotaProgressBar(used: number, limit: number): string {
  const width = 30
  const percent = Math.min((used / limit) * 100, 100)
  const filled = Math.round((percent / 100) * width)
  const empty = width - filled

  // Color based on usage level
  let color = chalk.green
  if (percent >= 90) color = chalk.red
  else if (percent >= 80) color = chalk.yellow

  const bar = color('█'.repeat(filled)) + chalk.gray('░'.repeat(empty))
  return `[${bar}] ${percent.toFixed(0)}%`
}

/**
 * Display a quota warning box
 *
 * @param quota - Quota information
 * @param tier - Current tier for upgrade suggestions
 */
export function displayQuotaWarning(quota: QuotaInfo, tier: LicenseTier): void {
  const percentUsed = quota.percentUsed
  const resetFormatted = quota.resetAt.toLocaleDateString()

  console.log()
  if (percentUsed >= 100) {
    console.log(chalk.red('━'.repeat(50)))
    console.log(chalk.red.bold('❌ API Quota Exceeded'))
    console.log(chalk.red(`You've used all ${quota.limit.toLocaleString()} API calls this month`))
    console.log(chalk.red(`Quota resets on ${resetFormatted}`))
    if (tier !== 'enterprise') {
      console.log(chalk.dim(`Upgrade at: https://skillsmith.app/upgrade`))
    }
    console.log(chalk.red('━'.repeat(50)))
  } else if (percentUsed >= 90) {
    console.log(chalk.yellow('━'.repeat(50)))
    console.log(chalk.yellow.bold('⚠️  API Quota Warning'))
    console.log(
      chalk.yellow(
        `You've used ${percentUsed.toFixed(0)}% of your monthly quota (${quota.used.toLocaleString()}/${quota.limit.toLocaleString()})`
      )
    )
    console.log(
      chalk.yellow(
        `${(quota.limit - quota.used).toLocaleString()} calls remaining until ${resetFormatted}`
      )
    )
    if (tier !== 'enterprise') {
      console.log(chalk.dim(`Upgrade at: https://skillsmith.app/upgrade`))
    }
    console.log(chalk.yellow('━'.repeat(50)))
  } else if (percentUsed >= 80) {
    console.log(chalk.yellow('━'.repeat(50)))
    console.log(chalk.yellow('⚠️  Approaching API Quota Limit'))
    console.log(
      chalk.yellow(
        `${percentUsed.toFixed(0)}% used (${quota.used.toLocaleString()}/${quota.limit.toLocaleString()})`
      )
    )
    console.log(chalk.yellow('━'.repeat(50)))
  }
}

/**
 * Display license status on CLI startup
 *
 * Shows license tier, expiration (if applicable), features for paid tiers,
 * and quota usage information.
 * Uses colored output: green for valid, yellow for community, red for expired/invalid.
 *
 * @param status - License status to display
 */
export function displayLicenseStatus(status: LicenseStatus): void {
  const tierBadge = formatTierBadge(status.tier)

  if (status.tier === 'community') {
    console.log(`License: ${tierBadge} ${chalk.dim('(free tier - 1,000 API calls/month)')}`)
  } else if (status.tier === 'individual') {
    const expiresInfo = status.expiresAt
      ? chalk.green(`(expires: ${status.expiresAt.toISOString().split('T')[0]})`)
      : ''
    console.log(`License: ${tierBadge} ${expiresInfo}`)
  } else if (status.valid && status.expiresAt) {
    const expiresFormatted = status.expiresAt.toISOString().split('T')[0]
    console.log(`License: ${tierBadge} ${chalk.green(`(expires: ${expiresFormatted})`)}`)
    console.log(`Features: ${chalk.dim(status.features.join(', '))}`)
  }

  // Display quota information if available
  if (status.quota && status.tier !== 'enterprise') {
    const { used, limit, percentUsed, resetAt } = status.quota
    const resetFormatted = resetAt.toISOString().split('T')[0]

    if (percentUsed >= 100) {
      console.log(
        chalk.red.bold(
          `API Quota: EXCEEDED (${used.toLocaleString()}/${limit.toLocaleString()} calls)`
        )
      )
      console.log(chalk.red(`Quota resets on ${resetFormatted}. Upgrade to continue.`))
    } else if (percentUsed >= 90) {
      console.log(
        chalk.yellow.bold(
          `API Quota: ${used.toLocaleString()}/${limit.toLocaleString()} (${percentUsed.toFixed(0)}%)`
        )
      )
      console.log(chalk.yellow(`Warning: Approaching limit. Resets ${resetFormatted}`))
    } else if (percentUsed >= 80) {
      console.log(
        chalk.yellow(
          `API Quota: ${used.toLocaleString()}/${limit.toLocaleString()} (${percentUsed.toFixed(0)}%)`
        )
      )
    } else {
      console.log(
        chalk.dim(`API Quota: ${used.toLocaleString()}/${limit.toLocaleString()} calls used`)
      )
    }
  } else if (status.tier === 'enterprise') {
    console.log(chalk.dim('API Quota: Unlimited'))
  }

  // Show warnings for invalid/expired licenses
  if (status.error) {
    console.log(chalk.red(`Warning: ${status.error}`))
    console.log(chalk.dim('Continuing with community tier features'))
  }
}

/**
 * Display the full CLI header with version and license info
 *
 * @param version - CLI version string
 */
export async function displayStartupHeader(version: string): Promise<void> {
  console.log(`Skillsmith CLI v${version}`)

  const status = await getLicenseStatus()
  displayLicenseStatus(status)
  console.log() // Empty line after header
}
