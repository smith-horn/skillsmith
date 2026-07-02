/**
 * @fileoverview `skillsmith agent` command group — install/uninstall the
 *   portable Skillsmith Agent pack across detected harnesses.
 * @module @skillsmith/cli/commands/agent
 * @see SMI-5456 Wave 1 Step 5.
 * @see SMI-5128 sibling-split convention — action impls + withTelemetry
 *   wrappers live in agent.action.ts; this file retains only the commander
 *   factory.
 *
 * Subcommands:
 *   skillsmith agent install [--force]
 *   skillsmith agent uninstall
 */

import { Command } from 'commander'

import { agentInstallAction, agentUninstallAction } from './agent.action.js'

// ---------------------------------------------------------------------------
// Command factory
// ---------------------------------------------------------------------------

/**
 * Build and return the `agent` commander group with its two subcommands.
 *
 * @see SMI-5456
 */
export function createAgentCommand(): Command {
  const agent = new Command('agent').description(
    'Manage the portable Skillsmith Agent pack (SKILL.md, shims, hooks, MCP registration) across detected harnesses'
  )

  agent
    .command('install')
    .description('Detect present harnesses and install the Skillsmith Agent pack into each')
    .option(
      '--force',
      'Overwrite a foreign pre-existing skillsmith MCP/hook config entry instead of leaving it untouched',
      false
    )
    .action(agentInstallAction)

  agent
    .command('uninstall')
    .description(
      'Remove everything a prior `agent install` wrote, restoring any config files it modified'
    )
    .action(agentUninstallAction)

  return agent
}

// Internal exports for tests — sourced from agent.action.ts (SMI-5128 split).
export {
  runInstall,
  runUninstall,
  agentInstallActionImpl,
  agentUninstallActionImpl,
} from './agent.action.js'
