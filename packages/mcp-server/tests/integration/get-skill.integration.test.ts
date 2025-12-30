/**
 * SMI-616: Get Skill Tool Integration Tests
 * Tests the get_skill tool with a real SQLite database
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestDatabase, type TestDatabaseContext } from './setup.js'

describe('Get Skill Tool Integration Tests', () => {
  let dbContext: TestDatabaseContext

  beforeAll(async () => {
    dbContext = await createTestDatabase()
  })

  afterAll(async () => {
    await dbContext.cleanup()
  })

  describe('Retrieve Skill by ID', () => {
    it('should retrieve existing skill by full ID', () => {
      const skill = dbContext.skillRepository.findById('anthropic/commit')

      expect(skill).not.toBeNull()
      expect(skill?.id).toBe('anthropic/commit')
      expect(skill?.name).toBe('commit')
      expect(skill?.author).toBe('anthropic')
    })

    it('should return null for non-existent skill ID', () => {
      const skill = dbContext.skillRepository.findById('nonexistent/skill')

      expect(skill).toBeNull()
    })

    it('should retrieve skill with all metadata fields', () => {
      const skill = dbContext.skillRepository.findById('anthropic/commit')

      expect(skill).not.toBeNull()
      expect(skill).toMatchObject({
        id: expect.any(String),
        name: expect.any(String),
        description: expect.any(String),
        author: expect.any(String),
        repoUrl: expect.any(String),
        qualityScore: expect.any(Number),
        trustTier: expect.stringMatching(/^(verified|community|experimental|unknown)$/),
        tags: expect.any(Array),
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      })
    })
  })

  describe('Retrieve Skill by Repository URL', () => {
    it('should find skill by repo URL', () => {
      const skill = dbContext.skillRepository.findByRepoUrl(
        'https://github.com/anthropics/claude-code-skills/commit'
      )

      expect(skill).not.toBeNull()
      expect(skill?.id).toBe('anthropic/commit')
    })

    it('should return null for non-existent repo URL', () => {
      const skill = dbContext.skillRepository.findByRepoUrl(
        'https://github.com/fake/nonexistent-repo'
      )

      expect(skill).toBeNull()
    })
  })

  describe('Skill Tags', () => {
    it('should return tags as an array', () => {
      const skill = dbContext.skillRepository.findById('anthropic/commit')

      expect(skill).not.toBeNull()
      expect(Array.isArray(skill?.tags)).toBe(true)
      expect(skill?.tags.length).toBeGreaterThan(0)
    })

    it('should have correct tag values', () => {
      const skill = dbContext.skillRepository.findById('anthropic/commit')

      expect(skill?.tags).toContain('git')
      expect(skill?.tags).toContain('commit')
    })
  })

  describe('Trust Tier Validation', () => {
    it('should have valid trust tier for verified skills', () => {
      const skill = dbContext.skillRepository.findById('anthropic/commit')

      expect(skill?.trustTier).toBe('verified')
    })

    it('should have valid trust tier for community skills', () => {
      const skill = dbContext.skillRepository.findById('community/jest-helper')

      expect(skill?.trustTier).toBe('community')
    })

    it('should have valid trust tier for experimental skills', () => {
      const skill = dbContext.skillRepository.findById('community/api-docs')

      expect(skill?.trustTier).toBe('experimental')
    })

    it('should have valid trust tier for unknown skills', () => {
      const skill = dbContext.skillRepository.findById('test/typescript-helper')

      expect(skill?.trustTier).toBe('unknown')
    })
  })

  describe('Quality Score', () => {
    it('should have quality score between 0 and 1', () => {
      const skill = dbContext.skillRepository.findById('anthropic/commit')

      expect(skill?.qualityScore).toBeGreaterThanOrEqual(0)
      expect(skill?.qualityScore).toBeLessThanOrEqual(1)
    })

    it('should have higher scores for verified skills', () => {
      const verifiedSkill = dbContext.skillRepository.findById('anthropic/commit')
      const unknownSkill = dbContext.skillRepository.findById('test/typescript-helper')

      expect(verifiedSkill?.qualityScore).toBeGreaterThan(unknownSkill?.qualityScore ?? 0)
    })
  })

  describe('Skill Existence Check', () => {
    it('should return true for existing skill', () => {
      const exists = dbContext.skillRepository.exists('anthropic/commit')

      expect(exists).toBe(true)
    })

    it('should return false for non-existent skill', () => {
      const exists = dbContext.skillRepository.exists('fake/nonexistent')

      expect(exists).toBe(false)
    })
  })

  describe('List All Skills', () => {
    it('should return paginated list of skills', () => {
      const results = dbContext.skillRepository.findAll(10, 0)

      expect(results.items.length).toBeGreaterThan(0)
      expect(results.total).toBeGreaterThan(0)
      expect(results.limit).toBe(10)
      expect(results.offset).toBe(0)
    })

    it('should respect limit parameter', () => {
      const results = dbContext.skillRepository.findAll(2, 0)

      expect(results.items.length).toBeLessThanOrEqual(2)
    })

    it('should support pagination with offset', () => {
      const page1 = dbContext.skillRepository.findAll(2, 0)
      const page2 = dbContext.skillRepository.findAll(2, 2)

      if (page1.total > 2 && page2.items.length > 0) {
        const page1Ids = page1.items.map((s) => s.id)
        const page2Ids = page2.items.map((s) => s.id)
        expect(page1Ids).not.toEqual(page2Ids)
      }
    })

    it('should indicate hasMore correctly', () => {
      const results = dbContext.skillRepository.findAll(1, 0)

      if (results.total > 1) {
        expect(results.hasMore).toBe(true)
      }
    })
  })

  describe('Skill Count', () => {
    it('should return total number of skills', () => {
      const count = dbContext.skillRepository.count()

      expect(count).toBeGreaterThan(0)
      expect(count).toBe(7) // We seeded 7 test skills
    })
  })

  describe('Edge Cases', () => {
    it('should handle skill ID with special characters', () => {
      // The repository should handle this gracefully
      const skill = dbContext.skillRepository.findById('some/skill-with-dashes')

      expect(skill).toBeNull() // Doesn't exist but shouldn't throw
    })

    it('should handle empty string ID', () => {
      const skill = dbContext.skillRepository.findById('')

      expect(skill).toBeNull()
    })

    it('should handle very long ID', () => {
      const longId = 'a'.repeat(500) + '/' + 'b'.repeat(500)
      const skill = dbContext.skillRepository.findById(longId)

      expect(skill).toBeNull()
    })
  })

  describe('Upsert Operations', () => {
    it('should create new skill if not exists', () => {
      const newSkill = dbContext.skillRepository.upsert({
        id: 'integration-test/new-skill',
        name: 'new-skill',
        description: 'A new skill for integration testing',
        author: 'integration-test',
        repoUrl: 'https://github.com/integration-test/new-skill',
        qualityScore: 0.75,
        trustTier: 'experimental',
        tags: ['test', 'integration'],
      })

      expect(newSkill.id).toBe('integration-test/new-skill')
      expect(newSkill.name).toBe('new-skill')
    })

    it('should update existing skill on upsert', () => {
      // First create
      dbContext.skillRepository.upsert({
        id: 'integration-test/upsert-test',
        name: 'upsert-test',
        description: 'Original description',
        author: 'integration-test',
        repoUrl: 'https://github.com/integration-test/upsert-test',
        qualityScore: 0.5,
        trustTier: 'unknown',
        tags: ['original'],
      })

      // Then update via upsert
      const updated = dbContext.skillRepository.upsert({
        name: 'upsert-test-updated',
        description: 'Updated description',
        repoUrl: 'https://github.com/integration-test/upsert-test',
        qualityScore: 0.8,
        trustTier: 'community',
        tags: ['updated'],
      })

      expect(updated.name).toBe('upsert-test-updated')
      expect(updated.description).toBe('Updated description')
      expect(updated.qualityScore).toBe(0.8)
    })
  })
})
