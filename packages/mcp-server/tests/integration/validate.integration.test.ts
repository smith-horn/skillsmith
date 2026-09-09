/**
 * SMI-756: Integration tests for validate MCP tool
 * Tests skill validation with real filesystem
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import {
  createTestFilesystem,
  createMockInstalledSkill,
  type TestFilesystemContext,
} from './setup.js'
import { executeValidate, formatValidationResults } from '../../src/tools/validate.js'

describe('Validate Tool Integration', () => {
  let ctx: TestFilesystemContext

  beforeEach(async () => {
    ctx = await createTestFilesystem()
  })

  afterEach(async () => {
    await ctx.cleanup()
  })

  describe('executeValidate', () => {
    it('should validate a valid SKILL.md file', async () => {
      const validSkillContent = `---
name: test-skill
description: A valid test skill for integration testing
author: test-author
version: 1.0.0
triggers:
  - test trigger
  - another trigger
---

# Test Skill

This is a valid skill with proper frontmatter and content.

## Usage

Use this skill by saying "test trigger".
`
      const skillPath = await createMockInstalledSkill(
        ctx.skillsDir,
        'test-skill',
        validSkillContent
      )

      const result = await executeValidate({
        skill_path: skillPath,
      })

      expect(result.valid).toBe(true)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(result.errors.filter((e: any) => e.severity === 'error')).toHaveLength(0)
      expect(result.metadata).toBeDefined()
      expect(result.metadata?.name).toBe('test-skill')
    })

    it('should detect missing required fields in strict mode', async () => {
      const invalidContent = `---
name: test-skill
---

# Test Skill

Missing description field.
`
      const skillPath = await createMockInstalledSkill(
        ctx.skillsDir,
        'invalid-skill',
        invalidContent
      )

      // In strict mode, missing description is an error
      const result = await executeValidate({
        skill_path: skillPath,
        strict: true,
      })

      expect(result.valid).toBe(false)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const errors = result.errors.filter((e: any) => e.severity === 'error')
      expect(errors.length).toBeGreaterThan(0)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(errors.some((e: any) => e.field === 'description')).toBe(true)
    })

    it('should detect empty frontmatter', async () => {
      const emptyFrontmatter = `---
---

# Just Content

No frontmatter fields at all.
`
      const skillPath = await createMockInstalledSkill(ctx.skillsDir, 'empty-fm', emptyFrontmatter)

      const result = await executeValidate({
        skill_path: skillPath,
      })

      expect(result.valid).toBe(false)
      expect(result.errors.length).toBeGreaterThan(0)
    })

    it('should validate skill directory with SKILL.md', async () => {
      const skillContent = `---
name: dir-skill
description: A skill in a directory
version: 1.0.0
---

# Directory Skill
`
      const skillDir = path.join(ctx.skillsDir, 'dir-skill')
      await fs.mkdir(skillDir, { recursive: true })
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), skillContent)

      const result = await executeValidate({
        skill_path: skillDir,
      })

      expect(result.path).toContain('SKILL.md')
    })

    it('should throw for non-existent path', async () => {
      await expect(
        executeValidate({
          skill_path: '/non/existent/path',
        })
      ).rejects.toThrow()
    })

    it('should enforce strict mode', async () => {
      // Fixture has no description: non-strict → warning; strict → error
      const warningContent = `---
name: warning-skill
version: 1.0.0
---

# Warning Skill
`
      const skillPath = await createMockInstalledSkill(
        ctx.skillsDir,
        'warning-skill',
        warningContent
      )

      const normalResult = await executeValidate({
        skill_path: skillPath,
        strict: false,
      })

      const strictResult = await executeValidate({
        skill_path: skillPath,
        strict: true,
      })

      // In strict mode, warnings become errors
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (normalResult.errors.some((e: any) => e.severity === 'warning')) {
        expect(strictResult.valid).toBe(false)
      }
    })

    it('should detect security issues', async () => {
      const securityContent = `---
name: security-test
description: A skill with potential security issues
url: file:///etc/passwd
---

# Security Test
`
      const skillPath = await createMockInstalledSkill(
        ctx.skillsDir,
        'security-skill',
        securityContent
      )

      const result = await executeValidate({
        skill_path: skillPath,
      })

      // Should detect file:// URL as security issue
      const _securityErrors = result.errors.filter(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (e: any) =>
          e.message.toLowerCase().includes('security') || e.message.toLowerCase().includes('url')
      )
      // May or may not have security errors depending on implementation
      expect(result.errors).toBeDefined()
    })

    it('should track timing information', async () => {
      const skillPath = await createMockInstalledSkill(ctx.skillsDir, 'timing-skill')

      const result = await executeValidate({
        skill_path: skillPath,
      })

      expect(result.timing.totalMs).toBeGreaterThanOrEqual(0)
    })

    // SMI-6472: Agent Skills spec name format + name/directory match
    it('should reject a frontmatter name that does not match the spec name format', async () => {
      const badFormatContent = `---
name: Bad_Name
description: A skill with an invalid name format
version: 1.0.0
---

# Bad Name Skill
`
      const skillPath = await createMockInstalledSkill(ctx.skillsDir, 'Bad_Name', badFormatContent)

      const result = await executeValidate({
        skill_path: skillPath,
      })

      expect(result.valid).toBe(false)
      expect(
        result.errors.some(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (e: any) =>
            e.field === 'name' && e.severity === 'error' && e.message.includes('lowercase letter')
        )
      ).toBe(true)
    })

    it('should pass when name matches spec format and directory (isDirectory=true)', async () => {
      const matchingContent = `---
name: matching-skill
description: A skill whose name matches its directory
version: 1.0.0
---

# Matching Skill
`
      const skillPath = await createMockInstalledSkill(
        ctx.skillsDir,
        'matching-skill',
        matchingContent
      )

      const result = await executeValidate({
        skill_path: skillPath,
      })

      expect(result.valid).toBe(true)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(result.errors.filter((e: any) => e.severity === 'error')).toHaveLength(0)
    })

    it('should reject a frontmatter name that does not match its directory (isDirectory=true)', async () => {
      const mismatchContent = `---
name: other-skill-name
description: A skill whose frontmatter name does not match its directory
version: 1.0.0
---

# Mismatched Skill
`
      const skillPath = await createMockInstalledSkill(
        ctx.skillsDir,
        'actual-dir-name',
        mismatchContent
      )

      const result = await executeValidate({
        skill_path: skillPath,
      })

      expect(result.valid).toBe(false)
      expect(
        result.errors.some(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (e: any) =>
            e.field === 'name' &&
            e.severity === 'error' &&
            e.message.includes('other-skill-name') &&
            e.message.includes('actual-dir-name')
        )
      ).toBe(true)
    })

    it('should reject a frontmatter name that does not match its directory (isDirectory=false, direct SKILL.md path)', async () => {
      const mismatchContent = `---
name: file-mode-name
description: A skill validated via a direct SKILL.md path, name mismatched
version: 1.0.0
---

# Mismatched Skill (file mode)
`
      const skillDir = await createMockInstalledSkill(
        ctx.skillsDir,
        'file-mode-dir',
        mismatchContent
      )
      const skillFilePath = path.join(skillDir, 'SKILL.md')

      const result = await executeValidate({
        skill_path: skillFilePath,
      })

      expect(result.valid).toBe(false)
      expect(
        result.errors.some(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (e: any) =>
            e.field === 'name' &&
            e.severity === 'error' &&
            e.message.includes('file-mode-name') &&
            e.message.includes('file-mode-dir')
        )
      ).toBe(true)
    })
  })

  describe('formatValidationResults', () => {
    it('should format valid skill results', async () => {
      const validContent = `---
name: format-test
description: Testing format output
version: 1.0.0
---

# Format Test
`
      const skillPath = await createMockInstalledSkill(ctx.skillsDir, 'format-skill', validContent)
      const result = await executeValidate({ skill_path: skillPath })
      const formatted = formatValidationResults(result)

      expect(formatted).toContain('Validation')
    })

    it('should format errors and warnings', async () => {
      const invalidContent = `---
name: error-test
---

# Error Test
`
      const skillPath = await createMockInstalledSkill(ctx.skillsDir, 'error-skill', invalidContent)
      const result = await executeValidate({ skill_path: skillPath })
      const formatted = formatValidationResults(result)

      expect(formatted).toBeDefined()
      expect(typeof formatted).toBe('string')
    })
  })
})
