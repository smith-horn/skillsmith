/**
 * @fileoverview Unit tests for AdvisoryRepository
 * @see SMI-skill-version-tracking Wave 3
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, closeDatabase } from '../../tests/helpers/database.js'
import { AdvisoryRepository, type SkillAdvisory } from './AdvisoryRepository.js'
import type { Database as DatabaseType } from '../db/database-interface.js'

// ============================================================================
// Test helpers
// ============================================================================

function makeAdvisory(overrides: Partial<SkillAdvisory> = {}): SkillAdvisory {
  return {
    id: 'SSA-2026-001',
    skillId: 'community/commit-helper',
    severity: 'high',
    title: 'Prompt injection in commit-helper',
    description: 'Maliciously crafted commit messages can inject arbitrary prompts.',
    publishedAt: '2026-01-15T00:00:00Z',
    ...overrides,
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('AdvisoryRepository', () => {
  let db: DatabaseType
  let repo: AdvisoryRepository

  beforeEach(() => {
    db = createTestDatabase()
    repo = new AdvisoryRepository(db)
  })

  afterEach(() => {
    closeDatabase(db)
  })

  // --------------------------------------------------------------------------
  // upsertAdvisory
  // --------------------------------------------------------------------------

  describe('upsertAdvisory', () => {
    it('creates a new advisory record', () => {
      const advisory = makeAdvisory()
      repo.upsertAdvisory(advisory)

      const results = repo.getAdvisoriesForSkill('community/commit-helper')
      expect(results).toHaveLength(1)
      expect(results[0].id).toBe('SSA-2026-001')
      expect(results[0].severity).toBe('high')
      expect(results[0].title).toBe('Prompt injection in commit-helper')
    })

    it('replaces an existing advisory on re-upsert (idempotent)', () => {
      repo.upsertAdvisory(makeAdvisory({ title: 'Original title' }))
      repo.upsertAdvisory(makeAdvisory({ title: 'Updated title' }))

      const results = repo.getAdvisoriesForSkill('community/commit-helper')
      expect(results).toHaveLength(1)
      expect(results[0].title).toBe('Updated title')
    })

    it('stores optional JSON fields correctly', () => {
      const advisory = makeAdvisory({
        affectedVersions: '["<1.2.0"]',
        patchedVersions: '[">=1.2.0"]',
        cweIds: '["CWE-77"]',
        advisoryRefs: '["https://example.com/advisory"]',
      })
      repo.upsertAdvisory(advisory)

      const results = repo.getAdvisoriesForSkill('community/commit-helper')
      expect(results[0]!.affectedVersions).toBe('["<1.2.0"]')
      expect(results[0]!.patchedVersions).toBe('[">=1.2.0"]')
      expect(results[0]!.cweIds).toBe('["CWE-77"]')
      expect(results[0]!.advisoryRefs).toBe('["https://example.com/advisory"]')
    })
  })

  // --------------------------------------------------------------------------
  // getAdvisoriesForSkill
  // --------------------------------------------------------------------------

  describe('getAdvisoriesForSkill', () => {
    it('returns only active (non-withdrawn) advisories for the given skill', () => {
      repo.upsertAdvisory(makeAdvisory({ id: 'SSA-2026-001', skillId: 'community/commit-helper' }))
      repo.upsertAdvisory(makeAdvisory({ id: 'SSA-2026-002', skillId: 'community/commit-helper' }))
      repo.upsertAdvisory(makeAdvisory({ id: 'SSA-2026-003', skillId: 'community/other-skill' }))

      // Withdraw SSA-2026-001
      repo.withdrawAdvisory('SSA-2026-001')

      const results = repo.getAdvisoriesForSkill('community/commit-helper')
      expect(results).toHaveLength(1)
      expect(results[0].id).toBe('SSA-2026-002')
    })

    it('returns empty array when skill has no advisories', () => {
      const results = repo.getAdvisoriesForSkill('community/nonexistent')
      expect(results).toHaveLength(0)
    })

    it('does not return advisories for other skills', () => {
      repo.upsertAdvisory(makeAdvisory({ id: 'SSA-2026-004', skillId: 'community/other-skill' }))

      const results = repo.getAdvisoriesForSkill('community/commit-helper')
      expect(results).toHaveLength(0)
    })
  })

  // --------------------------------------------------------------------------
  // getActiveAdvisories
  // --------------------------------------------------------------------------

  describe('getActiveAdvisories', () => {
    beforeEach(() => {
      repo.upsertAdvisory(
        makeAdvisory({ id: 'SSA-2026-010', severity: 'critical', skillId: 'community/skill-a' })
      )
      repo.upsertAdvisory(
        makeAdvisory({ id: 'SSA-2026-011', severity: 'high', skillId: 'community/skill-b' })
      )
      repo.upsertAdvisory(
        makeAdvisory({ id: 'SSA-2026-012', severity: 'medium', skillId: 'community/skill-c' })
      )
      repo.upsertAdvisory(
        makeAdvisory({ id: 'SSA-2026-013', severity: 'low', skillId: 'community/skill-d' })
      )
      repo.upsertAdvisory(
        makeAdvisory({ id: 'SSA-2026-014', severity: 'high', skillId: 'community/skill-e' })
      )
      // Withdraw one of the high advisories
      repo.withdrawAdvisory('SSA-2026-014')
    })

    it('returns all active advisories when no severity filter', () => {
      const results = repo.getActiveAdvisories()
      // 4 active (SSA-2026-010 through SSA-2026-013), SSA-2026-014 is withdrawn
      expect(results).toHaveLength(4)
    })

    it('filters by severity when provided', () => {
      const highs = repo.getActiveAdvisories('high')
      expect(highs).toHaveLength(1)
      expect(highs[0].id).toBe('SSA-2026-011')
    })

    it('returns active advisories for the given severity', () => {
      const results = repo.getActiveAdvisories('critical')
      // SSA-2026-010 is still active
      expect(results).toHaveLength(1)
      expect(results[0].id).toBe('SSA-2026-010')
    })

    it('does not return withdrawn advisories in unfiltered results', () => {
      const results = repo.getActiveAdvisories()
      const ids = results.map((r) => r.id)
      expect(ids).not.toContain('SSA-2026-014')
    })
  })

  // --------------------------------------------------------------------------
  // withdrawAdvisory
  // --------------------------------------------------------------------------

  describe('withdrawAdvisory', () => {
    it('sets withdrawn_at on the advisory', () => {
      repo.upsertAdvisory(makeAdvisory({ id: 'SSA-2026-020' }))

      // Advisory should be active before withdrawal
      const before = repo.getAdvisoriesForSkill('community/commit-helper')
      expect(before).toHaveLength(1)

      repo.withdrawAdvisory('SSA-2026-020')

      // Advisory should no longer appear in active queries
      const after = repo.getAdvisoriesForSkill('community/commit-helper')
      expect(after).toHaveLength(0)
    })

    it('is a no-op for non-existent advisory id', () => {
      // Should not throw
      expect(() => repo.withdrawAdvisory('SSA-9999-999')).not.toThrow()
    })
  })
})
