/**
 * @fileoverview Unit tests for skill_audit MCP tool
 * @see SMI-skill-version-tracking Wave 3
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AdvisoryRepository } from '@skillsmith/core'
import { createTestDatabase, closeDatabase } from '../../../core/tests/helpers/database.js'
import { executeSkillAudit } from './skill-audit.js'
import type { ToolContext } from '../context.js'
import type { SkillAdvisory } from '@skillsmith/core'
import type { Database as DatabaseType } from '../../../core/src/db/database-interface.js'

// ============================================================================
// Helpers
// ============================================================================

function makeAdvisory(overrides: Partial<SkillAdvisory> = {}): SkillAdvisory {
  return {
    id: 'SSA-2026-001',
    skillId: 'community/commit-helper',
    severity: 'high',
    title: 'Prompt injection in commit-helper',
    description: 'A security advisory for testing.',
    publishedAt: '2026-01-15T00:00:00Z',
    ...overrides,
  }
}

function makeContext(db: DatabaseType): ToolContext {
  return { db } as unknown as ToolContext
}

// ============================================================================
// Tests
// ============================================================================

describe('executeSkillAudit', () => {
  let db: DatabaseType
  let advisoryRepo: AdvisoryRepository

  beforeEach(() => {
    db = createTestDatabase()
    advisoryRepo = new AdvisoryRepository(db)
  })

  afterEach(() => {
    closeDatabase(db)
  })

  // --------------------------------------------------------------------------
  // Empty database — early-access message
  // --------------------------------------------------------------------------

  it('returns advisoriesAvailable: false with early-access message when DB has no advisories', async () => {
    const result = await executeSkillAudit({}, makeContext(db))

    expect(result.advisoriesAvailable).toBe(false)
    expect(result.message).toContain('early access')
    expect(result.message).toContain('skillsmith sync')
    expect(result.summary).toBeUndefined()
    expect(result.advisories).toBeUndefined()
  })

  // --------------------------------------------------------------------------
  // With advisories
  // --------------------------------------------------------------------------

  it('returns advisoriesAvailable: true with summary and entries when advisories exist', async () => {
    advisoryRepo.upsertAdvisory(makeAdvisory({ id: 'SSA-2026-001', severity: 'critical' }))
    advisoryRepo.upsertAdvisory(
      makeAdvisory({ id: 'SSA-2026-002', severity: 'high', skillId: 'community/other-skill' })
    )

    const result = await executeSkillAudit({}, makeContext(db))

    expect(result.advisoriesAvailable).toBe(true)
    expect(result.message).toBeUndefined()
    expect(result.summary).toBeDefined()
    expect(result.summary!.total).toBe(2)
    expect(result.summary!.critical).toBe(1)
    expect(result.summary!.high).toBe(1)
    expect(result.summary!.medium).toBe(0)
    expect(result.summary!.low).toBe(0)
    expect(result.advisories).toHaveLength(2)
  })

  it('sets fixAvailable: true when patchedVersions is present', async () => {
    advisoryRepo.upsertAdvisory(makeAdvisory({ patchedVersions: '[">=1.2.0"]' }))

    const result = await executeSkillAudit({}, makeContext(db))

    expect(result.advisories![0].fixAvailable).toBe(true)
  })

  it('sets fixAvailable: false when patchedVersions is absent', async () => {
    advisoryRepo.upsertAdvisory(makeAdvisory())

    const result = await executeSkillAudit({}, makeContext(db))

    expect(result.advisories![0].fixAvailable).toBe(false)
  })

  // --------------------------------------------------------------------------
  // skillIds filter
  // --------------------------------------------------------------------------

  it('filters by skillIds when provided', async () => {
    advisoryRepo.upsertAdvisory(makeAdvisory({ id: 'SSA-2026-010', skillId: 'community/skill-a' }))
    advisoryRepo.upsertAdvisory(makeAdvisory({ id: 'SSA-2026-011', skillId: 'community/skill-b' }))

    const result = await executeSkillAudit({ skillIds: ['community/skill-a'] }, makeContext(db))

    expect(result.advisoriesAvailable).toBe(true)
    expect(result.advisories).toHaveLength(1)
    expect(result.advisories![0].skillName).toBe('community/skill-a')
  })

  it('returns early-access message when skillIds filter matches no advisories', async () => {
    advisoryRepo.upsertAdvisory(makeAdvisory({ skillId: 'community/skill-a' }))

    const result = await executeSkillAudit({ skillIds: ['community/nonexistent'] }, makeContext(db))

    expect(result.advisoriesAvailable).toBe(false)
    expect(result.message).toContain('early access')
  })

  // --------------------------------------------------------------------------
  // Withdrawn advisories excluded
  // --------------------------------------------------------------------------

  it('excludes withdrawn advisories from results', async () => {
    advisoryRepo.upsertAdvisory(makeAdvisory({ id: 'SSA-2026-020' }))
    advisoryRepo.withdrawAdvisory('SSA-2026-020')

    const result = await executeSkillAudit({}, makeContext(db))

    expect(result.advisoriesAvailable).toBe(false)
  })

  // --------------------------------------------------------------------------
  // Advisory entry fields
  // --------------------------------------------------------------------------

  it('maps advisory fields correctly to entry shape', async () => {
    advisoryRepo.upsertAdvisory(
      makeAdvisory({
        id: 'SSA-2026-030',
        skillId: 'community/commit-helper',
        severity: 'critical',
        title: 'Test advisory',
      })
    )

    const result = await executeSkillAudit({}, makeContext(db))
    const entry = result.advisories![0]

    expect(entry.id).toBe('SSA-2026-030')
    expect(entry.skillName).toBe('community/commit-helper')
    expect(entry.severity).toBe('critical')
    expect(entry.title).toBe('Test advisory')
  })
})
