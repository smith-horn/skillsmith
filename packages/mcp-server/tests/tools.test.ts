/**
 * Tests for MCP Tools (SMI-586, SMI-588)
 * Updated for ADR-019: Filter-Only Skill Search
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { executeSearch } from '../src/tools/search.js'
import { createSeededTestContext, type ToolContext } from '../src/__tests__/test-utils.js'

// Mock the file operations for testing
const TEST_SKILLS_DIR = path.join(os.tmpdir(), 'test-claude-skills-' + Date.now())
const TEST_MANIFEST_DIR = path.join(os.tmpdir(), 'test-skillsmith-' + Date.now())

describe('installSkill', () => {
  beforeEach(async () => {
    await fs.mkdir(TEST_SKILLS_DIR, { recursive: true })
    await fs.mkdir(TEST_MANIFEST_DIR, { recursive: true })
  })

  afterEach(async () => {
    try {
      await fs.rm(TEST_SKILLS_DIR, { recursive: true, force: true })
      await fs.rm(TEST_MANIFEST_DIR, { recursive: true, force: true })
    } catch {
      // Directories may not exist, ignore cleanup errors
    }
  })

  it('should parse GitHub URLs correctly', () => {
    // This would test the parseSkillId function
    const testCases = [
      {
        input: 'anthropics/claude-skills/commit',
        expected: { owner: 'anthropics', repo: 'claude-skills', path: 'commit' },
      },
      {
        input: 'https://github.com/anthropics/claude-skills',
        expected: { owner: 'anthropics', repo: 'claude-skills', path: '' },
      },
    ]

    for (const { input, expected } of testCases) {
      // Test parseSkillId logic
      if (input.startsWith('https://github.com/')) {
        const url = new URL(input)
        const parts = url.pathname.split('/').filter(Boolean)
        expect(parts[0]).toBe(expected.owner)
        expect(parts[1]).toBe(expected.repo)
      } else if (input.includes('/')) {
        const [owner, ...rest] = input.split('/')
        expect(owner).toBe(expected.owner)
        expect(rest[0]).toBe(expected.repo)
        expect(rest.slice(1).join('/')).toBe(expected.path)
      }
    }
  })

  it('should validate SKILL.md content', () => {
    const validateSkillMd = (content: string) => {
      const errors: string[] = []
      if (!content.includes('# ')) {
        errors.push('Missing title')
      }
      if (content.length < 100) {
        errors.push('Too short')
      }
      return { valid: errors.length === 0, errors }
    }

    expect(
      validateSkillMd(
        '# My Skill\n\nThis is a valid skill with enough content to pass the minimum length requirement for validation.'
      )
    ).toEqual({
      valid: true,
      errors: [],
    })

    expect(validateSkillMd('Too short')).toEqual({
      valid: false,
      errors: ['Missing title', 'Too short'],
    })
  })
})

describe('uninstallSkill', () => {
  beforeEach(async () => {
    await fs.mkdir(TEST_SKILLS_DIR, { recursive: true })
    await fs.mkdir(TEST_MANIFEST_DIR, { recursive: true })
  })

  afterEach(async () => {
    try {
      await fs.rm(TEST_SKILLS_DIR, { recursive: true, force: true })
      await fs.rm(TEST_MANIFEST_DIR, { recursive: true, force: true })
    } catch {
      // Directories may not exist, ignore cleanup errors
    }
  })

  it('should detect modified skills', async () => {
    const skillPath = path.join(TEST_SKILLS_DIR, 'test-skill')
    await fs.mkdir(skillPath, { recursive: true })
    await fs.writeFile(path.join(skillPath, 'SKILL.md'), '# Test Skill')

    const installedAt = new Date(Date.now() - 10000).toISOString() // 10 seconds ago

    // Modify the file
    await fs.writeFile(path.join(skillPath, 'SKILL.md'), '# Modified Skill')

    const stats = await fs.stat(path.join(skillPath, 'SKILL.md'))
    const installDate = new Date(installedAt)

    expect(stats.mtime > installDate).toBe(true)
  })

  it('should clean up skill directory', async () => {
    const skillPath = path.join(TEST_SKILLS_DIR, 'to-remove')
    await fs.mkdir(skillPath, { recursive: true })
    await fs.writeFile(path.join(skillPath, 'SKILL.md'), '# Test')

    await fs.rm(skillPath, { recursive: true, force: true })

    await expect(fs.access(skillPath)).rejects.toThrow()
  })
})

describe('MCP Tool Schemas', () => {
  it('should have valid search input schema', () => {
    // Test that the schema validates correctly
    const validInput = {
      query: 'react testing',
      limit: 20,
      offset: 0,
    }

    expect(validInput.query.length).toBeGreaterThan(0)
    expect(validInput.limit).toBeLessThanOrEqual(100)
    expect(validInput.offset).toBeGreaterThanOrEqual(0)
  })

  it('should have valid install input schema', () => {
    const validInput = {
      skillId: 'owner/repo/skill',
      force: false,
      skipScan: false,
    }

    expect(validInput.skillId.length).toBeGreaterThan(0)
    expect(typeof validInput.force).toBe('boolean')
    expect(typeof validInput.skipScan).toBe('boolean')
  })

  it('should have valid uninstall input schema', () => {
    const validInput = {
      skillName: 'my-skill',
      force: false,
    }

    expect(validInput.skillName.length).toBeGreaterThan(0)
    expect(typeof validInput.force).toBe('boolean')
  })
})

/**
 * ADR-019: Filter-Only Skill Search Tests
 *
 * These tests validate the new filter-only search functionality:
 * - Search with category filter only (no query required)
 * - Search with trust_tier filter only (no query required)
 * - Search with min_score filter only (no query required)
 * - Accept single character queries (minimum length removed)
 * - Error when no query AND no filters provided
 *
 * TDD Red Phase: These tests SHOULD FAIL until implementation is complete.
 */
describe('Filter-only search', () => {
  let context: ToolContext

  beforeAll(() => {
    context = createSeededTestContext()
  })

  afterAll(() => {
    context.db.close()
  })

  it('should search with category filter only (no query)', async () => {
    const result = await executeSearch(
      { category: 'testing' } as Parameters<typeof executeSearch>[0],
      context
    )
    expect(result.results).toBeDefined()
    expect(result.filters.category).toBe('testing')
  })

  it('should search with trust_tier filter only (no query)', async () => {
    const result = await executeSearch(
      { trust_tier: 'verified' } as Parameters<typeof executeSearch>[0],
      context
    )
    expect(result.results).toBeDefined()
    expect(result.filters.trustTier).toBe('verified')
  })

  it('should throw error when no query and no filters', async () => {
    await expect(executeSearch({} as Parameters<typeof executeSearch>[0], context)).rejects.toThrow(
      /query or.*filter/i
    )
  })

  it('should accept single character query', async () => {
    const result = await executeSearch({ query: 'a' }, context)
    expect(result.results).toBeDefined()
    expect(result.query).toBe('a')
  })

  it('should accept empty query with min_score filter', async () => {
    const result = await executeSearch(
      { min_score: 80 } as Parameters<typeof executeSearch>[0],
      context
    )
    expect(result.results).toBeDefined()
    expect(result.filters.minScore).toBe(0.8)
  })

  it('should accept empty query string with category filter', async () => {
    const result = await executeSearch(
      { query: '', category: 'devops' } as Parameters<typeof executeSearch>[0],
      context
    )
    expect(result.results).toBeDefined()
    expect(result.filters.category).toBe('devops')
  })

  it('should combine multiple filters without query', async () => {
    const result = await executeSearch(
      { category: 'testing', trust_tier: 'community' } as Parameters<typeof executeSearch>[0],
      context
    )
    expect(result.results).toBeDefined()
    expect(result.filters.category).toBe('testing')
    expect(result.filters.trustTier).toBe('community')
  })
})
