/**
 * Unit tests for SMI-906: Auto-detect installed skills from ~/.claude/skills/
 * Tests the installed-skills utility functions
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  parseSkillMd,
  getSkillIdFromDir,
  getInstalledSkills,
  getInstalledSkillsSync,
  getInstalledSkillsDetailed,
} from '../../src/utils/installed-skills.js'

// Create a temp directory for testing
const TEST_TEMP_DIR = path.join(os.tmpdir(), 'skillsmith-test-skills-' + Date.now())

/**
 * Create a test skill directory with optional SKILL.md
 */
function createTestSkill(name: string, skillMdContent?: string): string {
  const skillDir = path.join(TEST_TEMP_DIR, name)
  fs.mkdirSync(skillDir, { recursive: true })

  if (skillMdContent) {
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillMdContent)
  }

  return skillDir
}

/**
 * Clean up test directory
 */
function cleanupTestDir(): void {
  if (fs.existsSync(TEST_TEMP_DIR)) {
    fs.rmSync(TEST_TEMP_DIR, { recursive: true, force: true })
  }
}

describe('installed-skills utility', () => {
  beforeEach(() => {
    cleanupTestDir()
    fs.mkdirSync(TEST_TEMP_DIR, { recursive: true })
  })

  afterEach(() => {
    cleanupTestDir()
  })

  describe('parseSkillMd', () => {
    it('should parse valid frontmatter with name', () => {
      const content = `---
name: docker
description: Docker development skill
---
# Docker Skill

Some content here.`

      const result = parseSkillMd(content)
      expect(result.id).toBe('docker')
      expect(result.name).toBe('docker')
      expect(result.description).toBe('Docker development skill')
    })

    it('should parse multiline description', () => {
      const content = `---
name: varlock
description: Secure environment variable management with Varlock.
---
# Varlock`

      const result = parseSkillMd(content)
      expect(result.id).toBe('varlock')
      expect(result.description).toBe('Secure environment variable management with Varlock.')
    })

    it('should return null values for missing frontmatter', () => {
      const content = `# Docker Skill

No frontmatter here.`

      const result = parseSkillMd(content)
      expect(result.id).toBeNull()
      expect(result.name).toBeNull()
      expect(result.description).toBeNull()
    })

    it('should return null values for unclosed frontmatter', () => {
      const content = `---
name: docker
description: Missing closing delimiter`

      const result = parseSkillMd(content)
      expect(result.id).toBeNull()
    })

    it('should handle empty frontmatter', () => {
      const content = `---
---
# Empty frontmatter`

      const result = parseSkillMd(content)
      expect(result.id).toBeNull()
      expect(result.name).toBeNull()
      expect(result.description).toBeNull()
    })

    it('should handle frontmatter with only name', () => {
      const content = `---
name: simple-skill
---
# Simple Skill`

      const result = parseSkillMd(content)
      expect(result.id).toBe('simple-skill')
      expect(result.name).toBe('simple-skill')
      expect(result.description).toBeNull()
    })

    it('should be case-insensitive for keys', () => {
      const content = `---
NAME: test-skill
Description: Test description
---
# Test`

      const result = parseSkillMd(content)
      expect(result.id).toBe('test-skill')
      expect(result.description).toBe('Test description')
    })
  })

  describe('getSkillIdFromDir', () => {
    it('should extract ID from SKILL.md', () => {
      const content = `---
name: custom-id
description: Test skill
---
# Custom Skill`

      createTestSkill('my-folder', content)
      const skillDir = path.join(TEST_TEMP_DIR, 'my-folder')

      const result = getSkillIdFromDir(skillDir, 'my-folder')
      expect(result).toBe('custom-id')
    })

    it('should fall back to directory name when no SKILL.md', () => {
      createTestSkill('folder-name')

      const skillDir = path.join(TEST_TEMP_DIR, 'folder-name')
      const result = getSkillIdFromDir(skillDir, 'folder-name')
      expect(result).toBe('folder-name')
    })

    it('should fall back to directory name when SKILL.md has no name', () => {
      const content = `---
description: No name field
---
# Missing Name`

      createTestSkill('fallback-folder', content)
      const skillDir = path.join(TEST_TEMP_DIR, 'fallback-folder')

      const result = getSkillIdFromDir(skillDir, 'fallback-folder')
      expect(result).toBe('fallback-folder')
    })

    it('should fall back to directory name when SKILL.md is invalid', () => {
      createTestSkill('invalid-md')
      // Write invalid content (not valid frontmatter)
      fs.writeFileSync(
        path.join(TEST_TEMP_DIR, 'invalid-md', 'SKILL.md'),
        'Not valid frontmatter content'
      )

      const skillDir = path.join(TEST_TEMP_DIR, 'invalid-md')
      const result = getSkillIdFromDir(skillDir, 'invalid-md')
      expect(result).toBe('invalid-md')
    })
  })

  describe('getInstalledSkills', () => {
    it('should return empty array for non-existent directory', async () => {
      const result = await getInstalledSkills('/non/existent/path')
      expect(result).toEqual([])
    })

    it('should return empty array for empty directory', async () => {
      const result = await getInstalledSkills(TEST_TEMP_DIR)
      expect(result).toEqual([])
    })

    it('should detect skills with SKILL.md', async () => {
      createTestSkill(
        'docker',
        `---
name: docker
description: Docker skill
---
# Docker`
      )

      createTestSkill(
        'varlock',
        `---
name: varlock
description: Varlock skill
---
# Varlock`
      )

      const result = await getInstalledSkills(TEST_TEMP_DIR)
      expect(result).toEqual(['docker', 'varlock'])
    })

    it('should fall back to folder names when no SKILL.md', async () => {
      createTestSkill('my-skill')
      createTestSkill('another-skill')

      const result = await getInstalledSkills(TEST_TEMP_DIR)
      expect(result).toEqual(['another-skill', 'my-skill'])
    })

    it('should mix SKILL.md IDs and folder names', async () => {
      createTestSkill(
        'has-skillmd',
        `---
name: custom-name
---
# Custom`
      )

      createTestSkill('no-skillmd')

      const result = await getInstalledSkills(TEST_TEMP_DIR)
      expect(result).toEqual(['custom-name', 'no-skillmd'])
    })

    it('should skip hidden directories', async () => {
      createTestSkill(
        '.hidden-skill',
        `---
name: hidden
---
# Hidden`
      )

      createTestSkill(
        'visible-skill',
        `---
name: visible
---
# Visible`
      )

      const result = await getInstalledSkills(TEST_TEMP_DIR)
      expect(result).toEqual(['visible'])
    })

    it('should skip files (only process directories)', async () => {
      // Create a file at the root level
      fs.writeFileSync(path.join(TEST_TEMP_DIR, 'some-file.txt'), 'content')

      createTestSkill(
        'real-skill',
        `---
name: real
---
# Real`
      )

      const result = await getInstalledSkills(TEST_TEMP_DIR)
      expect(result).toEqual(['real'])
    })

    it('should return sorted results', async () => {
      createTestSkill('zebra')
      createTestSkill('alpha')
      createTestSkill('beta')

      const result = await getInstalledSkills(TEST_TEMP_DIR)
      expect(result).toEqual(['alpha', 'beta', 'zebra'])
    })
  })

  describe('getInstalledSkillsSync', () => {
    it('should return empty array for non-existent directory', () => {
      const result = getInstalledSkillsSync('/non/existent/path')
      expect(result).toEqual([])
    })

    it('should detect skills synchronously', () => {
      createTestSkill(
        'sync-skill',
        `---
name: sync-test
---
# Sync`
      )

      const result = getInstalledSkillsSync(TEST_TEMP_DIR)
      expect(result).toEqual(['sync-test'])
    })
  })

  describe('getInstalledSkillsDetailed', () => {
    it('should return empty array for non-existent directory', async () => {
      const result = await getInstalledSkillsDetailed('/non/existent/path')
      expect(result).toEqual([])
    })

    it('should return detailed skill information', async () => {
      createTestSkill(
        'detailed-skill',
        `---
name: detailed
description: A detailed skill description
---
# Detailed Skill`
      )

      createTestSkill('simple-skill')

      const result = await getInstalledSkillsDetailed(TEST_TEMP_DIR)

      expect(result).toHaveLength(2)

      // Check detailed skill (has SKILL.md)
      const detailed = result.find((s) => s.id === 'detailed')
      expect(detailed).toBeDefined()
      expect(detailed?.directory).toBe('detailed-skill')
      expect(detailed?.hasSkillMd).toBe(true)
      expect(detailed?.description).toBe('A detailed skill description')

      // Check simple skill (no SKILL.md)
      const simple = result.find((s) => s.id === 'simple-skill')
      expect(simple).toBeDefined()
      expect(simple?.directory).toBe('simple-skill')
      expect(simple?.hasSkillMd).toBe(false)
      expect(simple?.description).toBeNull()
    })

    it('should include full path in result', async () => {
      createTestSkill('path-test')

      const result = await getInstalledSkillsDetailed(TEST_TEMP_DIR)

      expect(result).toHaveLength(1)
      expect(result[0].path).toBe(path.join(TEST_TEMP_DIR, 'path-test'))
    })
  })

  describe('integration with real ~/.claude/skills/ directory', () => {
    it('should work with default skills directory', async () => {
      // This test verifies the function works with real filesystem
      // It should not fail even if the directory doesn't exist
      const result = await getInstalledSkills()
      expect(Array.isArray(result)).toBe(true)
    })

    it('should handle real SKILL.md format', async () => {
      // Test with content that matches real SKILL.md format
      const realContent = `---
name: docker
description: Container-based development for isolated, reproducible environments. Use when running npm commands, installing packages, executing code, or managing project dependencies. Trigger phrases include "npm install", "run the build", "start the server", "install package", or any code execution request.
---

# Docker Development Skill

Execute all package installations and code execution inside Docker containers.`

      createTestSkill('real-format-test', realContent)

      const result = await getInstalledSkills(TEST_TEMP_DIR)
      expect(result).toEqual(['docker'])
    })
  })
})
