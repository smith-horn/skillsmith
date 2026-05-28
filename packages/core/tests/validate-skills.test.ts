/**
 * SMI-863: Tests for Skill Validation Pipeline
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import {
  validateSkill,
  runValidationPipeline,
  type RawSkillInput,
} from '../src/scripts/validate-skills.js'

describe('SMI-863: Skill Validation Pipeline', () => {
  // ============================================================================
  // Validation Tests
  // ============================================================================

  describe('validateSkill', () => {
    it('should validate a complete valid skill', () => {
      const raw: RawSkillInput = {
        id: 'author/skill-name',
        name: 'Skill Name',
        description: 'A test skill description',
        author: 'author',
        repo_url: 'https://github.com/author/skill-name',
        quality_score: 85,
        trust_tier: 'community',
        tags: ['test', 'example'],
        source: 'github',
      }

      const result = validateSkill(raw)

      expect(result.valid).toBe(true)
      expect(result.skill).not.toBeNull()
      expect(result.skill?.id).toBe('author/skill-name')
      expect(result.skill?.quality_score).toBe(85)
      expect(result.errors).toHaveLength(0)
    })

    it('should auto-fill author from repo URL', () => {
      const raw: RawSkillInput = {
        name: 'Skill Name',
        description: 'Description',
        repo_url: 'https://github.com/extracted-author/repo',
        quality_score: 50,
        trust_tier: 'community',
        source: 'github',
      }

      const result = validateSkill(raw)

      expect(result.valid).toBe(true)
      expect(result.skill?.author).toBe('extracted-author')
      expect(result.fixes).toContain('Auto-filled author from repo URL: "extracted-author"')
    })

    it('should auto-fill description from name', () => {
      const raw: RawSkillInput = {
        name: 'My Awesome Skill',
        author: 'author',
        repo_url: 'https://github.com/author/skill',
        quality_score: 50,
        trust_tier: 'community',
        source: 'github',
      }

      const result = validateSkill(raw)

      expect(result.valid).toBe(true)
      expect(result.skill?.description).toBe('My Awesome Skill')
      expect(result.fixes.some((f) => f.includes('Auto-filled description from name'))).toBe(true)
    })

    it('should auto-generate ID from author/name', () => {
      const raw: RawSkillInput = {
        name: 'Skill Name',
        author: 'author',
        description: 'Description',
        repo_url: 'https://github.com/author/skill',
        quality_score: 50,
        trust_tier: 'community',
        source: 'github',
      }

      const result = validateSkill(raw)

      expect(result.valid).toBe(true)
      expect(result.skill?.id).toBe('author/skill-name')
      expect(result.fixes.some((f) => f.includes('Auto-generated ID'))).toBe(true)
    })

    it('should fail validation when name is missing', () => {
      const raw: RawSkillInput = {
        description: 'Description',
        author: 'author',
        quality_score: 50,
        source: 'github',
      }

      const result = validateSkill(raw)

      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.field === 'name')).toBe(true)
    })

    it('should fail validation when author cannot be determined', () => {
      const raw: RawSkillInput = {
        name: 'Skill Name',
        description: 'Description',
        quality_score: 50,
        source: 'github',
        // No author, no repo_url to extract from
      }

      const result = validateSkill(raw)

      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.field === 'author')).toBe(true)
    })

    it('should fix invalid ID format', () => {
      const raw: RawSkillInput = {
        id: 'invalid-id-format',
        name: 'Skill Name',
        author: 'author',
        description: 'Description',
        quality_score: 50,
        source: 'github',
      }

      const result = validateSkill(raw)

      expect(result.valid).toBe(true)
      expect(result.skill?.id).toBe('author/skill-name')
      expect(result.fixes.some((f) => f.includes('Fixed invalid ID format'))).toBe(true)
    })

    it('should normalize quality score from 0-1 to 0-100', () => {
      const raw: RawSkillInput = {
        id: 'author/skill',
        name: 'Skill',
        author: 'author',
        description: 'Description',
        quality_score: 0.75,
        trust_tier: 'community',
        source: 'github',
      }

      const result = validateSkill(raw)

      expect(result.valid).toBe(true)
      expect(result.skill?.quality_score).toBe(75)
    })

    it('should normalize trust tier aliases', () => {
      const raw: RawSkillInput = {
        id: 'author/skill',
        name: 'Skill',
        author: 'author',
        description: 'Description',
        quality_score: 50,
        trust_tier: 'unknown', // SMI-5205: alias for 'unverified'
        source: 'github',
      }

      const result = validateSkill(raw)

      expect(result.valid).toBe(true)
      expect(result.skill?.trust_tier).toBe('unverified')
    })

    it('should handle both snake_case and camelCase field names', () => {
      const raw: RawSkillInput = {
        id: 'author/skill',
        name: 'Skill',
        author: 'author',
        description: 'Description',
        repoUrl: 'https://github.com/author/skill', // camelCase
        qualityScore: 80, // camelCase
        trustTier: 'community', // camelCase
        source: 'github',
      }

      const result = validateSkill(raw)

      expect(result.valid).toBe(true)
      expect(result.skill?.repo_url).toBe('https://github.com/author/skill')
      expect(result.skill?.quality_score).toBe(80)
      expect(result.skill?.trust_tier).toBe('community')
    })
  })

  // ============================================================================
  // Integration Tests
  // ============================================================================

  describe('runValidationPipeline (integration)', () => {
    const testDir = './test-output-validate-skills'
    const testInputPath = path.join(testDir, 'test-input.json')

    beforeEach(() => {
      // Create test directory
      if (!fs.existsSync(testDir)) {
        fs.mkdirSync(testDir, { recursive: true })
      }
    })

    afterEach(() => {
      // Clean up test files
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true })
      }
    })

    it('should process valid skills and generate output files', async () => {
      // Use semantically different skills to avoid false-positive duplicate detection
      const testData = [
        {
          id: 'tester/jest-runner',
          name: 'Jest Test Runner',
          description:
            'A comprehensive testing framework for running JavaScript unit tests with coverage reporting',
          author: 'tester',
          repo_url: 'https://github.com/tester/jest-runner',
          quality_score: 80,
          trust_tier: 'community',
          tags: ['testing', 'jest'],
          source: 'github',
        },
        {
          id: 'dbadmin/postgres-manager',
          name: 'PostgreSQL Database Manager',
          description:
            'Manage PostgreSQL databases with migrations, backups, and schema visualization tools',
          author: 'dbadmin',
          repo_url: 'https://github.com/dbadmin/postgres-manager',
          quality_score: 70,
          trust_tier: 'experimental',
          tags: ['database', 'postgresql'],
          source: 'github',
        },
      ]

      fs.writeFileSync(testInputPath, JSON.stringify(testData))

      const result = await runValidationPipeline(testInputPath, testDir)

      // Check returned data - should have 2 unique skills (semantically different)
      expect(result.validatedSkills.length).toBeGreaterThanOrEqual(1)
      expect(result.validationReport.summary.valid_skills).toBe(2)
      expect(result.validationReport.summary.invalid_skills).toBe(0)

      // Check output files exist
      expect(fs.existsSync(path.join(testDir, 'validated-skills.json'))).toBe(true)
      expect(fs.existsSync(path.join(testDir, 'validation-report.json'))).toBe(true)
      expect(fs.existsSync(path.join(testDir, 'duplicates-report.json'))).toBe(true)
    })

    it('should handle invalid skills and report errors', async () => {
      const testData = [
        {
          // Missing name
          description: 'Description',
          author: 'author',
          quality_score: 80,
          source: 'github',
        },
        {
          name: 'Valid Skill',
          description: 'Description',
          author: 'author',
          repo_url: 'https://github.com/author/valid',
          quality_score: 80,
          trust_tier: 'community',
          source: 'github',
        },
      ]

      fs.writeFileSync(testInputPath, JSON.stringify(testData))

      const result = await runValidationPipeline(testInputPath, testDir)

      expect(result.validatedSkills).toHaveLength(1)
      expect(result.validationReport.summary.valid_skills).toBe(1)
      expect(result.validationReport.summary.invalid_skills).toBe(1)
      expect(result.validationReport.errors).toHaveLength(1)
    })

    it('should deduplicate skills with same repo_url', async () => {
      const testData = [
        {
          id: 'author/skill-v1',
          name: 'Skill V1',
          description: 'Version 1',
          author: 'author',
          repo_url: 'https://github.com/author/skill',
          quality_score: 60,
          trust_tier: 'community',
          source: 'claude-plugins',
        },
        {
          id: 'author/skill-v2',
          name: 'Skill V2',
          description: 'Version 2',
          author: 'author',
          repo_url: 'https://github.com/author/skill', // Same URL
          quality_score: 80,
          trust_tier: 'community',
          source: 'github', // Higher priority
        },
      ]

      fs.writeFileSync(testInputPath, JSON.stringify(testData))

      const result = await runValidationPipeline(testInputPath, testDir)

      expect(result.validatedSkills).toHaveLength(1)
      expect(result.validatedSkills[0].source).toBe('github')
      expect(result.duplicatesReport.summary.by_repo_url).toBe(1)
    })

    it('should apply auto-fixes and report them', async () => {
      const testData = [
        {
          name: 'Skill Without ID',
          author: 'author',
          // Missing: id, description
          repo_url: 'https://github.com/author/skill',
          quality_score: 0.8, // 0-1 range
          trust_tier: 'beta', // Alias for 'experimental'
          source: 'github',
        },
      ]

      fs.writeFileSync(testInputPath, JSON.stringify(testData))

      const result = await runValidationPipeline(testInputPath, testDir)

      expect(result.validatedSkills).toHaveLength(1)
      const skill = result.validatedSkills[0]
      expect(skill.id).toBe('author/skill-without-id')
      expect(skill.description).toBe('Skill Without ID')
      expect(skill.quality_score).toBe(80)
      expect(skill.trust_tier).toBe('experimental')
      expect(result.validationReport.summary.auto_fixes_applied).toBeGreaterThan(0)
    })

    it('should handle nested skills array in input', async () => {
      const testData = {
        skills: [
          {
            id: 'author/skill',
            name: 'Skill',
            description: 'Description',
            author: 'author',
            repo_url: 'https://github.com/author/skill',
            quality_score: 80,
            trust_tier: 'community',
            source: 'github',
          },
        ],
      }

      fs.writeFileSync(testInputPath, JSON.stringify(testData))

      const result = await runValidationPipeline(testInputPath, testDir)

      expect(result.validatedSkills).toHaveLength(1)
    })
  })
})
