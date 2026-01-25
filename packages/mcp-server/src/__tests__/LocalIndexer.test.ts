/**
 * Tests for SMI-1809: LocalIndexer - Local skill indexing
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  LocalIndexer,
  getLocalIndexer,
  resetLocalIndexer,
  type LocalSkill,
} from '../indexer/LocalIndexer.js'

// Test fixtures directory
let testSkillsDir: string

/**
 * Create a test skill directory with SKILL.md
 */
function createTestSkill(
  dir: string,
  name: string,
  frontmatter?: Record<string, string | string[]>
): string {
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

  return skillDir
}

describe('LocalIndexer', () => {
  beforeAll(() => {
    // Create a temp directory for test skills
    testSkillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillsmith-test-'))
  })

  afterAll(() => {
    // Cleanup temp directory
    fs.rmSync(testSkillsDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    // Clear test directory before each test
    const entries = fs.readdirSync(testSkillsDir, { withFileTypes: true })
    for (const entry of entries) {
      fs.rmSync(path.join(testSkillsDir, entry.name), { recursive: true, force: true })
    }
  })

  describe('parseFrontmatter', () => {
    it('should parse basic frontmatter fields', () => {
      const indexer = new LocalIndexer(testSkillsDir)
      const content = `---
name: test-skill
description: A test skill for testing
author: test-author
version: 1.0.0
---

# Test Skill`

      const result = indexer.parseFrontmatter(content)

      expect(result.name).toBe('test-skill')
      expect(result.description).toBe('A test skill for testing')
      expect(result.author).toBe('test-author')
      expect(result.version).toBe('1.0.0')
    })

    it('should parse tags as array', () => {
      const indexer = new LocalIndexer(testSkillsDir)
      const content = `---
name: test-skill
tags:
  - testing
  - development
  - automation
---

# Test Skill`

      const result = indexer.parseFrontmatter(content)

      expect(result.tags).toEqual(['testing', 'development', 'automation'])
    })

    it('should parse inline array tags', () => {
      const indexer = new LocalIndexer(testSkillsDir)
      const content = `---
name: test-skill
tags: [testing, development, automation]
---

# Test Skill`

      const result = indexer.parseFrontmatter(content)

      expect(result.tags).toEqual(['testing', 'development', 'automation'])
    })

    it('should handle missing frontmatter', () => {
      const indexer = new LocalIndexer(testSkillsDir)
      const content = '# Test Skill\n\nNo frontmatter here.'

      const result = indexer.parseFrontmatter(content)

      expect(result.name).toBeNull()
      expect(result.description).toBeNull()
      expect(result.tags).toEqual([])
    })

    it('should handle unclosed frontmatter', () => {
      const indexer = new LocalIndexer(testSkillsDir)
      const content = `---
name: test-skill
# Missing closing delimiter`

      const result = indexer.parseFrontmatter(content)

      expect(result.name).toBeNull()
    })

    it('should handle quoted values', () => {
      const indexer = new LocalIndexer(testSkillsDir)
      const content = `---
name: "quoted-skill"
description: 'Single quoted description'
---

# Test`

      const result = indexer.parseFrontmatter(content)

      expect(result.name).toBe('quoted-skill')
      expect(result.description).toBe('Single quoted description')
    })
  })

  describe('calculateQualityScore', () => {
    it('should score a fully documented skill highly', () => {
      const indexer = new LocalIndexer(testSkillsDir)
      const frontmatter = {
        name: 'well-documented',
        description: 'A comprehensive description that explains what this skill does in detail.',
        author: 'test-author',
        tags: ['testing', 'documentation', 'quality', 'best-practices', 'automation'],
        version: '1.0.0',
        triggers: [],
      }

      const score = indexer.calculateQualityScore(frontmatter, true)

      // Should have high score with all fields present
      expect(score).toBeGreaterThanOrEqual(80)
    })

    it('should score a minimal skill lower', () => {
      const indexer = new LocalIndexer(testSkillsDir)
      const frontmatter = {
        name: null,
        description: null,
        author: null,
        tags: [],
        version: null,
        triggers: [],
      }

      const score = indexer.calculateQualityScore(frontmatter, false)

      // Should have low score with no fields
      expect(score).toBe(0)
    })

    it('should give points for SKILL.md presence', () => {
      const indexer = new LocalIndexer(testSkillsDir)
      const frontmatter = {
        name: null,
        description: null,
        author: null,
        tags: [],
        version: null,
        triggers: [],
      }

      const scoreWithout = indexer.calculateQualityScore(frontmatter, false)
      const scoreWith = indexer.calculateQualityScore(frontmatter, true)

      expect(scoreWith).toBeGreaterThan(scoreWithout)
    })

    it('should reward longer descriptions', () => {
      const indexer = new LocalIndexer(testSkillsDir)
      const shortDesc = {
        name: 'test',
        description: 'Short',
        author: null,
        tags: [],
        version: null,
        triggers: [],
      }
      const longDesc = {
        name: 'test',
        description:
          'A much longer description that provides more context and detail about what the skill does and how to use it effectively.',
        author: null,
        tags: [],
        version: null,
        triggers: [],
      }

      const shortScore = indexer.calculateQualityScore(shortDesc, true)
      const longScore = indexer.calculateQualityScore(longDesc, true)

      expect(longScore).toBeGreaterThan(shortScore)
    })

    it('should reward more tags (up to 5)', () => {
      const indexer = new LocalIndexer(testSkillsDir)
      const oneTags = {
        name: 'test',
        description: null,
        author: null,
        tags: ['one'],
        version: null,
        triggers: [],
      }
      const fiveTags = {
        name: 'test',
        description: null,
        author: null,
        tags: ['one', 'two', 'three', 'four', 'five'],
        version: null,
        triggers: [],
      }

      const oneScore = indexer.calculateQualityScore(oneTags, true)
      const fiveScore = indexer.calculateQualityScore(fiveTags, true)

      expect(fiveScore).toBeGreaterThan(oneScore)
    })
  })

  describe('index', () => {
    it('should index skills from directory', async () => {
      // Create test skills
      createTestSkill(testSkillsDir, 'skill-one', {
        name: 'skill-one',
        description: 'First test skill',
        tags: ['testing'],
      })
      createTestSkill(testSkillsDir, 'skill-two', {
        name: 'skill-two',
        description: 'Second test skill',
        author: 'test-author',
        tags: ['testing', 'development'],
      })

      const indexer = new LocalIndexer(testSkillsDir)
      const skills = await indexer.index()

      expect(skills).toHaveLength(2)
      expect(skills.map((s) => s.name)).toContain('skill-one')
      expect(skills.map((s) => s.name)).toContain('skill-two')
    })

    it('should use directory name if no SKILL.md', async () => {
      // Create skill without SKILL.md
      fs.mkdirSync(path.join(testSkillsDir, 'no-skillmd-skill'))

      const indexer = new LocalIndexer(testSkillsDir)
      const skills = await indexer.index()

      expect(skills).toHaveLength(1)
      expect(skills[0].name).toBe('no-skillmd-skill')
      expect(skills[0].hasSkillMd).toBe(false)
    })

    it('should skip hidden directories', async () => {
      createTestSkill(testSkillsDir, 'visible-skill', { name: 'visible' })
      fs.mkdirSync(path.join(testSkillsDir, '.hidden-skill'))
      fs.writeFileSync(
        path.join(testSkillsDir, '.hidden-skill', 'SKILL.md'),
        '---\nname: hidden\n---'
      )

      const indexer = new LocalIndexer(testSkillsDir)
      const skills = await indexer.index()

      expect(skills).toHaveLength(1)
      expect(skills[0].name).toBe('visible')
    })

    it('should return empty array for non-existent directory', async () => {
      const indexer = new LocalIndexer('/non/existent/path')
      const skills = await indexer.index()

      expect(skills).toEqual([])
    })

    it('should cache results', async () => {
      createTestSkill(testSkillsDir, 'cached-skill', { name: 'cached' })

      const indexer = new LocalIndexer(testSkillsDir, 60000) // 1 minute cache
      const initialSkills = await indexer.index()
      expect(initialSkills).toHaveLength(1)

      // Add another skill
      createTestSkill(testSkillsDir, 'new-skill', { name: 'new' })

      // Should return cached results
      const cachedSkills = await indexer.index()
      expect(cachedSkills).toHaveLength(1)

      // Force re-index should find new skill
      const refreshedSkills = await indexer.index(true)
      expect(refreshedSkills).toHaveLength(2)
    })

    it('should populate all LocalSkill fields', async () => {
      createTestSkill(testSkillsDir, 'complete-skill', {
        name: 'complete-skill',
        description: 'A complete test skill with all fields',
        author: 'test-author',
        tags: ['testing', 'complete'],
      })

      const indexer = new LocalIndexer(testSkillsDir)
      const skills = await indexer.index()

      expect(skills).toHaveLength(1)
      const skill = skills[0]

      expect(skill.id).toBe('local/complete-skill')
      expect(skill.name).toBe('complete-skill')
      expect(skill.description).toBe('A complete test skill with all fields')
      expect(skill.author).toBe('test-author')
      expect(skill.tags).toEqual(['testing', 'complete'])
      expect(skill.trustTier).toBe('local')
      expect(skill.source).toBe('local')
      expect(skill.hasSkillMd).toBe(true)
      expect(skill.qualityScore).toBeGreaterThan(0)
      expect(skill.path).toBe(path.join(testSkillsDir, 'complete-skill'))
      expect(skill.lastModified).not.toBeNull()
    })
  })

  describe('indexSync', () => {
    it('should synchronously index skills', () => {
      createTestSkill(testSkillsDir, 'sync-skill', { name: 'sync-skill' })

      const indexer = new LocalIndexer(testSkillsDir)
      const skills = indexer.indexSync()

      expect(skills).toHaveLength(1)
      expect(skills[0].name).toBe('sync-skill')
    })
  })

  describe('search', () => {
    let indexer: LocalIndexer
    let testSkills: LocalSkill[]

    beforeEach(async () => {
      createTestSkill(testSkillsDir, 'docker', {
        name: 'docker',
        description: 'Docker container management skill',
        author: 'devops-team',
        tags: ['docker', 'containers', 'devops'],
      })
      createTestSkill(testSkillsDir, 'git-commit', {
        name: 'git-commit',
        description: 'Generate semantic commit messages',
        author: 'git-experts',
        tags: ['git', 'commits', 'automation'],
      })
      createTestSkill(testSkillsDir, 'jest-testing', {
        name: 'jest-testing',
        description: 'Jest test generation and helpers',
        author: 'testing-team',
        tags: ['jest', 'testing', 'react'],
      })

      indexer = new LocalIndexer(testSkillsDir)
      testSkills = await indexer.index(true)
    })

    it('should search by name', () => {
      const results = indexer.search('docker', testSkills)

      expect(results).toHaveLength(1)
      expect(results[0].name).toBe('docker')
    })

    it('should search by description', () => {
      const results = indexer.search('semantic commit', testSkills)

      expect(results).toHaveLength(1)
      expect(results[0].name).toBe('git-commit')
    })

    it('should search by tags', () => {
      const results = indexer.search('testing', testSkills)

      expect(results).toHaveLength(1)
      expect(results[0].name).toBe('jest-testing')
    })

    it('should search by author', () => {
      const results = indexer.search('devops-team', testSkills)

      expect(results).toHaveLength(1)
      expect(results[0].name).toBe('docker')
    })

    it('should be case-insensitive', () => {
      const results = indexer.search('DOCKER', testSkills)

      expect(results).toHaveLength(1)
      expect(results[0].name).toBe('docker')
    })

    it('should return empty for no matches', () => {
      const results = indexer.search('nonexistent', testSkills)

      expect(results).toEqual([])
    })

    it('should use cached skills if none provided', () => {
      const results = indexer.search('git')

      expect(results).toHaveLength(1)
      expect(results[0].name).toBe('git-commit')
    })
  })

  describe('clearCache', () => {
    it('should clear the internal cache', async () => {
      createTestSkill(testSkillsDir, 'cache-test', { name: 'cache-test' })

      const indexer = new LocalIndexer(testSkillsDir, 60000)
      await indexer.index()

      // Add another skill
      createTestSkill(testSkillsDir, 'new-skill', { name: 'new' })

      // Clear cache
      indexer.clearCache()

      // Should find new skill without force
      const skills = await indexer.index()
      expect(skills).toHaveLength(2)
    })
  })

  describe('getSkillsDir', () => {
    it('should return the configured skills directory', () => {
      const indexer = new LocalIndexer(testSkillsDir)
      expect(indexer.getSkillsDir()).toBe(testSkillsDir)
    })

    it('should default to ~/.claude/skills/', () => {
      const indexer = new LocalIndexer()
      expect(indexer.getSkillsDir()).toBe(path.join(os.homedir(), '.claude', 'skills'))
    })
  })
})

describe('Singleton functions', () => {
  afterEach(() => {
    resetLocalIndexer()
  })

  it('getLocalIndexer should return singleton instance', () => {
    const indexer1 = getLocalIndexer()
    const indexer2 = getLocalIndexer()

    expect(indexer1).toBe(indexer2)
  })

  it('resetLocalIndexer should clear singleton', () => {
    const indexer1 = getLocalIndexer()
    resetLocalIndexer()
    const indexer2 = getLocalIndexer()

    expect(indexer1).not.toBe(indexer2)
  })
})
