/**
 * SMI-5127: Sync command action implementations + telemetry wrappers.
 *
 * Sibling-split from sync.ts following the <command>.action.ts convention
 * established by SMI-5040, wrapped with withTelemetry so the
 * CLI_DISPATCHER_MAP coverage test can assert 100% telemetry coverage
 * without importing the full commander tree.
 *
 * Holds `syncAction` (the main sync — Team-tier gated, SMI-registry-sync-
 * tier-gate) and `syncConfigAction` (partially gated: `--enable` requires
 * Team tier, `--disable`/`--show`/`--frequency` do not). The read-only,
 * ungated `status`/`history` subcommands were split out to the
 * `sync.status-history.action.ts` sibling once this file grew past the
 * 500-line CI standard with the tier gate + confirmation prompt added.
 *
 * Opts-adaptation choice: each *ActionImpl accepts the same typed options
 * struct that the sync.ts factory closures were building — the factory
 * closures remain in sync.ts, do the same Record<string,…> → typed cast they
 * always did, then call the wrapped action. This keeps sync.ts factories
 * identical to before (no signature churn) and keeps sync.action.ts free of
 * commander imports.
 */

import { confirm } from '@inquirer/prompts'
import chalk from 'chalk'
import ora from 'ora'
import {
  SyncConfigRepository,
  resolveSessionTier,
  SessionTierAuthError,
  SessionTierTransientError,
  type SyncProgress,
  type SyncFrequency,
} from '@skillsmith/core'
import { getCliLogger } from '../cli-logger.js'
import { withTelemetry } from '@skillsmith/core/telemetry'
import { openCliDatabase } from '../utils/open-database.js'
import { runRegistrySync, getSyncApiClient } from './run-registry-sync.js'
import { requireTier } from '../utils/require-tier.js'
import { sanitizeError } from '../utils/sanitize.js'
import { formatDuration, formatDate } from '../utils/formatters.js'

const logger = getCliLogger()
import {
  isAuthFailure,
  formatAuthGuidance,
  isTierRejection,
  formatTierUpgradeGuidance,
} from './sync.helpers.js'

const TIER_UPGRADE_MESSAGE =
  'This feature requires team tier or higher ($25/user/month). ' +
  'Upgrade at https://skillsmith.app/upgrade?tier=team'

/**
 * SMI-6236 F-2: `requireTier('team')` resolves tier from `SKILLSMITH_LICENSE_KEY`
 * only — completely disconnected from the credential `runRegistrySync()`
 * actually authenticates with (a stored JWT session via `getSyncApiClient()`,
 * or `SKILLSMITH_API_KEY`). A user authenticated only via `skillsmith login`
 * (the documented flow) has no `SKILLSMITH_LICENSE_KEY` set, so the naive
 * `requireTier('team')` gate incorrectly blocked them as "community" before
 * the request ever reached the server, which would have correctly admitted
 * them as Team. Verified live during this PR's review: a JWT-authenticated
 * Team caller failed client-side while the real `registry-sync` endpoint
 * returned 200 for the identical credential.
 *
 * Resolves tier via whichever credential the real request will use:
 *  - A stored JWT session → `resolveSessionTier()` (live, authoritative). A
 *    definitive sub-Team tier (or `authenticated:false`) throws the same
 *    upgrade message `requireTier()` would have. A *transient* failure
 *    (network/5xx/malformed response) must NOT block — `registry-sync`'s own
 *    gate is the backstop; blocking here would incorrectly downgrade a real
 *    paying customer just because the tier check itself glitched.
 *  - No JWT session, but `SKILLSMITH_API_KEY` is set → cannot be resolved
 *    offline. Skip the pre-check; the server's authoritative 403 is caught
 *    and presented as the same friendly message via `isTierRejection()`.
 *  - Neither → `requireTier('team')` (the `SKILLSMITH_LICENSE_KEY`-only
 *    offline check) is correct here: no real credential exists for the
 *    request to authenticate with regardless, so this genuinely is a
 *    community/anonymous caller — no network round-trip needed.
 */
async function requireSyncTier(): Promise<void> {
  try {
    const result = await resolveSessionTier()
    if (result.authenticated && (result.tier === 'team' || result.tier === 'enterprise')) {
      return
    }
    throw new Error(TIER_UPGRADE_MESSAGE)
  } catch (error) {
    if (error instanceof SessionTierAuthError) {
      // No stored JWT session — fall through to the other credential paths.
    } else if (error instanceof SessionTierTransientError) {
      return // Ambiguous — don't block; registry-sync's own gate decides.
    } else {
      throw error // Our own thrown upgrade-message Error.
    }
  }

  if (process.env['SKILLSMITH_API_KEY']) {
    return // Cannot resolve offline; rely on the server's 403.
  }

  await requireTier('team')
}

// ---------------------------------------------------------------------------
// Impl functions
// ---------------------------------------------------------------------------

/**
 * Fetch an approximate registry record count for the pre-sync confirmation
 * prompt. Reuses `getSyncApiClient()` — the same credential-resolution path
 * `runRegistrySync()` itself uses — so the count reflects the same auth
 * context the sync will actually run under.
 *
 * Returns `null` on any failure (network error, auth error, etc.): the count
 * is informational only and must never block the sync from proceeding just
 * because the count fetch itself failed.
 */
async function fetchApproximateRecordCount(): Promise<number | null> {
  try {
    const apiClient = await getSyncApiClient()
    const { data } = await apiClient.getStats()
    return data.skillCount
  } catch {
    return null
  }
}

/**
 * Run sync operation
 */
async function syncActionImpl(options: {
  dbPath: string
  force: boolean
  dryRun: boolean
  yes: boolean
  json: boolean
}): Promise<void> {
  const spinner = ora()

  try {
    // SMI-registry-sync-tier-gate: registry sync is a Team-tier feature —
    // gate before any database/network work where possible. Throws a
    // friendly upgrade message on a confirmed insufficient tier; the outer
    // catch below handles it the same as any other sync failure. See
    // requireSyncTier()'s own doc (SMI-6236 F-2) for why this isn't a bare
    // requireTier('team') call.
    await requireSyncTier()

    spinner.start('Opening database...')
    // SMI-4917: openCliDatabase opens a connected, schema-initialized DB —
    // fresh installs would otherwise hit "no such table: skills".
    const db = await openCliDatabase(options.dbPath)

    try {
      // SMI-registry-sync-tier-gate: confirm before pulling the full
      // registry, unless the caller opted out (--yes) or is consuming
      // machine-readable output (--json implies --yes — an interactive
      // prompt mid-stream would corrupt a --json consumer's stdout).
      if (!options.yes && !options.json) {
        spinner.stop()
        const count = await fetchApproximateRecordCount()
        const message =
          count !== null
            ? `This will download approximately ${count.toLocaleString()} skill records. Continue?`
            : 'This will download the full skill registry. Continue?'
        const proceed = await confirm({ message, default: false })

        if (!proceed) {
          console.log(chalk.dim('Sync cancelled.'))
          return
        }
        spinner.start()
      }

      spinner.text = options.force ? 'Starting full sync...' : 'Starting differential sync...'

      const result = await runRegistrySync(db, {
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
        // SMI-4482/SMI-6236: signal auth/tier failure via exit code so
        // `--json` scripts can detect "needs login"/"needs upgrade" without
        // parsing the payload.
        if (isAuthFailure(result) || isTierRejection(result)) {
          process.exitCode = 1
        }
        return
      }

      // SMI-4482: When sync failed because no credentials were available
      // (anonymous IP-trial exhausted, or auth rejected), replace the bare
      // `Authentication required` error with actionable guidance and exit
      // non-zero — instead of printing `Σ Total: 0` with no next step.
      if (isAuthFailure(result)) {
        spinner.fail(chalk.yellow('Sync requires authentication'))
        console.log()
        for (const line of formatAuthGuidance()) {
          logger.error(line)
        }
        // db.close() runs in the `finally` block below before process.exit.
        process.exitCode = 1
        return
      }

      // SMI-6236 F-2: requireSyncTier() couldn't resolve tier offline (e.g.
      // SKILLSMITH_API_KEY set, no JWT session to live-check) and let the
      // request through — registry-sync's own 403 is the authoritative
      // answer here. Replace the raw error string with the same friendly
      // upgrade message requireSyncTier() would have thrown had it been able
      // to check offline.
      if (isTierRejection(result)) {
        spinner.fail(chalk.yellow('Sync requires a Team or Enterprise subscription'))
        console.log()
        for (const line of formatTierUpgradeGuidance()) {
          logger.error(line)
        }
        process.exitCode = 1
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
    logger.error(`${chalk.red('Error:')} ${sanitizeError(error)}`)
    process.exit(1)
  }
}

/**
 * Configure sync settings
 */
async function syncConfigActionImpl(options: {
  dbPath: string
  enable: boolean | undefined
  disable: boolean | undefined
  frequency: string | undefined
  show: boolean | undefined
  json: boolean
}): Promise<void> {
  try {
    const db = await openCliDatabase(options.dbPath)

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
        // SMI-registry-sync-tier-gate: a below-tier user shouldn't be able to
        // enable a background-sync feature that will only ever fail — the
        // sync itself is gated to Team tier above. --disable/--show/--frequency
        // are deliberately NOT gated: a user must always be able to see or
        // turn off a setting regardless of tier. Uses requireSyncTier(), not
        // requireTier('team') directly — same SMI-6236 F-2 rationale as the
        // main sync gate; a JWT-only Team user must not be incorrectly
        // blocked from enabling background sync.
        await requireSyncTier()
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
          logger.error(chalk.red('Error: Frequency must be "daily" or "weekly"'))
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
    logger.error(`${chalk.red('Error:')} ${sanitizeError(error)}`)
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// Telemetry-wrapped exports (SMI-5127)
//
// Namespaced subcommand skillIds use "sync <subcommand>" convention so
// PostHog events are distinguishable per-subcommand while remaining
// obviously grouped under the sync surface.
// ---------------------------------------------------------------------------

export const syncAction = withTelemetry(syncActionImpl, {
  source: 'cli',
  extractSkillId: () => 'sync',
  extractFramework: () => 'cli',
})

export const syncConfigAction = withTelemetry(syncConfigActionImpl, {
  source: 'cli',
  extractSkillId: () => 'sync config',
  extractFramework: () => 'cli',
})
