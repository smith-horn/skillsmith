/**
 * Whoami Command - Show current authentication status
 *
 * SMI-2715: CLI Login Device Flow
 *
 * Displays the masked API key and the storage source so users can
 * understand where their credentials are being read from.
 */

import { Command } from 'commander'
import chalk from 'chalk'
import { getAuthStatus } from '@skillsmith/core'

/** Human-readable labels for each credential source */
const SOURCE_LABELS: Record<string, string> = {
  keyring: 'OS keyring',
  config: 'config file (~/.skillsmith/config.json)',
  env: 'environment variable (SKILLSMITH_API_KEY)',
  none: 'none',
}

/**
 * Create the `skillsmith whoami` command.
 */
export function createWhoamiCommand(): Command {
  return new Command('whoami')
    .description('Show current authentication status')
    .action(async () => {
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
    })
}
