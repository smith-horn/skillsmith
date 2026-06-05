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
export const AUTO_SYNC_COOLDOWN_MS = 15 * 60_000

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

/**
 * Whether the local `skills` table has no rows.
 *
 * SMI-4926: a 0-result search against an empty index is meaningfully different
 * from a genuine no-match — the registry has not been synced locally yet.
 * Reuses the same `SkillRepository.count()` that `autoSyncIfEmpty` relies on
 * (no raw SQL).
 *
 * @param db - An open, schema-initialized CLI database.
 */
export function isLocalIndexEmpty(db: DatabaseType): boolean {
  return new SkillRepository(db).count() === 0
}

/**
 * Build a sync-state-aware hint for a 0-result search against an empty index.
 *
 * SMI-4926: `autoSyncIfEmpty` may legitimately skip the sync (anonymous user,
 * or a sync attempted within `AUTO_SYNC_COOLDOWN_MS`), so the hint must not
 * unconditionally claim a sync is running. If the most recent sync attempt
 * started within the cooldown window, the user is told to retry shortly;
 * otherwise they are told to run `skillsmith sync`.
 *
 * Both messages start with a literal `ℹ ` text marker so they remain
 * distinguishable from the yellow no-match message under `NO_COLOR`, and carry
 * leading/trailing newlines to match `displayResults` padding.
 *
 * @param db - An open, schema-initialized CLI database.
 */
export function formatEmptyIndexHint(db: DatabaseType): string {
  const lastAttempt = new SyncHistoryRepository(db).getHistory(1)[0]
  if (lastAttempt) {
    const startedMs = new Date(lastAttempt.startedAt).getTime()
    if (!Number.isNaN(startedMs) && Date.now() - startedMs < AUTO_SYNC_COOLDOWN_MS) {
      return chalk.yellow(
        '\nℹ Your local skill index is still being populated — a sync is in progress. Try this search again shortly.\n'
      )
    }
  }
  return chalk.yellow(
    '\nℹ Your local skill index is empty. Run `skillsmith sync` to populate it, then search again.\n'
  )
}
