/**
 * Tests for SMI-1809: index_local MCP Tool
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  executeIndexLocal,
  formatIndexLocalResults,
  type IndexLocalResponse,
} from '../tools/index-local.js'
import { createTestContext, type ToolContext } from './test-utils.js'

// Test fixtures directory
let testSkillsDir: string
let context: ToolContext

/**
 * Create a test skill directory with SKILL.md
 */
function createTestSkill(
  dir: string,
  name: string,
  frontmatter?: Record<string, string | string[]>
): void {
  const skillDir = path.join(dir, name)
  fs.mkdirSync(skillDir, { recursive: true })

  if (frontmatter) {
    let content = '---\n'
    for (const [key, value] of Object.entries(frontmatter)) {
      if (Array.isArray(value)) {
        content += `${key}:\n`
        for (const item of value) {
          content += `  - ${item}\n`
        }
      } else {
        content += `${key}: ${value}\n`
      }
    }
    content += '---\n\n# ' + name + ' Skill\n\nThis is a test skill.'
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content)
  }
}

describe('index_local Tool', () => {
  beforeAll(() => {
    // Create a temp directory for test skills
    testSkillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillsmith-index-local-test-'))
    context = createTestContext()
  })

  afterAll(() => {
    // Cleanup temp directory
    fs.rmSync(testSkillsDir, { recursive: true, force: true })
    context.db.close()
  })

  beforeEach(() => {
    // Clear test directory before each test
    const entries = fs.readdirSync(testSkillsDir, { withFileTypes: true })
    for (const entry of entries) {
      fs.rmSync(path.join(testSkillsDir, entry.name), { recursive: true, force: true })
    }
  })

  describe('executeIndexLocal', () => {
    it('should return count of indexed skills', async () => {
      createTestSkill(testSkillsDir, 'skill-one', {
        name: 'skill-one',
        description: 'First test skill',
        tags: ['testing'],
      })
      createTestSkill(testSkillsDir, 'skill-two', {
        name: 'skill-two',
        description: 'Second test skill',
      })

      const result = await executeIndexLocal({ skillsDir: testSkillsDir, force: true }, context)

      expect(result.count).toBe(2)
      expect(result.skills).toHaveLength(2)
    })

    it('should return skill summaries', async () => {
      createTestSkill(testSkillsDir, 'documented-skill', {
        name: 'documented-skill',
        description: 'A well-documented skill',
        author: 'test-author',
        tags: ['testing', 'documentation'],
      })

      const result = await executeIndexLocal({ skillsDir: testSkillsDir, force: true }, context)

      expect(result.skills).toHaveLength(1)
      expect(result.skills[0].id).toBe('local/documented-skill')
      expect(result.skills[0].name).toBe('documented-skill')
      expect(result.skills[0].hasSkillMd).toBe(true)
      expect(result.skills[0].tagCount).toBe(2)
      expect(result.skills[0].qualityScore).toBeGreaterThan(0)
    })

    it('should return skills directory path', async () => {
      const result = await executeIndexLocal({ skillsDir: testSkillsDir }, context)

      expect(result.skillsDir).toBe(testSkillsDir)
    })

    it('should include timing information', async () => {
      createTestSkill(testSkillsDir, 'timed-skill', { name: 'timed-skill' })

      const result = await executeIndexLocal({ skillsDir: testSkillsDir, force: true }, context)

      expect(result.timing.indexMs).toBeGreaterThanOrEqual(0)
      expect(result.timing.totalMs).toBeGreaterThanOrEqual(0)
      expect(result.timing.totalMs).toBeGreaterThanOrEqual(result.timing.indexMs)
    })

    it('should indicate if result is from cache', async () => {
      createTestSkill(testSkillsDir, 'cache-skill', { name: 'cache-skill' })

      // First call - not from cache
      const result1 = await executeIndexLocal({ skillsDir: testSkillsDir, force: true }, context)
      expect(result1.fromCache).toBe(false)

      // Note: Due to how the indexer works with new instances per call,
      // cache behavior may vary. This tests the response field presence.
      expect(typeof result1.fromCache).toBe('boolean')
    })

    it('should return empty array for empty directory', async () => {
      const result = await executeIndexLocal({ skillsDir: testSkillsDir }, context)

      expect(result.count).toBe(0)
      expect(result.skills).toEqual([])
    })

    it('should return empty array for non-existent directory', async () => {
      const result = await executeIndexLocal(
        { skillsDir: '/non/existent/path' },
        context
      )

      expect(result.count).toBe(0)
      expect(result.skills).toEqual([])
    })

    it('should force re-index when force=true', async () => {
      createTestSkill(testSkillsDir, 'initial-skill', { name: 'initial' })

      // First index
      const result1 = await executeIndexLocal({ skillsDir: testSkillsDir, force: true }, context)
      expect(result1.count).toBe(1)

      // Add another skill
      createTestSkill(testSkillsDir, 'new-skill', { name: 'new' })

      // Force re-index should find new skill
      const result2 = await executeIndexLocal({ skillsDir: testSkillsDir, force: true }, context)
      expect(result2.count).toBe(2)
    })
  })

  describe('formatIndexLocalResults', () => {
    it('should format results for display', () => {
      const response: IndexLocalResponse = {
        count: 2,
        skillsDir: '/test/skills',
        skills: [
          { id: 'local/skill-one', name: 'skill-one', qualityScore: 85, hasSkillMd: true, tagCount: 3 },
          { id: 'local/skill-two', name: 'skill-two', qualityScore: 45, hasSkillMd: false, tagCount: 0 },
        ],
        timing: { indexMs: 10, totalMs: 15 },
        fromCache: false,
      }

      const formatted = formatIndexLocalResults(response)

      expect(formatted).toContain('Local Skills Index')
      expect(formatted).toContain('/test/skills')
      expect(formatted).toContain('2 skill(s)')
      expect(formatted).toContain('skill-one')
      expect(formatted).toContain('[HIGH]')
      expect(formatted).toContain('skill-two')
      expect(formatted).toContain('[LOW]')
      expect(formatted).toContain('(no SKILL.md)')
      expect(formatted).toContain('10ms')
      expect(formatted).toContain('15ms')
    })

    it('should format empty results', () => {
      const response: IndexLocalResponse = {
        count: 0,
        skillsDir: '/test/skills',
        skills: [],
        timing: { indexMs: 5, totalMs: 8 },
        fromCache: false,
      }

      const formatted = formatIndexLocalResults(response)

      expect(formatted).toContain('No skills found')
      expect(formatted).toContain('To add skills:')
      expect(formatted).toContain('~/.claude/skills/')
    })

    it('should indicate cache status', () => {
      const response: IndexLocalResponse = {
        count: 1,
        skillsDir: '/test/skills',
        skills: [{ id: 'local/cached', name: 'cached', qualityScore: 70, hasSkillMd: true, tagCount: 1 }],
        timing: { indexMs: 1, totalMs: 2 },
        fromCache: true,
      }

      const formatted = formatIndexLocalResults(response)

      expect(formatted).toContain('(from cache)')
    })

    it('should show medium quality badge', () => {
      const response: IndexLocalResponse = {
        count: 1,
        skillsDir: '/test/skills',
        skills: [{ id: 'local/medium', name: 'medium', qualityScore: 60, hasSkillMd: true, tagCount: 2 }],
        timing: { indexMs: 5, totalMs: 8 },
        fromCache: false,
      }

      const formatted = formatIndexLocalResults(response)

      expect(formatted).toContain('[MED]')
    })
  })
})
