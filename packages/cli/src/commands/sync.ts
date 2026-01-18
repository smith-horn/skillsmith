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
 */

import { Command } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import Table from 'cli-table3'
import {
  createDatabase,
  SkillRepository,
  createApiClient,
  SyncConfigRepository,
  SyncHistoryRepository,
  SyncEngine,
  type SyncProgress,
  type SyncFrequency,
} from '@skillsmith/core'
import { DEFAULT_DB_PATH } from '../config.js'
import { sanitizeError } from '../utils/sanitize.js'
import { formatDuration, formatDate, formatTimeUntil } from '../utils/formatters.js'

/**
 * Run sync operation
 */
async function runSync(options: {
  dbPath: string
  force: boolean
  dryRun: boolean
  json: boolean
}): Promise<void> {
  const spinner = ora()

  try {
    spinner.start('Opening database...')
    const db = createDatabase(options.dbPath)

    try {
      const skillRepo = new SkillRepository(db)
      const syncConfigRepo = new SyncConfigRepository(db)
      const syncHistoryRepo = new SyncHistoryRepository(db)
      const apiClient = createApiClient()

      const syncEngine = new SyncEngine(apiClient, skillRepo, syncConfigRepo, syncHistoryRepo)

      spinner.text = options.force ? 'Starting full sync...' : 'Starting differential sync...'

      const result = await syncEngine.sync({
        force: options.force,
        dryRun: options.dryRun,
        onProgress: (progress: SyncProgress) => {
          switch (progress.phase) {
            case 'connecting':
              spinner.text = 'Checking API health...'
              break
            case 'fetching':
              spinner.text = `Fetching skills... (${progress.current} fetched)`
              break
            case 'comparing':
              spinner.text = `Comparing ${progress.total} skills with local database...`
              break
            case 'upserting':
              spinner.text = `Syncing skill ${progress.current}/${progress.total}...`
              break
            case 'complete':
              break
          }
        },
      })

      if (options.json) {
        spinner.stop()
        console.log(JSON.stringify(result, null, 2))
        return
      }

      if (result.success) {
        spinner.succeed(
          options.dryRun
            ? chalk.yellow('Dry run complete (no changes made)')
            : chalk.green('Sync completed successfully')
        )
      } else {
        spinner.warn(chalk.yellow('Sync completed with errors'))
      }

      // Display results
      console.log()
      console.log(chalk.bold('Results:'))
      console.log(`  ${chalk.green('+')} Added:     ${result.skillsAdded}`)
      console.log(`  ${chalk.blue('~')} Updated:   ${result.skillsUpdated}`)
      console.log(`  ${chalk.dim('=')} Unchanged: ${result.skillsUnchanged}`)
      console.log(`  ${chalk.cyan('Σ')} Total:     ${result.totalProcessed}`)
      console.log(`  ${chalk.dim('⏱')} Duration:  ${formatDuration(result.durationMs)}`)

      if (result.errors.length > 0) {
        console.log()
        console.log(chalk.red('Errors:'))
        for (const error of result.errors) {
          console.log(`  ${chalk.red('•')} ${error}`)
        }
      }

      if (options.dryRun) {
        console.log()
        console.log(chalk.dim('Run without --dry-run to apply these changes.'))
      }
    } finally {
      db.close()
    }
  } catch (error) {
    spinner.fail('Sync failed')
    console.error(chalk.red('Error:'), sanitizeError(error))
    process.exit(1)
  }
}

/**
 * Show sync status
 */
async function showStatus(options: { dbPath: string; json: boolean }): Promise<void> {
  try {
    const db = createDatabase(options.dbPath)

    try {
      const syncConfigRepo = new SyncConfigRepository(db)
      const syncHistoryRepo = new SyncHistoryRepository(db)

      const config = syncConfigRepo.getConfig()
      const lastRun = syncHistoryRepo.getLastSuccessful()
      const isRunning = syncHistoryRepo.isRunning()
      const isDue = syncConfigRepo.isSyncDue()
      const stats = syncHistoryRepo.getStats()

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              config,
              lastRun,
              isRunning,
              isDue,
              stats,
            },
            null,
            2
          )
        )
        return
      }

      console.log(chalk.bold.blue('\n=== Sync Status ===\n'))

      // Configuration
      console.log(chalk.bold('Configuration:'))
      console.log(
        `  Auto-sync:  ${config.enabled ? chalk.green('Enabled') : chalk.red('Disabled')}`
      )
      console.log(`  Frequency:  ${chalk.cyan(config.frequency)}`)
      console.log()

      // Current state
      console.log(chalk.bold('Current State:'))
      console.log(`  Last sync:  ${formatDate(config.lastSyncAt)}`)
      console.log(`  Next sync:  ${formatDate(config.nextSyncAt)}`)
      console.log(`  Time until: ${formatTimeUntil(config.nextSyncAt)}`)
      console.log(
        `  Status:     ${isRunning ? chalk.yellow('Running') : isDue ? chalk.green('Due') : chalk.dim('Waiting')}`
      )
      console.log()

      // Last run details
      if (lastRun) {
        console.log(chalk.bold('Last Successful Run:'))
        console.log(`  Started:    ${formatDate(lastRun.startedAt)}`)
        console.log(
          `  Duration:   ${lastRun.durationMs ? formatDuration(lastRun.durationMs) : 'N/A'}`
        )
        console.log(`  Added:      ${lastRun.skillsAdded}`)
        console.log(`  Updated:    ${lastRun.skillsUpdated}`)
        console.log(`  Unchanged:  ${lastRun.skillsUnchanged}`)
        console.log()
      }

      // Error info
      if (config.lastSyncError) {
        console.log(chalk.bold.red('Last Error:'))
        console.log(`  ${config.lastSyncError}`)
        console.log()
      }

      // Statistics
      console.log(chalk.bold('Statistics:'))
      console.log(`  Total runs:     ${stats.totalRuns}`)
      console.log(`  Successful:     ${stats.successfulRuns}`)
      console.log(`  Failed:         ${stats.failedRuns}`)
      console.log(
        `  Avg duration:   ${stats.averageDurationMs ? formatDuration(stats.averageDurationMs) : 'N/A'}`
      )
    } finally {
      db.close()
    }
  } catch (error) {
    console.error(chalk.red('Error:'), sanitizeError(error))
    process.exit(1)
  }
}

/**
 * Show sync history
 */
async function showHistory(options: {
  dbPath: string
  limit: number
  json: boolean
}): Promise<void> {
  try {
    const db = createDatabase(options.dbPath)

    try {
      const syncHistoryRepo = new SyncHistoryRepository(db)
      const history = syncHistoryRepo.getHistory(options.limit)

      if (options.json) {
        console.log(JSON.stringify(history, null, 2))
        return
      }

      if (history.length === 0) {
        console.log(chalk.dim('\nNo sync history found. Run `skillsmith sync` to start syncing.\n'))
        return
      }

      console.log(chalk.bold.blue('\n=== Sync History ===\n'))

      const table = new Table({
        head: [
          chalk.bold('Date'),
          chalk.bold('Status'),
          chalk.bold('Added'),
          chalk.bold('Updated'),
          chalk.bold('Duration'),
        ],
        colWidths: [22, 12, 10, 10, 12],
      })

      for (const entry of history) {
        const statusColor =
          entry.status === 'success'
            ? chalk.green
            : entry.status === 'failed'
              ? chalk.red
              : entry.status === 'partial'
                ? chalk.yellow
                : chalk.blue

        table.push([
          new Date(entry.startedAt).toLocaleString(),
          statusColor(entry.status),
          String(entry.skillsAdded),
          String(entry.skillsUpdated),
          entry.durationMs ? formatDuration(entry.durationMs) : '-',
        ])
      }

      console.log(table.toString())

      if (history.some((e) => e.errorMessage)) {
        console.log()
        console.log(chalk.bold.red('Errors:'))
        for (const entry of history.filter((e) => e.errorMessage)) {
          console.log(
            `  ${chalk.dim(new Date(entry.startedAt).toLocaleDateString())}: ${entry.errorMessage}`
          )
        }
      }
    } finally {
      db.close()
    }
  } catch (error) {
    console.error(chalk.red('Error:'), sanitizeError(error))
    process.exit(1)
  }
}

/**
 * Configure sync settings
 */
async function configureSync(options: {
  dbPath: string
  enable: boolean | undefined
  disable: boolean | undefined
  frequency: string | undefined
  show: boolean | undefined
  json: boolean
}): Promise<void> {
  try {
    const db = createDatabase(options.dbPath)

    try {
      const syncConfigRepo = new SyncConfigRepository(db)

      // If just showing config
      if (options.show || (!options.enable && !options.disable && !options.frequency)) {
        const config = syncConfigRepo.getConfig()

        if (options.json) {
          console.log(JSON.stringify(config, null, 2))
          return
        }

        console.log(chalk.bold.blue('\n=== Sync Configuration ===\n'))
        console.log(
          `  Auto-sync:  ${config.enabled ? chalk.green('Enabled') : chalk.red('Disabled')}`
        )
        console.log(`  Frequency:  ${chalk.cyan(config.frequency)}`)
        console.log(`  Interval:   ${formatDuration(config.intervalMs)}`)
        console.log(`  Last sync:  ${formatDate(config.lastSyncAt)}`)
        console.log(`  Next sync:  ${formatDate(config.nextSyncAt)}`)
        console.log()
        console.log(chalk.dim('Use --enable/--disable to toggle auto-sync'))
        console.log(chalk.dim('Use --frequency daily|weekly to change schedule'))
        return
      }

      // Apply changes
      if (options.enable) {
        syncConfigRepo.enable()
        console.log(chalk.green('✓ Auto-sync enabled'))
      }

      if (options.disable) {
        syncConfigRepo.disable()
        console.log(chalk.yellow('✓ Auto-sync disabled'))
      }

      if (options.frequency) {
        const freq = options.frequency.toLowerCase()
        if (freq !== 'daily' && freq !== 'weekly') {
          console.error(chalk.red('Error: Frequency must be "daily" or "weekly"'))
          process.exit(1)
        }
        syncConfigRepo.setFrequency(freq as SyncFrequency)
        console.log(chalk.green(`✓ Frequency set to ${freq}`))
      }

      // Show updated config
      const config = syncConfigRepo.getConfig()
      console.log()
      console.log(chalk.dim('Current settings:'))
      console.log(
        `  Auto-sync: ${config.enabled ? 'enabled' : 'disabled'}, Frequency: ${config.frequency}`
      )
    } finally {
      db.close()
    }
  } catch (error) {
    console.error(chalk.red('Error:'), sanitizeError(error))
    process.exit(1)
  }
}

/**
 * Create sync status subcommand
 */
function createStatusCommand(): Command {
  return new Command('status')
    .description('Show sync status and statistics')
    .option('-d, --db <path>', 'Database file path', DEFAULT_DB_PATH)
    .option('--json', 'Output as JSON')
    .action(async (opts: Record<string, string | boolean | undefined>) => {
      await showStatus({
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
      await showHistory({
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
      await configureSync({
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
      await runSync({
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
