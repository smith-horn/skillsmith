/**
 * @fileoverview Integration tests for `skillsmith import-local` (SMI-4665)
 *
 * Exercises the action handler against a real SQLite DB on a tmpdir fixture.
 * Round-trip:
 *   1. Import — fixture skill lands in DB with source='local', trust_tier='local'
 *   2. Re-import is idempotent — same id, no duplicates
 *   3. SyncEngine.upsertSkills with force=true does NOT clobber the local row
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createDatabaseAsync,
  initializeSchema,
  SkillRepository,
  SyncEngine,
  SyncConfigRepository,
  SyncHistoryRepository,
} from '@skillsmith/core'
import { runImportLocal } from '../../src/commands/import-local.js'
import { vi } from 'vitest'

let workDir: string
let dbPath: string

beforeEach(async () => {
  workDir = await fs.mkdtemp(join(tmpdir(), 'skillsmith-il-'))
  dbPath = join(workDir, 'skills.db')
})

afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true })
})

async function writeSkill(name: string): Promise<string> {
  const dir = join(workDir, 'skills', name)
  await fs.mkdir(dir, { recursive: true })
  const file = join(dir, 'SKILL.md')
  await fs.writeFile(
    file,
    `---\nname: ${name}\ndescription: A test skill named ${name}\ntags:\n  - test\n---\n# ${name}\n\nBody.\n`
  )
  return file
}

describe('skillsmith import-local — round-trip', () => {
  it('imports SKILL.md files into the DB with source=local', async () => {
    await writeSkill('alpha')
    await writeSkill('beta')

    const result = await runImportLocal({
      path: join(workDir, 'skills'),
      dbPath,
    })

    expect(result.errors).toEqual([])
    expect(result.imported).toBe(2)
    expect(result.scanned).toBe(2)

    const db = await createDatabaseAsync(dbPath)
    initializeSchema(db)
    try {
      const repo = new SkillRepository(db)
      const all = repo.findAll({ limit: 100 })
      expect(all.items).toHaveLength(2)
      for (const skill of all.items) {
        expect(skill.source).toBe('local')
        expect(skill.trustTier).toBe('local')
      }
    } finally {
      db.close()
    }
  })

  it('re-importing the same directory is idempotent (same id, no duplicates)', async () => {
    await writeSkill('gamma')

    const first = await runImportLocal({ path: join(workDir, 'skills'), dbPath })
    expect(first.imported).toBe(1)
    expect(first.updated).toBe(0)

    const second = await runImportLocal({ path: join(workDir, 'skills'), dbPath })
    expect(second.imported).toBe(0)
    expect(second.updated).toBe(1) // path is the same, id matches → update path

    const db = await createDatabaseAsync(dbPath)
    initializeSchema(db)
    try {
      const repo = new SkillRepository(db)
      expect(repo.count()).toBe(1)
    } finally {
      db.close()
    }
  })

  it('sync --force does NOT clobber locally-imported rows', async () => {
    const skillFile = await writeSkill('delta')
    await runImportLocal({ path: join(workDir, 'skills'), dbPath })

    const db = await createDatabaseAsync(dbPath)
    try {
      const skillRepo = new SkillRepository(db)
      const localSkills = skillRepo.findAll({ limit: 10 }).items
      expect(localSkills).toHaveLength(1)
      const local = localSkills[0]!

      // Build a SyncEngine that returns a colliding registry skill.
      const apiClient = {
        isOffline: vi.fn().mockReturnValue(false),
        checkHealth: vi.fn().mockResolvedValue({ status: 'healthy' }),
        search: vi.fn().mockResolvedValue({
          data: [
            {
              id: local.id,
              name: 'CLOBBERED REGISTRY NAME',
              description: 'should not appear',
              author: 'reg',
              repo_url: 'https://example.com/registry-collision',
              quality_score: 0.5,
              trust_tier: 'community',
              tags: [],
              stars: 0,
              installable: true,
              created_at: new Date().toISOString(),
              updated_at: new Date(Date.now() + 60_000).toISOString(),
            },
          ],
          total: 1,
        }),
        getSkill: vi.fn(),
        getHealthStatus: vi.fn(),
      }

      const syncConfigRepo = new SyncConfigRepository(db)
      const syncHistoryRepo = new SyncHistoryRepository(db)
      const skillVersionRepo = {
        recordVersion: vi.fn().mockResolvedValue(undefined),
        pruneVersions: vi.fn().mockResolvedValue(undefined),
        getLatestVersion: vi.fn().mockResolvedValue(null),
        getVersionHistory: vi.fn().mockResolvedValue([]),
        getVersionByHash: vi.fn().mockResolvedValue(null),
      }

      const engine = new SyncEngine(
        apiClient as unknown as ConstructorParameters<typeof SyncEngine>[0],
        skillRepo,
        syncConfigRepo,
        syncHistoryRepo,
        skillVersionRepo as unknown as ConstructorParameters<typeof SyncEngine>[4]
      )

      const result = await engine.sync({ force: true })
      expect(result.success).toBe(true)
      expect(result.skillsUpdated).toBe(0)

      const after = skillRepo.findById(local.id)
      expect(after).not.toBeNull()
      expect(after!.name).toBe('delta')
      expect(after!.source).toBe('local')
    } finally {
      db.close()
    }

    // Sanity: the fixture file is still there (we didn't accidentally delete it).
    await fs.access(skillFile)
  })

  it('--dry-run does not mutate the DB', async () => {
    await writeSkill('echo')

    const result = await runImportLocal({
      path: join(workDir, 'skills'),
      dbPath,
      dryRun: true,
    })

    expect(result.dryRun).toBe(true)
    expect(result.imported).toBe(1)

    // The dry-run pass opens the DB only to read; it still initializes the
    // schema so subsequent reads work. Verify no skill rows landed.
    const db = await createDatabaseAsync(dbPath)
    initializeSchema(db)
    try {
      const repo = new SkillRepository(db)
      expect(repo.count()).toBe(0)
    } finally {
      db.close()
    }
  })
})
