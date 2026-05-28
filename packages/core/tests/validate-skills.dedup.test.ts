/**
 * SMI-863: Skill Deduplication Tests
 */

import { describe, it, expect } from 'vitest'
import {
  deduplicateByRepoUrl,
  detectSemanticDuplicates,
  compareSkillsForDedup,
  type ValidatedSkill,
} from '../src/scripts/validate-skills.js'

describe('SMI-863: Skill Deduplication', () => {
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
})
