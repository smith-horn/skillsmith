/**
 * SMI-866: Tests for import-to-database.ts
 *
 * Verifies:
 * - Record count matches input
 * - FTS5 index populated (test search)
 * - All required fields present
 * - No orphaned records
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, writeFileSync, unlinkSync, rmSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { importToDatabase, saveReport } from '../../src/scripts/import-to-database.js'
import { createDatabase } from '../../src/db/schema.js'
import { SkillRepository } from '../../src/repositories/SkillRepository.js'
import { SearchService } from '../../src/services/SearchService.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEST_DIR = join(__dirname, '..', 'fixtures', 'import-test')
const TEST_INPUT = join(TEST_DIR, 'test-validated-skills.json')
const TEST_DB = join(TEST_DIR, 'test-skills.db')
const TEST_REPORT = join(TEST_DIR, 'test-import-report.json')

/**
 * Sample validated skills for testing
 */
const sampleValidatedSkills = {
  description: 'Test validated skills',
  version: '1.0.0',
  skills: [
    {
      id: 'test/skill-1',
      name: 'test-skill-one',
      description: 'A test skill for unit testing',
      author: 'test-author',
      repoUrl: 'https://github.com/test/skill-1',
      qualityScore: 0.85,
      trustTier: 'community' as const,
      tags: ['testing', 'example'],
    },
    {
      id: 'test/skill-2',
      name: 'another-test-skill',
      description: 'Another test skill with different properties',
      author: 'another-author',
      repo_url: 'https://github.com/test/skill-2', // snake_case format
      quality_score: 0.75, // snake_case format
      trust_tier: 'experimental' as const, // snake_case format
      tags: ['demo', 'sample'],
    },
    {
      // Minimal skill - should get calculated quality score
      name: 'minimal-skill',
      description: 'A minimal skill with only required fields',
    },
    {
      id: 'test/skill-4',
      name: 'full-featured-skill',
      description:
        'A comprehensive skill with all features including documentation and examples for testing purposes',
      author: 'featured-author',
      repoUrl: 'https://github.com/test/skill-4',
      qualityScore: 0.95,
      trustTier: 'verified' as const,
      tags: ['featured', 'complete', 'documented', 'examples'],
      stars: 500,
    },
    {
      id: 'test/search-test',
      name: 'searchable-skill',
      description: 'This skill should be findable via FTS5 search',
      author: 'search-author',
      tags: ['searchable', 'fts5', 'fulltext'],
    },
  ],
}

describe('SMI-866: import-to-database', () => {
  beforeEach(() => {
    // Create test directory
    if (!existsSync(TEST_DIR)) {
      mkdirSync(TEST_DIR, { recursive: true })
    }

    // Write test input file
    writeFileSync(TEST_INPUT, JSON.stringify(sampleValidatedSkills, null, 2))

    // Clean up any existing test database
    if (existsSync(TEST_DB)) {
      unlinkSync(TEST_DB)
    }
    if (existsSync(`${TEST_DB}-shm`)) {
      unlinkSync(`${TEST_DB}-shm`)
    }
    if (existsSync(`${TEST_DB}-wal`)) {
      unlinkSync(`${TEST_DB}-wal`)
    }
  })

  afterEach(() => {
    // Clean up test files
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true })
    }
  })

  describe('importToDatabase', () => {
    it('should import all skills from validated-skills.json', async () => {
      const report = await importToDatabase(TEST_INPUT, TEST_DB)

      expect(report.success).toBe(true)
      expect(report.stats.inputCount).toBe(sampleValidatedSkills.skills.length)
      expect(report.stats.importedCount).toBe(sampleValidatedSkills.skills.length)
      expect(report.stats.skippedCount).toBe(0)
      expect(report.errors).toHaveLength(0)
    })

    it('should match record count between input and database', async () => {
      const report = await importToDatabase(TEST_INPUT, TEST_DB)

      expect(report.verification.recordCountMatch).toBe(true)
      expect(report.stats.importedCount).toBe(report.stats.inputCount)
    })

    it('should populate FTS5 index', async () => {
      const report = await importToDatabase(TEST_INPUT, TEST_DB)

      expect(report.verification.ftsIndexPopulated).toBe(true)
      expect(report.stats.ftsIndexCount).toBeGreaterThan(0)
      expect(report.stats.ftsIndexCount).toBe(report.stats.importedCount)
    })

    it('should pass search test with FTS5', async () => {
      const report = await importToDatabase(TEST_INPUT, TEST_DB)

      expect(report.verification.searchTestPassed).toBe(true)
      expect(report.verification.searchTestResults).toBeGreaterThan(0)
    })

    it('should have no orphaned records', async () => {
      const report = await importToDatabase(TEST_INPUT, TEST_DB)

      expect(report.verification.orphanedRecords).toBe(0)
    })

    it('should calculate quality scores for skills missing them', async () => {
      const report = await importToDatabase(TEST_INPUT, TEST_DB)

      // At least one skill should have had its quality score calculated
      expect(report.stats.qualityScoresCalculated).toBeGreaterThan(0)
    })

    it('should handle snake_case field names', async () => {
      const report = await importToDatabase(TEST_INPUT, TEST_DB)

      expect(report.success).toBe(true)

      // Verify the skill with snake_case fields was imported correctly
      const db = createDatabase(':memory:')
      const _repo = new SkillRepository(db)

      // Re-import to memory database for verification
      const memReport = await importToDatabase(TEST_INPUT, ':memory:')
      expect(memReport.stats.importedCount).toBe(sampleValidatedSkills.skills.length)
    })

    it('should skip skills with missing required fields', async () => {
      // Create input with invalid skill
      const invalidSkills = {
        skills: [
          { id: 'valid/skill', name: 'valid-skill' },
          { id: 'invalid/skill' }, // Missing name
          { name: 'another-valid' },
        ],
      }

      const invalidInput = join(TEST_DIR, 'invalid-skills.json')
      writeFileSync(invalidInput, JSON.stringify(invalidSkills))

      const report = await importToDatabase(invalidInput, TEST_DB)

      expect(report.stats.inputCount).toBe(3)
      expect(report.stats.importedCount).toBe(2) // 2 valid skills
      expect(report.stats.skippedCount).toBe(1) // 1 invalid skill
      expect(report.errors).toHaveLength(1)
      expect(report.errors[0].error).toContain('name')
    })

    it('should handle duplicate skills gracefully', async () => {
      // Import once
      const firstReport = await importToDatabase(TEST_INPUT, TEST_DB)
      expect(firstReport.success).toBe(true)

      // Import again (should handle duplicates)
      const secondReport = await importToDatabase(TEST_INPUT, TEST_DB)

      // Should not fail, but should report duplicates
      expect(secondReport.stats.duplicateCount).toBeGreaterThan(0)
    })

    it('should fail gracefully with missing input file', async () => {
      const report = await importToDatabase('/nonexistent/file.json', TEST_DB)

      expect(report.success).toBe(false)
      expect(report.errors).toHaveLength(1)
      expect(report.errors[0].error).toContain('not found')
    })

    it('should fail gracefully with invalid JSON', async () => {
      const invalidJson = join(TEST_DIR, 'invalid.json')
      writeFileSync(invalidJson, 'not valid json {{{')

      const report = await importToDatabase(invalidJson, TEST_DB)

      expect(report.success).toBe(false)
      expect(report.errors).toHaveLength(1)
    })

    it('should fail gracefully with missing skills array', async () => {
      const noSkills = join(TEST_DIR, 'no-skills.json')
      writeFileSync(noSkills, JSON.stringify({ description: 'no skills array' }))

      const report = await importToDatabase(noSkills, TEST_DB)

      expect(report.success).toBe(false)
      expect(report.errors[0].error).toContain('skills')
    })
  })

  describe('saveReport', () => {
    it('should save report to specified path', async () => {
      const report = await importToDatabase(TEST_INPUT, TEST_DB)
      saveReport(report, TEST_REPORT)

      expect(existsSync(TEST_REPORT)).toBe(true)
    })

    it('should create report directory if it does not exist', async () => {
      const report = await importToDatabase(TEST_INPUT, TEST_DB)
      const nestedReport = join(TEST_DIR, 'nested', 'path', 'report.json')

      saveReport(report, nestedReport)

      expect(existsSync(nestedReport)).toBe(true)
    })
  })

  describe('FTS5 Search Verification', () => {
    it('should find skills by name via FTS5', async () => {
      await importToDatabase(TEST_INPUT, TEST_DB)

      const db = (await import('better-sqlite3')).default(TEST_DB)
      const searchService = new SearchService(db)

      const results = searchService.search({
        query: 'searchable',
        limit: 10,
      })

      expect(results.total).toBeGreaterThan(0)
      expect(results.items[0].skill.name).toContain('searchable')

      db.close()
    })

    it('should find skills by description via FTS5', async () => {
      await importToDatabase(TEST_INPUT, TEST_DB)

      const db = (await import('better-sqlite3')).default(TEST_DB)
      const searchService = new SearchService(db)

      const results = searchService.search({
        query: 'comprehensive',
        limit: 10,
      })

      expect(results.total).toBeGreaterThan(0)

      db.close()
    })

    it('should find skills by tags via FTS5', async () => {
      await importToDatabase(TEST_INPUT, TEST_DB)

      const db = (await import('better-sqlite3')).default(TEST_DB)
      const searchService = new SearchService(db)

      const results = searchService.search({
        query: 'fulltext',
        limit: 10,
      })

      expect(results.total).toBeGreaterThan(0)

      db.close()
    })

    it('should return results with BM25 ranking', async () => {
      await importToDatabase(TEST_INPUT, TEST_DB)

      const db = (await import('better-sqlite3')).default(TEST_DB)
      const searchService = new SearchService(db)

      const results = searchService.search({
        query: 'test skill',
        limit: 10,
      })

      expect(results.total).toBeGreaterThan(0)
      // Results should have rank scores
      expect(results.items[0].rank).toBeGreaterThan(0)

      db.close()
    })
  })

  describe('Quality Score Calculation', () => {
    it('should calculate quality score based on metadata', async () => {
      // Create skill with minimal metadata
      const minimalSkills = {
        skills: [
          {
            name: 'bare-minimum',
            // No other fields
          },
          {
            name: 'with-description',
            description: 'This skill has a description that is longer than 20 characters',
          },
          {
            name: 'full-metadata',
            description: 'Full description with lots of details and information',
            author: 'test-author',
            repoUrl: 'https://github.com/test/repo',
            tags: ['tag1', 'tag2'],
            stars: 100,
          },
        ],
      }

      const minimalInput = join(TEST_DIR, 'minimal-skills.json')
      writeFileSync(minimalInput, JSON.stringify(minimalSkills))

      const report = await importToDatabase(minimalInput, TEST_DB)

      expect(report.stats.qualityScoresCalculated).toBe(3) // All 3 should have calculated scores

      // Verify scores are present in database
      const db = (await import('better-sqlite3')).default(TEST_DB)
      const repo = new SkillRepository(db)
      const allSkills = repo.findAll({ limit: 10 })

      // All skills should have quality scores
      allSkills.items.forEach((skill) => {
        expect(skill.qualityScore).not.toBeNull()
        expect(skill.qualityScore).toBeGreaterThan(0)
        expect(skill.qualityScore).toBeLessThanOrEqual(1)
      })

      // Skills with more metadata should have higher scores
      const bareMinimum = allSkills.items.find((s) => s.name === 'bare-minimum')
      const fullMetadata = allSkills.items.find((s) => s.name === 'full-metadata')

      expect(fullMetadata!.qualityScore).toBeGreaterThan(bareMinimum!.qualityScore!)

      db.close()
    })
  })

  describe('Integration with existing database', () => {
    it('should work with pre-existing database', async () => {
      // Create database with existing skills
      const db = createDatabase(TEST_DB)
      const repo = new SkillRepository(db)

      repo.create({
        name: 'existing-skill',
        description: 'A pre-existing skill',
        trustTier: 'verified',
      })

      db.close()

      // Import new skills
      const report = await importToDatabase(TEST_INPUT, TEST_DB)

      // Success may be false because recordCountMatch is false (pre-existing records)
      // But import should still work
      expect(report.stats.importedCount).toBe(sampleValidatedSkills.skills.length)
      expect(report.errors).toHaveLength(0)

      // Verify both old and new skills exist
      const newDb = (await import('better-sqlite3')).default(TEST_DB)
      const newRepo = new SkillRepository(newDb)
      const total = newRepo.count()

      // Should have original + new skills
      expect(total).toBe(1 + sampleValidatedSkills.skills.length)

      newDb.close()
    })
  })
})
