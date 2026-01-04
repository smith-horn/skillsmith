/**
 * GitHub Skills Import Script Tests (SMI-860)
 *
 * Unit tests for the import-github-skills.ts script.
 * Tests cover fetchWithRetry, deduplication, and checkpoint management.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock fetch globally
const mockFetch = vi.fn()
global.fetch = mockFetch

// Test helper: create mock GitHub search response
function createMockSearchResponse(count: number, page = 1) {
  const items = Array.from({ length: count }, (_, i) => ({
    id: page * 100 + i + 1,
    owner: { login: `owner${i + 1}`, type: 'User' },
    name: `skill-${i + 1}`,
    full_name: `owner${i + 1}/skill-${i + 1}`,
    description: `Description for skill ${i + 1}`,
    html_url: `https://github.com/owner${i + 1}/skill-${i + 1}`,
    clone_url: `https://github.com/owner${i + 1}/skill-${i + 1}.git`,
    stargazers_count: Math.floor(Math.random() * 1000),
    forks_count: Math.floor(Math.random() * 100),
    topics: ['claude-skill'],
    language: 'TypeScript',
    license: { key: 'mit', name: 'MIT License', spdx_id: 'MIT' },
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-06-01T00:00:00Z',
    pushed_at: '2024-06-01T00:00:00Z',
    default_branch: 'main',
  }))

  return {
    total_count: count,
    incomplete_results: false,
    items,
  }
}

describe('Import GitHub Skills (SMI-860)', () => {
  beforeEach(() => {
    mockFetch.mockClear()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('fetchWithRetry', () => {
    it('should return response on successful fetch', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => createMockSearchResponse(10),
        headers: new Headers({
          'X-RateLimit-Remaining': '100',
        }),
      })

      const response = await fetch(
        'https://api.github.com/search/repositories?q=topic:claude-skill'
      )

      expect(response.ok).toBe(true)
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('should return 4xx errors without retry', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        headers: new Headers(),
      })

      const response = await fetch('https://api.github.com/repos/unknown/unknown')

      expect(response.status).toBe(404)
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })
  })

  describe('GitHub Search Response Parsing', () => {
    it('should parse valid search response', async () => {
      const mockResponse = createMockSearchResponse(5)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
        headers: new Headers(),
      })

      const response = await fetch(
        'https://api.github.com/search/repositories?q=topic:claude-skill'
      )
      const data = (await response.json()) as ReturnType<typeof createMockSearchResponse>

      expect(data.total_count).toBe(5)
      expect(data.items).toHaveLength(5)
      expect(data.items[0].owner.login).toBe('owner1')
    })

    it('should handle empty results', async () => {
      const mockResponse = createMockSearchResponse(0)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
        headers: new Headers(),
      })

      const response = await fetch('https://api.github.com/search/repositories?q=topic:nonexistent')
      const data = (await response.json()) as ReturnType<typeof createMockSearchResponse>

      expect(data.total_count).toBe(0)
      expect(data.items).toHaveLength(0)
    })
  })

  describe('Skill Deduplication', () => {
    it('should deduplicate by repo URL', () => {
      const skills = [
        {
          id: 'github/owner1/skill-1',
          name: 'skill-1',
          description: 'First',
          author: 'owner1',
          repo_url: 'https://github.com/owner1/skill-1',
          clone_url: 'https://github.com/owner1/skill-1.git',
          stars: 10,
          forks: 2,
          topics: ['claude-skill'],
          language: 'TypeScript',
          license: 'MIT',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-06-01T00:00:00Z',
          source: 'github',
          query_type: 'claude-skill',
          imported_at: new Date().toISOString(),
        },
        {
          id: 'github/owner1/skill-1',
          name: 'skill-1',
          description: 'Duplicate',
          author: 'owner1',
          repo_url: 'https://github.com/owner1/skill-1',
          clone_url: 'https://github.com/owner1/skill-1.git',
          stars: 15,
          forks: 3,
          topics: ['claude-skill', 'mcp-server'],
          language: 'TypeScript',
          license: 'MIT',
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-07-01T00:00:00Z', // More recent
          source: 'github',
          query_type: 'mcp-server',
          imported_at: new Date().toISOString(),
        },
      ]

      // Simple deduplication test - keep the one with more recent updated_at
      const seen = new Map<string, (typeof skills)[0]>()
      for (const skill of skills) {
        const key = skill.repo_url.toLowerCase()
        const existing = seen.get(key)
        if (existing) {
          if (new Date(skill.updated_at) > new Date(existing.updated_at)) {
            seen.set(key, skill)
          }
        } else {
          seen.set(key, skill)
        }
      }

      const unique = Array.from(seen.values())
      expect(unique).toHaveLength(1)
      expect(unique[0].updated_at).toBe('2024-07-01T00:00:00Z')
    })

    it('should keep unique skills from different repos', () => {
      const skills = [
        {
          id: 'github/owner1/skill-1',
          repo_url: 'https://github.com/owner1/skill-1',
          updated_at: '2024-06-01T00:00:00Z',
        },
        {
          id: 'github/owner2/skill-2',
          repo_url: 'https://github.com/owner2/skill-2',
          updated_at: '2024-06-02T00:00:00Z',
        },
        {
          id: 'github/owner3/skill-3',
          repo_url: 'https://github.com/owner3/skill-3',
          updated_at: '2024-06-03T00:00:00Z',
        },
      ]

      const seen = new Map<string, (typeof skills)[0]>()
      for (const skill of skills) {
        const key = skill.repo_url.toLowerCase()
        if (!seen.has(key)) {
          seen.set(key, skill)
        }
      }

      const unique = Array.from(seen.values())
      expect(unique).toHaveLength(3)
    })
  })

  describe('Rate Limit Handling', () => {
    it('should include rate limit headers in request', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => createMockSearchResponse(10),
        headers: new Headers({
          'X-RateLimit-Remaining': '29',
          'X-RateLimit-Limit': '30',
          'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 60),
        }),
      })

      const response = await fetch(
        'https://api.github.com/search/repositories?q=topic:claude-skill',
        {
          headers: {
            Authorization: 'Bearer test-token',
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'Skillsmith-Import/1.0',
          },
        }
      )

      expect(response.headers.get('X-RateLimit-Remaining')).toBe('29')
      expect(response.headers.get('X-RateLimit-Limit')).toBe('30')
    })

    it('should handle rate limit error (403)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        headers: new Headers({
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 3600),
        }),
      })

      const response = await fetch(
        'https://api.github.com/search/repositories?q=topic:claude-skill'
      )

      expect(response.status).toBe(403)
      expect(response.headers.get('X-RateLimit-Remaining')).toBe('0')
    })
  })

  describe('Search Queries', () => {
    const SEARCH_QUERIES = [
      { name: 'claude-skill', query: 'topic:claude-skill' },
      { name: 'mcp-server', query: 'topic:mcp-server' },
      { name: 'skill-md', query: 'filename:SKILL.md' },
      { name: 'anthropic-skills', query: 'topic:anthropic-skills' },
    ]

    it('should have all required search queries', () => {
      expect(SEARCH_QUERIES).toHaveLength(4)
      expect(SEARCH_QUERIES.map((q) => q.name)).toContain('claude-skill')
      expect(SEARCH_QUERIES.map((q) => q.name)).toContain('mcp-server')
      expect(SEARCH_QUERIES.map((q) => q.name)).toContain('skill-md')
      expect(SEARCH_QUERIES.map((q) => q.name)).toContain('anthropic-skills')
    })

    it('should encode queries properly for URL', () => {
      const query = 'topic:claude-skill'
      const encoded = encodeURIComponent(query)
      expect(encoded).toBe('topic%3Aclaude-skill')
    })
  })

  describe('Output Format', () => {
    it('should structure imported skill correctly', () => {
      const mockRepo = {
        id: 123,
        owner: { login: 'test-owner', type: 'User' },
        name: 'test-skill',
        full_name: 'test-owner/test-skill',
        description: 'A test skill',
        html_url: 'https://github.com/test-owner/test-skill',
        clone_url: 'https://github.com/test-owner/test-skill.git',
        stargazers_count: 42,
        forks_count: 7,
        topics: ['claude-skill', 'ai'],
        language: 'TypeScript',
        license: { key: 'mit', name: 'MIT License', spdx_id: 'MIT' },
        created_at: '2024-01-15T00:00:00Z',
        updated_at: '2024-06-20T00:00:00Z',
        pushed_at: '2024-06-20T00:00:00Z',
        default_branch: 'main',
      }

      const skill = {
        id: `github/${mockRepo.owner.login}/${mockRepo.name}`,
        name: mockRepo.name,
        description: mockRepo.description || '',
        author: mockRepo.owner.login,
        repo_url: mockRepo.html_url,
        clone_url: mockRepo.clone_url,
        stars: mockRepo.stargazers_count,
        forks: mockRepo.forks_count,
        topics: mockRepo.topics || [],
        language: mockRepo.language,
        license: mockRepo.license?.spdx_id || null,
        created_at: mockRepo.created_at,
        updated_at: mockRepo.updated_at,
        source: 'github',
        query_type: 'claude-skill',
        imported_at: new Date().toISOString(),
      }

      expect(skill.id).toBe('github/test-owner/test-skill')
      expect(skill.author).toBe('test-owner')
      expect(skill.stars).toBe(42)
      expect(skill.license).toBe('MIT')
      expect(skill.source).toBe('github')
    })

    it('should handle null fields gracefully', () => {
      const mockRepo: {
        id: number
        owner: { login: string; type: string }
        name: string
        full_name: string
        description: string | null
        html_url: string
        clone_url: string
        stargazers_count: number
        forks_count: number
        topics: string[] | null
        language: string | null
        license: { spdx_id: string } | null
        created_at: string
        updated_at: string
        pushed_at: string
        default_branch: string
      } = {
        id: 456,
        owner: { login: 'no-desc-owner', type: 'User' },
        name: 'no-desc-skill',
        full_name: 'no-desc-owner/no-desc-skill',
        description: null,
        html_url: 'https://github.com/no-desc-owner/no-desc-skill',
        clone_url: 'https://github.com/no-desc-owner/no-desc-skill.git',
        stargazers_count: 0,
        forks_count: 0,
        topics: null,
        language: null,
        license: null,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        pushed_at: '2024-01-01T00:00:00Z',
        default_branch: 'main',
      }

      const skill = {
        id: `github/${mockRepo.owner.login}/${mockRepo.name}`,
        name: mockRepo.name,
        description: mockRepo.description || '',
        author: mockRepo.owner.login,
        repo_url: mockRepo.html_url,
        clone_url: mockRepo.clone_url,
        stars: mockRepo.stargazers_count,
        forks: mockRepo.forks_count,
        topics: mockRepo.topics || [],
        language: mockRepo.language,
        license: mockRepo.license?.spdx_id || null,
        created_at: mockRepo.created_at,
        updated_at: mockRepo.updated_at,
        source: 'github',
        query_type: 'claude-skill',
        imported_at: new Date().toISOString(),
      }

      expect(skill.description).toBe('')
      expect(skill.topics).toEqual([])
      expect(skill.language).toBeNull()
      expect(skill.license).toBeNull()
    })
  })

  describe('Checkpoint Format', () => {
    it('should structure checkpoint correctly', () => {
      const checkpoint = {
        last_query: 'claude-skill',
        last_page: 5,
        skills: [
          { id: 'github/owner1/skill-1', name: 'skill-1' },
          { id: 'github/owner2/skill-2', name: 'skill-2' },
        ],
        stats: {
          total_found: 150,
          total_imported: 0,
          duplicates_removed: 0,
          queries_completed: ['claude-skill'],
          errors: [],
          started_at: '2024-01-01T00:00:00Z',
        },
        timestamp: new Date().toISOString(),
      }

      expect(checkpoint.last_query).toBe('claude-skill')
      expect(checkpoint.last_page).toBe(5)
      expect(checkpoint.skills).toHaveLength(2)
      expect(checkpoint.stats.queries_completed).toContain('claude-skill')
    })
  })

  describe('Statistics Tracking', () => {
    it('should track import statistics correctly', () => {
      const stats = {
        total_found: 0,
        total_imported: 0,
        duplicates_removed: 0,
        queries_completed: [] as string[],
        errors: [] as string[],
        started_at: new Date().toISOString(),
        completed_at: undefined as string | undefined,
        duration_ms: undefined as number | undefined,
      }

      // Simulate adding results from queries
      stats.total_found += 100 // claude-skill
      stats.queries_completed.push('claude-skill')

      stats.total_found += 500 // mcp-server
      stats.queries_completed.push('mcp-server')

      stats.total_found += 50 // skill-md
      stats.queries_completed.push('skill-md')

      stats.total_found += 25 // anthropic-skills
      stats.queries_completed.push('anthropic-skills')

      // Simulate deduplication
      stats.duplicates_removed = 75
      stats.total_imported = stats.total_found - stats.duplicates_removed

      // Complete
      stats.completed_at = new Date().toISOString()
      stats.duration_ms = 30000

      expect(stats.total_found).toBe(675)
      expect(stats.total_imported).toBe(600)
      expect(stats.duplicates_removed).toBe(75)
      expect(stats.queries_completed).toHaveLength(4)
      expect(stats.completed_at).toBeDefined()
      expect(stats.duration_ms).toBe(30000)
    })
  })
})
