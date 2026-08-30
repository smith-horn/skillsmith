/**
 * SMI-745: Skill Management Commands
 *
 * Provides CLI commands for listing, updating, and removing installed skills.
 *
 * SMI-5593: action implementations moved to manage.action.ts (500-line
 * standard). This file retains only the commander factory functions and
 * re-exports.
 */

import { Command } from 'commander'
import { DEFAULT_DB_PATH } from '../config.js'
import { listAction, updateAction, removeAction } from './manage.action.js'
import { VALID_CLIENT_HINT } from './install.js'

export {
  getInstalledSkills,
  displaySkillsTable,
  getSkillDiff,
  updateSkill,
  updateSkills,
  listAction,
  updateAction,
  removeAction,
} from './manage.action.js'

/**
 * Create list command
 */
export function createListCommand(): Command {
  return new Command('list')
    .alias('ls')
    .description('List all installed skills')
    .option('-d, --db <path>', 'Database file path', DEFAULT_DB_PATH)
    .option('--outdated', 'Show only skills with available updates (requires Individual tier)')
    .option(
      '--client <id>',
      // SMI-5894 Wave 1 Step 2: `list` already scans every client's
      // directory by default — this flag NARROWS that inventory to one
      // client, it does not fix a detection gap (there wasn't one).
      `show only this client's installed skills, instead of every client (${VALID_CLIENT_HINT})`
    )
    .action(listAction)
}

// ADR-139 (SMI-6274 Wave 4): shared help text for the `--scope` flag on
// `update`/`remove`, parallel to VALID_CLIENT_HINT above.
const SCOPE_HINT =
  'target scope (ADR-139): "workspace" resolves against the nearest ancestor ' +
  'workspace marker or .git root; defaults to SKILLSMITH_SCOPE env, then the ' +
  'per-client config default, then auto-detecting an EXISTING workspace ' +
  'directory, then global'

/**
 * Create update command
 *
 * SMI-5593: user control over one skill, a set of skills, or all skills —
 * `skillsmith update <skill>`, `skillsmith update <skill1> <skill2> ...`,
 * or `skillsmith update --all`.
 */
export function createUpdateCommand(): Command {
  return new Command('update')
    .description('Update installed skills')
    .argument('[skills...]', 'Skill name(s) to update (omit for all, or pass --all explicitly)')
    .option('-d, --db <path>', 'Database file path', DEFAULT_DB_PATH)
    .option('-a, --all', 'Update all installed skills')
    .option('-n, --dry-run', 'Show what would update without installing')
    .option(
      '--client <id>',
      `update the copy installed for a specific agent (defaults to SKILLSMITH_CLIENT env or claude-code; ${VALID_CLIENT_HINT})`
    )
    .option('--scope <global|workspace>', SCOPE_HINT)
    .action(updateAction)
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
    .option('-f, --force', 'Skip confirmation prompt and force removal of modified/orphan skills')
    .option('-d, --db <path>', 'Database file path', DEFAULT_DB_PATH)
    .option(
      '--client <id>',
      `remove the copy installed for a specific agent (defaults to SKILLSMITH_CLIENT env or claude-code; ${VALID_CLIENT_HINT})`
    )
    .option('--scope <global|workspace>', SCOPE_HINT)
    .action(removeAction)
}
