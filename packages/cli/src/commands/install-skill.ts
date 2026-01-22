/**
 * SMI-824: Install Skillsmith Skill Command
 *
 * Installs the bundled skillsmith skill to ~/.claude/skills/skillsmith/
 * for enabling /skillsmith slash command in Claude Code sessions.
 */

import { Command } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import { mkdir, copyFile, stat, readdir } from 'fs/promises'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { fileURLToPath } from 'url'
import { sanitizeError } from '../utils/sanitize.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Get the path to bundled skill assets
 */
function getAssetsPath(): string {
  // Assets are in packages/cli/assets/skillsmith-skill/ relative to dist/src/commands/
  return join(__dirname, '..', '..', '..', 'assets', 'skillsmith-skill')
}

/**
 * Get the target installation path
 */
function getTargetPath(): string {
  return join(homedir(), '.claude', 'skills', 'skillsmith')
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
 * Install the skillsmith skill to ~/.claude/skills/skillsmith/
 */
async function installSkillsmithSkill(force: boolean): Promise<void> {
  const assetsPath = getAssetsPath()
  const targetPath = getTargetPath()

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
    console.log(chalk.cyan('  /skillsmith install <id>') + ' - Install a skill')
    console.log(chalk.cyan('  /skillsmith recommend') + ' - Get recommendations')
    console.log(chalk.cyan('  /skillsmith compare <ids>') + ' - Compare skills')
    console.log(chalk.cyan('  /skillsmith list') + ' - List installed skills')
    console.log(chalk.cyan('  /skillsmith uninstall <id>') + ' - Remove a skill')
    console.log()
    console.log(chalk.dim('Tip: Start a new Claude Code session to use the /skillsmith command.'))
  } catch (error) {
    spinner.fail('Failed to install skillsmith skill')
    throw error
  }
}

/**
 * Create the install-skill command
 */
export function createInstallSkillCommand(): Command {
  return new Command('install-skill')
    .description('Install the skillsmith skill for /skillsmith slash command support')
    .option('-f, --force', 'Reinstall even if already installed')
    .action(async (opts: { force?: boolean }) => {
      try {
        await installSkillsmithSkill(opts.force ?? false)
      } catch (error) {
        console.error(chalk.red('Error:'), sanitizeError(error))
        process.exit(1)
      }
    })
}

export default createInstallSkillCommand
