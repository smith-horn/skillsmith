/**
 * SMI-3484: CLI Install Command (Wave 1)
 *
 * Installs a skill from the registry or GitHub URL to ~/.claude/skills/.
 * Consumes SkillInstallationService from @skillsmith/core.
 *
 * SMI-5127+ sibling-split convention (ADR-139 / SMI-6274 Wave 4 pushed this
 * file past the 500-line standard): action impls + withTelemetry-wrapped
 * exports live in `install.action.ts`; this file keeps only the commander
 * factory and re-exports for existing call sites.
 */

import { Command } from 'commander'
import { DEFAULT_DB_PATH } from '../config.js'
import { installAction, VALID_CLIENT_HINT } from './install.action.js'

export {
  VALID_CLIENT_HINT,
  createDbRegistryLookup,
  createApiBackedRegistryLookup,
  formatJsonResult,
  displayResult,
  installAction,
} from './install.action.js'

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
    .option(
      '--client <id>',
      `install for a specific agent (defaults to SKILLSMITH_CLIENT env or claude-code; ${VALID_CLIENT_HINT})`
    )
    .option(
      '--scope <global|workspace>',
      'install scope (ADR-139): "workspace" resolves against the nearest ancestor ' +
        "workspace marker or .git root, creating the client's workspace skills " +
        'directory if none exists yet; defaults to SKILLSMITH_SCOPE env, then the ' +
        'per-client ~/.skillsmith/config.json default, then auto-detecting an ' +
        'EXISTING workspace directory, then global'
    )
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
    .action(installAction)
}

export default createInstallCommand
