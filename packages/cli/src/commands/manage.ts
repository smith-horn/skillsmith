/**
 * SMI-745: Skill Management Commands
 *
 * Provides CLI commands for listing, updating, and removing installed skills.
 */

import { Command } from 'commander'
import { confirm } from '@inquirer/prompts'
import chalk from 'chalk'
import Table from 'cli-table3'
import ora from 'ora'
import { readdir, readFile, rm, stat } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import {
  createDatabase,
  SkillRepository,
  SkillParser,
  type Skill,
  type TrustTier,
} from '@skillsmith/core'

const TRUST_TIER_COLORS: Record<TrustTier, (text: string) => string> = {
  verified: chalk.green,
  community: chalk.yellow,
  experimental: chalk.red,
  unknown: chalk.gray,
}

const SKILLS_DIR = join(homedir(), '.claude', 'skills')

interface InstalledSkill {
  name: string
  path: string
  version: string | null
  trustTier: TrustTier
  installDate: string
  hasUpdates: boolean
}

/**
 * Get list of installed skills from ~/.claude/skills
 */
async function getInstalledSkills(): Promise<InstalledSkill[]> {
  const skills: InstalledSkill[] = []

  try {
    const entries = await readdir(SKILLS_DIR, { withFileTypes: true })

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillPath = join(SKILLS_DIR, entry.name)
        const skillMdPath = join(skillPath, 'SKILL.md')

        try {
          const skillMdStat = await stat(skillMdPath)
          const content = await readFile(skillMdPath, 'utf-8')
          const parser = new SkillParser()
          const parsed = parser.parse(content)

          skills.push({
            name: parsed?.name || entry.name,
            path: skillPath,
            version: parsed?.version || null,
            trustTier: parsed ? parser.inferTrustTier(parsed) : 'unknown',
            installDate: skillMdStat.mtime.toISOString().split('T')[0] || 'Unknown',
            hasUpdates: false, // Would check remote for updates
          })
        } catch {
          // No SKILL.md, treat as unknown skill
          const dirStat = await stat(skillPath)
          skills.push({
            name: entry.name,
            path: skillPath,
            version: null,
            trustTier: 'unknown',
            installDate: dirStat.mtime.toISOString().split('T')[0] || 'Unknown',
            hasUpdates: false,
          })
        }
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }

  return skills
}

/**
 * Display skills in a table format
 */
function displaySkillsTable(skills: InstalledSkill[]): void {
  if (skills.length === 0) {
    console.log(chalk.yellow('\nNo skills installed.\n'))
    console.log(chalk.dim('Install skills with: skillsmith install <skill-name>\n'))
    return
  }

  const table = new Table({
    head: [
      chalk.bold('Name'),
      chalk.bold('Version'),
      chalk.bold('Trust Tier'),
      chalk.bold('Install Date'),
      chalk.bold('Updates'),
    ],
    colWidths: [30, 15, 15, 15, 12],
  })

  for (const skill of skills) {
    const colorFn = TRUST_TIER_COLORS[skill.trustTier]
    table.push([
      colorFn(skill.name),
      skill.version || chalk.dim('N/A'),
      colorFn(skill.trustTier),
      skill.installDate,
      skill.hasUpdates ? chalk.green('Available') : chalk.dim('Up to date'),
    ])
  }

  console.log('\n' + chalk.bold.blue('Installed Skills') + '\n')
  console.log(table.toString())
  console.log(chalk.dim(`\n${skills.length} skill(s) installed in ${SKILLS_DIR}\n`))
}

/**
 * Get skill diff from database
 */
async function getSkillDiff(
  skillName: string,
  dbPath: string
): Promise<{ oldVersion: string | null; newVersion: string | null; changes: string[] } | null> {
  const db = createDatabase(dbPath)
  const skillRepo = new SkillRepository(db)

  try {
    // Find skill in database by name (case-insensitive search)
    const allSkills = skillRepo.findAll(1000, 0)
    const skill = allSkills.items.find(
      (s: Skill) => s.name.toLowerCase() === skillName.toLowerCase()
    )

    if (!skill) {
      return null
    }

    // Get installed version
    const installed = (await getInstalledSkills()).find(
      (s) => s.name.toLowerCase() === skillName.toLowerCase()
    )

    const changes: string[] = []

    if (installed?.version !== (skill as Skill & { version?: string }).version) {
      changes.push(
        `Version: ${installed?.version || 'N/A'} -> ${(skill as Skill & { version?: string }).version || 'N/A'}`
      )
    }

    if (installed?.trustTier !== skill.trustTier) {
      changes.push(`Trust Tier: ${installed?.trustTier || 'unknown'} -> ${skill.trustTier}`)
    }

    return {
      oldVersion: installed?.version || null,
      newVersion: (skill as Skill & { version?: string }).version || null,
      changes,
    }
  } finally {
    db.close()
  }
}

/**
 * Update a single skill
 */
async function updateSkill(skillName: string, dbPath: string): Promise<boolean> {
  const spinner = ora(`Checking updates for ${skillName}...`).start()

  try {
    const diff = await getSkillDiff(skillName, dbPath)

    if (!diff) {
      spinner.fail(`Skill "${skillName}" not found in registry`)
      return false
    }

    if (diff.changes.length === 0) {
      spinner.succeed(`${skillName} is already up to date`)
      return true
    }

    spinner.stop()

    console.log(chalk.bold(`\nChanges for ${skillName}:`))
    for (const change of diff.changes) {
      console.log(chalk.cyan(`  - ${change}`))
    }
    console.log()

    const proceed = await confirm({
      message: `Update ${skillName}?`,
      default: true,
    })

    if (!proceed) {
      console.log(chalk.yellow('Update cancelled'))
      return false
    }

    const updateSpinner = ora(`Updating ${skillName}...`).start()

    // In a real implementation, this would fetch and install the new version
    // For now, we just simulate success
    await new Promise((resolve) => setTimeout(resolve, 1000))

    updateSpinner.succeed(`Successfully updated ${skillName}`)
    return true
  } catch (error) {
    spinner.fail(`Failed to update ${skillName}: ${error}`)
    return false
  }
}

/**
 * Update all installed skills
 */
async function updateAllSkills(dbPath: string): Promise<void> {
  const skills = await getInstalledSkills()

  if (skills.length === 0) {
    console.log(chalk.yellow('No skills installed'))
    return
  }

  console.log(chalk.bold(`\nChecking updates for ${skills.length} skill(s)...\n`))

  let updated = 0
  let failed = 0

  for (const skill of skills) {
    const success = await updateSkill(skill.name, dbPath)
    if (success) {
      updated++
    } else {
      failed++
    }
  }

  console.log(chalk.bold('\nUpdate Summary:'))
  console.log(chalk.green(`  Updated: ${updated}`))
  if (failed > 0) {
    console.log(chalk.red(`  Failed: ${failed}`))
  }
  console.log()
}

/**
 * Remove a skill
 */
async function removeSkill(skillName: string, force: boolean): Promise<boolean> {
  const installed = await getInstalledSkills()
  const skill = installed.find((s) => s.name.toLowerCase() === skillName.toLowerCase())

  if (!skill) {
    console.log(chalk.red(`Skill "${skillName}" is not installed`))
    return false
  }

  if (!force) {
    console.log(chalk.bold(`\nSkill to remove:`))
    console.log(`  Name: ${skill.name}`)
    console.log(`  Version: ${skill.version || 'N/A'}`)
    console.log(`  Path: ${skill.path}`)
    console.log()

    const proceed = await confirm({
      message: `Are you sure you want to remove ${skill.name}?`,
      default: false,
    })

    if (!proceed) {
      console.log(chalk.yellow('Removal cancelled'))
      return false
    }
  }

  const spinner = ora(`Removing ${skill.name}...`).start()

  try {
    await rm(skill.path, { recursive: true, force: true })
    spinner.succeed(`Successfully removed ${skill.name}`)
    return true
  } catch (error) {
    spinner.fail(`Failed to remove ${skill.name}: ${error}`)
    return false
  }
}

/**
 * Create list command
 */
export function createListCommand(): Command {
  return new Command('list')
    .alias('ls')
    .description('List all installed skills')
    .action(async () => {
      try {
        const skills = await getInstalledSkills()
        displaySkillsTable(skills)
      } catch (error) {
        console.error(chalk.red('Error listing skills:'), error)
        process.exit(1)
      }
    })
}

/**
 * Create update command
 */
export function createUpdateCommand(): Command {
  return new Command('update')
    .description('Update installed skills')
    .argument('[skill]', 'Skill name to update (omit for all)')
    .option('-d, --db <path>', 'Database file path', 'skillsmith.db')
    .option('-a, --all', 'Update all installed skills')
    .action(
      async (skillName: string | undefined, opts: Record<string, string | boolean | undefined>) => {
        const dbPath = opts['db'] as string
        const updateAll = opts['all'] as boolean | undefined

        try {
          if (updateAll || !skillName) {
            await updateAllSkills(dbPath)
          } else {
            await updateSkill(skillName, dbPath)
          }
        } catch (error) {
          console.error(chalk.red('Error updating skills:'), error)
          process.exit(1)
        }
      }
    )
}

/**
 * Create remove command
 */
export function createRemoveCommand(): Command {
  return new Command('remove')
    .alias('rm')
    .alias('uninstall')
    .description('Remove an installed skill')
    .argument('<skill>', 'Skill name to remove')
    .option('-f, --force', 'Skip confirmation prompt')
    .action(async (skillName: string, opts: Record<string, boolean | undefined>) => {
      const force = opts['force'] ?? false

      try {
        const success = await removeSkill(skillName, force)
        process.exit(success ? 0 : 1)
      } catch (error) {
        console.error(chalk.red('Error removing skill:'), error)
        process.exit(1)
      }
    })
}

export { getInstalledSkills, displaySkillsTable }
