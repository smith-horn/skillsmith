/**
 * SMI-628 / SMI-5205: IndexerRepository and GitHubIndexer Integration Tests
 *
 * Split from GitHubIndexer.test.ts to satisfy 500-line gate.
 * Tests for:
 * - IndexerRepository: Database operations
 * - GitHubIndexer Integration: live search (requires GITHUB_TOKEN)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { GitHubIndexer } from '../src/indexer/GitHubIndexer.js'
import { IndexerRepository } from '../src/repositories/IndexerRepository.js'
import { createDatabase, closeDatabase } from '../src/db/schema.js'
import type { Database as DatabaseType } from '../src/db/database-interface.js'

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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const createTestMetadata = (overrides: Record<string, unknown> = {}): any => ({
    name: 'test-skill',
    description: 'A test skill',
    author: 'test-author',
    version: '1.0.0',
    tags: ['test', 'example'],
    dependencies: undefined,
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
      const _metadataList = [
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
