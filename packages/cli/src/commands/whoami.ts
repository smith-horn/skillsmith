/**
 * Whoami Command - Show current authentication status
 *
 * SMI-2715: CLI Login Device Flow
 *
 * Displays the masked API key (or JWT session expiry) and the storage
 * source so users can understand where their credentials are being read
 * from. Checks a JWT device-code session (SMI-4402) via loadCredentials()
 * first — getAuthStatus() alone only sees the legacy API key.
 */

import { Command } from 'commander'
import chalk from 'chalk'
import { getAuthStatus, loadCredentials } from '@skillsmith/core'
import { withTelemetry } from '@skillsmith/core/telemetry'

/** Human-readable labels for each credential source */
const SOURCE_LABELS: Record<string, string> = {
  keyring: 'OS keyring',
  config: 'config file (~/.skillsmith/config.json)',
  env: 'environment variable (SKILLSMITH_API_KEY)',
  none: 'none',
}

// SMI-5040: extracted from inline .action() closure for withTelemetry wrap.
async function whoamiActionImpl(): Promise<void> {
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
    process.exit(0)
  }

  const status = await getAuthStatus()

  if (!status.authenticated || !status.keyPrefix) {
    console.log(`Not authenticated. Run ${chalk.cyan('`skillsmith login`')} to authenticate.`)
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
