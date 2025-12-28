/**
 * Unit tests for security utilities
 */
import { describe, it, expect } from 'vitest'
import { escapeHtml, isValidSkillId, sanitizeSkillId } from '../utils/security.js'

describe('escapeHtml', () => {
  it('should escape HTML entities', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
    )
  })

  it('should escape ampersands', () => {
    expect(escapeHtml('foo & bar')).toBe('foo &amp; bar')
  })

  it('should escape quotes', () => {
    expect(escapeHtml('say "hello"')).toBe('say &quot;hello&quot;')
  })

  it('should escape single quotes', () => {
    expect(escapeHtml("it's")).toBe('it&#039;s')
  })

  it('should handle empty strings', () => {
    expect(escapeHtml('')).toBe('')
  })

  it('should handle strings without special characters', () => {
    expect(escapeHtml('hello world')).toBe('hello world')
  })

  it('should escape complex XSS payloads', () => {
    const payload = '<img src=x onerror="alert(1)">'
    expect(escapeHtml(payload)).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;')
  })
})

describe('isValidSkillId', () => {
  it('should accept valid skill IDs', () => {
    expect(isValidSkillId('my-skill')).toBe(true)
    expect(isValidSkillId('my_skill')).toBe(true)
    expect(isValidSkillId('mySkill123')).toBe(true)
    expect(isValidSkillId('skill')).toBe(true)
  })

  it('should reject empty strings', () => {
    expect(isValidSkillId('')).toBe(false)
    expect(isValidSkillId('   ')).toBe(false)
  })

  it('should reject path traversal attempts', () => {
    expect(isValidSkillId('../etc/passwd')).toBe(false)
    expect(isValidSkillId('..\\windows\\system32')).toBe(false)
    expect(isValidSkillId('foo/../bar')).toBe(false)
  })

  it('should reject IDs with slashes', () => {
    expect(isValidSkillId('foo/bar')).toBe(false)
    expect(isValidSkillId('foo\\bar')).toBe(false)
  })

  it('should reject reserved names', () => {
    expect(isValidSkillId('.')).toBe(false)
    expect(isValidSkillId('..')).toBe(false)
    expect(isValidSkillId('CON')).toBe(false)
    expect(isValidSkillId('nul')).toBe(false)
  })

  it('should reject IDs with special characters', () => {
    expect(isValidSkillId('skill@name')).toBe(false)
    expect(isValidSkillId('skill name')).toBe(false)
    expect(isValidSkillId('skill!name')).toBe(false)
  })

  it('should reject overly long IDs', () => {
    const longId = 'a'.repeat(200)
    expect(isValidSkillId(longId)).toBe(false)
  })

  it('should accept IDs up to 128 characters', () => {
    const maxId = 'a'.repeat(128)
    expect(isValidSkillId(maxId)).toBe(true)
  })
})

describe('sanitizeSkillId', () => {
  it('should remove unsafe characters', () => {
    expect(sanitizeSkillId('foo/bar')).toBe('foo-bar')
    expect(sanitizeSkillId('foo\\bar')).toBe('foo-bar')
    expect(sanitizeSkillId('foo@bar')).toBe('foo-bar')
  })

  it('should preserve safe characters', () => {
    expect(sanitizeSkillId('my-skill_123')).toBe('my-skill_123')
  })

  it('should truncate long IDs', () => {
    const longId = 'a'.repeat(200)
    expect(sanitizeSkillId(longId).length).toBe(128)
  })
})
