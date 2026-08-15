/**
 * SMI-824: Install Skillsmith Skill Command
 *
 * Installs the bundled skillsmith skill to the target client's skills
 * directory (defaults to `~/.claude/skills/skillsmith/` for Claude Code;
 * SMI-5893 Wave 7 Step 3 added `--client <id>` to target another agent
 * instead, reusing the `resolveClientId`/`getInstallPath` pattern already
 * established by `install.ts`).
 */

import { Command } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import { mkdir, copyFile, stat, readdir } from 'fs/promises'
import { join, dirname } from 'path'
import {
  CLIENT_DISPLAY_LABELS,
  getInstallPath,
  resolveClientId,
  type ClientId,
} from '@skillsmith/core/install'
import { getCliLogger } from '../cli-logger.js'
import { withTelemetry } from '@skillsmith/core/telemetry'
import { sanitizeError } from '../utils/sanitize.js'
import { packageRoot } from '../utils/package-root.js'
import { VALID_CLIENT_HINT } from './install.js'

const logger = getCliLogger()

/**
 * Get the path to bundled skill assets
 */
function getAssetsPath(): string {
  return join(packageRoot(), 'assets', 'skillsmith-skill')
}

/**
 * Get the target installation path for `client`.
 *
 * SMI-4578 / SMI-5893 (Wave 7 Step 3): routes through
 * `@skillsmith/core/install`'s `getInstallPath(client)` — the same
 * `resolveClientId`/`getInstallPath` pattern `install.ts:299-301` already
 * uses — so a resolved `--client`/`SKILLSMITH_CLIENT` value is honored
 * instead of always hardcoding the canonical Claude Code directory.
 */
function getTargetPath(client: ClientId): string {
  return join(getInstallPath(client), 'skillsmith')
}

/**
 * Check if a directory exists
 */
async function directoryExists(path: string): Promise<boolean> {
  try {
    const stats = await stat(path)
    return stats.isDirectory()
  } catch {
    return false
  }
}

/**
 * Copy all files from source to destination directory
 * Skips symlinks for security (prevents path traversal attacks)
 */
async function copyDirectory(src: string, dest: string): Promise<number> {
  const entries = await readdir(src, { withFileTypes: true })
  let filesCopied = 0

  for (const entry of entries) {
    // Security: Skip symlinks to prevent path traversal attacks
    if (entry.isSymbolicLink()) {
      continue
    }

    const srcPath = join(src, entry.name)
    const destPath = join(dest, entry.name)

    if (entry.isDirectory()) {
      await mkdir(destPath, { recursive: true })
      filesCopied += await copyDirectory(srcPath, destPath)
    } else if (entry.isFile()) {
      await copyFile(srcPath, destPath)
      filesCopied++
    }
  }

  return filesCopied
}

/**
 * Install the skillsmith skill to `client`'s skills directory
 * (`<install-path>/skillsmith/`).
 */
async function installSkillsmithSkill(force: boolean, client: ClientId): Promise<void> {
  const assetsPath = getAssetsPath()
  const targetPath = getTargetPath(client)

  // Check if assets exist
  if (!(await directoryExists(assetsPath))) {
    throw new Error(
      `Skill assets not found at ${assetsPath}. This may indicate a corrupted installation.`
    )
  }

  // Check for existing installation
  const exists = await directoryExists(targetPath)
  if (exists && !force) {
    console.log(chalk.yellow('\nSkillsmith skill is already installed.'))
    console.log(chalk.dim(`Location: ${targetPath}`))
    console.log(chalk.dim('\nUse --force to reinstall.'))
    return
  }

  const spinner = ora('Installing skillsmith skill...').start()

  try {
    // Create parent directories if needed
    await mkdir(dirname(targetPath), { recursive: true })

    // Create target directory
    await mkdir(targetPath, { recursive: true })

    // Copy all assets
    const filesCopied = await copyDirectory(assetsPath, targetPath)

    // Validate that files were actually copied
    if (filesCopied === 0) {
      spinner.warn(chalk.yellow('Warning: No files found in assets directory'))
      console.log(
        chalk.dim('This may indicate a corrupted installation. Try reinstalling the CLI.')
      )
      return
    }

    spinner.succeed(chalk.green('Skillsmith skill installed successfully!'))

    console.log()
    console.log(chalk.bold('Installation Details:'))
    console.log(chalk.dim(`  Location: ${targetPath}`))
    console.log(chalk.dim(`  Files copied: ${filesCopied}`))
    console.log()
    console.log(chalk.bold('Available Commands:'))
    console.log(chalk.cyan('  /skillsmith search <query>') + ' - Search for skills')
    console.log(chalk.cyan('  /skillsmith install <author/name>') + ' - Install a skill')
    console.log(chalk.cyan('  /skillsmith recommend') + ' - Get recommendations')
    console.log(chalk.cyan('  /skillsmith compare <ids>') + ' - Compare skills')
    console.log(chalk.cyan('  /skillsmith list') + ' - List installed skills')
    console.log(chalk.cyan('  /skillsmith uninstall <id>') + ' - Remove a skill')
    console.log()
    console.log(
      chalk.dim(
        `Tip: Start a new ${CLIENT_DISPLAY_LABELS[client]} session to use the /skillsmith command.`
      )
    )
  } catch (error) {
    spinner.fail('Failed to install skillsmith skill')
    throw error
  }
}

// SMI-5040: extracted from inline .action() closure for withTelemetry wrap.
async function setupActionImpl(opts: { force?: boolean; client?: string }): Promise<void> {
  try {
    // SMI-3484: Deprecation warning when invoked via old name
    const invokedName = process.argv[2]
    if (invokedName === 'install-skill') {
      console.log(
        chalk.yellow(
          'Warning: "install-skill" is deprecated and will be removed in a future release. ' +
            'Use "setup" instead.'
        )
      )
    }
    // SMI-5893 (Wave 7 Step 3): same `resolveClientId`/`getInstallPath`
    // pattern install.ts:299-301 already uses — an explicit --client wins,
    // otherwise SKILLSMITH_CLIENT, otherwise the canonical client.
    const client = resolveClientId(opts.client ?? process.env['SKILLSMITH_CLIENT'])
    await installSkillsmithSkill(opts.force ?? false, client)
  } catch (error) {
    logger.error(`${chalk.red('Error:')} ${sanitizeError(error)}`)
    process.exit(1)
  }
}

export const setupAction = withTelemetry(setupActionImpl, {
  source: 'cli',
  extractSkillId: () => 'setup',
  extractFramework: () => 'cli',
})

/**
 * Create the install-skill command
 */
export function createInstallSkillCommand(): Command {
  return new Command('setup')
    .alias('install-skill')
    .description(
      "Set up the skillsmith slash command skill (installs to the target client's skills " +
        'directory, defaults to ~/.claude/skills/skillsmith/ for Claude Code)'
    )
    .option('-f, --force', 'Reinstall even if already installed')
    .option(
      '--client <id>',
      `set up for a specific agent (defaults to SKILLSMITH_CLIENT env or claude-code; ${VALID_CLIENT_HINT})`
    )
    .action(setupAction)
}

export default createInstallSkillCommand
