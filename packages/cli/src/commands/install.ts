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
  emitInstallEvent,
  isGitHubUrl,
  type CoreInstallResult,
  type RegistryLookup,
  type RegistrySkillInfo,
} from '@skillsmith/core'
import { addLink, assertClientId, getInstallPath, type ClientId } from '@skillsmith/core/install'
import { DEFAULT_DB_PATH, DEFAULT_MANIFEST_PATH } from '../config.js'
import { sanitizeError } from '../utils/sanitize.js'

const VALID_CLIENT_HINT =
  'Valid IDs: claude-code | cursor | copilot | windsurf | agents (Codex users pass --client agents).'

/**
 * SMI-4578: parse and validate the comma-separated `--also-link` value.
 * Rejects empty entries, duplicates, and any client ID not in the
 * canonical table. The default-client (`--client`) is excluded — fanning
 * out into the same client you just installed for is a no-op.
 */
function parseAlsoLink(raw: string | undefined, defaultClient: ClientId): ClientId[] {
  if (!raw || raw.trim() === '') return []
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  const seen = new Set<ClientId>()
  const out: ClientId[] = []
  for (const id of ids) {
    assertClientId(id)
    if (id === defaultClient) {
      throw new Error(
        `--also-link target '${id}' is the same as --client; pick a different client or drop it from --also-link.`
      )
    }
    if (seen.has(id)) {
      throw new Error(`--also-link target '${id}' is listed more than once`)
    }
    seen.add(id)
    out.push(id)
  }
  return out
}

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
      // Skip the first tip when contentHashMismatch is true — it's the mismatch
      // warning already displayed as chalk.yellow above (added via tips.unshift)
      const startIndex = result.contentHashMismatch ? 1 : 0
      if (startIndex < result.tips.length) {
        console.log()
        for (let i = startIndex; i < result.tips.length; i++) {
          console.log(chalk.dim(`  Tip: ${result.tips[i]}`))
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
    .option('--client <id>', `install for a specific agent (${VALID_CLIENT_HINT})`, 'claude-code')
    .option(
      '--also-link <ids>',
      'comma-separated additional clients to fan-out into (default: copy; pair with --symlink for POSIX symlinks)',
      ''
    )
    .option(
      '--symlink',
      'use relative symlinks instead of file copies for --also-link (POSIX only; falls back to copy on Windows EPERM)',
      false
    )
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
          client?: string
          alsoLink?: string
          symlink?: boolean
        }
      ) => {
        const quiet = opts.quiet ?? false
        const jsonOutput = opts.json ?? false

        try {
          // SMI-4578: validate --client and parse --also-link before any
          // I/O so a bad flag fails fast with a friendly hint.
          const rawClient = opts.client ?? 'claude-code'
          if (rawClient.includes(',')) {
            throw new Error(
              `--client takes a single value (got '${rawClient}'). Pass --also-link <ids> to fan-out into additional clients.`
            )
          }
          assertClientId(rawClient)
          const client: ClientId = rawClient
          const alsoLinkClients = parseAlsoLink(opts.alsoLink, client)
          const skillsDir = getInstallPath(client)

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
              skillsDir,
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

            const installStart = Date.now()
            const result = await service.install(skillId, installOptions)

            // SMI-4182: fire-and-forget install telemetry — skipped when CLI
            // is unauthenticated (no SKILLSMITH_API_KEY), per product decision.
            void emitInstallEvent({
              skillId,
              source: 'cli',
              success: result.success,
              durationMs: Date.now() - installStart,
            })

            // SMI-4578: fan-out to --also-link clients only after the
            // primary install succeeds. Any fan-out failure is reported as
            // a warning but does NOT mark the overall install as failed —
            // the canonical install at `client` is already complete.
            if (result.success && alsoLinkClients.length > 0) {
              for (const target of alsoLinkClients) {
                try {
                  const linked = await addLink({
                    skillId,
                    fromClient: client,
                    toClient: target,
                    preferSymlink: opts.symlink ?? false,
                    force: opts.force ?? false,
                  })
                  if (!quiet && !jsonOutput) {
                    const note = linked.fellBackToCopy ? ' (fell back to copy)' : ''
                    console.log(
                      chalk.dim(`  Linked into ${target} as ${linked.record.kind}${note}`)
                    )
                  }
                } catch (linkErr) {
                  if (!jsonOutput) {
                    console.warn(
                      chalk.yellow(
                        `  Warning: could not link to ${target}: ${sanitizeError(linkErr)}`
                      )
                    )
                  }
                }
              }
            }

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
