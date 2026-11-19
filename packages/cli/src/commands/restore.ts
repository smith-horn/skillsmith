/**
 * @fileoverview The `skillsmith restore <id>` command factory (SMI-6531 6d-ii).
 * @module @skillsmith/cli/commands/restore
 */
import { Command, InvalidArgumentError } from 'commander'
import { restoreAction, type RestoreActionOptions } from './restore.action.js'

const once =
  (flag: string) =>
  (value: string, previous: string | undefined): string => {
    if (previous !== undefined)
      throw new InvalidArgumentError(`${flag} was given twice; give it once.`)
    return value
  }

const collect = (value: string, previous: string[]): string[] => [...previous, value]

export function createRestoreCommand(): Command {
  return new Command('restore')
    .description(
      'Put a set-aside copy back where it came from (shows the plan, then asks). Find copies with `skillsmith doctor backups`.'
    )
    .argument('<id>', 'An op id, <opId>/<name>, or the full path of the set-aside copy')
    .option('--root <dir>', 'Also scan this skills root (repeatable)', collect, [] as string[])
    .option(
      '--state-root <dir>',
      'State root to read instead of the discovered ones',
      once('--state-root')
    )
    .option('--json', 'Print the plan and its result as JSON')
    .option('--yes', 'Proceed without the prompt (waives no check)')
    .action((id: string, opts: RestoreActionOptions) => restoreAction(id, opts))
}
