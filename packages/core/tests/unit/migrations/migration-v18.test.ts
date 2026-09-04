/**
 * @fileoverview Tests for migration v18 — purge proxy-hash skill_versions history
 * @see SMI-6343 Wave 2 — repair the content-hash comparison
 *
 * Coverage:
 *  - MIGRATIONS registers v18 with the documented SQL.
 *  - SCHEMA_VERSION is at least 18.
 *  - MIGRATION_V18_SQL empties skill_versions of any pre-existing (proxy-hash
 *    era) rows.
 *  - A v17 fixture DB upgrades to v18 cleanly via runMigrations, purging a
 *    legacy row planted before the upgrade.
 *  - A post-migration registry sync (SyncEngine) repopulates skill_versions
 *    with a real SKILL.md content hash — never a metadata proxy.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDatabase, closeDatabase, type Database } from '../../helpers/database.js'
import {
  getSchemaVersion,
  SCHEMA_VERSION,
  runMigrations,
  MIGRATIONS,
  createDatabaseAsync,
  initializeSchema,
  SCHEMA_SQL,
} from '../../../src/db/schema.js'
import { MIGRATION_V18_SQL } from '../../../src/db/migrations/v18-skill-versions-real-content-hash.js'
import { SyncEngine } from '../../../src/sync/SyncEngine.js'
import { SkillRepository } from '../../../src/repositories/SkillRepository.js'
import { SyncConfigRepository } from '../../../src/repositories/SyncConfigRepository.js'
import { SyncHistoryRepository } from '../../../src/repositories/SyncHistoryRepository.js'
import { SkillVersionRepository } from '../../../src/repositories/SkillVersionRepository.js'
import type { SkillsmithApiClient, ApiSearchResult } from '../../../src/api/client.js'
// The BARE factory (creates no tables) — needed to build a pristine fixture DB
// whose schema_version table starts empty.
import { createDatabaseAsync as createBareDatabaseAsync } from '../../../src/db/createDatabase.js'

/**
 * Build a fixture DB stamped at exactly `targetVersion` by running the base
 * schema then every migration up to (and including) `targetVersion`. Mirrors
 * the pattern in migration-v17.test.ts's fixtureAtVersion().
 */
async function fixtureAtVersion(targetVersion: number): Promise<Database> {
  const db = (await createBareDatabaseAsync(':memory:')) as Database
  db.exec(SCHEMA_SQL)
  for (const migration of MIGRATIONS) {
    if (migration.version === 1 || migration.version > targetVersion) continue
    try {
      if (migration.apply) {
        migration.apply(db)
      } else if (migration.sql !== undefined) {
        db.exec(migration.sql)
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if (!msg.includes('duplicate column')) throw error
    }
    db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(migration.version)
  }
  return db
}

function countSkillVersions(db: Database): number {
  return (db.prepare('SELECT COUNT(*) as c FROM skill_versions').get() as { c: number }).c
}

function buildMockApiClient(skills: ApiSearchResult[]): SkillsmithApiClient {
  return {
    isOffline: vi.fn().mockReturnValue(false),
    checkHealth: vi.fn().mockResolvedValue({ status: 'healthy' }),
    syncRegistry: vi.fn().mockResolvedValue({ data: skills, meta: {} }),
    search: vi.fn(),
    getSkill: vi.fn(),
    getHealthStatus: vi.fn(),
  } as unknown as SkillsmithApiClient
}

describe('Migration v18: purge proxy-hash skill_versions history', () => {
  let db: Database

  beforeEach(async () => {
    db = await createTestDatabase()
  })

  afterEach(() => {
    closeDatabase(db)
  })

  it('SCHEMA_VERSION is at least 18', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(18)
  })

  it('MIGRATIONS registers v18 with the expected SQL', () => {
    const v18 = MIGRATIONS.find((m) => m.version === 18)
    expect(v18).toBeDefined()
    expect(v18?.sql).toBe(MIGRATION_V18_SQL)
    expect(v18?.description).toContain('SMI-6343')
  })

  it('MIGRATION_V18_SQL empties skill_versions of pre-existing (proxy-hash) rows', () => {
    db.prepare(`INSERT INTO skill_versions (skill_id, content_hash) VALUES (?, ?)`).run(
      'legacy/skill',
      'deadbeef-proxy-hash'
    )
    expect(countSkillVersions(db)).toBe(1)

    db.exec(MIGRATION_V18_SQL)

    expect(countSkillVersions(db)).toBe(0)
  })

  it('is idempotent — running it again on an already-empty table is a no-op', () => {
    db.exec(MIGRATION_V18_SQL)
    expect(countSkillVersions(db)).toBe(0)
    expect(() => db.exec(MIGRATION_V18_SQL)).not.toThrow()
    expect(countSkillVersions(db)).toBe(0)
  })

  it('a v17 fixture DB upgrades to v18 cleanly, purging a legacy proxy-hash row planted before the upgrade', async () => {
    const v17 = await fixtureAtVersion(17)
    expect(getSchemaVersion(v17)).toBe(17)

    // Plant a legacy (pre-fix) proxy-hash row, as a real pre-migration DB would have.
    v17
      .prepare(`INSERT INTO skill_versions (skill_id, content_hash) VALUES (?, ?)`)
      .run('legacy/proxy-hash-skill', 'legacy-proxy-hash-value')
    expect(countSkillVersions(v17)).toBe(1)

    const ran = runMigrations(v17)
    expect(ran).toBeGreaterThanOrEqual(1)
    expect(getSchemaVersion(v17)).toBe(SCHEMA_VERSION)
    expect(countSkillVersions(v17)).toBe(0)

    closeDatabase(v17)
  })

  it('post-migration registry sync repopulates skill_versions with a real content hash, never a metadata proxy', async () => {
    db.exec(MIGRATION_V18_SQL)
    expect(countSkillVersions(db)).toBe(0)

    const skillRepo = new SkillRepository(db)
    const syncConfigRepo = new SyncConfigRepository(db)
    const syncHistoryRepo = new SyncHistoryRepository(db)
    const skillVersionRepo = new SkillVersionRepository(db)

    const realContentHash = 'a'.repeat(64) // shape of a real sha256 hex digest
    const skill: ApiSearchResult = {
      id: 'community/real-hash-skill',
      name: 'Real Hash Skill',
      description: 'test skill',
      author: 'test-author',
      repo_url: 'https://github.com/test/real-hash-skill',
      quality_score: 0.8,
      trust_tier: 'community',
      tags: [],
      content_hash: realContentHash,
      updated_at: new Date().toISOString(),
    }

    const apiClient = buildMockApiClient([skill])
    const engine = new SyncEngine(
      apiClient,
      skillRepo,
      syncConfigRepo,
      syncHistoryRepo,
      skillVersionRepo
    )

    const result = await engine.sync()
    expect(result.success).toBe(true)
    expect(result.skillsAdded).toBe(1)

    const latest = await skillVersionRepo.getLatestVersion('community/real-hash-skill')
    expect(latest).not.toBeNull()
    expect(latest?.content_hash).toBe(realContentHash)

    // Never a metadata-proxy hash: the proxy was
    // sha256(JSON.stringify({id, name, description, updated_at})) — a
    // completely different value from the registry's real content_hash.
    const metadataProxyShape = JSON.stringify({
      id: skill.id,
      name: skill.name,
      description: skill.description ?? null,
      updated_at: skill.updated_at ?? null,
    })
    expect(latest?.content_hash).not.toBe(metadataProxyShape)
  })

  it('post-migration registry sync skips recordVersion entirely when the registry provides no content hash', async () => {
    db.exec(MIGRATION_V18_SQL)

    const skillRepo = new SkillRepository(db)
    const syncConfigRepo = new SyncConfigRepository(db)
    const syncHistoryRepo = new SyncHistoryRepository(db)
    const skillVersionRepo = new SkillVersionRepository(db)

    const skill: ApiSearchResult = {
      id: 'community/no-hash-skill',
      name: 'No Hash Skill',
      description: 'test skill',
      author: 'test-author',
      repo_url: 'https://github.com/test/no-hash-skill',
      quality_score: 0.8,
      trust_tier: 'community',
      tags: [],
      // content_hash intentionally omitted
      updated_at: new Date().toISOString(),
    }

    const apiClient = buildMockApiClient([skill])
    const engine = new SyncEngine(
      apiClient,
      skillRepo,
      syncConfigRepo,
      syncHistoryRepo,
      skillVersionRepo
    )

    const result = await engine.sync()
    expect(result.success).toBe(true)
    expect(result.skillsAdded).toBe(1)

    // No row was recorded — a missing hash is honestly "unknown", never a
    // proxy fabrication.
    const latest = await skillVersionRepo.getLatestVersion('community/no-hash-skill')
    expect(latest).toBeNull()
  })

  it('H1: the skills table itself is unaffected by v18 (only skill_versions is touched)', () => {
    db.prepare(
      "INSERT INTO skills (id, name, trust_tier, source) VALUES ('keep-1', 'keep', 'community', 'registry')"
    ).run()

    db.exec(MIGRATION_V18_SQL)

    const row = db.prepare('SELECT id FROM skills WHERE id = ?').get('keep-1') as
      | { id: string }
      | undefined
    expect(row?.id).toBe('keep-1')
  })

  it('fresh-install convergence: a brand-new DB has an empty skill_versions table at the current schema version', async () => {
    const fresh = await createDatabaseAsync(':memory:')
    initializeSchema(fresh)
    expect(getSchemaVersion(fresh)).toBe(SCHEMA_VERSION)
    expect(countSkillVersions(fresh)).toBe(0)
    closeDatabase(fresh)
  })
})
