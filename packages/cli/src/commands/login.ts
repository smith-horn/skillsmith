/**
 * Login Command - Authenticate the Skillsmith CLI
 *
 * SMI-2715: CLI Login Device Flow
 *
 * Opens the Skillsmith dashboard in the browser (or prints the URL for
 * headless/CI environments), prompts for an API key with masked input,
 * validates the format, and stores it securely via @skillsmith/core.
 *
 * Security notes:
 * - No --key <value> flag: would expose the secret in ps aux / shell history
 * - Headless path: SKILLSMITH_API_KEY env var (documented in README)
 * - Always-masked input: @inquirer/prompts password() renders bullets
 */

import { Command } from 'commander'
import { password } from '@inquirer/prompts'
import chalk from 'chalk'
import { getAuthStatus, storeApiKey, isValidApiKeyFormat } from '@skillsmith/core'

/** URL where users generate their CLI API token */
const CLI_TOKEN_URL = 'https://skillsmith.app/account/cli-token'

/**
 * Detect whether the current environment is headless (no interactive display).
 * On Linux without DISPLAY, opening a browser will fail silently.
 */
function isHeadlessEnvironment(): boolean {
  return process.env['CI'] === 'true' || (process.platform === 'linux' && !process.env['DISPLAY'])
}

/**
 * Attempt to open a URL in the default browser.
 * Returns true if the browser was opened, false otherwise.
 */
async function tryOpenBrowser(url: string): Promise<boolean> {
  try {
    const { default: open } = await import('open')
    await open(url)
    return true
  } catch {
    return false
  }
}

/**
 * Create the `skillsmith login` command.
 *
 * Options:
 *   --no-browser   Print URL instead of opening browser (for CI/headless)
 */
export function createLoginCommand(): Command {
  return new Command('login')
    .description('Authenticate the Skillsmith CLI with your API key')
    .option('--no-browser', 'Print URL instead of opening browser (for CI/headless)')
    .action(async (options: { browser: boolean }) => {
      // 1. Check if already authenticated
      const status = await getAuthStatus()
      if (status.authenticated) {
        console.log(
          `Already authenticated (${status.keyPrefix}...). ` +
            `Run \`skillsmith logout\` first to switch accounts.`
        )
        process.exit(0)
      }

      // 2. Open browser or print URL
      const headless = isHeadlessEnvironment()
      const shouldOpenBrowser = options.browser && !headless

      if (shouldOpenBrowser) {
        const opened = await tryOpenBrowser(CLI_TOKEN_URL)
        if (opened) {
          console.log(`Opening ${chalk.cyan(CLI_TOKEN_URL)} in your browser...`)
        } else {
          console.log(`Could not open browser. Visit this URL manually:`)
          console.log(chalk.cyan(CLI_TOKEN_URL))
        }
      } else {
        console.log(`Visit this URL to get your API key:`)
        console.log(chalk.cyan(CLI_TOKEN_URL))
      }

      // 3. Prompt for masked API key (up to 3 format-validation failures)
      console.log('\nAfter authenticating, copy the API key shown and paste it below.')

      let attempts = 0
      const MAX_ATTEMPTS = 3

      while (attempts < MAX_ATTEMPTS) {
        const raw = await password({ message: 'Paste your API key:' })

        if (!isValidApiKeyFormat(raw)) {
          attempts++
          if (attempts < MAX_ATTEMPTS) {
            console.error(
              chalk.red(
                `That doesn't look like a valid key (expected: sk_live_...). ` +
                  `Try again (${attempts} of ${MAX_ATTEMPTS}).`
              )
            )
          }
          continue
        }

        // Valid format — store and exit
        await storeApiKey(raw)
        console.log(chalk.green('\nLogged in successfully.'))
        console.log(
          chalk.dim('  Note: your API key may still be in your clipboard. Clear it when done.')
        )
        process.exit(0)
      }

      // Exhausted all attempts
      console.error(chalk.red('\nToo many invalid attempts. Get a new key at:'))
      console.error(chalk.cyan(CLI_TOKEN_URL))
      process.exit(1)
    })
}
