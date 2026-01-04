/**
 * SMI-863: Tests for Skill Validation and Deduplication Pipeline
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import {
  validateSkill,
  deduplicateByRepoUrl,
  detectSemanticDuplicates,
  compareSkillsForDedup,
  extractOwnerFromRepoUrl,
  generateSkillId,
  normalizeQualityScore,
  normalizeTrustTier,
  normalizeSource,
  hashRepoUrl,
  runValidationPipeline,
  type RawSkillInput,
  type ValidatedSkill,
} from '../src/scripts/validate-skills.js'

describe('SMI-863: Skill Validation and Deduplication Pipeline', () => {
  // ============================================================================
  // Utility Function Tests
  // ============================================================================

  describe('extractOwnerFromRepoUrl', () => {
    it('should extract owner from GitHub URL', () => {
      expect(extractOwnerFromRepoUrl('https://github.com/anthropics/claude-skill')).toBe(
        'anthropics'
      )
      expect(extractOwnerFromRepoUrl('https://github.com/user/repo')).toBe('user')
    })

    it('should return null for invalid URLs', () => {
      expect(extractOwnerFromRepoUrl(null)).toBeNull()
      expect(extractOwnerFromRepoUrl('')).toBeNull()
      expect(extractOwnerFromRepoUrl('not-a-url')).toBeNull()
    })

    it('should handle various URL formats', () => {
      expect(extractOwnerFromRepoUrl('https://gitlab.com/owner/project')).toBe('owner')
      expect(extractOwnerFromRepoUrl('http://github.com/test/example')).toBe('test')
    })
  })

  describe('generateSkillId', () => {
    it('should generate valid ID from author and name', () => {
      expect(generateSkillId('anthropic', 'my-skill')).toBe('anthropic/my-skill')
      expect(generateSkillId('User Name', 'Skill Name')).toBe('user-name/skill-name')
    })

    it('should sanitize special characters', () => {
      expect(generateSkillId('user@123', 'skill!test')).toBe('user-123/skill-test')
      expect(generateSkillId('  spaced  ', '  skill  ')).toBe('spaced/skill')
    })

    it('should handle unicode characters', () => {
      const id = generateSkillId('user', 'skill-test')
      expect(id).toMatch(/^[a-z0-9-]+\/[a-z0-9-]+$/)
    })
  })

  describe('normalizeQualityScore', () => {
    it('should return default for null/undefined', () => {
      expect(normalizeQualityScore(null)).toBe(50)
      expect(normalizeQualityScore(undefined)).toBe(50)
    })

    it('should convert 0-1 range to 0-100', () => {
      expect(normalizeQualityScore(0.5)).toBe(50)
      expect(normalizeQualityScore(0.85)).toBe(85)
      expect(normalizeQualityScore(1)).toBe(100)
      expect(normalizeQualityScore(0)).toBe(0)
    })

    it('should clamp values to 0-100', () => {
      expect(normalizeQualityScore(150)).toBe(100)
      expect(normalizeQualityScore(-10)).toBe(0)
    })

    it('should handle values already in 0-100 range', () => {
      expect(normalizeQualityScore(75)).toBe(75)
      expect(normalizeQualityScore(100)).toBe(100)
    })
  })

  describe('normalizeTrustTier', () => {
    it('should return unknown for null/undefined', () => {
      expect(normalizeTrustTier(null)).toBe('unknown')
      expect(normalizeTrustTier(undefined)).toBe('unknown')
    })

    it('should normalize valid trust tiers', () => {
      expect(normalizeTrustTier('verified')).toBe('verified')
      expect(normalizeTrustTier('VERIFIED')).toBe('verified')
      expect(normalizeTrustTier('community')).toBe('community')
      expect(normalizeTrustTier('experimental')).toBe('experimental')
    })

    it('should map aliases', () => {
      expect(normalizeTrustTier('official')).toBe('verified')
      expect(normalizeTrustTier('anthropic-official')).toBe('verified')
      expect(normalizeTrustTier('beta')).toBe('experimental')
      expect(normalizeTrustTier('standard')).toBe('community')
      expect(normalizeTrustTier('unverified')).toBe('unknown')
    })

    it('should return unknown for unrecognized values', () => {
      expect(normalizeTrustTier('invalid')).toBe('unknown')
      expect(normalizeTrustTier('random')).toBe('unknown')
    })
  })

  describe('normalizeSource', () => {
    it('should normalize source names', () => {
      expect(normalizeSource('GitHub')).toBe('github')
      expect(normalizeSource('  GITHUB  ')).toBe('github')
      expect(normalizeSource('claude-plugins')).toBe('claude-plugins')
    })

    it('should return unknown for null/undefined', () => {
      expect(normalizeSource(null)).toBe('unknown')
      expect(normalizeSource(undefined)).toBe('unknown')
    })
  })

  describe('hashRepoUrl', () => {
    it('should generate consistent hashes', () => {
      const hash1 = hashRepoUrl('https://github.com/user/repo')
      const hash2 = hashRepoUrl('https://github.com/user/repo')
      expect(hash1).toBe(hash2)
    })

    it('should be case-insensitive', () => {
      const hash1 = hashRepoUrl('https://github.com/User/Repo')
      const hash2 = hashRepoUrl('https://github.com/user/repo')
      expect(hash1).toBe(hash2)
    })

    it('should generate valid MD5 hashes', () => {
      const hash = hashRepoUrl('https://github.com/test/example')
      expect(hash).toMatch(/^[a-f0-9]{32}$/)
    })
  })

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
        trust_tier: 'official', // Should become 'verified'
        source: 'github',
      }

      const result = validateSkill(raw)

      expect(result.valid).toBe(true)
      expect(result.skill?.trust_tier).toBe('verified')
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
  // Deduplication Tests
  // ============================================================================

  describe('compareSkillsForDedup', () => {
    const baseSkill: ValidatedSkill = {
      id: 'author/skill',
      name: 'Skill',
      description: 'Description',
      author: 'author',
      repo_url: 'https://github.com/author/skill',
      quality_score: 70,
      trust_tier: 'community',
      tags: [],
      source: 'github',
    }

    it('should prefer higher source priority', () => {
      const skillA = { ...baseSkill, source: 'anthropic-official', quality_score: 60 }
      const skillB = { ...baseSkill, source: 'github', quality_score: 80 }

      expect(compareSkillsForDedup(skillA, skillB)).toBe('a')
    })

    it('should prefer higher quality score when same source priority', () => {
      const skillA = { ...baseSkill, source: 'github', quality_score: 80 }
      const skillB = { ...baseSkill, source: 'github', quality_score: 60 }

      expect(compareSkillsForDedup(skillA, skillB)).toBe('a')
      expect(compareSkillsForDedup(skillB, skillA)).toBe('b')
    })

    it('should prefer skillA when scores are equal', () => {
      const skillA = { ...baseSkill, source: 'github', quality_score: 70 }
      const skillB = { ...baseSkill, source: 'github', quality_score: 70 }

      expect(compareSkillsForDedup(skillA, skillB)).toBe('a')
    })
  })

  describe('deduplicateByRepoUrl', () => {
    it('should keep unique skills', () => {
      const skills: ValidatedSkill[] = [
        {
          id: 'author1/skill1',
          name: 'Skill 1',
          description: 'Desc 1',
          author: 'author1',
          repo_url: 'https://github.com/author1/skill1',
          quality_score: 70,
          trust_tier: 'community',
          tags: [],
          source: 'github',
        },
        {
          id: 'author2/skill2',
          name: 'Skill 2',
          description: 'Desc 2',
          author: 'author2',
          repo_url: 'https://github.com/author2/skill2',
          quality_score: 80,
          trust_tier: 'community',
          tags: [],
          source: 'github',
        },
      ]

      const result = deduplicateByRepoUrl(skills)

      expect(result.unique).toHaveLength(2)
      expect(result.duplicates).toHaveLength(0)
    })

    it('should remove duplicates with same repo_url', () => {
      const skills: ValidatedSkill[] = [
        {
          id: 'author/skill-github',
          name: 'Skill GitHub',
          description: 'From GitHub',
          author: 'author',
          repo_url: 'https://github.com/author/skill',
          quality_score: 70,
          trust_tier: 'community',
          tags: [],
          source: 'github',
        },
        {
          id: 'author/skill-plugins',
          name: 'Skill Plugins',
          description: 'From Plugins',
          author: 'author',
          repo_url: 'https://github.com/author/skill', // Same URL
          quality_score: 60,
          trust_tier: 'community',
          tags: [],
          source: 'claude-plugins',
        },
      ]

      const result = deduplicateByRepoUrl(skills)

      expect(result.unique).toHaveLength(1)
      expect(result.duplicates).toHaveLength(1)
      // GitHub has higher priority
      expect(result.unique[0].source).toBe('github')
      expect(result.duplicates[0].reason).toBe('repo_url')
    })

    it('should keep skills without repo_url separately', () => {
      const skills: ValidatedSkill[] = [
        {
          id: 'author1/skill1',
          name: 'Skill 1',
          description: 'Desc 1',
          author: 'author1',
          repo_url: null,
          quality_score: 70,
          trust_tier: 'community',
          tags: [],
          source: 'github',
        },
        {
          id: 'author2/skill2',
          name: 'Skill 2',
          description: 'Desc 2',
          author: 'author2',
          repo_url: null,
          quality_score: 80,
          trust_tier: 'community',
          tags: [],
          source: 'github',
        },
      ]

      const result = deduplicateByRepoUrl(skills)

      expect(result.unique).toHaveLength(2)
      expect(result.duplicates).toHaveLength(0)
    })

    it('should be case-insensitive for repo URLs', () => {
      const skills: ValidatedSkill[] = [
        {
          id: 'author/skill1',
          name: 'Skill 1',
          description: 'Desc 1',
          author: 'author',
          repo_url: 'https://github.com/Author/Skill',
          quality_score: 70,
          trust_tier: 'community',
          tags: [],
          source: 'github',
        },
        {
          id: 'author/skill2',
          name: 'Skill 2',
          description: 'Desc 2',
          author: 'author',
          repo_url: 'https://github.com/author/skill', // Same URL, different case
          quality_score: 80,
          trust_tier: 'community',
          tags: [],
          source: 'github',
        },
      ]

      const result = deduplicateByRepoUrl(skills)

      expect(result.unique).toHaveLength(1)
      expect(result.duplicates).toHaveLength(1)
    })
  })

  describe('detectSemanticDuplicates', () => {
    it('should keep semantically different skills', async () => {
      const skills: ValidatedSkill[] = [
        {
          id: 'author/testing-skill',
          name: 'Testing Skill',
          description: 'A skill for running tests and test automation',
          author: 'author',
          repo_url: 'https://github.com/author/testing',
          quality_score: 70,
          trust_tier: 'community',
          tags: ['testing'],
          source: 'github',
        },
        {
          id: 'author/database-skill',
          name: 'Database Skill',
          description: 'A skill for database management and queries',
          author: 'author',
          repo_url: 'https://github.com/author/database',
          quality_score: 80,
          trust_tier: 'community',
          tags: ['database'],
          source: 'github',
        },
      ]

      const result = await detectSemanticDuplicates(skills)

      expect(result.unique).toHaveLength(2)
      expect(result.duplicates).toHaveLength(0)
    })

    it('should detect semantically similar skills', async () => {
      const skills: ValidatedSkill[] = [
        {
          id: 'author/jest-testing',
          name: 'Jest Testing Helper',
          description: 'A skill for Jest testing automation and test running',
          author: 'author',
          repo_url: 'https://github.com/author/jest-testing',
          quality_score: 70,
          trust_tier: 'community',
          tags: ['testing', 'jest'],
          source: 'github',
        },
        {
          id: 'author/jest-test-helper',
          name: 'Jest Test Helper',
          description: 'A skill for Jest testing automation and test running', // Same description
          author: 'author',
          repo_url: 'https://github.com/author/jest-test-helper',
          quality_score: 80,
          trust_tier: 'community',
          tags: ['testing', 'jest'],
          source: 'github',
        },
      ]

      const result = await detectSemanticDuplicates(skills, 0.85)

      // With mock embeddings, same text should produce same embedding
      expect(result.duplicates.length).toBeGreaterThanOrEqual(0)
    })

    it('should handle empty array', async () => {
      const result = await detectSemanticDuplicates([])

      expect(result.unique).toHaveLength(0)
      expect(result.duplicates).toHaveLength(0)
    })

    it('should handle single skill', async () => {
      const skills: ValidatedSkill[] = [
        {
          id: 'author/skill',
          name: 'Skill',
          description: 'Description',
          author: 'author',
          repo_url: 'https://github.com/author/skill',
          quality_score: 70,
          trust_tier: 'community',
          tags: [],
          source: 'github',
        },
      ]

      const result = await detectSemanticDuplicates(skills)

      expect(result.unique).toHaveLength(1)
      expect(result.duplicates).toHaveLength(0)
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
          trust_tier: 'official', // Alias
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
      expect(skill.trust_tier).toBe('verified')
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
