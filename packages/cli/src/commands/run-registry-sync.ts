/**
 * @fileoverview Reusable registry-sync helper.
 * @see SMI-4917
 *
 * Extracted from `sync.ts`'s `runSync` so the registry-sync mechanics (JWT load,
 * API client, repositories, `SyncEngine`) can be reused by:
 *   - the `sync` command (`sync.ts`),
 *   - the post-login auto-sync (`login.ts`),
 *   - the empty-DB auto-sync on `search` (`search.helpers.ts`).
 *
 * This helper does NOT open or close the database and does NOT call
 * `process.exit` — the caller owns the database lifecycle and process control.
 */
import {
  SkillRepository,
  SyncConfigRepository,
  SyncHistoryRepository,
  SkillVersionRepository,
  SyncEngine,
  createApiClient,
  loadStoredAccessToken,
  type DatabaseType,
  type SyncProgress,
  type SyncResult,
} from '@skillsmith/core'

/**
 * Run a registry sync against an already-open, schema-initialized database.
 *
 * @param db - An open CLI database (use `openCliDatabase`). The caller owns
 *   `db.close()`.
 * @param options - Sync options.
 * @param options.force - Force a full sync (ignore last-sync time).
 * @param options.dryRun - Report what would sync without writing.
 * @param options.onProgress - Progress callback forwarded to the `SyncEngine`.
 * @returns The `SyncResult` from the engine.
 */
export async function runRegistrySync(
  db: DatabaseType,
  options: {
    force?: boolean
    dryRun?: boolean
    onProgress?: (progress: SyncProgress) => void
  } = {}
): Promise<SyncResult> {
  const skillRepo = new SkillRepository(db)
  const syncConfigRepo = new SyncConfigRepository(db)
  const syncHistoryRepo = new SyncHistoryRepository(db)
  const skillVersionRepo = new SkillVersionRepository(db)

  // SMI-4474: auto-load JWT from ~/.skillsmith/config.json so logged-in users
  // count toward their quota instead of going anonymous.
  const jwtToken = await loadStoredAccessToken()
  const apiClient = createApiClient(jwtToken ? { jwtToken } : {})

  const syncEngine = new SyncEngine(
    apiClient,
    skillRepo,
    syncConfigRepo,
    syncHistoryRepo,
    skillVersionRepo
  )

  const syncOptions: {
    force?: boolean
    dryRun?: boolean
    onProgress?: (progress: SyncProgress) => void
  } = {}
  if (options.force !== undefined) syncOptions.force = options.force
  if (options.dryRun !== undefined) syncOptions.dryRun = options.dryRun
  if (options.onProgress !== undefined) syncOptions.onProgress = options.onProgress

  return syncEngine.sync(syncOptions)
}
