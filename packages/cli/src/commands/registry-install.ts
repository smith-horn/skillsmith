/**
 * @fileoverview `skillsmith registry install <skillId>` — pull a skill from
 * your team's private registry (Enterprise) and install it locally.
 * @module @skillsmith/cli/commands/registry-install
 * @see SMI-5905 Wave 4
 * @see docs/internal/implementation/private-registry-skill-install.md
 *
 * Commander factory only — action impl + withTelemetry wrap live in
 * `registry-install.action.ts` (SMI-5127/SMI-5128 sibling-split convention,
 * matching `inventory.ts`/`inventory.action.ts`).
 *
 * Explicit v1 scope trim (plan §Architectural decision): no `--also-link`
 * multi-client fan-out beyond `--client`/`SKILLSMITH_CLIENT` targeting, and
 * no `--skip-scan` — `installFromContent()` (Wave 1) always scans at the
 * `community` trust tier, with no opt-out.
 */

import { Command } from 'commander'
import { registryInstallAction } from './registry-install.action.js'
import { VALID_CLIENT_HINT } from './install.js'
import { DEFAULT_DB_PATH } from '../config.js'

/**
 * Build the `registry install` subcommand.
 */
export function createRegistryInstallCommand(): Command {
  return new Command('install')
    .description("Install a skill from your team's private registry (Enterprise)")
    .argument('<skillId>', 'Private registry skill ID (author/name)')
    .option('--version <version>', 'Install a specific published version (default: most recent)')
    .option('-f, --force', 'Force reinstall if already installed')
    .option('-q, --quiet', 'Suppress advisory output')
    .option('--json', 'Output structured JSON result')
    .option('-d, --db <path>', 'Database file path', DEFAULT_DB_PATH)
    .option(
      '--client <id>',
      `install for a specific agent (defaults to SKILLSMITH_CLIENT env or ` +
        `claude-code; ${VALID_CLIENT_HINT})`
    )
    .action(registryInstallAction)
}

/**
 * Build the `registry` command group.
 */
export function createRegistryCommand(): Command {
  return new Command('registry')
    .description("Commands for your team's private skill registry (Enterprise)")
    .addCommand(createRegistryInstallCommand())
}

export default createRegistryCommand
