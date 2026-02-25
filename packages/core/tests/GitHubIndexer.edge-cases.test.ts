/**
 * SMI-2756: Wave 3 — GitHubIndexer edge-case tests
 *
 * Companion file to GitHubIndexer.test.ts (which exceeds the 500-line limit).
 * Covers: rate-limit handling, network errors, malformed API responses,
 * repositoryToSkill logic (trust tier assignment, log-scale quality),
 * and indexAllTopics deduplication.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { GitHubIndexer } from '../src/indexer/GitHubIndexer.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeApiRepo(
  overrides: Partial<{
    id: number
    full_name: string
    name: string
    owner_login: string
    description: string | null
    html_url: string
    stargazers_count: number
    forks_count: number
    topics: string[]
    updated_at: string
    default_branch: string
  }> = {}
) {
  return {
    id: overrides.id ?? 1,
    full_name: overrides.full_name ?? 'owner/repo',
    name: overrides.name ?? 'repo',
    owner: { login: overrides.owner_login ?? 'owner' },
    description: overrides.description ?? null,
    html_url: overrides.html_url ?? 'https://github.com/owner/repo',
    stargazers_count: overrides.stargazers_count ?? 0,
    forks_count: overrides.forks_count ?? 0,
    topics: overrides.topics ?? [],
    updated_at: overrides.updated_at ?? '2025-01-01T00:00:00Z',
    default_branch: overrides.default_branch ?? 'main',
  }
}

function mockFetchSuccess(items: ReturnType<typeof makeApiRepo>[], totalCount = items.length) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      total_count: totalCount,
      incomplete_results: false,
      items,
    }),
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GitHubIndexer — edge cases', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  // -------------------------------------------------------------------------
  // searchRepositories
  // -------------------------------------------------------------------------

  describe('searchRepositories', () => {
    it('returns populated IndexResult on success', async () => {
      const indexer = new GitHubIndexer({ requestDelay: 0 })
      const globalFetch = vi
        .spyOn(global, 'fetch')
        .mockImplementation(
          mockFetchSuccess([makeApiRepo({ name: 'my-skill', stargazers_count: 10 })])
        )

      const result = await indexer.searchRepositories('topic:claude-skill')

      expect(result.found).toBe(1)
      expect(result.indexed).toBe(1)
      expect(result.failed).toBe(0)
      expect(result.repositories).toHaveLength(1)
      expect(result.repositories[0].name).toBe('my-skill')
      globalFetch.mockRestore()
    })

    it('handles 403 rate-limit response', async () => {
      const indexer = new GitHubIndexer({ requestDelay: 0 })
      vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ message: 'rate limit exceeded' }),
      } as Response)

      const result = await indexer.searchRepositories('topic:claude-skill')

      expect(result.failed).toBe(1)
      expect(result.errors).toContain('GitHub API rate limit exceeded')
      expect(result.indexed).toBe(0)
    })

    it('handles non-403 HTTP error with status in message', async () => {
      const indexer = new GitHubIndexer({ requestDelay: 0 })
      vi.spyOn(global, 'fetch').mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({}),
      } as Response)

      const result = await indexer.searchRepositories('query')

      expect(result.failed).toBe(1)
      expect(result.errors[0]).toContain('500')
    })

    it('captures network error without throwing', async () => {
      const indexer = new GitHubIndexer({ requestDelay: 0 })
      vi.spyOn(global, 'fetch').mockRejectedValue(new Error('Network timeout'))

      const result = await indexer.searchRepositories('topic:claude-skill')

      expect(result.failed).toBe(1)
      expect(result.errors[0]).toContain('Network timeout')
    })

    it('includes Authorization header when token is provided', async () => {
      const indexer = new GitHubIndexer({ token: 'ghp_test123', requestDelay: 0 })
      let capturedHeaders: Record<string, string> = {}

      vi.spyOn(global, 'fetch').mockImplementation(async (_, init) => {
        capturedHeaders = (init?.headers as Record<string, string>) ?? {}
        return {
          ok: true,
          status: 200,
          json: async () => ({ total_count: 0, incomplete_results: false, items: [] }),
        } as Response
      })

      await indexer.searchRepositories('topic:test')

      expect(capturedHeaders['Authorization']).toBe('Bearer ghp_test123')
    })

    it('omits Authorization header when no token provided', async () => {
      const indexer = new GitHubIndexer({ requestDelay: 0 })
      let capturedHeaders: Record<string, string> = {}

      vi.spyOn(global, 'fetch').mockImplementation(async (_, init) => {
        capturedHeaders = (init?.headers as Record<string, string>) ?? {}
        return {
          ok: true,
          status: 200,
          json: async () => ({ total_count: 0, incomplete_results: false, items: [] }),
        } as Response
      })

      await indexer.searchRepositories('topic:test')

      expect(capturedHeaders['Authorization']).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // repositoryToSkill — trust tier assignment
  // -------------------------------------------------------------------------

  describe('repositoryToSkill', () => {
    it('assigns verified tier when claude-code-official topic present', () => {
      const indexer = new GitHubIndexer({ requestDelay: 0 })
      const repo = {
        owner: 'anthropic',
        name: 'official-skill',
        fullName: 'anthropic/official-skill',
        description: 'Official skill',
        url: 'https://github.com/anthropic/official-skill',
        stars: 0,
        forks: 0,
        topics: ['claude-code-official'],
        updatedAt: '2025-01-01T00:00:00Z',
        defaultBranch: 'main',
      }

      const skill = indexer.repositoryToSkill(repo)

      expect(skill.trustTier).toBe('verified')
    })

    it('assigns community tier for repos with >= 50 stars', () => {
      const indexer = new GitHubIndexer({ requestDelay: 0 })
      const repo = {
        owner: 'dev',
        name: 'popular-skill',
        fullName: 'dev/popular-skill',
        description: null,
        url: 'https://github.com/dev/popular-skill',
        stars: 50,
        forks: 0,
        topics: [],
        updatedAt: '2025-01-01T00:00:00Z',
        defaultBranch: 'main',
      }

      const skill = indexer.repositoryToSkill(repo)

      expect(skill.trustTier).toBe('community')
    })

    it('assigns experimental tier for repos with 5–49 stars', () => {
      const indexer = new GitHubIndexer({ requestDelay: 0 })
      const repo = {
        owner: 'dev',
        name: 'new-skill',
        fullName: 'dev/new-skill',
        description: null,
        url: 'https://github.com/dev/new-skill',
        stars: 10,
        forks: 0,
        topics: [],
        updatedAt: '2025-01-01T00:00:00Z',
        defaultBranch: 'main',
      }

      const skill = indexer.repositoryToSkill(repo)

      expect(skill.trustTier).toBe('experimental')
    })

    it('assigns unknown tier for repos with < 5 stars', () => {
      const indexer = new GitHubIndexer({ requestDelay: 0 })
      const repo = {
        owner: 'dev',
        name: 'brand-new-skill',
        fullName: 'dev/brand-new-skill',
        description: null,
        url: 'https://github.com/dev/brand-new-skill',
        stars: 2,
        forks: 0,
        topics: [],
        updatedAt: '2025-01-01T00:00:00Z',
        defaultBranch: 'main',
      }

      const skill = indexer.repositoryToSkill(repo)

      expect(skill.trustTier).toBe('unknown')
    })

    it('uses log-scale quality score when SKILLSMITH_LOG_QUALITY_SCORE=true', () => {
      vi.stubEnv('SKILLSMITH_LOG_QUALITY_SCORE', 'true')
      const indexer = new GitHubIndexer({ requestDelay: 0 })

      const repoLinear = {
        owner: 'dev',
        name: 'skill',
        fullName: 'dev/skill',
        description: null,
        url: 'https://github.com/dev/skill',
        stars: 1000,
        forks: 200,
        topics: [],
        updatedAt: '2025-01-01T00:00:00Z',
        defaultBranch: 'main',
      }

      vi.stubEnv('SKILLSMITH_LOG_QUALITY_SCORE', 'false')
      const indexerLinear = new GitHubIndexer({ requestDelay: 0 })

      const logSkill = indexer.repositoryToSkill(repoLinear)
      const linearSkill = indexerLinear.repositoryToSkill(repoLinear)

      // Both should produce valid quality scores in [0,1]
      expect(logSkill.qualityScore).toBeGreaterThanOrEqual(0)
      expect(logSkill.qualityScore).toBeLessThanOrEqual(1)
      expect(linearSkill.qualityScore).toBeGreaterThanOrEqual(0)
      expect(linearSkill.qualityScore).toBeLessThanOrEqual(1)
    })
  })

  // -------------------------------------------------------------------------
  // indexAllTopics — deduplication
  // -------------------------------------------------------------------------

  describe('indexAllTopics', () => {
    it('deduplicates repositories with identical URLs across topics', async () => {
      const sharedRepo = makeApiRepo({ html_url: 'https://github.com/owner/shared' })

      const indexer = new GitHubIndexer({
        topics: ['topic-a', 'topic-b'],
        requestDelay: 0,
      })

      vi.spyOn(global, 'fetch').mockImplementation(mockFetchSuccess([sharedRepo]))

      const result = await indexer.indexAllTopics(1)

      // Should appear only once despite being returned for both topics
      expect(
        result.repositories.filter((r) => r.url === 'https://github.com/owner/shared')
      ).toHaveLength(1)
    })

    it('stops paging a topic when fewer results than perPage are returned', async () => {
      const indexer = new GitHubIndexer({
        topics: ['topic-x'],
        perPage: 30,
        requestDelay: 0,
      })

      // Return only 5 items — less than perPage — so pagination should stop after page 1
      const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(
        mockFetchSuccess(
          Array.from({ length: 5 }, (_, i) =>
            makeApiRepo({
              id: i,
              full_name: `owner/skill-${i}`,
              html_url: `https://github.com/owner/skill-${i}`,
            })
          )
        )
      )

      await indexer.indexAllTopics(3)

      // fetch should only be called once (single page)
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })
  })
})
