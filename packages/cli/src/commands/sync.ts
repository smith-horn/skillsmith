/**
 * Sync Command - Registry synchronization CLI
 *
 * Provides commands for syncing the local skill database with the
 * live Skillsmith registry.
 *
 * Usage:
 *   skillsmith sync              # Run sync (differential)
 *   skillsmith sync --force      # Run full sync
 *   skillsmith sync --dry-run    # Preview what would sync
 *   skillsmith sync status       # Show sync status
 *   skillsmith sync history      # Show sync history
 *   skillsmith sync config       # Configure auto-sync
 *
 * SMI-5127: Action implementations moved to sync.action.ts.
 * This file retains only the commander factory functions.
 */

import { Command } from 'commander'
import { DEFAULT_DB_PATH } from '../config.js'
import { syncAction, syncStatusAction, syncHistoryAction, syncConfigAction } from './sync.action.js'

/**
 * Create sync status subcommand
 */
function createStatusCommand(): Command {
  return new Command('status')
    .description('Show sync status and statistics')
    .option('-d, --db <path>', 'Database file path', DEFAULT_DB_PATH)
    .option('--json', 'Output as JSON')
    .action(async (opts: Record<string, string | boolean | undefined>) => {
      await syncStatusAction({
        dbPath: opts['db'] as string,
        json: (opts['json'] as boolean) ?? false,
      })
    })
}

/**
 * Create sync history subcommand
 */
function createHistoryCommand(): Command {
  return new Command('history')
    .description('Show sync history')
    .option('-d, --db <path>', 'Database file path', DEFAULT_DB_PATH)
    .option('-l, --limit <number>', 'Number of entries to show', '10')
    .option('--json', 'Output as JSON')
    .action(async (opts: Record<string, string | boolean | undefined>) => {
      await syncHistoryAction({
        dbPath: opts['db'] as string,
        limit: parseInt(opts['limit'] as string, 10),
        json: (opts['json'] as boolean) ?? false,
      })
    })
}

/**
 * Create sync config subcommand
 */
function createConfigCommand(): Command {
  return new Command('config')
    .description('Configure automatic sync settings')
    .option('-d, --db <path>', 'Database file path', DEFAULT_DB_PATH)
    .option('--enable', 'Enable automatic background sync')
    .option('--disable', 'Disable automatic background sync')
    .option('--frequency <freq>', 'Set sync frequency (daily|weekly)')
    .option('--show', 'Show current configuration')
    .option('--json', 'Output as JSON')
    .action(async (opts: Record<string, string | boolean | undefined>) => {
      await syncConfigAction({
        dbPath: opts['db'] as string,
        enable: opts['enable'] as boolean | undefined,
        disable: opts['disable'] as boolean | undefined,
        frequency: opts['frequency'] as string | undefined,
        show: opts['show'] as boolean | undefined,
        json: (opts['json'] as boolean) ?? false,
      })
    })
}

/**
 * Create sync command with subcommands
 */
export function createSyncCommand(): Command {
  const cmd = new Command('sync')
    .description('Synchronize skills from the Skillsmith registry')
    .option('-d, --db <path>', 'Database file path', DEFAULT_DB_PATH)
    .option('-f, --force', 'Force full sync (ignore last sync time)')
    .option('--dry-run', 'Show what would be synced without making changes')
    .option('--json', 'Output results as JSON')
    .action(async (opts: Record<string, string | boolean | undefined>) => {
      await syncAction({
        dbPath: opts['db'] as string,
        force: (opts['force'] as boolean) ?? false,
        dryRun: (opts['dry-run'] as boolean) ?? false,
        json: (opts['json'] as boolean) ?? false,
      })
    })

  // Add subcommands
  cmd.addCommand(createStatusCommand())
  cmd.addCommand(createHistoryCommand())
  cmd.addCommand(createConfigCommand())

  return cmd
}

export default createSyncCommand
