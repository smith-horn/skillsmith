/**
 * License status utilities for Skillsmith CLI
 *
 * Handles license validation, status display, and tier formatting.
 * Supports community (free), team, and enterprise license tiers.
 *
 * When @smith-horn/enterprise is available, uses proper RS256 JWT validation.
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
import type { LicenseTier, LicenseStatus } from './license-types.js'
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
 * Display license status on CLI startup
 *
 * Shows license tier, expiration (if applicable), features for paid tiers,
 * and quota usage information.
 * Uses colored output: green for valid, yellow for community, red for expired/invalid.
 *
 * @param status - License status to display
 */
// SMI-5427: displayLicenseStatus and displayStartupHeader use console.error so
// the decorative banner never mixes with a command's stdout payload. Only these
// two display functions are changed — command result output is unaffected.
export function displayLicenseStatus(status: LicenseStatus): void {
  const tierBadge = formatTierBadge(status.tier)

  if (status.tier === 'community') {
    console.error(`License: ${tierBadge} ${chalk.dim('(free tier - 100 API calls/month)')}`)
  } else if (status.tier === 'individual') {
    const expiresInfo = status.expiresAt
      ? chalk.green(`(expires: ${status.expiresAt.toISOString().split('T')[0]})`)
      : ''
    console.error(`License: ${tierBadge} ${expiresInfo}`)
  } else if (status.valid && status.expiresAt) {
    const expiresFormatted = status.expiresAt.toISOString().split('T')[0]
    console.error(`License: ${tierBadge} ${chalk.green(`(expires: ${expiresFormatted})`)}`)
    console.error(`Features: ${chalk.dim(status.features.join(', '))}`)
  }

  // Display quota information if available
  if (status.quota && status.tier !== 'enterprise') {
    const { used, limit, percentUsed, resetAt } = status.quota
    const resetFormatted = resetAt.toISOString().split('T')[0]

    if (percentUsed >= 100) {
      console.error(
        chalk.red.bold(
          `API Quota: EXCEEDED (${used.toLocaleString()}/${limit.toLocaleString()} calls)`
        )
      )
      console.error(chalk.red(`Quota resets on ${resetFormatted}. Upgrade to continue.`))
    } else if (percentUsed >= 90) {
      console.error(
        chalk.yellow.bold(
          `API Quota: ${used.toLocaleString()}/${limit.toLocaleString()} (${percentUsed.toFixed(0)}%)`
        )
      )
      console.error(chalk.yellow(`Warning: Approaching limit. Resets ${resetFormatted}`))
    } else if (percentUsed >= 80) {
      console.error(
        chalk.yellow(
          `API Quota: ${used.toLocaleString()}/${limit.toLocaleString()} (${percentUsed.toFixed(0)}%)`
        )
      )
    } else {
      console.error(
        chalk.dim(`API Quota: ${used.toLocaleString()}/${limit.toLocaleString()} calls used`)
      )
    }
  } else if (status.tier === 'enterprise') {
    console.error(chalk.dim('API Quota: Unlimited'))
  }

  // Show warnings for invalid/expired licenses
  if (status.error) {
    console.error(chalk.red(`Warning: ${status.error}`))
    console.error(chalk.dim('Continuing with community tier features'))
  }
}

/**
 * Display the full CLI header with version and license info
 *
 * @param version - CLI version string
 */
export async function displayStartupHeader(version: string): Promise<void> {
  console.error(`Skillsmith CLI v${version}`)

  const status = await getLicenseStatus()
  displayLicenseStatus(status)
  console.error() // Empty line after header
}
