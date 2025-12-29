/**
 * Tests for SMI-742: MCP Skill Validate Tool
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  executeValidate,
  formatValidationResults,
  validateInputSchema,
} from '../src/tools/validate.js'
import { SkillsmithError, ErrorCodes } from '@skillsmith/core'

describe('Skill Validate Tool', () => {
  let testDir: string

  beforeEach(async () => {
    // Create a temporary directory for test files
    testDir = await fs.mkdtemp(join(tmpdir(), 'skillsmith-validate-test-'))
  })

  afterEach(async () => {
    // Clean up test directory
    await fs.rm(testDir, { recursive: true, force: true })
  })

  describe('validateInputSchema', () => {
    it('should require skill_path', () => {
      expect(() => validateInputSchema.parse({})).toThrow()
      expect(() => validateInputSchema.parse({ skill_path: '' })).toThrow()
    })

    it('should accept valid skill_path', () => {
      const result = validateInputSchema.parse({
        skill_path: '/path/to/SKILL.md',
      })
      expect(result.skill_path).toBe('/path/to/SKILL.md')
      expect(result.strict).toBe(false) // default
    })

    it('should accept strict mode', () => {
      const result = validateInputSchema.parse({
        skill_path: '/path/to/skill',
        strict: true,
      })
      expect(result.strict).toBe(true)
    })

    it('should default strict to false', () => {
      const result = validateInputSchema.parse({
        skill_path: '/path/to/skill',
      })
      expect(result.strict).toBe(false)
    })
  })

  describe('executeValidate', () => {
    it('should validate a valid SKILL.md file', async () => {
      const skillContent = `---
name: test-skill
description: A test skill for validation
author: test-author
version: 1.0.0
tags:
  - testing
  - validation
---

# Test Skill

This is a test skill.
`
      const filePath = join(testDir, 'SKILL.md')
      await fs.writeFile(filePath, skillContent)

      const result = await executeValidate({ skill_path: filePath })

      expect(result.valid).toBe(true)
      expect(result.errors.filter((e) => e.severity === 'error')).toHaveLength(0)
      expect(result.metadata).toBeDefined()
      expect(result.metadata?.name).toBe('test-skill')
      expect(result.metadata?.description).toBe('A test skill for validation')
      expect(result.timing.totalMs).toBeGreaterThanOrEqual(0)
    })

    it('should find SKILL.md in directory', async () => {
      const skillContent = `---
name: dir-skill
description: Skill in directory
---
`
      await fs.writeFile(join(testDir, 'SKILL.md'), skillContent)

      const result = await executeValidate({ skill_path: testDir })

      expect(result.valid).toBe(true)
      expect(result.path).toBe(join(testDir, 'SKILL.md'))
      expect(result.metadata?.name).toBe('dir-skill')
    })

    it('should return error for missing name field', async () => {
      const skillContent = `---
description: A skill without a name
---
`
      const filePath = join(testDir, 'SKILL.md')
      await fs.writeFile(filePath, skillContent)

      const result = await executeValidate({ skill_path: filePath })

      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.field === 'name' && e.severity === 'error')).toBe(true)
    })

    it('should warn for missing description in non-strict mode', async () => {
      const skillContent = `---
name: no-description-skill
---
`
      const filePath = join(testDir, 'SKILL.md')
      await fs.writeFile(filePath, skillContent)

      const result = await executeValidate({ skill_path: filePath, strict: false })

      expect(result.valid).toBe(true) // Still valid in non-strict mode
      expect(result.errors.some((e) => e.field === 'description' && e.severity === 'warning')).toBe(
        true
      )
    })

    it('should error for missing description in strict mode', async () => {
      const skillContent = `---
name: no-description-skill
---
`
      const filePath = join(testDir, 'SKILL.md')
      await fs.writeFile(filePath, skillContent)

      const result = await executeValidate({ skill_path: filePath, strict: true })

      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.field === 'description' && e.severity === 'error')).toBe(
        true
      )
    })

    it('should error for name exceeding 64 characters', async () => {
      const longName = 'a'.repeat(65)
      const skillContent = `---
name: ${longName}
description: A skill with a very long name
---
`
      const filePath = join(testDir, 'SKILL.md')
      await fs.writeFile(filePath, skillContent)

      const result = await executeValidate({ skill_path: filePath })

      expect(result.valid).toBe(false)
      expect(
        result.errors.some(
          (e) => e.field === 'name' && e.message.includes('exceeds maximum length')
        )
      ).toBe(true)
    })

    it('should error for description exceeding 1024 characters', async () => {
      const longDesc = 'a'.repeat(1025)
      const skillContent = `---
name: long-desc-skill
description: ${longDesc}
---
`
      const filePath = join(testDir, 'SKILL.md')
      await fs.writeFile(filePath, skillContent)

      const result = await executeValidate({ skill_path: filePath })

      expect(result.valid).toBe(false)
      expect(
        result.errors.some(
          (e) => e.field === 'description' && e.message.includes('exceeds maximum length')
        )
      ).toBe(true)
    })

    it('should detect SSRF pattern in repository URL', async () => {
      const skillContent = `---
name: ssrf-skill
description: A skill with dangerous URL
repository: file:///etc/passwd
---
`
      const filePath = join(testDir, 'SKILL.md')
      await fs.writeFile(filePath, skillContent)

      const result = await executeValidate({ skill_path: filePath })

      expect(result.valid).toBe(false)
      expect(
        result.errors.some(
          (e) => e.field === 'repository' && e.message.includes('dangerous URL pattern')
        )
      ).toBe(true)
    })

    it('should detect localhost in repository URL', async () => {
      const skillContent = `---
name: localhost-skill
description: A skill with localhost URL
repository: http://localhost:8080/repo
---
`
      const filePath = join(testDir, 'SKILL.md')
      await fs.writeFile(filePath, skillContent)

      const result = await executeValidate({ skill_path: filePath })

      expect(result.valid).toBe(false)
      expect(
        result.errors.some(
          (e) => e.field === 'repository' && e.message.includes('dangerous URL pattern')
        )
      ).toBe(true)
    })

    it('should detect path traversal in values', async () => {
      const skillContent = `---
name: traversal-skill
description: ../../../etc/passwd
---
`
      const filePath = join(testDir, 'SKILL.md')
      await fs.writeFile(filePath, skillContent)

      const result = await executeValidate({ skill_path: filePath })

      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.message.includes('path traversal'))).toBe(true)
    })

    it('should error for invalid frontmatter', async () => {
      const skillContent = `# No Frontmatter Skill

This skill has no YAML frontmatter.
`
      const filePath = join(testDir, 'SKILL.md')
      await fs.writeFile(filePath, skillContent)

      const result = await executeValidate({ skill_path: filePath })

      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.field === 'frontmatter')).toBe(true)
    })

    it('should throw for non-existent path', async () => {
      const fakePath = join(testDir, 'nonexistent', 'SKILL.md')

      try {
        await executeValidate({ skill_path: fakePath })
        expect.fail('Should have thrown an error')
      } catch (error) {
        expect(error).toBeInstanceOf(SkillsmithError)
        expect((error as SkillsmithError).code).toBe(ErrorCodes.SKILL_NOT_FOUND)
      }
    })

    it('should throw for path traversal in input path', async () => {
      try {
        await executeValidate({ skill_path: '../../../etc/passwd' })
        expect.fail('Should have thrown an error')
      } catch (error) {
        expect(error).toBeInstanceOf(SkillsmithError)
        expect((error as SkillsmithError).code).toBe(ErrorCodes.VALIDATION_INVALID_TYPE)
      }
    })

    it('should validate tags array correctly', async () => {
      const skillContent = `---
name: tags-skill
description: A skill with invalid tags
tags: not-an-array
---
`
      const filePath = join(testDir, 'SKILL.md')
      await fs.writeFile(filePath, skillContent)

      const result = await executeValidate({ skill_path: filePath })

      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.field === 'tags' && e.message.includes('array'))).toBe(
        true
      )
    })

    it('should validate tag length limits', async () => {
      const longTag = 'a'.repeat(33)
      const skillContent = `---
name: long-tag-skill
description: A skill with a very long tag
tags:
  - ${longTag}
---
`
      const filePath = join(testDir, 'SKILL.md')
      await fs.writeFile(filePath, skillContent)

      const result = await executeValidate({ skill_path: filePath })

      expect(result.valid).toBe(false)
      expect(
        result.errors.some((e) => e.field.startsWith('tags[') && e.message.includes('exceeds'))
      ).toBe(true)
    })
  })

  describe('formatValidationResults', () => {
    it('should format valid skill results', async () => {
      const skillContent = `---
name: format-test-skill
description: A skill for testing formatting
author: tester
version: 1.0.0
tags: [testing, formatting]
---
`
      const filePath = join(testDir, 'SKILL.md')
      await fs.writeFile(filePath, skillContent)

      const result = await executeValidate({ skill_path: filePath })
      const formatted = formatValidationResults(result)

      expect(formatted).toContain('Skill Validation Results')
      expect(formatted).toContain('Status: VALID')
      expect(formatted).toContain('Metadata:')
      expect(formatted).toContain('Name: format-test-skill')
      expect(formatted).toContain('Author: tester')
      expect(formatted).toContain('Version: 1.0.0')
    })

    it('should format invalid skill results with errors', async () => {
      const skillContent = `---
description: No name field
---
`
      const filePath = join(testDir, 'SKILL.md')
      await fs.writeFile(filePath, skillContent)

      const result = await executeValidate({ skill_path: filePath })
      const formatted = formatValidationResults(result)

      expect(formatted).toContain('Status: INVALID')
      expect(formatted).toContain('[ERROR]')
      expect(formatted).toContain('name')
    })

    it('should show warning count in formatted output', async () => {
      const skillContent = `---
name: warning-skill
---
`
      const filePath = join(testDir, 'SKILL.md')
      await fs.writeFile(filePath, skillContent)

      const result = await executeValidate({ skill_path: filePath })
      const formatted = formatValidationResults(result)

      expect(formatted).toContain('warning(s)')
      expect(formatted).toContain('[WARN]')
    })

    it('should include timing information', async () => {
      const skillContent = `---
name: timing-skill
description: Test timing
---
`
      const filePath = join(testDir, 'SKILL.md')
      await fs.writeFile(filePath, skillContent)

      const result = await executeValidate({ skill_path: filePath })
      const formatted = formatValidationResults(result)

      expect(formatted).toContain('Completed in')
      expect(formatted).toContain('ms')
    })
  })
})
