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
    .action(listAction)
}

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
    .action(removeAction)
}
