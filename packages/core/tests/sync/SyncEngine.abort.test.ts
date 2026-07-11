/**
 * SyncEngine Tests — abort-signal threading (SMI-5649)
 *
 * Split from SyncEngine.test.ts to stay under the 500-LOC file-size gate.
 * Reuses that file's mock factories (createMockSkill, createMockApiClient,
 * createMockSkillVersionRepo — exported there for this purpose).
 *
 * The load-bearing safety property under test: once `signal.aborted` is
 * true, NO NEW db write ever begins — checked at loop/write boundaries
 * (search-query loop, pagination loop, pre-upsert, per-skill upsert loop).
 * Every write already issued before the abort checkpoint is a real,
 * committed write; nothing already in flight is rolled back.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { createDatabase, closeDatabase } from '../../src/db/schema.js'
import { SyncConfigRepository } from '../../src/repositories/SyncConfigRepository.js'
import { SyncHistoryRepository } from '../../src/repositories/SyncHistoryRepository.js'
import { SkillRepository } from '../../src/repositories/SkillRepository.js'
import { SyncEngine } from '../../src/sync/SyncEngine.js'
import type { DatabaseType } from '../../src/db/schema.js'
import type { SkillsmithApiClient } from '../../src/api/client.js'
import {
  createMockSkillVersionRepo,
  createMockSkill,
  createMockApiClient,
} from './SyncEngine.test.js'

describe('SyncEngine - abort signal (SMI-5649)', () => {
  let db: DatabaseType
  let syncConfigRepo: SyncConfigRepository
  let syncHistoryRepo: SyncHistoryRepository
  let skillRepo: SkillRepository

  beforeEach(() => {
    db = createDatabase(':memory:')
    syncConfigRepo = new SyncConfigRepository(db)
    syncHistoryRepo = new SyncHistoryRepository(db)
    skillRepo = new SkillRepository(db)
  })

  afterEach(() => {
    closeDatabase(db)
  })

  it('performs no writes and returns a clean result when the signal is already aborted', async () => {
    const skills = [createMockSkill('test/skill-1'), createMockSkill('test/skill-2')]
    const apiClient = createMockApiClient({ skills })
    const engine = new SyncEngine(
      apiClient,
      skillRepo,
      syncConfigRepo,
      syncHistoryRepo,
      createMockSkillVersionRepo()
    )

    const controller = new AbortController()
    controller.abort()

    const result = await engine.sync({ signal: controller.signal })

    // Never throws — an abort surfaces as a clean, successful-shaped
    // result, not an error (design doc §2.1).
    expect(result.success).toBe(true)
    expect(result.skillsAdded).toBe(0)
    expect(result.skillsUpdated).toBe(0)
    expect(skillRepo.findById('test/skill-1')).toBeNull()
    expect(skillRepo.findById('test/skill-2')).toBeNull()
  })

  it('stops issuing new skillRepo writes once aborted mid-upsert, keeping already-committed writes', async () => {
    const skills = [
      createMockSkill('test/skill-1'),
      createMockSkill('test/skill-2'),
      createMockSkill('test/skill-3'),
    ]
    const apiClient = createMockApiClient({ skills })
    const engine = new SyncEngine(
      apiClient,
      skillRepo,
      syncConfigRepo,
      syncHistoryRepo,
      createMockSkillVersionRepo()
    )

    const controller = new AbortController()
    let createCount = 0
    const originalCreate = skillRepo.create.bind(skillRepo)
    vi.spyOn(skillRepo, 'create').mockImplementation(
      (...args: Parameters<typeof skillRepo.create>) => {
        createCount++
        const result = originalCreate(...args)
        if (createCount === 1) {
          // Abort right after the first skill commits — the per-skill loop's
          // abort checkpoint must stop before issuing a second create().
          controller.abort()
        }
        return result
      }
    )

    const result = await engine.sync({ signal: controller.signal })

    expect(createCount).toBe(1)
    expect(skillRepo.findById('test/skill-1')).not.toBeNull()
    expect(skillRepo.findById('test/skill-2')).toBeNull()
    expect(skillRepo.findById('test/skill-3')).toBeNull()
    expect(result.success).toBe(true)
  })

  it('stops fetching new pages once aborted mid-fetch', async () => {
    const skills = Array.from({ length: 150 }, (_, i) => createMockSkill(`test/skill-${i}`))
    const apiClient = createMockApiClient({ skills })
    const engine = new SyncEngine(
      apiClient,
      skillRepo,
      syncConfigRepo,
      syncHistoryRepo,
      createMockSkillVersionRepo()
    )

    const controller = new AbortController()
    let searchCallCount = 0
    const searchMock = apiClient.search as ReturnType<typeof vi.fn>
    const originalImpl = searchMock.getMockImplementation() as (
      opts: Parameters<SkillsmithApiClient['search']>[0]
    ) => ReturnType<SkillsmithApiClient['search']>
    searchMock.mockImplementation((opts: Parameters<SkillsmithApiClient['search']>[0]) => {
      searchCallCount++
      if (searchCallCount === 3) {
        controller.abort()
      }
      return originalImpl(opts)
    })

    await engine.sync({ signal: controller.signal, pageSize: 100 })

    // Unaborted, this fixture makes 16 search calls (8 queries x 2 pages
    // each — see the pagination test in SyncEngine.test.ts). Aborting on
    // the 3rd call must stop the loop well short of that.
    expect(searchCallCount).toBeLessThan(16)
  })
})
