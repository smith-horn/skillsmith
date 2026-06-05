/**
 * @fileoverview Tests for the `search` command's empty-DB auto-sync helper.
 * @see SMI-4917 — Bug 3: a fresh install left an empty `skills` table so the
 *   first `search` returned nothing. `autoSyncIfEmpty` bootstraps the registry,
 *   bounded (H5) so it never hammers the API.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// loadStoredAccessToken decides whether the user is authenticated; runRegistrySync
// performs the actual sync. Both are mocked so the test is hermetic.
const loadStoredAccessToken = vi.fn<() => Promise<string | null>>()
const runRegistrySync = vi.fn()

vi.mock('@skillsmith/core', async () => {
  const actual = await vi.importActual<typeof import('@skillsmith/core')>('@skillsmith/core')
  return {
    ...actual,
    loadStoredAccessToken: () => loadStoredAccessToken(),
  }
})

vi.mock('../src/commands/run-registry-sync.js', () => ({
  runRegistrySync: (...args: unknown[]) => runRegistrySync(...args),
}))

// ora must no-op cleanly in the test (non-TTY) — stub it to a chainable object.
vi.mock('ora', () => {
  const spinner = {
    start: vi.fn(() => spinner),
    succeed: vi.fn(() => spinner),
    warn: vi.fn(() => spinner),
    fail: vi.fn(() => spinner),
    stop: vi.fn(() => spinner),
    text: '',
  }
  return { default: vi.fn(() => spinner) }
})

import { openCliDatabase } from '../src/utils/open-database.js'
import {
  SkillRepository,
  SyncHistoryRepository,
  closeDatabase,
  type DatabaseType,
} from '@skillsmith/core'

async function freshDb(): Promise<DatabaseType> {
  return openCliDatabase(':memory:')
}

function seedSkill(db: DatabaseType): void {
  new SkillRepository(db).create({
    id: 'seed-1',
    name: 'seeded-skill',
    description: 'a pre-existing skill',
    trustTier: 'community',
  })
}

describe('SMI-4917 Bug 3: autoSyncIfEmpty', () => {
  let db: DatabaseType

  beforeEach(async () => {
    vi.clearAllMocks()
    runRegistrySync.mockResolvedValue({
      success: true,
      skillsAdded: 5,
      skillsUpdated: 0,
      skillsUnchanged: 0,
      totalProcessed: 5,
      errors: [],
      durationMs: 1,
      dryRun: false,
    })
    db = await freshDb()
  })

  afterEach(() => {
    closeDatabase(db)
  })

  it('syncs when the DB is empty and a token is present', async () => {
    loadStoredAccessToken.mockResolvedValue('jwt-token')
    const { autoSyncIfEmpty } = await import('../src/commands/search.helpers.js')

    await autoSyncIfEmpty(db)

    expect(runRegistrySync).toHaveBeenCalledTimes(1)
  })

  it('does NOT sync when the DB already has skills', async () => {
    loadStoredAccessToken.mockResolvedValue('jwt-token')
    seedSkill(db)
    const { autoSyncIfEmpty } = await import('../src/commands/search.helpers.js')

    await autoSyncIfEmpty(db)

    expect(runRegistrySync).not.toHaveBeenCalled()
  })

  it('does NOT sync for an anonymous user (no stored token)', async () => {
    loadStoredAccessToken.mockResolvedValue(null)
    const { autoSyncIfEmpty } = await import('../src/commands/search.helpers.js')

    await autoSyncIfEmpty(db)

    expect(runRegistrySync).not.toHaveBeenCalled()
  })

  it('does NOT sync when a sync was attempted within the last 15 minutes', async () => {
    loadStoredAccessToken.mockResolvedValue('jwt-token')
    // Record a sync attempt that started 1 minute ago.
    const historyRepo = new SyncHistoryRepository(db)
    historyRepo.startRun() // startRun() stamps started_at = now
    const { autoSyncIfEmpty } = await import('../src/commands/search.helpers.js')

    await autoSyncIfEmpty(db)

    expect(runRegistrySync).not.toHaveBeenCalled()
  })

  it('DOES sync when the last sync attempt is older than 15 minutes', async () => {
    loadStoredAccessToken.mockResolvedValue('jwt-token')
    // Insert a sync_history row whose started_at is 20 minutes ago.
    const twentyMinAgo = new Date(Date.now() - 20 * 60_000).toISOString()
    db.prepare("INSERT INTO sync_history (id, started_at, status) VALUES (?, ?, 'success')").run(
      'old-run',
      twentyMinAgo
    )
    const { autoSyncIfEmpty } = await import('../src/commands/search.helpers.js')

    await autoSyncIfEmpty(db)

    expect(runRegistrySync).toHaveBeenCalledTimes(1)
  })

  it('never throws when the sync fails — search proceeds with local results', async () => {
    loadStoredAccessToken.mockResolvedValue('jwt-token')
    runRegistrySync.mockRejectedValue(new Error('network down'))
    const { autoSyncIfEmpty } = await import('../src/commands/search.helpers.js')

    await expect(autoSyncIfEmpty(db)).resolves.toBeUndefined()
  })
})
