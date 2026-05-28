/**
 * SMI-863: Skill Validation Normalizer Function Tests
 */

import { describe, it, expect } from 'vitest'
import {
  extractOwnerFromRepoUrl,
  generateSkillId,
  normalizeQualityScore,
  normalizeTrustTier,
  normalizeSource,
  hashRepoUrl,
} from '../src/scripts/validate-skills.js'

describe('SMI-863: Skill Validation Normalizer Functions', () => {
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
    it('should return unverified for null/undefined', () => {
      expect(normalizeTrustTier(null)).toBe('unverified')
      expect(normalizeTrustTier(undefined)).toBe('unverified')
    })

    it('should normalize valid trust tiers', () => {
      expect(normalizeTrustTier('official')).toBe('official')
      expect(normalizeTrustTier('verified')).toBe('verified')
      expect(normalizeTrustTier('VERIFIED')).toBe('verified')
      expect(normalizeTrustTier('curated')).toBe('curated')
      expect(normalizeTrustTier('community')).toBe('community')
      expect(normalizeTrustTier('experimental')).toBe('experimental')
      expect(normalizeTrustTier('unverified')).toBe('unverified')
    })

    it('should map aliases', () => {
      expect(normalizeTrustTier('anthropic-official')).toBe('official')
      expect(normalizeTrustTier('beta')).toBe('experimental')
      expect(normalizeTrustTier('standard')).toBe('community')
      expect(normalizeTrustTier('unknown')).toBe('unverified')
    })

    it('should return unverified for unrecognized values', () => {
      expect(normalizeTrustTier('invalid')).toBe('unverified')
      expect(normalizeTrustTier('random')).toBe('unverified')
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
})
