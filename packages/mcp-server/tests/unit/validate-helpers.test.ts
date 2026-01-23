/**
 * @fileoverview Tests for validate.helpers.ts
 * @module @skillsmith/mcp-server/tests/unit/validate-helpers
 *
 * SMI-1719: Unit tests for extracted helper functions from Wave 3 refactor
 */

import { describe, it, expect } from 'vitest'
import {
  parseYamlFrontmatter,
  hasSsrfPattern,
  hasPathTraversal,
  validateMetadata,
} from '../../src/tools/validate.helpers.js'

describe('validate.helpers', () => {
  describe('parseYamlFrontmatter', () => {
    it('parses simple key-value pairs', () => {
      const content = `---
name: my-skill
description: A test skill
version: 1.0.0
---
# Content`

      const result = parseYamlFrontmatter(content)

      expect(result).toEqual({
        name: 'my-skill',
        description: 'A test skill',
        version: '1.0.0',
      })
    })

    it('parses quoted strings', () => {
      const content = `---
name: "my-skill"
description: 'A test skill'
---`

      const result = parseYamlFrontmatter(content)

      expect(result?.name).toBe('my-skill')
      expect(result?.description).toBe('A test skill')
    })

    it('parses boolean values', () => {
      const content = `---
enabled: true
disabled: false
---`

      const result = parseYamlFrontmatter(content)

      expect(result?.enabled).toBe(true)
      expect(result?.disabled).toBe(false)
    })

    it('parses numeric values', () => {
      const content = `---
count: 42
score: 3.14
negative: -10
---`

      const result = parseYamlFrontmatter(content)

      expect(result?.count).toBe(42)
      expect(result?.score).toBe(3.14)
      expect(result?.negative).toBe(-10)
    })

    it('parses inline arrays', () => {
      const content = `---
tags: [typescript, testing, cli]
---`

      const result = parseYamlFrontmatter(content)

      expect(result?.tags).toEqual(['typescript', 'testing', 'cli'])
    })

    it('parses multiline arrays', () => {
      const content = `---
tags:
  - typescript
  - testing
  - cli
---`

      const result = parseYamlFrontmatter(content)

      expect(result?.tags).toEqual(['typescript', 'testing', 'cli'])
    })

    it('ignores comments', () => {
      const content = `---
# This is a comment
name: my-skill
# Another comment
description: Test
---`

      const result = parseYamlFrontmatter(content)

      expect(result).toEqual({
        name: 'my-skill',
        description: 'Test',
      })
    })

    it('returns null for content without frontmatter', () => {
      const content = '# Just markdown\n\nNo frontmatter here'

      expect(parseYamlFrontmatter(content)).toBeNull()
    })

    it('returns null for truly unclosed frontmatter', () => {
      // Note: The parser uses indexOf('---', 3) so any occurrence of --- will close it
      // This test verifies truly unclosed frontmatter (no --- anywhere after the opening)
      const content = `---
name: my-skill
description: Test
author: someone`

      expect(parseYamlFrontmatter(content)).toBeNull()
    })

    it('handles empty values', () => {
      const content = `---
name: my-skill
tags:
---`

      const result = parseYamlFrontmatter(content)

      expect(result?.name).toBe('my-skill')
    })
  })

  describe('hasSsrfPattern', () => {
    it('detects file:// protocol', () => {
      expect(hasSsrfPattern('file:///etc/passwd')).toBe(true)
    })

    it('detects gopher:// protocol', () => {
      expect(hasSsrfPattern('gopher://localhost')).toBe(true)
    })

    it('detects localhost', () => {
      expect(hasSsrfPattern('http://localhost/admin')).toBe(true)
    })

    it('detects 127.0.0.x', () => {
      expect(hasSsrfPattern('http://127.0.0.1/admin')).toBe(true)
    })

    it('detects private IP 10.x.x.x', () => {
      expect(hasSsrfPattern('http://10.0.0.1/internal')).toBe(true)
    })

    // SMI-1723: Additional private IP ranges
    it('detects private IP 192.168.x.x', () => {
      expect(hasSsrfPattern('http://192.168.1.1/admin')).toBe(true)
      expect(hasSsrfPattern('http://192.168.0.100/config')).toBe(true)
    })

    it('detects cloud metadata service 169.254.x.x', () => {
      // AWS/Azure/GCP metadata endpoints
      expect(hasSsrfPattern('http://169.254.169.254/latest/meta-data/')).toBe(true)
      expect(hasSsrfPattern('http://169.254.170.2/v2/credentials')).toBe(true)
    })

    it('allows safe URLs', () => {
      expect(hasSsrfPattern('https://github.com/user/repo')).toBe(false)
      expect(hasSsrfPattern('https://example.com')).toBe(false)
    })
  })

  describe('hasPathTraversal', () => {
    it('detects ../', () => {
      expect(hasPathTraversal('../etc/passwd')).toBe(true)
    })

    it('detects encoded path traversal', () => {
      expect(hasPathTraversal('%2e%2e/etc/passwd')).toBe(true)
    })

    it('detects windows-style traversal', () => {
      expect(hasPathTraversal('..\\windows\\system32')).toBe(true)
    })

    it('allows safe paths', () => {
      expect(hasPathTraversal('/home/user/file.txt')).toBe(false)
      expect(hasPathTraversal('src/index.ts')).toBe(false)
    })
  })

  describe('validateMetadata', () => {
    it('validates valid metadata', () => {
      const metadata = {
        name: 'my-skill',
        description: 'A test skill',
        author: 'test-author',
        version: '1.0.0',
        tags: ['testing'],
      }

      const errors = validateMetadata(metadata, false)

      expect(errors).toEqual([])
    })

    it('requires name field', () => {
      const metadata = { description: 'Test' }

      const errors = validateMetadata(metadata, false)

      expect(errors.some((e) => e.field === 'name' && e.severity === 'error')).toBe(true)
    })

    it('requires description in strict mode', () => {
      const metadata = { name: 'my-skill' }

      const strictErrors = validateMetadata(metadata, true)
      const normalErrors = validateMetadata(metadata, false)

      expect(strictErrors.some((e) => e.field === 'description' && e.severity === 'error')).toBe(
        true
      )
      expect(normalErrors.some((e) => e.field === 'description' && e.severity === 'warning')).toBe(
        true
      )
    })

    it('validates name type', () => {
      const metadata = { name: 123, description: 'Test' }

      const errors = validateMetadata(metadata, false)

      expect(errors.some((e) => e.field === 'name' && e.message.includes('must be a string'))).toBe(
        true
      )
    })

    it('validates name length', () => {
      const metadata = { name: 'a'.repeat(100), description: 'Test' }

      const errors = validateMetadata(metadata, false)

      expect(errors.some((e) => e.field === 'name' && e.message.includes('exceeds maximum'))).toBe(
        true
      )
    })

    it('validates tags array', () => {
      const metadata = { name: 'test', description: 'Test', tags: 'not-an-array' }

      const errors = validateMetadata(metadata, false)

      expect(errors.some((e) => e.field === 'tags' && e.message.includes('must be an array'))).toBe(
        true
      )
    })

    it('validates tag count', () => {
      const metadata = {
        name: 'test',
        description: 'Test',
        tags: Array(25).fill('tag'),
      }

      const errors = validateMetadata(metadata, false)

      expect(
        errors.some((e) => e.field === 'tags' && e.message.includes('exceeds maximum count'))
      ).toBe(true)
    })

    it('validates individual tag type', () => {
      const metadata = { name: 'test', description: 'Test', tags: [123, 'valid'] }

      const errors = validateMetadata(metadata, false)

      expect(
        errors.some((e) => e.field === 'tags[0]' && e.message.includes('must be a string'))
      ).toBe(true)
    })

    it('detects SSRF in repository URL', () => {
      const metadata = {
        name: 'test',
        description: 'Test',
        repository: 'http://localhost/admin',
      }

      const errors = validateMetadata(metadata, false)

      expect(
        errors.some((e) => e.field === 'repository' && e.message.includes('dangerous URL'))
      ).toBe(true)
    })

    it('detects SSRF in homepage URL', () => {
      const metadata = {
        name: 'test',
        description: 'Test',
        homepage: 'file:///etc/passwd',
      }

      const errors = validateMetadata(metadata, false)

      expect(
        errors.some((e) => e.field === 'homepage' && e.message.includes('dangerous URL'))
      ).toBe(true)
    })

    it('detects path traversal in any field', () => {
      const metadata = {
        name: 'test',
        description: '../../../etc/passwd',
      }

      const errors = validateMetadata(metadata, false)

      expect(
        errors.some((e) => e.field === 'description' && e.message.includes('path traversal'))
      ).toBe(true)
    })

    it('recommends version in strict mode', () => {
      const metadata = { name: 'test', description: 'Test' }

      const errors = validateMetadata(metadata, true)

      expect(errors.some((e) => e.field === 'version' && e.severity === 'warning')).toBe(true)
    })

    it('recommends tags in strict mode', () => {
      const metadata = { name: 'test', description: 'Test' }

      const errors = validateMetadata(metadata, true)

      expect(errors.some((e) => e.field === 'tags' && e.message.includes('recommended'))).toBe(true)
    })
  })
})
