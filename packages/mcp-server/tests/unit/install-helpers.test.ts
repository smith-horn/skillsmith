/**
 * @fileoverview Tests for install.helpers.ts pure functions
 * @module @skillsmith/mcp-server/tests/unit/install-helpers
 *
 * SMI-1721: Added to restore test coverage after Wave 3 refactor
 */

import { describe, it, expect } from 'vitest'
import {
  parseSkillId,
  parseRepoUrl,
  validateSkillMd,
  generateTips,
} from '../../src/tools/install.helpers.js'

describe('install.helpers', () => {
  describe('parseSkillId', () => {
    it('parses full GitHub URL', () => {
      const result = parseSkillId('https://github.com/owner/repo')
      expect(result).toEqual({
        owner: 'owner',
        repo: 'repo',
        path: '',
        isRegistryId: false,
      })
    })

    it('parses GitHub URL with path', () => {
      const result = parseSkillId('https://github.com/owner/repo/tree/main/skills/my-skill')
      expect(result).toEqual({
        owner: 'owner',
        repo: 'repo',
        path: 'tree/main/skills/my-skill',
        isRegistryId: false,
      })
    })

    it('parses 2-part registry ID', () => {
      const result = parseSkillId('author/skill-name')
      expect(result).toEqual({
        owner: 'author',
        repo: 'skill-name',
        path: '',
        isRegistryId: true,
      })
    })

    it('parses 3-part direct reference', () => {
      const result = parseSkillId('owner/repo/skills/my-skill')
      expect(result).toEqual({
        owner: 'owner',
        repo: 'repo',
        path: 'skills/my-skill',
        isRegistryId: false,
      })
    })

    it('throws for invalid format', () => {
      expect(() => parseSkillId('invalid')).toThrow('Invalid skill ID format')
    })
  })

  describe('parseRepoUrl', () => {
    it('parses simple GitHub URL', () => {
      const result = parseRepoUrl('https://github.com/owner/repo')
      expect(result).toEqual({
        owner: 'owner',
        repo: 'repo',
        path: '',
        branch: 'main',
      })
    })

    it('parses GitHub URL with tree path', () => {
      const result = parseRepoUrl('https://github.com/owner/repo/tree/develop/src/skills')
      expect(result).toEqual({
        owner: 'owner',
        repo: 'repo',
        path: 'src/skills',
        branch: 'develop',
      })
    })

    it('parses GitHub URL with blob path', () => {
      const result = parseRepoUrl('https://github.com/owner/repo/blob/feature/path/file.md')
      expect(result).toEqual({
        owner: 'owner',
        repo: 'repo',
        path: 'path/file.md',
        branch: 'feature',
      })
    })

    it('rejects non-GitHub hosts', () => {
      expect(() => parseRepoUrl('https://gitlab.com/owner/repo')).toThrow('Invalid repository host')
    })

    it('rejects malicious hosts', () => {
      expect(() => parseRepoUrl('https://evil.com/owner/repo')).toThrow('Invalid repository host')
    })

    it('accepts www.github.com', () => {
      const result = parseRepoUrl('https://www.github.com/owner/repo')
      expect(result.owner).toBe('owner')
      expect(result.repo).toBe('repo')
    })
  })

  describe('validateSkillMd', () => {
    it('validates valid SKILL.md', () => {
      const content = `# My Skill

This is a skill that does something useful. It has enough content to pass validation.

## Usage
Use this skill to do things.
`
      const result = validateSkillMd(content)
      expect(result.valid).toBe(true)
      expect(result.errors).toEqual([])
    })

    it('rejects missing title', () => {
      const content =
        'This is content without a heading. It is long enough but has no title marker.'
      const result = validateSkillMd(content)
      expect(result.valid).toBe(false)
      expect(result.errors).toContain('Missing title (# heading)')
    })

    it('rejects too short content', () => {
      const content = '# Title\n\nToo short.'
      const result = validateSkillMd(content)
      expect(result.valid).toBe(false)
      expect(result.errors).toContain('SKILL.md is too short (minimum 100 characters)')
    })

    it('collects multiple errors', () => {
      const content = 'No title, too short'
      const result = validateSkillMd(content)
      expect(result.valid).toBe(false)
      expect(result.errors.length).toBe(2)
    })
  })

  describe('generateTips', () => {
    it('generates tips with skill name', () => {
      const tips = generateTips('my-skill')
      expect(tips).toHaveLength(4)
      expect(tips[0]).toContain('my-skill')
      expect(tips[0]).toContain('installed successfully')
    })

    it('includes usage instructions', () => {
      const tips = generateTips('test-skill')
      expect(tips.some((t) => t.includes('Use the test-skill skill'))).toBe(true)
    })

    it('includes ls command', () => {
      const tips = generateTips('any-skill')
      expect(tips.some((t) => t.includes('ls ~/.claude/skills/'))).toBe(true)
    })

    it('includes uninstall hint', () => {
      const tips = generateTips('any-skill')
      expect(tips.some((t) => t.includes('uninstall_skill'))).toBe(true)
    })
  })
})
