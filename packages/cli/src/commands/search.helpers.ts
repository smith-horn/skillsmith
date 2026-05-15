/**
 * @fileoverview Helpers for the `search` command.
 * @see SMI-4917
 *
 * Extracted from `search.ts` pre-emptively so the empty-DB auto-sync logic does
 * not push `search.ts` past the 500-line `audit:standards` gate.
 */
import chalk from 'chalk'
import ora from 'ora'
import {
  SkillRepository,
  SyncHistoryRepository,
  loadStoredAccessToken,
  type DatabaseType,
} from '@skillsmith/core'
import { runRegistrySync } from './run-registry-sync.js'

/** Skip the auto-sync if a sync attempt started within this window. */
const AUTO_SYNC_COOLDOWN_MS = 15 * 60_000

/**
 * Bootstrap the local registry on a first-time `search` against an empty DB.
 *
 * Bug 3 of SMI-4917: a fresh install (or a login that pre-dates the post-login
 * auto-sync) leaves an empty `skills` table, so the first `search` returns
 * nothing. This helper syncs the registry once, best-effort, when the DB is
 * empty.
 *
 * Bounded (H5) to avoid hammering the registry:
 *   - skipped when the DB already has skills,
 *   - skipped for anonymous users (no stored token) — they would only hit the
 *     trial cap; `search` falls back to whatever is local,
 *   - skipped when a sync was attempted within the last 15 minutes (so a string
 *     of failed/offline searches does not re-trigger a full sync each time).
 *
 * Never throws: a sync failure downgrades to a warning and `search` proceeds
 * with local results.
 *
 * @param db - An open, schema-initialized CLI database.
 */
export async function autoSyncIfEmpty(db: DatabaseType): Promise<void> {
  if (new SkillRepository(db).count() > 0) return

  // Anonymous users would only hit the trial cap — skip the auto-sync.
  if (!(await loadStoredAccessToken())) return

  // Skip when a sync was attempted recently (success OR failure).
  const lastAttempt = new SyncHistoryRepository(db).getHistory(1)[0]
  if (lastAttempt) {
    const startedMs = new Date(lastAttempt.startedAt).getTime()
    if (!Number.isNaN(startedMs) && Date.now() - startedMs < AUTO_SYNC_COOLDOWN_MS) {
      return
    }
  }

  const spinner = ora('No skills found locally — syncing from registry…').start()
  try {
    const result = await runRegistrySync(db)
    spinner.succeed(chalk.green(`Synced ${result.totalProcessed} skills.`))
  } catch {
    spinner.warn(chalk.yellow('Could not sync — showing local results only.'))
  }
}
