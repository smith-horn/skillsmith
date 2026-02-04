/**
 * SMI-2271: GitHub parameter validation tests
 */

import { describe, it, expect } from 'vitest'
import {
  isValidGitHubIdentifier,
  validateGitHubPath,
  validateGitHubParams,
  isValidGitHubTopic,
  isValidBranchName,
  sanitizeForLog,
  ValidationError,
} from './validation.ts'

describe('SMI-2271: GitHub Parameter Validation', () => {
  describe('isValidGitHubIdentifier', () => {
    it('should accept valid GitHub usernames', () => {
      expect(isValidGitHubIdentifier('anthropics')).toBe(true)
      expect(isValidGitHubIdentifier('user-name')).toBe(true)
      expect(isValidGitHubIdentifier('user_name')).toBe(true)
      expect(isValidGitHubIdentifier('user.name')).toBe(true)
      expect(isValidGitHubIdentifier('A123')).toBe(true)
    })

    it('should reject path traversal attempts', () => {
      expect(isValidGitHubIdentifier('../etc')).toBe(false)
      expect(isValidGitHubIdentifier('user/../admin')).toBe(false)
      expect(isValidGitHubIdentifier('..')).toBe(false)
    })

    it('should reject identifiers starting with a hyphen', () => {
      expect(isValidGitHubIdentifier('-leadinghyphen')).toBe(false)
    })

    it('should reject special characters', () => {
      expect(isValidGitHubIdentifier('user/name')).toBe(false)
      expect(isValidGitHubIdentifier('user name')).toBe(false)
      expect(isValidGitHubIdentifier('user@name')).toBe(false)
      expect(isValidGitHubIdentifier('user;name')).toBe(false)
      expect(isValidGitHubIdentifier('user\x00name')).toBe(false)
    })

    it('should reject empty or non-string input', () => {
      expect(isValidGitHubIdentifier('')).toBe(false)
      expect(isValidGitHubIdentifier(null as unknown as string)).toBe(false)
      expect(isValidGitHubIdentifier(undefined as unknown as string)).toBe(false)
    })

    it('should reject identifiers exceeding 100 characters', () => {
      expect(isValidGitHubIdentifier('a'.repeat(100))).toBe(true)
      expect(isValidGitHubIdentifier('a'.repeat(101))).toBe(false)
    })

    it('should reject identifiers starting with a dot', () => {
      expect(isValidGitHubIdentifier('.hidden')).toBe(false)
    })

    it('should reject identifiers ending with a dot', () => {
      expect(isValidGitHubIdentifier('trailing.')).toBe(false)
    })

    it('should allow dots in the middle of identifiers', () => {
      expect(isValidGitHubIdentifier('normal.name')).toBe(true)
    })
  })

  describe('validateGitHubPath', () => {
    it('should accept valid file paths', () => {
      expect(validateGitHubPath('skills/my-skill')).toBe(true)
      expect(validateGitHubPath('SKILL.md')).toBe(true)
      expect(validateGitHubPath('path/to/deep/file.ts')).toBe(true)
    })

    it('should reject path traversal', () => {
      expect(validateGitHubPath('../../../etc/passwd')).toBe(false)
      expect(validateGitHubPath('skills/../../../etc')).toBe(false)
      expect(validateGitHubPath('skill/..hidden')).toBe(false)
    })

    it('should reject null bytes', () => {
      expect(validateGitHubPath('path\x00injection')).toBe(false)
    })

    it('should reject double slashes', () => {
      expect(validateGitHubPath('path//confusion')).toBe(false)
    })

    it('should reject leading slashes', () => {
      expect(validateGitHubPath('/absolute/path')).toBe(false)
    })

    it('should reject paths exceeding 500 characters', () => {
      expect(validateGitHubPath('a'.repeat(500))).toBe(true)
      expect(validateGitHubPath('a'.repeat(501))).toBe(false)
    })

    it('should reject empty or non-string input', () => {
      expect(validateGitHubPath('')).toBe(false)
      expect(validateGitHubPath(null as unknown as string)).toBe(false)
    })
  })

  describe('validateGitHubParams', () => {
    it('should accept valid owner and repo', () => {
      expect(() => validateGitHubParams('anthropics', 'skills')).not.toThrow()
    })

    it('should accept valid owner, repo, and path', () => {
      expect(() => validateGitHubParams('anthropics', 'skills', 'commit/SKILL.md')).not.toThrow()
    })

    it('should throw ValidationError for invalid owner', () => {
      expect(() => validateGitHubParams('../evil', 'repo')).toThrow(ValidationError)
      expect(() => validateGitHubParams('../evil', 'repo')).toThrow('Invalid GitHub owner')
    })

    it('should throw ValidationError for invalid repo', () => {
      expect(() => validateGitHubParams('owner', '../evil')).toThrow(ValidationError)
      expect(() => validateGitHubParams('owner', '../evil')).toThrow('Invalid GitHub repo')
    })

    it('should throw ValidationError for invalid path', () => {
      expect(() => validateGitHubParams('owner', 'repo', '../../etc/passwd')).toThrow(
        ValidationError
      )
      expect(() => validateGitHubParams('owner', 'repo', '../../etc/passwd')).toThrow(
        'Invalid GitHub path'
      )
    })

    it('should skip path validation when path is undefined', () => {
      expect(() => validateGitHubParams('owner', 'repo', undefined)).not.toThrow()
    })

    it('should truncate invalid identifiers in error messages', () => {
      const longName = 'a'.repeat(200)
      try {
        validateGitHubParams(longName, 'repo')
      } catch (e) {
        expect((e as Error).message).toContain('a'.repeat(80)) // 80 chars max
        expect((e as Error).message.length).toBeLessThan(120) // Not 200+ chars
      }
    })
  })

  describe('isValidGitHubTopic', () => {
    it('should accept valid topics', () => {
      expect(isValidGitHubTopic('claude-code-skill')).toBe(true)
      expect(isValidGitHubTopic('claude-code')).toBe(true)
      expect(isValidGitHubTopic('testing')).toBe(true)
    })

    it('should reject topics with special characters', () => {
      expect(isValidGitHubTopic('topic; rm -rf /')).toBe(false)
      expect(isValidGitHubTopic('topic&injection')).toBe(false)
    })

    it('should reject topics starting with a hyphen', () => {
      expect(isValidGitHubTopic('-invalid')).toBe(false)
    })

    it('should reject topics exceeding 50 characters', () => {
      expect(isValidGitHubTopic('a'.repeat(50))).toBe(true)
      expect(isValidGitHubTopic('a'.repeat(51))).toBe(false)
    })

    it('should reject empty input', () => {
      expect(isValidGitHubTopic('')).toBe(false)
    })
  })

  describe('isValidBranchName', () => {
    it('should accept valid branch names', () => {
      expect(isValidBranchName('main')).toBe(true)
      expect(isValidBranchName('feature/foo')).toBe(true)
      expect(isValidBranchName('release-1.0')).toBe(true)
      expect(isValidBranchName('v2.0.0')).toBe(true)
    })

    it('should reject path traversal', () => {
      expect(isValidBranchName('../etc/passwd')).toBe(false)
    })

    it('should reject null bytes', () => {
      expect(isValidBranchName('branch\x00name')).toBe(false)
    })

    it('should reject excessively long names', () => {
      expect(isValidBranchName('a'.repeat(257))).toBe(false)
    })

    it('should reject names with spaces', () => {
      expect(isValidBranchName('branch name')).toBe(false)
    })

    it('should reject names starting with a dot', () => {
      expect(isValidBranchName('.hidden')).toBe(false)
    })

    it('should reject names ending with .lock', () => {
      expect(isValidBranchName('refs/heads/main.lock')).toBe(false)
    })

    it('should reject names with tilde, caret, colon, or backslash', () => {
      expect(isValidBranchName('branch~1')).toBe(false)
      expect(isValidBranchName('branch^2')).toBe(false)
      expect(isValidBranchName('branch:name')).toBe(false)
      expect(isValidBranchName('branch\\name')).toBe(false)
    })

    it('should reject names starting or ending with slash', () => {
      expect(isValidBranchName('/leading')).toBe(false)
      expect(isValidBranchName('trailing/')).toBe(false)
    })

    it('should reject control characters', () => {
      expect(isValidBranchName('branch\x1bname')).toBe(false)
    })

    it('should reject empty or non-string input', () => {
      expect(isValidBranchName('')).toBe(false)
      expect(isValidBranchName(null as unknown as string)).toBe(false)
      expect(isValidBranchName(undefined as unknown as string)).toBe(false)
    })
  })

  describe('sanitizeForLog', () => {
    it('should return <empty> for null/undefined', () => {
      expect(sanitizeForLog(null)).toBe('<empty>')
      expect(sanitizeForLog(undefined)).toBe('<empty>')
    })

    it('should strip control characters', () => {
      expect(sanitizeForLog('hello\x00world')).toBe('helloworld')
      expect(sanitizeForLog('test\x1b[31mred')).toBe('test[31mred')
    })

    it('should truncate to 80 characters', () => {
      expect(sanitizeForLog('a'.repeat(100))).toBe('a'.repeat(80))
    })

    it('should handle normal strings', () => {
      expect(sanitizeForLog('normal-string')).toBe('normal-string')
    })
  })
})
