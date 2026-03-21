/**
 * SMI-3484: CLI Install Command (Wave 1)
 *
 * Installs a skill from the registry or GitHub URL to ~/.claude/skills/.
 * Consumes SkillInstallationService from @skillsmith/core.
 */

import { Command } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import {
  createDatabaseAsync,
  initializeSchema,
  SkillRepository,
  SkillDependencyRepository,
  SkillInstallationService,
  isGitHubUrl,
  type CoreInstallResult,
  type RegistryLookup,
  type RegistrySkillInfo,
} from '@skillsmith/core'
import { DEFAULT_DB_PATH, DEFAULT_SKILLS_DIR, DEFAULT_MANIFEST_PATH } from '../config.js'
import { sanitizeError } from '../utils/sanitize.js'

/**
 * Validate that a skill ID is in author/name format.
 * Rejects IDs that look like bare names without an author prefix.
 */
function isValidSkillId(skillId: string): boolean {
  if (isGitHubUrl(skillId)) return true
  // Must be author/name format: non-empty segments separated by exactly one slash
  return /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(skillId)
}

/**
 * Create a registry lookup backed by the local SQLite database.
 * Returns null for skills without a repo_url (metadata-only entries).
 */
function createDbRegistryLookup(skillRepo: SkillRepository): RegistryLookup {
  return {
    async lookup(skillId: string): Promise<RegistrySkillInfo | null> {
      const skill = skillRepo.findById(skillId)
      if (!skill) return null
      if (!skill.repoUrl) return null

      return {
        repoUrl: skill.repoUrl,
        name: skill.name,
        trustTier: skill.trustTier,
        // GAP-07: Quarantine status is managed at the quarantine layer, not on
        // the Skill type. CLI installs from local DB do not have quarantine
        // data — default to false. This is a known limitation; quarantine
        // enforcement is authoritative only via the MCP registry API path.
        quarantined: false,
      }
    },
  }
}

/**
 * Format install result for --json output
 */
function formatJsonResult(result: CoreInstallResult): string {
  return JSON.stringify(
    {
      success: result.success,
      skillId: result.skillId,
      installPath: result.installPath,
      error: result.error,
      trustTier: result.trustTier,
      optimization: result.optimization,
      tips: result.tips,
    },
    null,
    2
  )
}

/**
 * Display install result in human-readable format
 */
function displayResult(result: CoreInstallResult, quiet: boolean): void {
  if (result.success) {
    console.log(chalk.green('\nSkill installed successfully!'))
    console.log(chalk.dim(`  Path: ${result.installPath}`))

    if (result.trustTier) {
      console.log(chalk.dim(`  Trust tier: ${result.trustTier}`))
    }

    if (result.optimization?.optimized && !quiet) {
      console.log(chalk.dim(`  Optimized: ${result.optimization.tokenReductionPercent}% reduction`))
      if (result.optimization.subSkills && result.optimization.subSkills.length > 0) {
        console.log(chalk.dim(`  Sub-skills: ${result.optimization.subSkills.join(', ')}`))
      }
      if (result.optimization.subagentGenerated) {
        console.log(chalk.dim(`  Companion subagent generated`))
      }
    }

    if (result.contentHashMismatch) {
      console.log(chalk.yellow('\n  Warning: Content has changed since last indexed.'))
      console.log(chalk.yellow("  Review recent changes at the skill's repository before using."))
    }

    if (result.tips && result.tips.length > 0 && !quiet) {
      // Filter out the content hash mismatch tip (already shown as yellow warning above)
      const displayTips = result.contentHashMismatch
        ? result.tips.filter((t) => !t.includes('changed since Skillsmith last indexed'))
        : result.tips
      if (displayTips.length > 0) {
        console.log()
        for (const tip of displayTips) {
          console.log(chalk.dim(`  Tip: ${tip}`))
        }
      }
    }
  } else {
    console.error(chalk.red(`\nInstallation failed: ${result.error}`))

    if (result.securityReport && !result.securityReport.passed) {
      console.error(chalk.red('  Security scan failed.'))
      for (const finding of result.securityReport.findings) {
        if (finding.severity === 'critical' || finding.severity === 'high') {
          console.error(chalk.red(`  [${finding.severity}] ${finding.message}`))
        }
      }
    }

    if (result.tips && result.tips.length > 0 && !quiet) {
      console.log()
      for (const tip of result.tips) {
        console.log(chalk.dim(`  ${tip}`))
      }
    }
  }
}

/**
 * Create the install command
 */
export function createInstallCommand(): Command {
  return new Command('install')
    .description('Install a skill from the registry or GitHub URL')
    .argument('<skillId>', 'Skill ID (author/name) or GitHub URL')
    .option('-f, --force', 'Force reinstall if already installed')
    .option('--skip-scan', 'Skip security scan (not recommended)')
    .option('--skip-optimize', 'Skip Skillsmith optimization')
    .option('-q, --quiet', 'Suppress advisory output')
    .option('--json', 'Output structured JSON result')
    .option('-d, --db <path>', 'Database file path', DEFAULT_DB_PATH)
    .action(
      async (
        skillId: string,
        opts: {
          force?: boolean
          skipScan?: boolean
          skipOptimize?: boolean
          quiet?: boolean
          json?: boolean
          db?: string
        }
      ) => {
        const quiet = opts.quiet ?? false
        const jsonOutput = opts.json ?? false

        try {
          // Validate skill ID format
          if (!isValidSkillId(skillId)) {
            const errorMsg =
              'Invalid skill ID format. Expected "author/name" or a GitHub URL.\n' +
              '  Examples:\n' +
              '    skillsmith install community/jest-helper\n' +
              '    skillsmith install https://github.com/owner/repo'

            if (jsonOutput) {
              console.log(JSON.stringify({ success: false, skillId, error: errorMsg }, null, 2))
            } else {
              console.error(chalk.red(errorMsg))
            }
            process.exit(1)
            return
          }

          const dbPath = opts.db ?? DEFAULT_DB_PATH
          const db = await createDatabaseAsync(dbPath)
          initializeSchema(db)

          const spinner = jsonOutput ? null : ora('Installing skill...').start()

          try {
            const skillRepo = new SkillRepository(db)
            const skillDependencyRepo = new SkillDependencyRepository(db)

            const service = new SkillInstallationService({
              db,
              skillRepo,
              skillDependencyRepo,
              skillsDir: DEFAULT_SKILLS_DIR,
              manifestPath: DEFAULT_MANIFEST_PATH,
              registryLookup: createDbRegistryLookup(skillRepo),
              onProgress: (_stage: string, detail: string) => {
                if (spinner) {
                  spinner.text = detail
                }
              },
            })

            // Build install options — only set defined properties (exactOptionalPropertyTypes)
            const installOptions: import('@skillsmith/core').InstallOptions = {}
            if (opts.force !== undefined) {
              installOptions.force = opts.force
            }
            if (opts.skipScan !== undefined) {
              installOptions.skipScan = opts.skipScan
            }
            if (opts.skipOptimize !== undefined) {
              installOptions.skipOptimize = opts.skipOptimize
            }

            const result = await service.install(skillId, installOptions)

            if (spinner) {
              if (result.success) {
                spinner.succeed('Skill installed')
              } else {
                spinner.fail('Installation failed')
              }
            }

            if (jsonOutput) {
              console.log(formatJsonResult(result))
            } else {
              displayResult(result, quiet)
            }

            if (!result.success) {
              process.exit(1)
            }
          } finally {
            db.close()
          }
        } catch (error) {
          if (jsonOutput) {
            console.log(
              JSON.stringify({ success: false, skillId, error: sanitizeError(error) }, null, 2)
            )
          } else {
            console.error(chalk.red('Install error:'), sanitizeError(error))
          }
          process.exit(1)
        }
      }
    )
}

export default createInstallCommand
