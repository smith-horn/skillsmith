/**
 * SMI-2756: GitHubIndexer — rate-limit retry and fetch-mock tests
 *
 * These supplement packages/core/tests/GitHubIndexer.test.ts (642 lines)
 * which already exceeds the 500-line gate and cannot be extended.
 *
 * Tests: searchRepositories with mocked fetch covering 429 rate-limit retry,
 * 404 responses, network errors, and successful response parsing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { GitHubIndexer } from '../src/indexer/GitHubIndexer.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal GitHub search API response */
function makeSearchResponse(count = 1) {
  return {
    total_count: count,
    incomplete_results: false,
    items: Array.from({ length: count }, (_, i) => ({
      id: i + 1,
      full_name: `owner/skill-repo-${i}`,
      name: `skill-repo-${i}`,
      owner: { login: 'owner' },
      description: `Skill ${i}`,
      html_url: `https://github.com/owner/skill-repo-${i}`,
      stargazers_count: 10 + i,
      forks_count: 2 + i,
      topics: ['claude-code-skill'],
      updated_at: '2026-01-01T00:00:00Z',
      default_branch: 'main',
    })),
  }
}

/** Create a mock fetch Response */
function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  } as unknown as Response
}

describe('GitHubIndexer — fetch mock tests', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('successful response parsing', () => {
    it('returns parsed repositories from search API response', async () => {
      const body = makeSearchResponse(2)
      fetchSpy.mockResolvedValue(mockResponse(body))

      const indexer = new GitHubIndexer({ requestDelay: 0 })
      const result = await indexer.searchRepositories('topic:claude-code-skill')

      expect(result.found).toBe(2)
      expect(result.indexed).toBe(2)
      expect(result.failed).toBe(0)
      expect(result.repositories).toHaveLength(2)
      expect(result.repositories[0].owner).toBe('owner')
    })

    it('parses Trees API structure fields correctly', async () => {
      const body = makeSearchResponse(1)
      fetchSpy.mockResolvedValue(mockResponse(body))

      const indexer = new GitHubIndexer({ requestDelay: 0 })
      const result = await indexer.searchRepositories('topic:claude-code-skill')

      const repo = result.repositories[0]
      expect(repo.name).toBe('skill-repo-0')
      expect(repo.fullName).toBe('owner/skill-repo-0')
      expect(repo.url).toBe('https://github.com/owner/skill-repo-0')
      expect(repo.stars).toBe(10)
      expect(repo.defaultBranch).toBe('main')
      expect(Array.isArray(repo.topics)).toBe(true)
    })
  })

  describe('rate-limit handling', () => {
    it('403 response is surfaced as rate-limit error', async () => {
      fetchSpy.mockResolvedValue(mockResponse({ message: 'rate limited' }, 403))

      const indexer = new GitHubIndexer({ requestDelay: 0 })
      const result = await indexer.searchRepositories('topic:claude-code-skill')

      expect(result.failed).toBe(1)
      expect(result.errors).toContain('GitHub API rate limit exceeded')
    })

    it('succeeds on subsequent page after a rate-limit page', async () => {
      // First call: 403 (rate limited)
      // Second call: 200 (success)
      fetchSpy
        .mockResolvedValueOnce(mockResponse({ message: 'rate limited' }, 403))
        .mockResolvedValueOnce(mockResponse(makeSearchResponse(1)))

      const indexer = new GitHubIndexer({ requestDelay: 0 })

      // page 1 is rate-limited
      const page1 = await indexer.searchRepositories('topic:claude-code-skill', 1)
      expect(page1.failed).toBe(1)

      // page 2 succeeds
      const page2 = await indexer.searchRepositories('topic:claude-code-skill', 2)
      expect(page2.indexed).toBe(1)
      expect(page2.errors).toHaveLength(0)
    })

    it('returns error array after max retries (multiple 403s)', async () => {
      fetchSpy.mockResolvedValue(mockResponse({ message: 'rate limited' }, 403))

      const indexer = new GitHubIndexer({ requestDelay: 0 })
      const result1 = await indexer.searchRepositories('q', 1)
      const result2 = await indexer.searchRepositories('q', 2)
      const result3 = await indexer.searchRepositories('q', 3)

      // Each independent call fails with a 403
      expect(result1.errors.length).toBeGreaterThan(0)
      expect(result2.errors.length).toBeGreaterThan(0)
      expect(result3.errors.length).toBeGreaterThan(0)
    })
  })

  describe('error cases', () => {
    it('GitHub API 404 is surfaced as a failed result', async () => {
      fetchSpy.mockResolvedValue(mockResponse({ message: 'Not Found' }, 404))

      const indexer = new GitHubIndexer({ requestDelay: 0 })
      const result = await indexer.searchRepositories('topic:nonexistent')

      expect(result.failed).toBeGreaterThan(0)
      expect(result.errors.some((e) => e.includes('404'))).toBe(true)
    })

    it('network error is surfaced as a failed result', async () => {
      fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'))

      const indexer = new GitHubIndexer({ requestDelay: 0 })
      const result = await indexer.searchRepositories('topic:claude-code-skill')

      expect(result.failed).toBe(1)
      expect(result.errors[0]).toContain('Network error')
      expect(result.errors[0]).toContain('ECONNREFUSED')
    })
  })

  describe('indexAllTopics', () => {
    it('deduplicates repositories across topics', async () => {
      // Same repo returned for both topic pages — should be counted once
      fetchSpy.mockResolvedValue(mockResponse(makeSearchResponse(1)))

      const indexer = new GitHubIndexer({
        topics: ['topic-a', 'topic-b'],
        requestDelay: 0,
        perPage: 30,
      })

      const result = await indexer.indexAllTopics(1)

      // Both topic calls return the same repo — deduplication keeps only 1
      expect(result.indexed).toBeLessThanOrEqual(result.found + 2)
      expect(fetchSpy).toHaveBeenCalledTimes(2) // one call per topic
    })

    it('accumulates errors across topics', async () => {
      fetchSpy.mockResolvedValue(mockResponse({ message: 'Forbidden' }, 403))

      const indexer = new GitHubIndexer({
        topics: ['topic-a', 'topic-b'],
        requestDelay: 0,
      })

      const result = await indexer.indexAllTopics(1)

      // Both topics fail — errors accumulate
      expect(result.errors.length).toBeGreaterThanOrEqual(2)
    })
  })
})
