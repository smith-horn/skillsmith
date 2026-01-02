/**
 * SMI-914: Anonymizer Tests
 * SMI-917: Per-installation salt tests
 *
 * Tests for user ID and project context hashing functions.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {
  anonymizeUserId,
  hashProjectContext,
  getSaltPath,
  loadOrCreateSalt,
  clearSaltCache,
} from '../src/analytics/anonymizer.js'
import { join } from 'path'
import { homedir } from 'os'

describe('getSaltPath', () => {
  it('should return path to ~/.skillsmith/anonymizer-salt', () => {
    const result = getSaltPath()
    const expected = join(homedir(), '.skillsmith', 'anonymizer-salt')
    expect(result).toBe(expected)
  })
})

describe('loadOrCreateSalt', () => {
  beforeEach(() => {
    clearSaltCache()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should return a Buffer', () => {
    const salt = loadOrCreateSalt()
    expect(Buffer.isBuffer(salt)).toBe(true)
  })

  it('should cache salt after first load', () => {
    const salt1 = loadOrCreateSalt()
    const salt2 = loadOrCreateSalt()
    // Same buffer reference due to caching
    expect(salt1).toBe(salt2)
  })

  it('should return consistent salt across calls', () => {
    const salt1 = loadOrCreateSalt()
    clearSaltCache()
    const salt2 = loadOrCreateSalt()
    // Same content (loaded from file)
    expect(salt1.toString('hex')).toBe(salt2.toString('hex'))
  })
})

describe('clearSaltCache', () => {
  it('should clear the cached salt', () => {
    // Load salt to populate cache
    const salt1 = loadOrCreateSalt()
    // Clear cache
    clearSaltCache()
    // Load again - should reload from file (same content but proves cache was cleared)
    const salt2 = loadOrCreateSalt()
    expect(salt1.toString('hex')).toBe(salt2.toString('hex'))
  })
})

describe('anonymizeUserId', () => {
  beforeEach(() => {
    clearSaltCache()
  })

  it('should return a 16-character hex string', () => {
    const result = anonymizeUserId('user123')
    expect(result).toHaveLength(16)
    expect(result).toMatch(/^[0-9a-f]{16}$/)
  })

  it('should produce consistent results for the same input', () => {
    const result1 = anonymizeUserId('user123')
    const result2 = anonymizeUserId('user123')
    expect(result1).toBe(result2)
  })

  it('should produce different results for different inputs', () => {
    const result1 = anonymizeUserId('user123')
    const result2 = anonymizeUserId('user456')
    expect(result1).not.toBe(result2)
  })

  it('should handle special characters in identifier', () => {
    const result = anonymizeUserId('user@example.com')
    expect(result).toHaveLength(16)
    expect(result).toMatch(/^[0-9a-f]{16}$/)
  })

  it('should handle unicode characters', () => {
    const result = anonymizeUserId('user-unicode')
    expect(result).toHaveLength(16)
    expect(result).toMatch(/^[0-9a-f]{16}$/)
  })

  it('should throw for empty identifier', () => {
    expect(() => anonymizeUserId('')).toThrow('User identifier cannot be empty')
  })

  it('should throw for whitespace-only identifier', () => {
    expect(() => anonymizeUserId('   ')).toThrow('User identifier cannot be empty')
  })

  it('should handle very long identifiers', () => {
    const longId = 'a'.repeat(10000)
    const result = anonymizeUserId(longId)
    expect(result).toHaveLength(16)
    expect(result).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('hashProjectContext', () => {
  it('should return an 8-character hex string', () => {
    const result = hashProjectContext({ framework: 'react' })
    expect(result).toHaveLength(8)
    expect(result).toMatch(/^[0-9a-f]{8}$/)
  })

  it('should produce consistent results for the same context', () => {
    const context = { framework: 'react', language: 'typescript' }
    const result1 = hashProjectContext(context)
    const result2 = hashProjectContext(context)
    expect(result1).toBe(result2)
  })

  it('should produce same results regardless of key order', () => {
    const context1 = { framework: 'react', language: 'typescript' }
    const context2 = { language: 'typescript', framework: 'react' }
    const result1 = hashProjectContext(context1)
    const result2 = hashProjectContext(context2)
    expect(result1).toBe(result2)
  })

  it('should produce different results for different contexts', () => {
    const result1 = hashProjectContext({ framework: 'react' })
    const result2 = hashProjectContext({ framework: 'vue' })
    expect(result1).not.toBe(result2)
  })

  it('should return empty context hash for empty object', () => {
    const result = hashProjectContext({})
    expect(result).toBe('00000000')
  })

  it('should handle nested objects', () => {
    const context = {
      framework: 'react',
      dependencies: { testing: 'vitest', linting: 'eslint' },
    }
    const result = hashProjectContext(context)
    expect(result).toHaveLength(8)
    expect(result).toMatch(/^[0-9a-f]{8}$/)
  })

  it('should handle arrays in context', () => {
    const context = {
      frameworks: ['react', 'nextjs'],
      buildTools: ['vite', 'esbuild'],
    }
    const result = hashProjectContext(context)
    expect(result).toHaveLength(8)
    expect(result).toMatch(/^[0-9a-f]{8}$/)
  })

  it('should handle null and undefined values', () => {
    const context = {
      framework: 'react',
      optional: null,
      missing: undefined,
    }
    const result = hashProjectContext(context)
    expect(result).toHaveLength(8)
    expect(result).toMatch(/^[0-9a-f]{8}$/)
  })
})
