/**
 * SMI-628: GitHubIndexer and SkillParser Tests
 *
 * Tests for:
 * - SkillParser: YAML frontmatter parsing
 * - GitHubIndexer: Repository skill discovery
 *
 * IndexerRepository and integration tests: GitHubIndexer.repository.test.ts
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { SkillParser } from '../src/indexer/SkillParser.js'
import { GitHubIndexer } from '../src/indexer/GitHubIndexer.js'

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
      // SMI-3135: dependencies is now DependencyDeclaration (structured object).
      // Old string[] format in YAML is passed through from frontmatter at runtime.
      expect(result?.dependencies).toBeDefined()
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

      // Quality score: (min(500/10, 50) + min(100/5, 25) + 25) / 100 = (50 + 20 + 25) / 100 = 0.95
      expect(input.qualityScore).toBe(0.95)
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

    it('should assign official tier for official topics', () => {
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

      expect(indexer.repositoryToSkill(official).trustTier).toBe('official')
    })
  })
})
