/**
 * @fileoverview SyncEngine source-aware predicate tests
 * @see SMI-4665: Filesystem-walking SKILL.md import command
 *
 * Coverage:
 *   - Live path: `force=true` does NOT overwrite `source='local'` rows
 *   - Live path: `source='registry'` rows continue to update normally
 *   - Dry-run: local rows are reported as `unchanged`, not `updated`
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createDatabase, closeDatabase } from '../../src/db/schema.js'
import { SyncConfigRepository } from '../../src/repositories/SyncConfigRepository.js'
import { SyncHistoryRepository } from '../../src/repositories/SyncHistoryRepository.js'
import { SkillRepository } from '../../src/repositories/SkillRepository.js'
import { SyncEngine } from '../../src/sync/SyncEngine.js'
import type { SkillVersionRepository } from '../../src/repositories/SkillVersionRepository.js'
import type { DatabaseType } from '../../src/db/schema.js'
import type { SkillsmithApiClient, ApiSearchResult } from '../../src/api/client.js'

function createMockSkillVersionRepo(): SkillVersionRepository {
  return {
    recordVersion: vi.fn().mockResolvedValue(undefined),
    pruneVersions: vi.fn().mockResolvedValue(undefined),
    getLatestVersion: vi.fn().mockResolvedValue(null),
    getVersionHistory: vi.fn().mockResolvedValue([]),
    getVersionByHash: vi.fn().mockResolvedValue(null),
  } as unknown as SkillVersionRepository
}

function createApiSkill(id: string, updatedAt: string): ApiSearchResult {
  return {
    id,
    name: `Registry ${id}`,
    description: `Registry description for ${id}`,
    author: 'registry-author',
    repo_url: `https://github.com/registry/${id}`,
    quality_score: 0.9,
    trust_tier: 'community',
    tags: ['registry'],
    stars: 10,
    installable: true,
    created_at: updatedAt,
    updated_at: updatedAt,
  } as unknown as ApiSearchResult
}

function createMockApiClient(skills: ApiSearchResult[]): SkillsmithApiClient {
  const search = vi.fn().mockImplementation(async ({ limit = 100, offset = 0 }) => ({
    data: skills.slice(offset, offset + limit),
    total: skills.length,
    limit,
    offset,
  }))
  return {
    isOffline: vi.fn().mockReturnValue(false),
    checkHealth: vi.fn().mockResolvedValue({ status: 'healthy' }),
    search,
    getSkill: vi.fn(),
    getHealthStatus: vi.fn(),
  } as unknown as SkillsmithApiClient
}

describe('SyncEngine source-aware predicate (SMI-4665)', () => {
  let db: DatabaseType
  let skillRepo: SkillRepository
  let syncConfigRepo: SyncConfigRepository
  let syncHistoryRepo: SyncHistoryRepository

  beforeEach(() => {
    db = createDatabase(':memory:')
    skillRepo = new SkillRepository(db)
    syncConfigRepo = new SyncConfigRepository(db)
    syncHistoryRepo = new SyncHistoryRepository(db)
  })

  afterEach(() => {
    closeDatabase(db)
  })

  it('force=true does NOT overwrite source=local rows', async () => {
    // Seed a locally-imported skill with the same id the registry would later carry.
    skillRepo.create({
      id: 'shared-id',
      name: 'My Local WIP',
      description: 'Iterating on disk',
      trustTier: 'local',
      source: 'local',
      tags: ['wip'],
    })

    const future = new Date(Date.now() + 60_000).toISOString()
    const apiClient = createMockApiClient([createApiSkill('shared-id', future)])
    const engine = new SyncEngine(
      apiClient,
      skillRepo,
      syncConfigRepo,
      syncHistoryRepo,
      createMockSkillVersionRepo()
    )

    const result = await engine.sync({ force: true })

    expect(result.success).toBe(true)
    expect(result.skillsAdded).toBe(0)
    expect(result.skillsUpdated).toBe(0)
    expect(result.skillsUnchanged).toBeGreaterThanOrEqual(1)

    const after = skillRepo.findById('shared-id')
    expect(after).not.toBeNull()
    expect(after!.name).toBe('My Local WIP')
    expect(after!.source).toBe('local')
    expect(after!.trustTier).toBe('local')
  })

  it('source=registry rows continue to update under force=true', async () => {
    // Seed a registry-sourced row.
    skillRepo.create({
      id: 'registry-id',
      name: 'Old Registry',
      trustTier: 'community',
      source: 'registry',
      tags: ['old'],
    })

    const future = new Date(Date.now() + 60_000).toISOString()
    const apiClient = createMockApiClient([createApiSkill('registry-id', future)])
    const engine = new SyncEngine(
      apiClient,
      skillRepo,
      syncConfigRepo,
      syncHistoryRepo,
      createMockSkillVersionRepo()
    )

    const result = await engine.sync({ force: true })

    expect(result.success).toBe(true)
    expect(result.skillsUpdated).toBeGreaterThanOrEqual(1)

    const after = skillRepo.findById('registry-id')
    expect(after).not.toBeNull()
    expect(after!.name).toBe('Registry registry-id')
    expect(after!.source).toBe('registry')
  })

  it('dry-run reports local rows as unchanged, not updated', async () => {
    skillRepo.create({
      id: 'local-id',
      name: 'Local',
      trustTier: 'local',
      source: 'local',
      tags: [],
    })
    skillRepo.create({
      id: 'reg-id',
      name: 'Reg',
      trustTier: 'community',
      source: 'registry',
      tags: [],
    })

    const future = new Date(Date.now() + 60_000).toISOString()
    const apiClient = createMockApiClient([
      createApiSkill('local-id', future),
      createApiSkill('reg-id', future),
    ])
    const engine = new SyncEngine(
      apiClient,
      skillRepo,
      syncConfigRepo,
      syncHistoryRepo,
      createMockSkillVersionRepo()
    )

    const result = await engine.sync({ force: true, dryRun: true })

    expect(result.dryRun).toBe(true)
    // Exactly one row (local-id) should be classified as unchanged-due-to-source,
    // and exactly one (reg-id) should be classified as updated.
    expect(result.skillsUpdated).toBeGreaterThanOrEqual(1)
    expect(result.skillsUpdated).toBeLessThan(2)

    // Even in dry-run we MUST NOT have mutated the DB.
    const localAfter = skillRepo.findById('local-id')
    expect(localAfter!.name).toBe('Local')
    expect(localAfter!.source).toBe('local')
  })
})
