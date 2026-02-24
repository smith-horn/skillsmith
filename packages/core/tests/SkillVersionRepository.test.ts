/**
 * SkillVersionRepository Tests
 *
 * Tests for skill version hash tracking (SMI-skill-version-tracking Wave 1).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, closeDatabase } from './helpers/database.js'
import { SkillVersionRepository } from '../src/repositories/SkillVersionRepository.js'
import type { Database } from './helpers/database.js'

describe('SkillVersionRepository', () => {
  let db: Database
  let repo: SkillVersionRepository

  beforeEach(() => {
    db = createTestDatabase()
    repo = new SkillVersionRepository(db)
  })

  afterEach(() => {
    closeDatabase(db)
  })

  describe('recordVersion', () => {
    it('should insert a new version record', async () => {
      await repo.recordVersion('author/skill-a', 'abc123hash', '1.0.0')
      const latest = await repo.getLatestVersion('author/skill-a')
      expect(latest).not.toBeNull()
      expect(latest!.skill_id).toBe('author/skill-a')
      expect(latest!.content_hash).toBe('abc123hash')
      expect(latest!.semver).toBe('1.0.0')
    })

    it('should be idempotent — duplicate (skill_id, content_hash) is silently ignored', async () => {
      await repo.recordVersion('author/skill-a', 'abc123hash')
      await repo.recordVersion('author/skill-a', 'abc123hash')
      const history = await repo.getVersionHistory('author/skill-a', 50)
      expect(history.length).toBe(1)
    })

    it('should store different hashes for the same skill', async () => {
      await repo.recordVersion('author/skill-a', 'hash-v1')
      await repo.recordVersion('author/skill-a', 'hash-v2')
      const history = await repo.getVersionHistory('author/skill-a', 50)
      expect(history.length).toBe(2)
    })

    it('should store null semver when omitted', async () => {
      await repo.recordVersion('author/skill-a', 'hash-v1')
      const latest = await repo.getLatestVersion('author/skill-a')
      expect(latest!.semver).toBeNull()
    })

    it('should store optional metadata', async () => {
      const meta = JSON.stringify({ source: 'registry' })
      await repo.recordVersion('author/skill-a', 'hash-v1', '1.0.0', meta)
      const latest = await repo.getLatestVersion('author/skill-a')
      expect(latest!.metadata).toBe(meta)
    })
  })

  describe('getLatestVersion', () => {
    it('should return null when no versions recorded', async () => {
      const result = await repo.getLatestVersion('nonexistent/skill')
      expect(result).toBeNull()
    })

    it('should return the most recently recorded version', async () => {
      await repo.recordVersion('author/skill-a', 'hash-v1')
      // Backdate the first row so the second has a later recorded_at
      db.prepare(
        `UPDATE skill_versions SET recorded_at = recorded_at - 10 WHERE content_hash = ?`
      ).run('hash-v1')
      await repo.recordVersion('author/skill-a', 'hash-v2')
      const latest = await repo.getLatestVersion('author/skill-a')
      expect(latest!.content_hash).toBe('hash-v2')
    })

    it('should not return versions from a different skill', async () => {
      await repo.recordVersion('author/skill-b', 'hash-b')
      const result = await repo.getLatestVersion('author/skill-a')
      expect(result).toBeNull()
    })
  })

  describe('getVersionHistory', () => {
    it('should return empty array when no versions recorded', async () => {
      const history = await repo.getVersionHistory('nonexistent/skill')
      expect(history).toEqual([])
    })

    it('should return versions ordered newest first (DESC)', async () => {
      await repo.recordVersion('author/skill-a', 'hash-v1')
      db.prepare(
        `UPDATE skill_versions SET recorded_at = recorded_at - 10 WHERE content_hash = ?`
      ).run('hash-v1')
      await repo.recordVersion('author/skill-a', 'hash-v2')
      const history = await repo.getVersionHistory('author/skill-a')
      expect(history[0].content_hash).toBe('hash-v2')
      expect(history[1].content_hash).toBe('hash-v1')
    })

    it('should respect the limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        await repo.recordVersion('author/skill-a', `hash-v${i}`)
      }
      const history = await repo.getVersionHistory('author/skill-a', 3)
      expect(history.length).toBe(3)
    })

    it('should default to limit 20', async () => {
      for (let i = 0; i < 25; i++) {
        await repo.recordVersion('author/skill-a', `hash-v${i}`)
      }
      const history = await repo.getVersionHistory('author/skill-a')
      expect(history.length).toBe(20)
    })

    it('should only return versions for the requested skill', async () => {
      await repo.recordVersion('author/skill-a', 'hash-a')
      await repo.recordVersion('author/skill-b', 'hash-b')
      const history = await repo.getVersionHistory('author/skill-a')
      expect(history.length).toBe(1)
      expect(history[0].content_hash).toBe('hash-a')
    })
  })

  describe('getVersionByHash', () => {
    it('should return the matching row', async () => {
      await repo.recordVersion('author/skill-a', 'target-hash', '2.0.0')
      const row = await repo.getVersionByHash('author/skill-a', 'target-hash')
      expect(row).not.toBeNull()
      expect(row!.content_hash).toBe('target-hash')
      expect(row!.semver).toBe('2.0.0')
    })

    it('should return null when hash not found', async () => {
      const row = await repo.getVersionByHash('author/skill-a', 'nonexistent-hash')
      expect(row).toBeNull()
    })

    it('should return null when skill_id does not match', async () => {
      await repo.recordVersion('author/skill-a', 'shared-hash')
      const row = await repo.getVersionByHash('author/skill-b', 'shared-hash')
      expect(row).toBeNull()
    })
  })

  describe('pruneVersions', () => {
    it('should retain at most keepCount rows per skill', async () => {
      // Insert 55 distinct hashes
      for (let i = 0; i < 55; i++) {
        await repo.recordVersion('author/skill-a', `hash-${String(i).padStart(3, '0')}`)
      }
      await repo.pruneVersions('author/skill-a', 50)
      const history = await repo.getVersionHistory('author/skill-a', 100)
      expect(history.length).toBe(50)
    })

    it('should keep the most recent rows when pruning', async () => {
      for (let i = 0; i < 5; i++) {
        await repo.recordVersion('author/skill-a', `hash-${i}`)
        // Space out recorded_at so ordering is deterministic
        db.prepare(`UPDATE skill_versions SET recorded_at = ? WHERE content_hash = ?`).run(
          1000 + i,
          `hash-${i}`
        )
      }
      await repo.pruneVersions('author/skill-a', 3)
      const history = await repo.getVersionHistory('author/skill-a', 10)
      // Newest 3: hash-4, hash-3, hash-2
      const hashes = history.map((r) => r.content_hash)
      expect(hashes).toContain('hash-4')
      expect(hashes).toContain('hash-3')
      expect(hashes).toContain('hash-2')
      expect(hashes).not.toContain('hash-1')
      expect(hashes).not.toContain('hash-0')
    })

    it('should not prune when row count is below keepCount', async () => {
      await repo.recordVersion('author/skill-a', 'hash-v1')
      await repo.recordVersion('author/skill-a', 'hash-v2')
      await repo.pruneVersions('author/skill-a', 50)
      const history = await repo.getVersionHistory('author/skill-a', 100)
      expect(history.length).toBe(2)
    })

    it('should not affect other skills when pruning', async () => {
      for (let i = 0; i < 55; i++) {
        await repo.recordVersion('author/skill-a', `hash-a-${i}`)
      }
      await repo.recordVersion('author/skill-b', 'hash-b-1')
      await repo.pruneVersions('author/skill-a', 50)
      const historyB = await repo.getVersionHistory('author/skill-b', 100)
      expect(historyB.length).toBe(1)
    })
  })
})
