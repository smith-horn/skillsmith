/**
 * SMI-898: Path Traversal Protection Tests
 *
 * Comprehensive tests for the path validation security module.
 * Tests various path traversal attack vectors and ensures proper rejection.
 */

import { describe, it, expect } from 'vitest'
import { resolve } from 'path'
import { homedir } from 'os'
import { validateDbPath, validateDbPathOrThrow, isPathSafe } from '../pathValidation.js'

describe('SMI-898: Path Traversal Protection', () => {
  const homeDir = homedir()
  const skillsmithDir = resolve(homeDir, '.skillsmith')
  const claudeDir = resolve(homeDir, '.claude')

  describe('validateDbPath', () => {
    describe('valid paths', () => {
      it('should accept in-memory database', () => {
        const result = validateDbPath(':memory:')
        expect(result.valid).toBe(true)
        expect(result.resolvedPath).toBe(':memory:')
      })

      it('should accept paths in ~/.skillsmith', () => {
        const testPath = resolve(skillsmithDir, 'test.db')
        const result = validateDbPath(testPath)
        expect(result.valid).toBe(true)
        expect(result.resolvedPath).toBe(testPath)
      })

      it('should accept paths in ~/.claude', () => {
        const testPath = resolve(claudeDir, 'skills/test.db')
        const result = validateDbPath(testPath)
        expect(result.valid).toBe(true)
        expect(result.resolvedPath).toBe(testPath)
      })

      it('should accept nested paths in allowed directories', () => {
        const testPath = resolve(skillsmithDir, 'data/nested/deep/test.db')
        const result = validateDbPath(testPath)
        expect(result.valid).toBe(true)
        expect(result.resolvedPath).toBe(testPath)
      })

      it('should accept paths in temp directories', () => {
        const testPath = '/tmp/skillsmith-test/test.db'
        const result = validateDbPath(testPath, { allowTempDir: true })
        expect(result.valid).toBe(true)
        expect(result.resolvedPath).toBe(testPath)
      })
    })

    describe('path traversal attacks', () => {
      it('should reject simple .. traversal', () => {
        const result = validateDbPath('../../../etc/passwd')
        expect(result.valid).toBe(false)
        expect(result.error).toContain('traversal')
      })

      it('should reject .. traversal in middle of path', () => {
        const result = validateDbPath(`${skillsmithDir}/../../../etc/passwd`)
        expect(result.valid).toBe(false)
        expect(result.error).toContain('traversal')
      })

      it('should reject encoded traversal attempts when decoded', () => {
        // URL-encoded ".." - if decoded before validation, would be traversal
        // Note: Our function checks for literal ".." not URL-encoded
        // This test ensures basic ".." detection works
        const decodedAttack = decodeURIComponent('%2e%2e/%2e%2e/etc/passwd')
        const result = validateDbPath(decodedAttack)
        expect(result.valid).toBe(false)
        expect(result.error).toContain('traversal')
      })

      it('should reject mixed slash traversal', () => {
        const result = validateDbPath('..\\..\\..\\etc\\passwd')
        expect(result.valid).toBe(false)
        expect(result.error).toContain('traversal')
      })

      it('should reject double-encoded traversal when decoded', () => {
        // %252e%252e decodes to %2e%2e, then to ..
        // Test the fully decoded version
        const doubleDecoded = decodeURIComponent(decodeURIComponent('%252e%252e'))
        expect(doubleDecoded).toBe('..')
        const result = validateDbPath(`/home/user/${doubleDecoded}/etc/passwd`)
        expect(result.valid).toBe(false)
      })

      it('should reject hidden dot segment traversal (./..)', () => {
        const result = validateDbPath('./../../../etc/passwd')
        expect(result.valid).toBe(false)
        expect(result.error).toContain('traversal')
      })

      it('should reject traversal with extra dots (...)', () => {
        const result = validateDbPath('.../etc/passwd')
        expect(result.valid).toBe(false)
        expect(result.error).toContain('traversal')
      })
    })

    describe('paths outside allowed directories', () => {
      it('should reject absolute paths to system directories', () => {
        const result = validateDbPath('/etc/passwd')
        expect(result.valid).toBe(false)
        expect(result.error).toContain('outside allowed')
      })

      it('should reject absolute paths to other user directories', () => {
        // Use a path that's definitely NOT in allowed dirs (not current user's home)
        const result = validateDbPath('/home/otheruser/data/secret.db')
        expect(result.valid).toBe(false)
        expect(result.error).toContain('outside allowed')
      })

      it('should reject paths in home but outside allowed subdirs', () => {
        const result = validateDbPath(resolve(homeDir, 'Documents/secret.db'))
        expect(result.valid).toBe(false)
        expect(result.error).toContain('outside allowed')
      })

      it('should reject Windows-style system paths when run on Windows or when backslashes are normalized', () => {
        // On Unix, Windows paths are treated as regular paths with backslash as separator
        // The path resolves relative to allowed dir, so test with explicit outside path
        const result = validateDbPath('/mnt/c/Windows/System32/config')
        expect(result.valid).toBe(false)
        expect(result.error).toContain('outside allowed')
      })
    })

    describe('invalid inputs', () => {
      it('should reject null bytes', () => {
        const result = validateDbPath(`${skillsmithDir}/test\0.db`)
        expect(result.valid).toBe(false)
        expect(result.error).toContain('Invalid characters')
      })

      it('should reject control characters', () => {
        const result = validateDbPath(`${skillsmithDir}/test\x07.db`)
        expect(result.valid).toBe(false)
        expect(result.error).toContain('Invalid characters')
      })

      it('should reject empty string', () => {
        const result = validateDbPath('')
        expect(result.valid).toBe(false)
        expect(result.error).toContain('required')
      })

      it('should reject undefined', () => {
        const result = validateDbPath(undefined as unknown as string)
        expect(result.valid).toBe(false)
        expect(result.error).toContain('required')
      })

      it('should reject paths exceeding max length', () => {
        const longPath = skillsmithDir + '/' + 'a'.repeat(5000) + '.db'
        const result = validateDbPath(longPath)
        expect(result.valid).toBe(false)
        expect(result.error).toContain('length')
      })
    })

    describe('edge cases', () => {
      it('should reject in-memory when disabled', () => {
        const result = validateDbPath(':memory:', { allowInMemory: false })
        expect(result.valid).toBe(false)
        expect(result.error).toContain('In-memory')
      })

      it('should reject temp dirs when disabled', () => {
        const result = validateDbPath('/tmp/test.db', { allowTempDir: false })
        expect(result.valid).toBe(false)
        expect(result.error).toContain('outside allowed')
      })

      it('should handle symlink-like paths (detected by resolve)', () => {
        // This tests that resolve() properly handles the path
        const result = validateDbPath(`${skillsmithDir}/./test.db`)
        expect(result.valid).toBe(true)
        expect(result.resolvedPath).toBe(resolve(skillsmithDir, 'test.db'))
      })

      it('should handle relative paths by resolving to first allowed dir', () => {
        const result = validateDbPath('custom.db')
        expect(result.valid).toBe(true)
        expect(result.resolvedPath).toBe(resolve(skillsmithDir, 'custom.db'))
      })

      it('should accept custom allowed directories', () => {
        const customDir = '/var/lib/skillsmith'
        const result = validateDbPath('/var/lib/skillsmith/test.db', {
          allowedDirs: [customDir],
          allowTempDir: false,
        })
        expect(result.valid).toBe(true)
      })
    })
  })

  describe('validateDbPathOrThrow', () => {
    it('should return resolved path for valid input', () => {
      const result = validateDbPathOrThrow(':memory:')
      expect(result).toBe(':memory:')
    })

    it('should throw for invalid input', () => {
      expect(() => validateDbPathOrThrow('../../../etc/passwd')).toThrow('Invalid database path')
    })

    it('should throw with descriptive error message', () => {
      expect(() => validateDbPathOrThrow('/etc/passwd')).toThrow('outside allowed')
    })
  })

  describe('isPathSafe', () => {
    it('should return true for safe paths', () => {
      expect(isPathSafe('/home/user/.skillsmith/test.db')).toBe(true)
      expect(isPathSafe(':memory:')).toBe(true)
      expect(isPathSafe('relative/path.db')).toBe(true)
    })

    it('should return false for paths with ..', () => {
      expect(isPathSafe('../../../etc/passwd')).toBe(false)
      expect(isPathSafe('foo/../bar/../../../etc')).toBe(false)
    })

    it('should return false for paths with null bytes', () => {
      expect(isPathSafe('test\0.db')).toBe(false)
    })

    it('should return false for paths with control characters', () => {
      expect(isPathSafe('test\x07.db')).toBe(false)
    })

    it('should return false for empty/undefined', () => {
      expect(isPathSafe('')).toBe(false)
      expect(isPathSafe(undefined as unknown as string)).toBe(false)
    })
  })

  describe('real-world attack vectors', () => {
    it('should block CVE-style path traversal', () => {
      // Common attack patterns - focus on actual ".." traversal
      // URL-encoded versions would need to be decoded first by the application layer
      const attacks = [
        '../../../etc/passwd',
        '..\\..\\..\\etc\\passwd',
        '..//..//..//etc/passwd',
        './../../../etc/passwd',
        'foo/../../../etc/passwd',
        '.../.../etc/passwd',
      ]

      for (const attack of attacks) {
        const result = validateDbPath(attack)
        expect(result.valid).toBe(false)
      }
    })

    it('should block Unicode dot attacks when normalized', () => {
      // Unicode dots (\u002e is regular ASCII dot)
      // \u002e\u002e is literally ".."
      const dotDotPath = '\u002e\u002e/\u002e\u002e/etc/passwd'
      expect(dotDotPath).toBe('../../etc/passwd') // Confirm it's actual ..
      const result = validateDbPath(dotDotPath)
      expect(result.valid).toBe(false)
      expect(result.error).toContain('traversal')
    })

    it('should block symlink escape attempts via path construction', () => {
      // While we can't prevent actual symlink attacks without filesystem access,
      // we can block paths that attempt to escape via naming patterns
      const attacks = [
        `${skillsmithDir}/../../etc/passwd`,
        `${skillsmithDir}/../other-user/.ssh/id_rsa`,
      ]

      for (const attack of attacks) {
        const result = validateDbPath(attack)
        expect(result.valid).toBe(false)
      }
    })
  })
})
