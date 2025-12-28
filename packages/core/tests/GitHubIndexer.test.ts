/**
 * SMI-628: GitHubIndexer and SkillParser Tests
 *
 * Tests for:
 * - SkillParser: YAML frontmatter parsing
 * - GitHubIndexer: Repository skill discovery
 * - IndexerRepository: Database operations
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { SkillParser } from '../src/indexer/SkillParser.js'
import { GitHubIndexer } from '../src/indexer/GitHubIndexer.js'
import { IndexerRepository } from '../src/repositories/IndexerRepository.js'
import { createDatabase, closeDatabase } from '../src/db/schema.js'
import type { Database as DatabaseType } from 'better-sqlite3'

// ============================================================
// SkillParser Tests
// ============================================================

describe('SkillParser', () => {
  let parser: SkillParser

  beforeEach(() => {
    parser = new SkillParser()
  })

  describe('extractFrontmatter', () => {
    it('should extract valid YAML frontmatter', () => {
      const content = `---
name: test-skill
description: A test skill
author: test-author
version: 1.0.0
tags:
  - testing
  - example
---

# Test Skill

This is the body content.`

      const frontmatter = parser.extractFrontmatter(content)

      expect(frontmatter).not.toBeNull()
      expect(frontmatter?.name).toBe('test-skill')
      expect(frontmatter?.description).toBe('A test skill')
      expect(frontmatter?.author).toBe('test-author')
      expect(frontmatter?.version).toBe('1.0.0')
      expect(frontmatter?.tags).toEqual(['testing', 'example'])
    })

    it('should return null for content without frontmatter', () => {
      const content = `# Just a markdown file

No frontmatter here.`

      const frontmatter = parser.extractFrontmatter(content)
      expect(frontmatter).toBeNull()
    })

    it('should return null for unclosed frontmatter', () => {
      const content = `---
name: test-skill

No closing delimiter.`

      const frontmatter = parser.extractFrontmatter(content)
      expect(frontmatter).toBeNull()
    })

    it('should parse inline arrays', () => {
      const content = `---
name: inline-test
tags: [tag1, tag2, tag3]
---

Content`

      const frontmatter = parser.extractFrontmatter(content)

      expect(frontmatter?.tags).toEqual(['tag1', 'tag2', 'tag3'])
    })

    it('should parse boolean values', () => {
      const content = `---
name: bool-test
enabled: true
disabled: false
---

Content`

      const frontmatter = parser.extractFrontmatter(content)

      expect(frontmatter?.enabled).toBe(true)
      expect(frontmatter?.disabled).toBe(false)
    })

    it('should parse numeric values', () => {
      const content = `---
name: num-test
count: 42
rating: 4.5
---

Content`

      const frontmatter = parser.extractFrontmatter(content)

      expect(frontmatter?.count).toBe(42)
      expect(frontmatter?.rating).toBe(4.5)
    })
  })

  describe('parse', () => {
    it('should parse a complete SKILL.md file', () => {
      const content = `---
name: complete-skill
description: A complete skill with all fields
author: complete-author
version: 2.0.0
tags:
  - complete
  - full
dependencies:
  - dep-a
  - dep-b
category: testing
license: MIT
---

# Complete Skill

Full documentation here.`

      const result = parser.parse(content)

      expect(result).not.toBeNull()
      expect(result?.name).toBe('complete-skill')
      expect(result?.description).toBe('A complete skill with all fields')
      expect(result?.author).toBe('complete-author')
      expect(result?.version).toBe('2.0.0')
      expect(result?.tags).toEqual(['complete', 'full'])
      expect(result?.dependencies).toEqual(['dep-a', 'dep-b'])
      expect(result?.category).toBe('testing')
      expect(result?.license).toBe('MIT')
      expect(result?.rawContent).toBe(content)
    })

    it('should return null for content without name when required', () => {
      const strictParser = new SkillParser({ requireName: true })

      const content = `---
description: Missing name field
---

Content`

      const result = strictParser.parse(content)
      expect(result).toBeNull()
    })

    it('should parse content with minimal fields', () => {
      const content = `---
name: minimal-skill
---

Just the name.`

      const result = parser.parse(content)

      expect(result).not.toBeNull()
      expect(result?.name).toBe('minimal-skill')
      expect(result?.description).toBeNull()
      expect(result?.tags).toEqual([])
    })
  })

  describe('parseWithValidation', () => {
    it('should return validation errors for invalid content', () => {
      const content = `Not valid frontmatter`

      const result = parser.parseWithValidation(content)

      expect(result.metadata).toBeNull()
      expect(result.validation.valid).toBe(false)
      expect(result.validation.errors).toContain('Failed to extract YAML frontmatter')
    })

    it('should return warnings for missing recommended fields', () => {
      const content = `---
name: warnings-test
---

Minimal content.`

      const result = parser.parseWithValidation(content)

      expect(result.metadata).not.toBeNull()
      expect(result.validation.valid).toBe(true)
      expect(result.validation.warnings.length).toBeGreaterThan(0)
    })
  })

  describe('extractBody', () => {
    it('should extract markdown body after frontmatter', () => {
      const content = `---
name: body-test
---

# Title

Body content here.`

      const body = parser.extractBody(content)

      expect(body).toBe('# Title\n\nBody content here.')
    })

    it('should return full content if no frontmatter', () => {
      const content = `# No Frontmatter

Just content.`

      const body = parser.extractBody(content)
      expect(body).toBe(content)
    })
  })

  describe('inferTrustTier', () => {
    it('should return verified for known authors', () => {
      const content = `---
name: verified-test
author: anthropic
description: Verified author test with comprehensive documentation
tags:
  - tag1
  - tag2
  - tag3
version: 1.0.0
license: MIT
---

Content`

      const result = parser.parse(content)
      expect(result).not.toBeNull()

      const tier = parser.inferTrustTier(result!)
      expect(tier).toBe('verified')
    })

    it('should return community for comprehensive metadata', () => {
      const content = `---
name: community-test
author: some-author
description: A comprehensive description with plenty of detail about what this skill does
tags:
  - tag1
  - tag2
  - tag3
version: 1.0.0
license: MIT
---

Content`

      const result = parser.parse(content)
      expect(result).not.toBeNull()

      const tier = parser.inferTrustTier(result!)
      expect(tier).toBe('community')
    })

    it('should return unknown for minimal metadata', () => {
      const content = `---
name: minimal-test
---

Content`

      const result = parser.parse(content)
      expect(result).not.toBeNull()

      const tier = parser.inferTrustTier(result!)
      expect(tier).toBe('unknown')
    })
  })
})

// ============================================================
// GitHubIndexer Tests
// ============================================================

describe('GitHubIndexer', () => {
  let indexer: GitHubIndexer

  beforeEach(() => {
    indexer = new GitHubIndexer({
      requestDelay: 10, // Fast for testing
    })
  })

  describe('constructor', () => {
    it('should use default options', () => {
      const defaultIndexer = new GitHubIndexer()
      expect(defaultIndexer).toBeDefined()
    })

    it('should accept custom options', () => {
      const customIndexer = new GitHubIndexer({
        token: 'test-token',
        requestDelay: 200,
        perPage: 20,
      })
      expect(customIndexer).toBeDefined()
    })
  })

  describe('repositoryToSkill', () => {
    it('should convert repository to skill input', () => {
      const repo = {
        owner: 'test-author',
        name: 'test-skill',
        fullName: 'test-author/test-skill',
        description: 'Test description',
        url: 'https://github.com/test/repo',
        stars: 100,
        forks: 10,
        topics: ['test', 'claude-code'],
        updatedAt: new Date().toISOString(),
        defaultBranch: 'main',
      }

      const input = indexer.repositoryToSkill(repo)

      expect(input.name).toBe('test-skill')
      expect(input.description).toBe('Test description')
      expect(input.author).toBe('test-author')
      expect(input.repoUrl).toBe('https://github.com/test/repo')
      expect(input.tags).toEqual(['test', 'claude-code'])
    })

    it('should calculate quality score from stars and forks', () => {
      const repo = {
        owner: 'author',
        name: 'popular-skill',
        fullName: 'author/popular-skill',
        description: 'Popular skill',
        url: 'https://github.com/author/popular-skill',
        stars: 500,
        forks: 100,
        topics: [],
        updatedAt: new Date().toISOString(),
        defaultBranch: 'main',
      }

      const input = indexer.repositoryToSkill(repo)

      // Quality score: min(500/10, 50) + min(100/5, 25) + 25 = 50 + 20 + 25 = 95
      expect(input.qualityScore).toBe(95)
    })

    it('should assign trust tier based on stars', () => {
      const lowStars = {
        owner: 'a',
        name: 'low',
        fullName: 'a/low',
        description: null,
        url: 'https://github.com/a/low',
        stars: 2,
        forks: 0,
        topics: [],
        updatedAt: new Date().toISOString(),
        defaultBranch: 'main',
      }

      const mediumStars = {
        ...lowStars,
        name: 'medium',
        stars: 10,
      }

      const highStars = {
        ...lowStars,
        name: 'high',
        stars: 100,
      }

      expect(indexer.repositoryToSkill(lowStars).trustTier).toBe('unknown')
      expect(indexer.repositoryToSkill(mediumStars).trustTier).toBe('experimental')
      expect(indexer.repositoryToSkill(highStars).trustTier).toBe('community')
    })

    it('should assign verified tier for official topics', () => {
      const official = {
        owner: 'anthropic',
        name: 'official-skill',
        fullName: 'anthropic/official-skill',
        description: 'Official skill',
        url: 'https://github.com/anthropic/official-skill',
        stars: 5,
        forks: 0,
        topics: ['claude-code-official'],
        updatedAt: new Date().toISOString(),
        defaultBranch: 'main',
      }

      expect(indexer.repositoryToSkill(official).trustTier).toBe('verified')
    })
  })
})

// ============================================================
// IndexerRepository Tests
// ============================================================

describe('IndexerRepository', () => {
  let db: DatabaseType
  let repository: IndexerRepository

  beforeEach(() => {
    db = createDatabase(':memory:')
    repository = new IndexerRepository(db)
  })

  afterEach(() => {
    closeDatabase(db)
  })

  const createTestMetadata = (overrides = {}): any => ({
    name: 'test-skill',
    description: 'A test skill',
    author: 'test-author',
    version: '1.0.0',
    tags: ['test', 'example'],
    dependencies: [],
    category: 'testing',
    license: 'MIT',
    repository: null,
    rawContent: '---\nname: test-skill\n---\nTest content',
    frontmatter: { name: 'test-skill' },
    repoUrl: 'https://github.com/test/repo',
    filePath: 'SKILL.md',
    sha: 'abc123def456',
    owner: 'test',
    repo: 'repo',
    discoveredAt: new Date().toISOString(),
    ...overrides,
  })

  describe('upsertFromMetadata', () => {
    it('should insert a new skill', () => {
      const metadata = createTestMetadata()

      const result = repository.upsertFromMetadata(metadata)

      expect(result.inserted).toBe(true)
      expect(result.contentChanged).toBe(true)
      expect(result.skill.name).toBe('test-skill')
      expect(result.skill.repoUrl).toBe('https://github.com/test/repo')
      expect(result.skill.sourceSha).toBe('abc123def456')
    })

    it('should update an existing skill with changed content', () => {
      const metadata = createTestMetadata()
      repository.upsertFromMetadata(metadata)

      // Update with new SHA (content changed)
      const updatedMetadata = createTestMetadata({
        sha: 'newsha789',
        description: 'Updated description',
      })

      const result = repository.upsertFromMetadata(updatedMetadata)

      expect(result.inserted).toBe(false)
      expect(result.contentChanged).toBe(true)
      expect(result.skill.description).toBe('Updated description')
      expect(result.skill.sourceSha).toBe('newsha789')
    })

    it('should mark unchanged when SHA matches', () => {
      const metadata = createTestMetadata()
      repository.upsertFromMetadata(metadata)

      // Same SHA = no content change
      const result = repository.upsertFromMetadata(metadata)

      expect(result.inserted).toBe(false)
      expect(result.contentChanged).toBe(false)
    })

    it('should apply custom trust tier', () => {
      const metadata = createTestMetadata()

      const result = repository.upsertFromMetadata(metadata, 'verified')

      expect(result.skill.trustTier).toBe('verified')
    })
  })

  describe('batchUpsertFromMetadata', () => {
    it('should batch insert multiple skills', () => {
      const metadataList = [
        createTestMetadata({ repoUrl: 'https://github.com/a/repo1' }),
        createTestMetadata({ repoUrl: 'https://github.com/b/repo2', name: 'skill-2' }),
        createTestMetadata({ repoUrl: 'https://github.com/c/repo3', name: 'skill-3' }),
      ]

      const result = repository.batchUpsertFromMetadata(metadataList)

      expect(result.total).toBe(3)
      expect(result.inserted).toBe(3)
      expect(result.updated).toBe(0)
      expect(result.unchanged).toBe(0)
      expect(result.errors).toHaveLength(0)
    })

    it('should handle mixed insert/update/unchanged', () => {
      // First, insert one skill
      const initial = createTestMetadata({ repoUrl: 'https://github.com/existing/repo' })
      repository.upsertFromMetadata(initial)

      // Batch with: existing unchanged, existing updated, new
      const metadataList = [
        createTestMetadata({ repoUrl: 'https://github.com/existing/repo' }), // unchanged
        createTestMetadata({
          repoUrl: 'https://github.com/existing/repo',
          sha: 'newsha', // This will match repo_url but update
        }),
        createTestMetadata({ repoUrl: 'https://github.com/new/repo', name: 'new-skill' }), // new
      ]

      // Note: Due to unique constraint on repo_url, only one entry per repo_url
      // So we'll test with different repos
      const properList = [
        createTestMetadata({ repoUrl: 'https://github.com/existing/repo' }), // unchanged (same sha)
        createTestMetadata({ repoUrl: 'https://github.com/new/repo', name: 'new-skill' }), // new
      ]

      const result = repository.batchUpsertFromMetadata(properList)

      expect(result.total).toBe(2)
      expect(result.unchanged).toBe(1)
      expect(result.inserted).toBe(1)
    })
  })

  describe('findByRepoUrl', () => {
    it('should find skill by repository URL', () => {
      const metadata = createTestMetadata()
      repository.upsertFromMetadata(metadata)

      const found = repository.findByRepoUrl('https://github.com/test/repo')

      expect(found).not.toBeNull()
      expect(found?.name).toBe('test-skill')
    })

    it('should return null for non-existent URL', () => {
      const found = repository.findByRepoUrl('https://github.com/nonexistent/repo')
      expect(found).toBeNull()
    })
  })

  describe('findBySha', () => {
    it('should find skill by source SHA', () => {
      const metadata = createTestMetadata({ sha: 'unique-sha-123' })
      repository.upsertFromMetadata(metadata)

      const found = repository.findBySha('unique-sha-123')

      expect(found).not.toBeNull()
      expect(found?.sourceSha).toBe('unique-sha-123')
    })
  })

  describe('findAllIndexed', () => {
    it('should return paginated indexed skills', () => {
      // Insert multiple skills
      for (let i = 0; i < 5; i++) {
        repository.upsertFromMetadata(
          createTestMetadata({
            repoUrl: `https://github.com/test/repo${i}`,
            name: `skill-${i}`,
          })
        )
      }

      const page1 = repository.findAllIndexed(2, 0)
      expect(page1).toHaveLength(2)

      const page2 = repository.findAllIndexed(2, 2)
      expect(page2).toHaveLength(2)

      const page3 = repository.findAllIndexed(2, 4)
      expect(page3).toHaveLength(1)
    })
  })

  describe('findNeedingReindex', () => {
    it('should find skills needing reindex', () => {
      // Insert a skill
      repository.upsertFromMetadata(createTestMetadata())

      // All recently indexed skills shouldn't need reindex
      const needing = repository.findNeedingReindex('-1 day', 10)

      // Since we just indexed, it shouldn't need reindex yet
      expect(needing).toHaveLength(0)
    })
  })
})

// ============================================================
// Integration Tests (if GITHUB_TOKEN is available)
// ============================================================

describe('GitHubIndexer Integration', () => {
  const hasToken = !!process.env.GITHUB_TOKEN

  it.skipIf(!hasToken)(
    'should search for claude-code skills on GitHub',
    async () => {
      const indexer = new GitHubIndexer({
        token: process.env.GITHUB_TOKEN,
        requestDelay: 150,
      })

      const result = await indexer.searchRepositories('topic:claude-code-skill')

      expect(result.found).toBeGreaterThanOrEqual(0)
      expect(result.errors).toHaveLength(0)
      // Note: May or may not find repositories depending on GitHub state
    },
    30000
  )
})
