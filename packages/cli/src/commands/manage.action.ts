/**
 * SMI-745: Skill Management Commands — action implementations.
 *
 * SMI-5593: split out of manage.ts (which had grown past the 500-line
 * standard once the real `skillsmith update` implementation replaced the
 * stub) following the <command>.action.ts convention established by
 * SMI-5040/SMI-5127. The update diff/apply logic lives in manage.update.ts
 * (a second sibling split — this file was still over 500 lines with it
 * inline). manage.ts keeps only the commander factory functions.
 */

import { confirm } from '@inquirer/prompts'
import chalk from 'chalk'
import Table from 'cli-table3'
import ora from 'ora'
import { mkdir } from 'fs/promises'
import { dirname } from 'path'
import {
  SkillRepository,
  SkillDependencyRepository,
  SkillInstallationService,
  type TrustTier,
} from '@skillsmith/core'
import { openCliDatabase } from '../utils/open-database.js'
import { DEFAULT_DB_PATH, DEFAULT_SKILLS_DIR, DEFAULT_MANIFEST_PATH } from '../config.js'
import { removeLinks } from '@skillsmith/core/install'
import { getCliLogger } from '../cli-logger.js'
import { sanitizeError } from '../utils/sanitize.js'
import { withTelemetry } from '@skillsmith/core/telemetry'
import { getInstalledSkills, type InstalledSkill } from '../utils/skills-directory.js'
import { getSkillDiff, updateSkill, updateSkills } from './manage.update.js'

const logger = getCliLogger()

/**
 * SMI-1809: Added 'local' tier color for local skills
 * SMI-5205: Added 'official' and 'unverified' tier colors
 */
const TRUST_TIER_COLORS: Record<TrustTier, (text: string) => string> = {
  official: chalk.magenta, // SMI-5205: Platform/partner — magenta to stand out from verified
  verified: chalk.green,
  curated: chalk.blue,
  community: chalk.yellow,
  local: chalk.cyan, // SMI-1809: Cyan for local skills
  experimental: chalk.red,
  unknown: chalk.gray,
  unverified: chalk.gray, // SMI-5205: Public alias for unknown — same color as unknown
}

/**
 * Display skills in a table format
 */
function displaySkillsTable(skills: InstalledSkill[]): void {
  if (skills.length === 0) {
    console.log(chalk.yellow('\nNo skills installed.\n'))
    console.log(chalk.dim('Install skills with: skillsmith install <author/skill-name>\n'))
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
  console.log(
    chalk.dim(
      `\n${skills.length} skill(s) found (global: ~/.claude/skills, local: ./.claude/skills)\n`
    )
  )
}

/**
 * Remove a skill using SkillInstallationService for manifest-aware removal.
 * Falls back to direct removal for orphan skills (on disk but not in manifest).
 */
async function removeSkill(skillName: string, force: boolean, dbPath: string): Promise<boolean> {
  // Show skill info and confirm before proceeding (unless --force)
  if (!force) {
    const installed = await getInstalledSkills()
    const skill = installed.find((s) => s.name.toLowerCase() === skillName.toLowerCase())

    if (!skill) {
      console.log(chalk.red(`Skill "${skillName}" is not installed`))
      return false
    }

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

  const spinner = ora(`Removing ${skillName}...`).start()

  // Ensure database directory exists before opening
  await mkdir(dirname(dbPath), { recursive: true })
  const db = await openCliDatabase(dbPath)

  try {
    const skillRepo = new SkillRepository(db)
    const skillDependencyRepo = new SkillDependencyRepository(db)

    const service = new SkillInstallationService({
      db,
      skillRepo,
      skillDependencyRepo,
      skillsDir: DEFAULT_SKILLS_DIR,
      manifestPath: DEFAULT_MANIFEST_PATH,
      onProgress: (_stage: string, detail: string) => {
        spinner.text = detail
      },
    })

    const result = await service.uninstall(skillName, { force })

    if (result.success) {
      // SMI-4578: tear down any --also-link fan-out destinations recorded
      // for this skill. Best-effort — uninstall must succeed even if the
      // manifest is missing or a destination was already cleaned up.
      try {
        const linkCount = await removeLinks(skillName)
        if (linkCount > 0) {
          spinner.text = `Removed ${linkCount} cross-client link${linkCount > 1 ? 's' : ''}`
        }
      } catch (linkErr) {
        console.log(
          chalk.yellow(
            `  Warning: could not clean up cross-client links: ${sanitizeError(linkErr)}`
          )
        )
      }

      spinner.succeed(`Successfully removed ${skillName}`)
      if (result.warning) {
        console.log(chalk.yellow(`  Warning: ${result.warning}`))
      }
      return true
    } else {
      spinner.fail(result.message)
      if (result.warning) {
        console.log(chalk.yellow(`  ${result.warning}`))
      }
      return false
    }
  } catch (error) {
    spinner.fail(`Failed to remove ${skillName}: ${sanitizeError(error)}`)
    return false
  } finally {
    db.close()
  }
}

/**
 * List action
 */
// SMI-5128: handler impls extracted from inline .action() closures so
// withTelemetry can wrap them at the export boundary (SMI-5040 coverage gate).
async function listActionImpl(opts: Record<string, string | boolean | undefined>): Promise<void> {
  try {
    const dbPath = opts['db'] as string
    const outdated = (opts['outdated'] as boolean) ?? false

    const skills = await getInstalledSkills(dbPath)
    const filtered = outdated ? skills.filter((s) => s.hasUpdates) : skills

    if (outdated && filtered.length === 0) {
      console.log(chalk.green('\nAll installed skills are up to date.\n'))
      return
    }

    displaySkillsTable(filtered)
  } catch (error) {
    logger.error(`${chalk.red('Error listing skills:')} ${sanitizeError(error)}`)
    process.exit(1)
  }
}

export const listAction = withTelemetry(listActionImpl, {
  source: 'cli',
  extractSkillId: () => 'list',
  extractFramework: () => 'cli',
})

/**
 * Update action
 *
 * SMI-5593: user control over one skill, a set of skills, or all skills.
 * Bare `skillsmith update` (no names, no --all) prints usage guidance
 * instead of silently updating everything — a behavior change from the
 * prior implicit "no args = update all" (see docs updated alongside this).
 */
async function updateActionImpl(
  skillNames: string[],
  opts: Record<string, string | boolean | undefined>
): Promise<void> {
  const dbPath = (opts['db'] as string) ?? DEFAULT_DB_PATH
  const updateAll = (opts['all'] as boolean) ?? false
  const dryRun = (opts['dryRun'] as boolean) ?? false

  try {
    if (updateAll) {
      if (skillNames.length > 0) {
        logger.error(chalk.red('Cannot combine --all with specific skill names.'))
        process.exit(1)
        return
      }
      await updateSkills(undefined, dbPath, dryRun)
    } else if (skillNames.length > 0) {
      await updateSkills(skillNames, dbPath, dryRun)
    } else {
      console.log(
        chalk.yellow('Specify one or more skills to update, or pass --all for everything.')
      )
      console.log(chalk.dim('  skillsmith update <skill>'))
      console.log(chalk.dim('  skillsmith update <skill1> <skill2> ...'))
      console.log(chalk.dim('  skillsmith update --all'))
      console.log(chalk.dim('  skillsmith update <skill> --dry-run'))
      process.exit(1)
    }
  } catch (error) {
    logger.error(`${chalk.red('Error updating skills:')} ${sanitizeError(error)}`)
    process.exit(1)
  }
}

export const updateAction = withTelemetry(updateActionImpl, {
  source: 'cli',
  extractSkillId: () => 'update',
  extractFramework: () => 'cli',
})

/**
 * Remove action
 */
async function removeActionImpl(
  skillName: string,
  opts: Record<string, string | boolean | undefined>
): Promise<void> {
  const force = (opts['force'] as boolean) ?? false
  const dbPath = (opts['db'] as string) ?? DEFAULT_DB_PATH

  try {
    const success = await removeSkill(skillName, force, dbPath)
    process.exit(success ? 0 : 1)
  } catch (error) {
    logger.error(`${chalk.red('Error removing skill:')} ${sanitizeError(error)}`)
    process.exit(1)
  }
}

export const removeAction = withTelemetry(removeActionImpl, {
  source: 'cli',
  extractSkillId: () => 'remove',
  extractFramework: () => 'cli',
})

export { getInstalledSkills, displaySkillsTable, getSkillDiff, updateSkill, updateSkills }
