/**
 * Whoami Command - Show current authentication status
 *
 * SMI-2715: CLI Login Device Flow
 * SMI-6266 Wave 2 (SMI-6272): live entitlement display
 *
 * Displays the masked API key (or JWT session expiry), the storage source,
 * and — new in Wave 2 — the caller's live effective tier (and per-minute
 * rate limit, when the live check returns one) via `resolveEffectiveTier()`
 * (Wave 1, SMI-6271). Checks a JWT device-code session (SMI-4402) via
 * loadCredentials() first — getAuthStatus() alone only sees the legacy API
 * key.
 */

import { Command } from 'commander'
import chalk from 'chalk'
import { getAuthStatus, loadCredentials } from '@skillsmith/core'
import { withTelemetry } from '@skillsmith/core/telemetry'
import { resolveEffectiveTier, type EffectiveTierResult } from '../utils/require-tier.js'
import { formatTierBadge } from '../utils/license.js'

/** Human-readable labels for each credential source */
const SOURCE_LABELS: Record<string, string> = {
  keyring: 'OS keyring',
  config: 'config file (~/.skillsmith/config.json)',
  env: 'environment variable (SKILLSMITH_API_KEY)',
  none: 'none',
}

/**
 * Print the caller's live effective tier, reusing `formatTierBadge()`
 * (license.ts) rather than reimplementing tier-badge formatting.
 *
 * `whoami` is a display command, not a gate — unlike `requireTier()`'s
 * fail-closed throw on a transient live-check failure, blocking the entire
 * command here would be wrong (the rest of `whoami`'s output, e.g. the
 * masked key, is still valid and useful even when the live tier check
 * fails). But a CLI invocation is a single short-lived process with no
 * cross-call cache (see require-tier.ts's own doc comment on
 * `resolveViaApiKey()`), so there is no real "last-known" tier to fall back
 * to here — showing the `communityStatus()` placeholder `resolveEffectiveTier()`
 * returns on a transient failure would be actively misleading (it could
 * silently under-report a real paying customer as Community). So on
 * `transient: true` this prints an explicit "could not verify" line and
 * deliberately omits any tier badge, rather than displaying unverified
 * placeholder data as if it were real.
 */
function printTierSection(result: EffectiveTierResult): void {
  console.log()
  if (result.transient) {
    console.log(
      chalk.dim('  Tier:   ') +
        chalk.yellow('could not verify (live check failed — try again in a moment)')
    )
    return
  }

  console.log(chalk.dim('  Tier:   ') + formatTierBadge(result.status.tier))
  if (result.rateLimit !== undefined) {
    console.log(chalk.dim('  Rate limit: ') + chalk.cyan(`${result.rateLimit} req/min`))
  }
}

// SMI-5040: extracted from inline .action() closure for withTelemetry wrap.
async function whoamiActionImpl(): Promise<void> {
  // Kicked off up front so it runs concurrently with the credential checks
  // below rather than adding its own latency serially after them.
  const tierResultPromise = resolveEffectiveTier()

  // loadCredentials() returning non-null already means a resolvable refresh
  // token is on file — don't additionally gate on access-token freshness
  // (Date.now() < expiresAt): an expired access token with a live refresh
  // token is a session resolveFreshAccessToken() refreshes transparently on
  // next use, so reporting it as "not authenticated" here would be wrong
  // (PR review finding, SMI-6235 — same root issue as logout.ts's gate).
  const jwtSession = await loadCredentials()
  if (jwtSession) {
    console.log(chalk.bold('Skillsmith CLI'))
    console.log(chalk.dim('  Session: ') + chalk.cyan('device-code login'))
    const expired = Date.now() >= jwtSession.expiresAt
    const expiresLabel = new Date(jwtSession.expiresAt).toLocaleString()
    console.log(
      chalk.dim('  Access token: ') +
        (expired
          ? chalk.yellow(`expired ${expiresLabel} (refreshes automatically on next use)`)
          : chalk.green(`valid until ${expiresLabel}`))
    )
    printTierSection(await tierResultPromise)
    process.exit(0)
  }

  const status = await getAuthStatus()

  if (!status.authenticated || !status.keyPrefix) {
    console.log(`Not authenticated. Run ${chalk.cyan('`skillsmith login`')} to authenticate.`)
    printTierSection(await tierResultPromise)
    process.exit(0)
  }

  // Mask: show first 12 chars + ellipsis
  // The full key is sk_live_ (8 chars) + 32-128 chars.
  // 12 chars shows "sk_live_xxxx" without revealing the secret suffix.
  const masked = `${status.keyPrefix}...`

  console.log(chalk.bold('Skillsmith CLI'))
  console.log(chalk.dim('  Key:    ') + chalk.cyan(masked))
  console.log(chalk.dim('  Source: ') + (SOURCE_LABELS[status.source] ?? status.source))
  console.log(chalk.dim('  Format: ') + chalk.green('valid'))

  // Hint: when using file fallback, let the user know they can upgrade to keyring
  if (status.source === 'config') {
    console.log(
      chalk.dim(
        '  Tip:    Install @isaacs/keytar for more secure OS keyring storage: ' +
          'npm install -g @isaacs/keytar'
      )
    )
  }

  printTierSection(await tierResultPromise)
  process.exit(0)
}

export const whoamiAction = withTelemetry(whoamiActionImpl, {
  source: 'cli',
  extractSkillId: () => 'whoami',
  extractFramework: () => 'cli',
})

/**
 * Create the `skillsmith whoami` command.
 */
export function createWhoamiCommand(): Command {
  return new Command('whoami')
    .description('Show current authentication status')
    .action(whoamiAction)
}
