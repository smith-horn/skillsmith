/**
 * @fileoverview requireTier — CLI license tier gate helper
 * @module @skillsmith/cli/utils/require-tier
 * @see SMI-skill-version-tracking Wave 1
 *
 * Throws a user-friendly error when the current license tier is below
 * the minimum required for a CLI command or flag.
 *
 * Security properties:
 *  - Fail-secure: key present + validation failure → block, never fall back
 *    to community to silently allow access
 *  - SKILLSMITH_SKIP_LICENSE_CHECK=true is a CI/dev escape hatch only; it
 *    must use bracket notation per TypeScript/ESLint index-signature rules
 *  - SKILLSMITH_LICENSE_KEY is read from env but never logged
 */

import { getLicenseStatus } from './license-validation.js'
import type { LicenseTier } from './license-types.js'

/**
 * Ordered license tiers, lowest to highest.
 * Used for tier comparison arithmetic.
 */
const TIER_ORDER: LicenseTier[] = ['community', 'individual', 'team', 'enterprise']

/**
 * Prices for use in upgrade messages
 */
const TIER_PRICING: Record<LicenseTier, string> = {
  community: '$0/month',
  individual: '$9.99/month',
  team: '$25/user/month',
  enterprise: '$55/user/month',
}

/**
 * Throw if the current license tier is below minimumTier.
 *
 * Call this at the top of any CLI command or action that requires a paid tier.
 *
 * @param minimumTier - Minimum tier required to use the feature
 * @throws Error with an upgrade prompt when the tier requirement is not met
 * @throws Error when a license key is present but fails validation (fail-secure)
 *
 * @example
 * ```typescript
 * export function createOutdatedCommand(): Command {
 *   return new Command('outdated')
 *     .action(async () => {
 *       await requireTier('individual')
 *       // ... rest of command
 *     })
 * }
 * ```
 */
export async function requireTier(minimumTier: LicenseTier): Promise<void> {
  // CI / dev escape hatch — must use bracket notation (TS index-signature rule)
  if (process.env['SKILLSMITH_SKIP_LICENSE_CHECK'] === 'true') {
    return
  }

  const status = await getLicenseStatus()

  // Fail-secure: key present + validation failure → block
  // Never silently fall back to community when a key was supplied
  const hasKey = Boolean(process.env['SKILLSMITH_LICENSE_KEY'])
  if (hasKey && !status.valid) {
    throw new Error(
      `License validation failed. ` +
        `Please check your SKILLSMITH_LICENSE_KEY or visit https://skillsmith.app/account to manage your license.`
    )
  }

  const currentTier = (status.tier ?? 'community') as LicenseTier
  const currentIndex = TIER_ORDER.indexOf(currentTier)
  const requiredIndex = TIER_ORDER.indexOf(minimumTier)

  if (currentIndex < requiredIndex) {
    const pricing = TIER_PRICING[minimumTier]
    throw new Error(
      `This feature requires ${minimumTier} tier or higher (${pricing}). ` +
        `You are currently on the ${currentTier} tier. ` +
        `Upgrade at https://skillsmith.app/upgrade?tier=${minimumTier}`
    )
  }
}
