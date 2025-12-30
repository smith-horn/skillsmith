/**
 * Validation Utilities Tests (SMI-726)
 *
 * Comprehensive tests for centralized validation patterns.
 */

import { describe, it, expect } from 'vitest'
import {
  validateUrl,
  validatePath,
  sanitizeInput,
  safePatternMatch,
  validatePatterns,
  ValidationError,
} from '../src/validation/index.js'
import { join } from 'path'
import { tmpdir } from 'os'

describe('validateUrl', () => {
  describe('valid URLs', () => {
    it('should allow valid https URLs', () => {
      expect(() => validateUrl('https://example.com')).not.toThrow()
      expect(() => validateUrl('https://api.github.com/repos')).not.toThrow()
      expect(() => validateUrl('https://registry.npmjs.org/package')).not.toThrow()
    })

    it('should allow valid http URLs', () => {
      expect(() => validateUrl('http://example.com')).not.toThrow()
      expect(() => validateUrl('http://api.example.com:8080/path')).not.toThrow()
    })

    it('should allow public IP addresses', () => {
      expect(() => validateUrl('http://8.8.8.8')).not.toThrow()
      expect(() => validateUrl('https://1.1.1.1')).not.toThrow()
      expect(() => validateUrl('http://142.250.185.46')).not.toThrow() // Google IP
    })
  })

  describe('invalid protocols', () => {
    it('should reject file:// protocol', () => {
      expect(() => validateUrl('file:///etc/passwd')).toThrow(ValidationError)
      expect(() => validateUrl('file:///etc/passwd')).toThrow(/Invalid protocol/)
    })

    it('should reject ftp:// protocol', () => {
      expect(() => validateUrl('ftp://example.com')).toThrow(ValidationError)
      expect(() => validateUrl('ftp://example.com')).toThrow(/Invalid protocol/)
    })

    it('should reject javascript: protocol', () => {
      expect(() => validateUrl('javascript:alert(1)')).toThrow(ValidationError)
    })

    it('should reject data: protocol', () => {
      expect(() => validateUrl('data:text/html,<script>alert(1)</script>')).toThrow(ValidationError)
    })
  })

  describe('localhost blocking', () => {
    it('should block localhost', () => {
      expect(() => validateUrl('http://localhost')).toThrow(ValidationError)
      expect(() => validateUrl('http://localhost')).toThrow(/localhost is blocked/)
    })

    it('should block 127.0.0.1', () => {
      expect(() => validateUrl('http://127.0.0.1')).toThrow(ValidationError)
      expect(() => validateUrl('http://127.0.0.1:3000')).toThrow(/private.*network blocked/)
    })

    it('should block 127.x.x.x range', () => {
      expect(() => validateUrl('http://127.1.2.3')).toThrow(ValidationError)
      expect(() => validateUrl('http://127.255.255.255')).toThrow(ValidationError)
    })

    it('should block ::1 (IPv6 localhost)', () => {
      expect(() => validateUrl('http://[::1]')).toThrow(ValidationError)
      expect(() => validateUrl('http://[::1]:3000')).toThrow(/localhost is blocked/)
    })

    it('should block 0.0.0.0', () => {
      expect(() => validateUrl('http://0.0.0.0')).toThrow(ValidationError)
      expect(() => validateUrl('http://0.0.0.0')).toThrow(/localhost is blocked/)
    })
  })

  describe('private network blocking', () => {
    it('should block 10.x.x.x range', () => {
      expect(() => validateUrl('http://10.0.0.1')).toThrow(ValidationError)
      expect(() => validateUrl('http://10.1.2.3')).toThrow(/private.*network blocked/)
      expect(() => validateUrl('http://10.255.255.255')).toThrow(ValidationError)
    })

    it('should block 172.16.x.x - 172.31.x.x range', () => {
      expect(() => validateUrl('http://172.16.0.1')).toThrow(ValidationError)
      expect(() => validateUrl('http://172.20.0.1')).toThrow(/private.*network blocked/)
      expect(() => validateUrl('http://172.31.255.255')).toThrow(ValidationError)
    })

    it('should NOT block 172.15.x.x or 172.32.x.x', () => {
      expect(() => validateUrl('http://172.15.0.1')).not.toThrow()
      expect(() => validateUrl('http://172.32.0.1')).not.toThrow()
    })

    it('should block 192.168.x.x range', () => {
      expect(() => validateUrl('http://192.168.0.1')).toThrow(ValidationError)
      expect(() => validateUrl('http://192.168.1.1')).toThrow(/private.*network blocked/)
      expect(() => validateUrl('http://192.168.255.255')).toThrow(ValidationError)
    })

    it('should NOT block 192.167.x.x or 192.169.x.x', () => {
      expect(() => validateUrl('http://192.167.0.1')).not.toThrow()
      expect(() => validateUrl('http://192.169.0.1')).not.toThrow()
    })

    it('should block 169.254.x.x range (link-local)', () => {
      expect(() => validateUrl('http://169.254.0.1')).toThrow(ValidationError)
      expect(() => validateUrl('http://169.254.169.254')).toThrow(/private.*network blocked/)
    })

    it('should block 0.x.x.x range (current network)', () => {
      expect(() => validateUrl('http://0.1.2.3')).toThrow(ValidationError)
      expect(() => validateUrl('http://0.255.255.255')).toThrow(/private.*network blocked/)
    })
  })

  describe('IPv6 blocking (SMI-729)', () => {
    it('should block IPv6 link-local addresses (fe80::/10)', () => {
      expect(() => validateUrl('http://[fe80::1]')).toThrow(ValidationError)
      expect(() => validateUrl('http://[fe80::1]')).toThrow(/IPv6 link-local/)
      expect(() => validateUrl('http://[fe80:0000:0000:0000:0000:0000:0000:0001]')).toThrow(
        ValidationError
      )
    })

    it('should block IPv6 unique local addresses (fc00::/7)', () => {
      expect(() => validateUrl('http://[fc00::1]')).toThrow(ValidationError)
      expect(() => validateUrl('http://[fc00::1]')).toThrow(/IPv6 unique local/)
      expect(() => validateUrl('http://[fd00::1]')).toThrow(ValidationError)
    })

    it('should block IPv6 multicast addresses (ff00::/8)', () => {
      expect(() => validateUrl('http://[ff00::1]')).toThrow(ValidationError)
      expect(() => validateUrl('http://[ff00::1]')).toThrow(/IPv6 multicast/)
      expect(() => validateUrl('http://[ff02::1]')).toThrow(ValidationError)
    })

    it('should block IPv4-mapped IPv6 private addresses', () => {
      expect(() => validateUrl('http://[::ffff:192.168.1.1]')).toThrow(ValidationError)
      expect(() => validateUrl('http://[::ffff:192.168.1.1]')).toThrow(/IPv4-mapped IPv6/)
      expect(() => validateUrl('http://[::ffff:10.0.0.1]')).toThrow(ValidationError)
      expect(() => validateUrl('http://[::ffff:127.0.0.1]')).toThrow(ValidationError)
    })

    it('should block IPv4-mapped IPv6 in hex notation', () => {
      // ::ffff:c0a8:0001 is ::ffff:192.168.0.1 in hex
      expect(() => validateUrl('http://[::ffff:c0a8:0001]')).toThrow(ValidationError)
      expect(() => validateUrl('http://[::ffff:c0a8:0001]')).toThrow(/IPv4-mapped IPv6/)
    })

    it('should allow public IPv6 addresses', () => {
      // Google's public IPv6 DNS
      expect(() => validateUrl('http://[2001:4860:4860::8888]')).not.toThrow()
      // Cloudflare's public IPv6 DNS
      expect(() => validateUrl('http://[2606:4700:4700::1111]')).not.toThrow()
    })
  })

  describe('invalid URLs', () => {
    it('should reject malformed URLs', () => {
      expect(() => validateUrl('not-a-url')).toThrow(ValidationError)
      expect(() => validateUrl('not-a-url')).toThrow(/Invalid URL format/)
    })

    it('should reject empty URLs', () => {
      expect(() => validateUrl('')).toThrow(ValidationError)
    })

    it('should reject invalid IPv4 addresses', () => {
      expect(() => validateUrl('http://256.256.256.256')).toThrow(ValidationError)
      expect(() => validateUrl('http://999.1.2.3')).toThrow(ValidationError)
    })
  })

  describe('error details', () => {
    it('should include error code in ValidationError', () => {
      try {
        validateUrl('ftp://example.com')
        expect.fail('Should have thrown')
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError)
        expect((error as ValidationError).code).toBe('INVALID_PROTOCOL')
      }
    })

    it('should include details in ValidationError', () => {
      try {
        validateUrl('http://localhost')
        expect.fail('Should have thrown')
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError)
        const validationError = error as ValidationError
        expect(validationError.details).toBeDefined()
        expect(validationError.details).toHaveProperty('hostname')
      }
    })
  })
})

describe('validatePath', () => {
  const rootDir = tmpdir()

  describe('valid paths', () => {
    it('should allow paths within root', () => {
      expect(() => validatePath(join(rootDir, 'skills'), rootDir)).not.toThrow()
      expect(() => validatePath(join(rootDir, 'skills/my-skill'), rootDir)).not.toThrow()
      expect(() => validatePath(join(rootDir, 'a/b/c/d'), rootDir)).not.toThrow()
    })

    it('should allow path equal to root', () => {
      expect(() => validatePath(rootDir, rootDir)).not.toThrow()
    })

    it('should allow relative paths within root', () => {
      expect(() => validatePath('skills', rootDir)).not.toThrow()
      expect(() => validatePath('./skills', rootDir)).not.toThrow()
      expect(() => validatePath('skills/my-skill/SKILL.md', rootDir)).not.toThrow()
    })
  })

  describe('path traversal attempts', () => {
    it('should block paths with ../ escaping root', () => {
      expect(() => validatePath('../etc/passwd', rootDir)).toThrow(ValidationError)
      expect(() => validatePath('../etc/passwd', rootDir)).toThrow(/Path traversal/)
    })

    it('should block paths with multiple ../ escaping root', () => {
      expect(() => validatePath('../../etc/passwd', rootDir)).toThrow(ValidationError)
      expect(() => validatePath('../../../etc/passwd', rootDir)).toThrow(ValidationError)
    })

    it('should block absolute paths outside root', () => {
      expect(() => validatePath('/etc/passwd', rootDir)).toThrow(ValidationError)
      expect(() => validatePath('/root/.ssh/id_rsa', rootDir)).toThrow(/Path traversal/)
    })

    it('should allow ../ that stays within root', () => {
      // Path 'skills/my-skill/../other-skill' resolves to 'skills/other-skill'
      // which is still within rootDir
      expect(() => validatePath('skills/my-skill/../other-skill', rootDir)).not.toThrow()
    })
  })

  describe('edge cases', () => {
    it('should reject empty path', () => {
      expect(() => validatePath('', rootDir)).toThrow(ValidationError)
      expect(() => validatePath('', rootDir)).toThrow(/Path cannot be empty/)
    })

    it('should reject empty root directory', () => {
      expect(() => validatePath('test', '')).toThrow(ValidationError)
      expect(() => validatePath('test', '')).toThrow(/Root directory cannot be empty/)
    })
  })

  describe('error details', () => {
    it('should include error code in ValidationError', () => {
      try {
        validatePath('/etc/passwd', rootDir)
        expect.fail('Should have thrown')
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError)
        expect((error as ValidationError).code).toBe('PATH_TRAVERSAL')
      }
    })

    it('should include path details in ValidationError', () => {
      try {
        validatePath('../../../etc/passwd', rootDir)
        expect.fail('Should have thrown')
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError)
        const validationError = error as ValidationError
        expect(validationError.details).toBeDefined()
        expect(validationError.details).toHaveProperty('originalPath')
        expect(validationError.details).toHaveProperty('normalizedPath')
      }
    })
  })
})

describe('sanitizeInput', () => {
  describe('path traversal removal', () => {
    it('should remove ../ sequences', () => {
      expect(sanitizeInput('../../etc/passwd')).toBe('etc/passwd')
      expect(sanitizeInput('../../../root/.ssh/id_rsa')).toBe('root/.ssh/id_rsa')
    })

    it('should remove ..\\ sequences (Windows)', () => {
      expect(sanitizeInput('..\\..\\windows\\system32')).toBe('windows\\system32')
    })

    it('should remove leading traversal sequences', () => {
      expect(sanitizeInput('../file.txt')).toBe('file.txt')
      expect(sanitizeInput('../../file.txt')).toBe('file.txt')
    })

    it('should not remove .. when removePathTraversal is false', () => {
      expect(sanitizeInput('../test', { removePathTraversal: false })).toBe('../test')
    })
  })

  describe('HTML escaping', () => {
    it('should escape HTML special characters', () => {
      expect(sanitizeInput('<script>alert(1)</script>')).toBe(
        '&lt;script&gt;alert(1)&lt;/script&gt;'
      )
      expect(sanitizeInput('"><img src=x onerror=alert(1)>')).toContain('&quot;&gt;&lt;img')
    })

    it('should escape ampersands', () => {
      expect(sanitizeInput('Tom & Jerry')).toBe('Tom &amp; Jerry')
    })

    it('should escape quotes', () => {
      expect(sanitizeInput(`"double" and 'single'`)).toBe(
        `&quot;double&quot; and &#x27;single&#x27;`
      )
    })

    it('should not escape when escapeHtml is false', () => {
      expect(sanitizeInput('<script>', { escapeHtml: false })).toBe('<script>')
    })
  })

  describe('null byte removal', () => {
    it('should remove null bytes', () => {
      expect(sanitizeInput('test\0file.txt')).toBe('testfile.txt')
      expect(sanitizeInput('\0\0\0test')).toBe('test')
    })

    it('should not remove null bytes when removeNullBytes is false', () => {
      expect(sanitizeInput('test\0', { removeNullBytes: false })).toBe('test\0')
    })
  })

  describe('combined sanitization', () => {
    it('should apply all sanitizations by default', () => {
      const input = '../<script>\0alert(1)</script>'
      const result = sanitizeInput(input)
      expect(result).toBe('&lt;script&gt;alert(1)&lt;/script&gt;')
      expect(result).not.toContain('../')
      expect(result).not.toContain('\0')
    })

    it('should allow selective sanitization', () => {
      const input = '../<script>test</script>'
      const result = sanitizeInput(input, {
        removePathTraversal: true,
        escapeHtml: false,
        removeNullBytes: false,
      })
      expect(result).toBe('<script>test</script>')
      expect(result).not.toContain('../')
    })
  })
})

describe('safePatternMatch', () => {
  describe('exact matching', () => {
    it('should match exact strings', () => {
      expect(safePatternMatch('node_modules', 'node_modules')).toBe(true)
      expect(safePatternMatch('.git', '.git')).toBe(true)
      expect(safePatternMatch('test', 'test')).toBe(true)
    })

    it('should not match completely different strings', () => {
      // Note: 'node_module' IS a prefix of 'node_modules', so it matches
      // These test truly different strings that share no prefix relationship
      expect(safePatternMatch('node_modules', 'package')).toBe(false)
      expect(safePatternMatch('.git', '.svn')).toBe(false)
      expect(safePatternMatch('src', 'lib')).toBe(false)
    })
  })

  describe('prefix matching', () => {
    it('should match prefixes', () => {
      expect(safePatternMatch('node_modules/package', 'node_')).toBe(true)
      expect(safePatternMatch('test-file.js', 'test-')).toBe(true)
      expect(safePatternMatch('.gitignore', '.git')).toBe(true)
    })

    it('should not match non-prefixes', () => {
      expect(safePatternMatch('package/node_modules', 'node_')).toBe(false)
      expect(safePatternMatch('mytest.js', 'test')).toBe(false)
    })
  })

  describe('regex matching', () => {
    it('should match valid regex patterns', () => {
      expect(safePatternMatch('test.js', '\\.js$')).toBe(true)
      expect(safePatternMatch('file.test.ts', '\\.(test|spec)\\.')).toBe(true)
      expect(safePatternMatch('node_modules', '^node')).toBe(true)
    })

    it('should not match when regex does not match', () => {
      expect(safePatternMatch('test.ts', '\\.js$')).toBe(false)
      expect(safePatternMatch('file.js', '\\.(test|spec)\\.')).toBe(false)
    })
  })

  describe('invalid regex fallback', () => {
    it('should fall back to includes for invalid regex', () => {
      // Invalid regex patterns should fall back to includes
      expect(safePatternMatch('test(evil', '(evil')).toBe(true)
      expect(safePatternMatch('test[unclosed', '[unclosed')).toBe(true)
    })

    it('should not crash on malicious regex', () => {
      expect(() => safePatternMatch('test', '(a+)+')).not.toThrow()
      expect(() => safePatternMatch('test', '(.*)*')).not.toThrow()
    })
  })
})

describe('validatePatterns', () => {
  describe('safe patterns', () => {
    it('should return no warnings for safe patterns', () => {
      const patterns = ['node_modules', '.git', '\\.js$', '^test-']
      expect(validatePatterns(patterns)).toEqual([])
    })

    it('should return no warnings for simple strings', () => {
      const patterns = ['dist', 'build', 'coverage']
      expect(validatePatterns(patterns)).toEqual([])
    })
  })

  describe('ReDoS detection', () => {
    it('should warn about nested + quantifiers', () => {
      const patterns = ['(a+)+b']
      const warnings = validatePatterns(patterns)
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('ReDoS')
      expect(warnings[0]).toContain('nested quantifiers')
    })

    it('should warn about nested * quantifiers', () => {
      const patterns = ['(a*)*b']
      const warnings = validatePatterns(patterns)
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('ReDoS')
    })
  })

  describe('suspicious patterns', () => {
    it('should warn about extremely long patterns', () => {
      const longPattern = 'a'.repeat(1001)
      const warnings = validatePatterns([longPattern])
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('suspiciously long')
      expect(warnings[0]).toContain('1001 chars')
    })
  })

  describe('invalid patterns', () => {
    it('should warn about invalid regex syntax', () => {
      const patterns = ['(unclosed', '[unclosed', 'invalid++']
      const warnings = validatePatterns(patterns)
      expect(warnings.length).toBeGreaterThan(0)
      warnings.forEach((warning) => {
        expect(warning).toContain('Invalid regex pattern')
      })
    })
  })

  describe('multiple warnings', () => {
    it('should return multiple warnings for multiple issues', () => {
      const patterns = [
        '(a+)+b', // ReDoS
        'a'.repeat(1001), // Too long
        '(unclosed', // Invalid
      ]
      const warnings = validatePatterns(patterns)
      expect(warnings.length).toBeGreaterThanOrEqual(3)
    })
  })
})

describe('ValidationError', () => {
  it('should be instanceof Error', () => {
    const error = new ValidationError('test', 'TEST_CODE')
    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(ValidationError)
  })

  it('should have correct properties', () => {
    const error = new ValidationError('test message', 'TEST_CODE', { foo: 'bar' })
    expect(error.message).toBe('test message')
    expect(error.code).toBe('TEST_CODE')
    expect(error.details).toEqual({ foo: 'bar' })
    expect(error.name).toBe('ValidationError')
  })
})
