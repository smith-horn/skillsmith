/**
 * @fileoverview Reusable registry-sync helper.
 * @see SMI-4917
 *
 * Extracted from `sync.ts`'s `runSync` so the registry-sync mechanics (JWT load,
 * API client, repositories, `SyncEngine`) can be reused by the `sync` command.
 * The post-login auto-sync (`login.ts`) and the empty-DB auto-sync on `search`
 * (`search.helpers.ts`) call sites were removed under SMI-5427 — `sync.action.ts`
 * (via `sync.ts`) is now this helper's only caller.
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
  type SkillsmithApiClient,
} from '@skillsmith/core'

/**
 * Resolve the API client used for registry sync, with the same
 * credential-resolution path `runRegistrySync()` uses: an auto-loaded stored
 * JWT (SMI-4474) when available, falling back to the client's own anonymous
 * mode otherwise.
 *
 * Exported so callers that need the same authenticated client outside of a
 * full sync run (e.g. `sync.action.ts`'s pre-sync record-count fetch) reuse
 * this exact resolution instead of duplicating it.
 */
export async function getSyncApiClient(): Promise<SkillsmithApiClient> {
  // SMI-4474: auto-load JWT from ~/.skillsmith/config.json so logged-in users
  // count toward their quota instead of going anonymous.
  const jwtToken = await loadStoredAccessToken()
  return createApiClient(jwtToken ? { jwtToken } : {})
}

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

  const apiClient = await getSyncApiClient()

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
