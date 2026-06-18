/**
 * Tests for Per-Skill GitHub Tree URL Builder (SMI-5286 Wave 1a C-1)
 *
 * The `buildSkillTreeUrl` function constructs distinct per-skill tree URLs for
 * the upsert dedup fix. The only unique constraint is `skills.repo_url`, and the
 * upsert target is the per-skill tree URL, not the bare repo root.
 */

import { describe, it, expect } from 'vitest'
import { buildSkillTreeUrl } from '../../indexer/skill-url.js'

describe('SMI-5286 Wave 1a: buildSkillTreeUrl', () => {
  describe('normal cases', () => {
    it('should build a standard tree URL with skill path', () => {
      const result = buildSkillTreeUrl('https://github.com/o/r', 'main', '.agents/skills/foo')
      expect(result).toBe('https://github.com/o/r/tree/main/.agents/skills/foo')
    })

    it('should honor non-main default branch', () => {
      const result = buildSkillTreeUrl('https://github.com/o/r', 'develop', 'x')
      expect(result).toBe('https://github.com/o/r/tree/develop/x')
    })

    it('should handle nested skill paths', () => {
      const result = buildSkillTreeUrl(
        'https://github.com/foo/bar',
        'main',
        '.claude/skills/category/my-skill'
      )
      expect(result).toBe('https://github.com/foo/bar/tree/main/.claude/skills/category/my-skill')
    })
  })

  describe('trailing slash normalization', () => {
    it('should strip trailing slash from repo URL', () => {
      const result = buildSkillTreeUrl('https://github.com/o/r/', 'main', 'a/b')
      expect(result).toBe('https://github.com/o/r/tree/main/a/b')
    })

    it('should handle multiple trailing slashes on repo URL', () => {
      const result = buildSkillTreeUrl('https://github.com/o/r///', 'main', 'path')
      expect(result).toBe('https://github.com/o/r/tree/main/path')
    })
  })

  describe('leading slash normalization', () => {
    it('should drop leading slash from skillPath', () => {
      const result = buildSkillTreeUrl('https://github.com/o/r', 'main', '/a/b')
      expect(result).toBe('https://github.com/o/r/tree/main/a/b')
    })

    it('should handle multiple leading slashes in skillPath', () => {
      const result = buildSkillTreeUrl('https://github.com/o/r', 'main', '///path')
      expect(result).toBe('https://github.com/o/r/tree/main/path')
    })
  })

  describe('root skill case (empty skillPath)', () => {
    it('should return branch tree URL for empty skillPath', () => {
      const result = buildSkillTreeUrl('https://github.com/o/r', 'main', '')
      expect(result).toBe('https://github.com/o/r/tree/main')
    })

    it('should not add trailing slash for empty skillPath', () => {
      const result = buildSkillTreeUrl('https://github.com/o/r', 'main', '')
      expect(result).toMatch(/^https:\/\/github\.com\/o\/r\/tree\/main$/)
      expect(result).not.toMatch(/\/$/)
    })
  })

  describe('distinctness (C-1 guarantee)', () => {
    it('should produce distinct URLs for different skillPaths in same repo', () => {
      const url1 = buildSkillTreeUrl('https://github.com/o/r', 'main', 'skills/foo')
      const url2 = buildSkillTreeUrl('https://github.com/o/r', 'main', 'skills/bar')
      expect(url1).not.toBe(url2)
      expect(url1).toBe('https://github.com/o/r/tree/main/skills/foo')
      expect(url2).toBe('https://github.com/o/r/tree/main/skills/bar')
    })

    it('should produce distinct URLs for different branches', () => {
      const url1 = buildSkillTreeUrl('https://github.com/o/r', 'main', 'skills/foo')
      const url2 = buildSkillTreeUrl('https://github.com/o/r', 'develop', 'skills/foo')
      expect(url1).not.toBe(url2)
    })

    it('should produce distinct URLs for different repos', () => {
      const url1 = buildSkillTreeUrl('https://github.com/org1/r', 'main', 'skills/foo')
      const url2 = buildSkillTreeUrl('https://github.com/org2/r', 'main', 'skills/foo')
      expect(url1).not.toBe(url2)
    })
  })

  describe('edge cases with both normalization rules', () => {
    it('should strip trailing slash AND leading slash', () => {
      const result = buildSkillTreeUrl('https://github.com/o/r/', 'main', '/a/b')
      expect(result).toBe('https://github.com/o/r/tree/main/a/b')
    })

    it('should handle slash-only skillPath after normalization', () => {
      const result = buildSkillTreeUrl('https://github.com/o/r', 'main', '///')
      expect(result).toBe('https://github.com/o/r/tree/main')
    })

    it('should handle complex branch names with slashes', () => {
      const result = buildSkillTreeUrl('https://github.com/o/r', 'release/v1.0', 'skills/my-skill')
      expect(result).toBe('https://github.com/o/r/tree/release/v1.0/skills/my-skill')
    })
  })

  describe('real-world high-trust emitter patterns', () => {
    it('should match high-trust indexer URL shape (non-bare repo root)', () => {
      // high-trust-indexer.ts:261 produces URLs like this
      const result = buildSkillTreeUrl(
        'https://github.com/anthropics/anthropic-sdk-python',
        'main',
        '.claude/skills/extract-json'
      )
      expect(result).toMatch(/https:\/\/github\.com\/.*\/tree\/.*\//)
      expect(result).toContain('.claude/skills/extract-json')
    })

    it('should handle typical community discovery patterns', () => {
      const result = buildSkillTreeUrl(
        'https://github.com/community-user/skill-repo',
        'main',
        'skills'
      )
      expect(result).toBe('https://github.com/community-user/skill-repo/tree/main/skills')
    })
  })
})
