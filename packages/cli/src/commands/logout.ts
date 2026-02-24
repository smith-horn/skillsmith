/**
 * Logout Command - Remove stored Skillsmith API key
 *
 * SMI-2715: CLI Login Device Flow
 *
 * Checks authentication status, prompts for confirmation, and clears
 * the stored API key from all storage locations (keyring + config file).
 */

import { Command } from 'commander'
import { confirm } from '@inquirer/prompts'
import chalk from 'chalk'
import { clearApiKey, getAuthStatus } from '@skillsmith/core'

/**
 * Create the `skillsmith logout` command.
 */
export function createLogoutCommand(): Command {
  return new Command('logout').description('Remove stored Skillsmith API key').action(async () => {
    // 1. Check whether there is anything to remove
    const status = await getAuthStatus()
    if (!status.authenticated) {
      console.log('Not authenticated. Nothing to log out.')
      process.exit(0)
    }

    // 2. Confirm before removing
    const confirmed = await confirm({
      message: 'Log out and remove stored API key?',
      default: false,
    })

    if (!confirmed) {
      console.log('Cancelled.')
      process.exit(0)
    }

    // 3. Clear key from all storage locations
    const result = await clearApiKey()

    if (result.success) {
      console.log(chalk.green(`Logged out. Key removed from ${result.source}.`))
    } else {
      console.log(
        chalk.yellow(
          `Logged out (config file cleared), but could not remove from keyring: ${result.error}`
        )
      )
      console.log(chalk.dim('The key may still be stored in your OS keyring.'))
    }
    process.exit(0)
  })
}
