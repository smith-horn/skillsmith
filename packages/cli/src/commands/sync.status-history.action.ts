/**
 * SMI-registry-sync-tier-gate: `sync status` / `sync history` action
 * implementations + telemetry wrappers.
 *
 * Further sibling-split from `sync.action.ts`, which grew past the
 * <500-line CI standard once the registry-sync tier gate + pre-sync
 * confirmation prompt were added to `syncActionImpl`. These two read-only,
 * ungated subcommands (`status`, `history`) have no tier dependency, so they
 * split cleanly into their own file — `sync.action.ts` keeps `syncAction`
 * (the main, Team-tier-gated sync) and `syncConfigAction` (partially gated
 * on `--enable`). Follows the same `<command>.action.ts` sibling convention
 * established by SMI-5040/SMI-5127.
 */

import chalk from 'chalk'
import Table from 'cli-table3'
import { SyncConfigRepository, SyncHistoryRepository } from '@skillsmith/core'
import { getCliLogger } from '../cli-logger.js'
import { withTelemetry } from '@skillsmith/core/telemetry'
import { openCliDatabase } from '../utils/open-database.js'
import { sanitizeError } from '../utils/sanitize.js'
import { formatDuration, formatDate, formatTimeUntil } from '../utils/formatters.js'
import { scanLocalSkillsForWarnings, formatAdapterWarnings } from './sync.helpers.js'

const logger = getCliLogger()

// ---------------------------------------------------------------------------
// Impl functions
// ---------------------------------------------------------------------------

/**
 * Show sync status
 *
 * SMI-5894 (Wave 1 Step 4): `client` (optional) scopes the local-skills
 * adapter-warnings scan to a specific agent's directory, resolved by
 * `scanLocalSkillsForWarnings()` the same way install/list/remove/update
 * resolve their target directory (explicit --client, else
 * SKILLSMITH_CLIENT, else the canonical client).
 */
async function syncStatusActionImpl(options: {
  dbPath: string
  json: boolean
  client?: string | undefined
}): Promise<void> {
  try {
    const db = await openCliDatabase(options.dbPath)

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

      // Local-skills adapter warnings (SMI-4287, GitHub #600).
      // Surface symlink-escape / permission / loop errors so the user can
      // act on them (e.g. `chmod +r`, remove rogue symlink).
      const adapterWarnings = await scanLocalSkillsForWarnings(options.client)
      if (adapterWarnings.length > 0) {
        console.log()
        console.log(chalk.bold.yellow('Local skill warnings:'))
        for (const line of formatAdapterWarnings(adapterWarnings)) {
          logger.error(line)
        }
      }
    } finally {
      db.close()
    }
  } catch (error) {
    logger.error(`${chalk.red('Error:')} ${sanitizeError(error)}`)
    process.exit(1)
  }
}

/**
 * Show sync history
 */
async function syncHistoryActionImpl(options: {
  dbPath: string
  limit: number
  json: boolean
}): Promise<void> {
  try {
    const db = await openCliDatabase(options.dbPath)

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
    logger.error(`${chalk.red('Error:')} ${sanitizeError(error)}`)
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// Telemetry-wrapped exports (SMI-5127)
// ---------------------------------------------------------------------------

export const syncStatusAction = withTelemetry(syncStatusActionImpl, {
  source: 'cli',
  extractSkillId: () => 'sync status',
  extractFramework: () => 'cli',
})

export const syncHistoryAction = withTelemetry(syncHistoryActionImpl, {
  source: 'cli',
  extractSkillId: () => 'sync history',
  extractFramework: () => 'cli',
})
