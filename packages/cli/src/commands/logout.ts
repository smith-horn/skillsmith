/**
 * Logout Command - Remove stored Skillsmith credentials
 *
 * SMI-2715: CLI Login Device Flow
 *
 * Checks authentication status, prompts for confirmation, and clears
 * stored credentials from all storage locations (keyring + config file) —
 * both the legacy API key and a JWT device-code session (SMI-4402), since
 * `login` accepts either and this command must be able to end either.
 */

import { Command } from 'commander'
import { confirm } from '@inquirer/prompts'
import chalk from 'chalk'
import { clearApiKey, clearCredentials, getAuthStatus, loadCredentials } from '@skillsmith/core'
import { withTelemetry } from '@skillsmith/core/telemetry'

// SMI-5128: extracted from inline .action() closure to a named function so
// withTelemetry can wrap it at the export boundary (SMI-5040 coverage gate).
async function logoutActionImpl(): Promise<void> {
  // 1. Check whether there is anything to remove. getAuthStatus() only sees
  // the legacy API key (SMI-2714) — a JWT session (SMI-4402) needs its own
  // check via loadCredentials(), same as login.ts does.
  //
  // Unlike login.ts's "Date.now() < expiresAt" freshness gate (which decides
  // whether to skip a fresh OAuth round-trip), logout only needs to know
  // whether a JWT credential set exists at all: an expired access token
  // with its refresh token still on file is a session `resolveFreshAccessToken()`
  // would silently refresh on next use, and there is no locally-checkable way
  // to know the refresh token itself has expired — gating on access-token
  // freshness here would report "Not authenticated" for a still-clearable,
  // still-functionally-live session (PR review finding, SMI-6235).
  const status = await getAuthStatus()
  const jwtSession = await loadCredentials()
  const hasJwtSession = jwtSession !== null
  if (!status.authenticated && !hasJwtSession) {
    console.log('Not authenticated. Nothing to log out.')
    process.exit(0)
  }

  // 2. Confirm before removing
  const confirmed = await confirm({
    message: 'Log out and remove stored credentials?',
    default: false,
  })

  if (!confirmed) {
    console.log('Cancelled.')
    process.exit(0)
  }

  // 3. Clear both credential stores unconditionally — matches clearApiKey()'s
  // own "always clear, even if nothing was there" pattern, and avoids leaving
  // a stale credential behind from whichever flow the user didn't use.
  const apiKeyResult = await clearApiKey()
  const jwtResult = await clearCredentials()
  const results = [apiKeyResult, jwtResult]

  if (results.every((r) => r.success)) {
    // Each result's `source` is itself a composite string (e.g. "keyring and
    // config file"), so deduping the two composite strings directly can
    // produce "keyring and config file and config file" when they overlap.
    // Flatten to individual location names first (PR review finding, SMI-6235).
    const sources = [...new Set(results.flatMap((r) => r.source.split(' and ')))].join(' and ')
    console.log(chalk.green(`Logged out. Credentials removed from ${sources}.`))
  } else {
    console.log(chalk.yellow('Logged out (config file cleared), but with keyring warnings:'))
    for (const result of results) {
      if (!result.success) {
        console.log(chalk.yellow(`  Could not remove from keyring: ${result.error}`))
      }
    }
    console.log(chalk.dim('Some credentials may still be stored in your OS keyring.'))
  }
  process.exit(0)
}

export const logoutAction = withTelemetry(logoutActionImpl, {
  source: 'cli',
  extractSkillId: () => 'logout',
  extractFramework: () => 'cli',
})

/**
 * Create the `skillsmith logout` command.
 */
export function createLogoutCommand(): Command {
  return new Command('logout')
    .description('Remove stored Skillsmith credentials')
    .action(logoutAction)
}
