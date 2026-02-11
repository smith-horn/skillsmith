/**
 * @fileoverview Tests for publish.helpers.ts and publish.types.ts
 * @module @skillsmith/mcp-server/tests/unit/publish-helpers
 *
 * SMI-2440: Unit tests for publish tool helper functions and Zod schemas
 */

import { describe, it, expect } from 'vitest'
import { validateSkillPath, generateChecksum } from '../../src/tools/publish.helpers.js'
import { publishInputSchema } from '../../src/tools/publish.types.js'

describe('publish helpers', () => {
  describe('validateSkillPath', () => {
    it('returns null for valid paths', () => {
      expect(validateSkillPath('/home/user/skills/my-skill')).toBeNull()
      expect(validateSkillPath('skills/my-skill')).toBeNull()
      expect(validateSkillPath('/Users/dev/.claude/skills/commit')).toBeNull()
      expect(validateSkillPath('my-skill-v2')).toBeNull()
    })

    it('rejects paths with path traversal (../)', () => {
      expect(validateSkillPath('../etc/passwd')).toBe('Path contains path traversal pattern')
      expect(validateSkillPath('/home/user/../secret')).toBe('Path contains path traversal pattern')
      expect(validateSkillPath('skills/../../root')).toBe('Path contains path traversal pattern')
    })

    it('rejects paths with shell metacharacters (;, |, $, etc.)', () => {
      expect(validateSkillPath('/tmp/skill; rm -rf /')).toBe('Path contains shell metacharacters')
      expect(validateSkillPath('/tmp/skill | cat /etc/passwd')).toBe(
        'Path contains shell metacharacters'
      )
      expect(validateSkillPath('/tmp/$HOME/skill')).toBe('Path contains shell metacharacters')
      expect(validateSkillPath('/tmp/skill&bg')).toBe('Path contains shell metacharacters')
      expect(validateSkillPath('skill(test)')).toBe('Path contains shell metacharacters')
      expect(validateSkillPath('skill{a,b}')).toBe('Path contains shell metacharacters')
      expect(validateSkillPath('skill!force')).toBe('Path contains shell metacharacters')
      expect(validateSkillPath('skill<in')).toBe('Path contains shell metacharacters')
      expect(validateSkillPath('skill>out')).toBe('Path contains shell metacharacters')
    })

    it('rejects paths with backticks', () => {
      expect(validateSkillPath('/tmp/`whoami`/skill')).toBe('Path contains shell metacharacters')
      expect(validateSkillPath('skill`id`')).toBe('Path contains shell metacharacters')
    })
  })

  describe('generateChecksum', () => {
    it('returns SHA256 hex string', () => {
      const checksum = generateChecksum('hello world')

      // SHA256 produces a 64-character hex string
      expect(checksum).toMatch(/^[a-f0-9]{64}$/)
    })

    it('returns consistent checksum for same content', () => {
      const content = 'test content for checksum'
      const first = generateChecksum(content)
      const second = generateChecksum(content)

      expect(first).toBe(second)
    })

    it('returns different checksum for different content', () => {
      const first = generateChecksum('content A')
      const second = generateChecksum('content B')

      expect(first).not.toBe(second)
    })
  })

  describe('scanReferences', () => {
    it.todo('scans .md files for project-specific references')
    it.todo('respects 20-file limit')
    it.todo('applies custom regex patterns')
    it.todo('ignores invalid regex patterns')
  })

  describe('createGitHubRepo', () => {
    it.todo('creates a public repo via gh CLI')
    it.todo('creates a private repo via gh CLI')
    it.todo('returns null on failure')
  })
})

describe('publishInputSchema', () => {
  it('requires skill_path', () => {
    const result = publishInputSchema.safeParse({})

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('skill_path'))).toBe(true)
    }
  })

  it('rejects empty skill_path', () => {
    const result = publishInputSchema.safeParse({ skill_path: '' })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('skill_path'))).toBe(true)
    }
  })

  it('defaults check_references to true', () => {
    const result = publishInputSchema.parse({ skill_path: '/tmp/my-skill' })

    expect(result.check_references).toBe(true)
  })

  it('defaults create_repo to false', () => {
    const result = publishInputSchema.parse({ skill_path: '/tmp/my-skill' })

    expect(result.create_repo).toBe(false)
  })

  it('defaults visibility to public', () => {
    const result = publishInputSchema.parse({ skill_path: '/tmp/my-skill' })

    expect(result.visibility).toBe('public')
  })

  it('rejects reference_patterns strings longer than 200 chars', () => {
    const longPattern = 'a'.repeat(201)
    const result = publishInputSchema.safeParse({
      skill_path: '/tmp/my-skill',
      reference_patterns: [longPattern],
    })

    expect(result.success).toBe(false)
  })

  it('rejects more than 20 reference_patterns', () => {
    const patterns = Array.from({ length: 21 }, (_, i) => `pattern-${i}`)
    const result = publishInputSchema.safeParse({
      skill_path: '/tmp/my-skill',
      reference_patterns: patterns,
    })

    expect(result.success).toBe(false)
  })

  it('accepts valid input with all fields', () => {
    const result = publishInputSchema.safeParse({
      skill_path: '/home/user/.claude/skills/my-skill',
      check_references: false,
      reference_patterns: ['TODO', 'FIXME', 'HACK'],
      create_repo: true,
      visibility: 'private',
      add_topic: true,
    })

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.skill_path).toBe('/home/user/.claude/skills/my-skill')
      expect(result.data.check_references).toBe(false)
      expect(result.data.reference_patterns).toEqual(['TODO', 'FIXME', 'HACK'])
      expect(result.data.create_repo).toBe(true)
      expect(result.data.visibility).toBe('private')
      expect(result.data.add_topic).toBe(true)
    }
  })
})
