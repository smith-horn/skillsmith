/**
 * @fileoverview Tests for SessionManager.helpers.ts
 * @module @skillsmith/core/tests/session/SessionManager.helpers
 *
 * SMI-1719: Unit tests for extracted helper functions from Wave 3 refactor
 */

import { describe, it, expect } from 'vitest'
import {
  validateMemoryKey,
  MEMORY_KEYS,
  MEMORY_NAMESPACE,
} from '../../src/session/SessionManager.helpers.js'

describe('SessionManager.helpers', () => {
  describe('validateMemoryKey', () => {
    it('accepts valid alphanumeric keys', () => {
      expect(validateMemoryKey('session123')).toBe(true)
      expect(validateMemoryKey('abc')).toBe(true)
      expect(validateMemoryKey('test')).toBe(true)
    })

    it('accepts keys with hyphens', () => {
      expect(validateMemoryKey('session-id')).toBe(true)
      expect(validateMemoryKey('my-test-key')).toBe(true)
    })

    it('accepts keys with underscores', () => {
      expect(validateMemoryKey('session_id')).toBe(true)
      expect(validateMemoryKey('my_test_key')).toBe(true)
    })

    it('accepts keys with forward slashes', () => {
      expect(validateMemoryKey('session/current')).toBe(true)
      expect(validateMemoryKey('checkpoint/123')).toBe(true)
      expect(validateMemoryKey('a/b/c/d')).toBe(true)
    })

    it('accepts mixed valid characters', () => {
      expect(validateMemoryKey('session/my-id_123')).toBe(true)
      expect(validateMemoryKey('prefix/sub_key-1')).toBe(true)
    })

    it('rejects keys with spaces', () => {
      expect(validateMemoryKey('session id')).toBe(false)
      expect(validateMemoryKey('my key')).toBe(false)
    })

    it('rejects keys with special characters', () => {
      expect(validateMemoryKey('session@id')).toBe(false)
      expect(validateMemoryKey('key!value')).toBe(false)
      expect(validateMemoryKey('test#1')).toBe(false)
      expect(validateMemoryKey('a$b')).toBe(false)
      expect(validateMemoryKey('x%y')).toBe(false)
      expect(validateMemoryKey('a&b')).toBe(false)
      expect(validateMemoryKey('a*b')).toBe(false)
    })

    it('rejects keys with backslashes', () => {
      expect(validateMemoryKey('session\\id')).toBe(false)
      expect(validateMemoryKey('a\\b\\c')).toBe(false)
    })

    it('rejects keys with dots', () => {
      expect(validateMemoryKey('session.id')).toBe(false)
      expect(validateMemoryKey('../passwd')).toBe(false)
    })

    it('rejects empty keys', () => {
      expect(validateMemoryKey('')).toBe(false)
    })

    it('rejects keys exceeding 256 characters', () => {
      const longKey = 'a'.repeat(257)
      expect(validateMemoryKey(longKey)).toBe(false)
    })

    it('accepts keys at exactly 256 characters', () => {
      const maxKey = 'a'.repeat(256)
      expect(validateMemoryKey(maxKey)).toBe(true)
    })

    it('rejects keys with newlines', () => {
      expect(validateMemoryKey('session\nid')).toBe(false)
      expect(validateMemoryKey('key\r\nvalue')).toBe(false)
    })

    it('rejects keys with semicolons (command injection)', () => {
      expect(validateMemoryKey('key;ls')).toBe(false)
      expect(validateMemoryKey('key;rm -rf /')).toBe(false)
    })

    it('rejects keys with pipe (command injection)', () => {
      expect(validateMemoryKey('key|cat /etc/passwd')).toBe(false)
    })

    it('rejects keys with backticks (command injection)', () => {
      expect(validateMemoryKey('key`ls`')).toBe(false)
    })
  })

  describe('MEMORY_KEYS', () => {
    it('exports CURRENT key', () => {
      expect(MEMORY_KEYS.CURRENT).toBe('session/current')
    })

    it('exports SESSION_PREFIX', () => {
      expect(MEMORY_KEYS.SESSION_PREFIX).toBe('session/')
    })

    it('exports CHECKPOINT_PREFIX', () => {
      expect(MEMORY_KEYS.CHECKPOINT_PREFIX).toBe('checkpoint/')
    })

    it('all keys pass validation', () => {
      expect(validateMemoryKey(MEMORY_KEYS.CURRENT)).toBe(true)
      expect(validateMemoryKey(MEMORY_KEYS.SESSION_PREFIX + 'test')).toBe(true)
      expect(validateMemoryKey(MEMORY_KEYS.CHECKPOINT_PREFIX + '123')).toBe(true)
    })
  })

  describe('MEMORY_NAMESPACE', () => {
    it('exports namespace constant', () => {
      expect(MEMORY_NAMESPACE).toBe('skillsmith-sessions')
    })

    it('namespace passes validation', () => {
      expect(validateMemoryKey(MEMORY_NAMESPACE)).toBe(true)
    })
  })
})
