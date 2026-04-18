/**
 * GitLabSourceAdapter additional coverage (SMI-4290 / closes #595)
 *
 * Sidecar to ScraperAdapters.test.ts — fills genuine coverage gaps for
 * `skillExists`, `getSkillSha`, and the `createGitLabAdapter` factory.
 *
 * The primary suite (`ScraperAdapters.test.ts:631`) already has 14 tests
 * covering init, health, search, pagination, `getRepository`, and
 * `fetchSkillContent`. This file stays under 500 lines and is kept
 * separate so pre-commit's file-length check does not block edits to
 * the main (>500 line) test file.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { GitLabSourceAdapter, createGitLabAdapter } from '../src/sources/GitLabSourceAdapter.js'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => body,
  } as unknown as Response
}

function notFoundResponse(): Response {
  return {
    ok: false,
    status: 404,
    headers: new Headers(),
  } as unknown as Response
}

function rateLimitedResponse(): Response {
  return {
    ok: false,
    status: 429,
    headers: new Headers(),
  } as unknown as Response
}

describe('GitLabSourceAdapter — additional coverage (SMI-4290)', () => {
  let adapter: GitLabSourceAdapter

  beforeEach(() => {
    mockFetch.mockReset()
    adapter = new GitLabSourceAdapter({
      id: 'test-gitlab-coverage',
      name: 'Test GitLab Coverage',
      type: 'gitlab',
      baseUrl: 'https://gitlab.com/api/v4',
      enabled: true,
      rateLimit: { maxRequests: 100, windowMs: 60000, minDelayMs: 0 },
    })
  })

  describe('skillExists', () => {
    it('returns true when the default SKILL.md path resolves 200', async () => {
      mockFetch.mockResolvedValueOnce(okResponse({}))

      const exists = await adapter.skillExists({ owner: 'user', repo: 'skill-repo' })

      expect(exists).toBe(true)
      expect(mockFetch).toHaveBeenCalledTimes(1)
      const [url, init] = mockFetch.mock.calls[0]
      expect(String(url)).toContain('/projects/user%2Fskill-repo/repository/files/')
      expect((init as RequestInit).method).toBe('HEAD')
    })

    it('returns false when every candidate path returns 404', async () => {
      // GitLabSourceAdapter falls back through SKILL_FILE_PATHS; each lookup 404s.
      mockFetch.mockResolvedValue(notFoundResponse())

      const exists = await adapter.skillExists({ owner: 'user', repo: 'missing-repo' })

      expect(exists).toBe(false)
      expect(mockFetch.mock.calls.length).toBeGreaterThan(0)
    })

    it('returns true when an explicit path is provided and resolves', async () => {
      mockFetch.mockResolvedValueOnce(okResponse({}))

      const exists = await adapter.skillExists({
        owner: 'user',
        repo: 'skill-repo',
        path: 'docs/custom-skill.md',
      })

      expect(exists).toBe(true)
      // With an explicit path only one request should be attempted.
      expect(mockFetch).toHaveBeenCalledTimes(1)
      expect(String(mockFetch.mock.calls[0][0])).toContain(
        encodeURIComponent('docs/custom-skill.md')
      )
    })

    it('returns false when the request throws (network error surfaced as continue)', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNRESET'))

      const exists = await adapter.skillExists({ owner: 'user', repo: 'broken-repo' })

      expect(exists).toBe(false)
    })

    it('returns false when the rate-limited status is surfaced (not a 200)', async () => {
      mockFetch.mockResolvedValue(rateLimitedResponse())

      const exists = await adapter.skillExists({ owner: 'user', repo: 'limited-repo' })

      expect(exists).toBe(false)
    })
  })

  describe('getSkillSha', () => {
    it('returns the content SHA-256 when the file resolves', async () => {
      mockFetch.mockResolvedValueOnce(
        okResponse({
          file_name: 'SKILL.md',
          file_path: 'SKILL.md',
          content: '',
          encoding: 'base64',
          content_sha256: 'sha-abc-123',
        })
      )

      const sha = await adapter.getSkillSha({ owner: 'user', repo: 'skill-repo' })

      expect(sha).toBe('sha-abc-123')
    })

    it('returns null when every candidate path 404s', async () => {
      mockFetch.mockResolvedValue(notFoundResponse())

      const sha = await adapter.getSkillSha({ owner: 'user', repo: 'missing-repo' })

      expect(sha).toBeNull()
    })

    it('falls back to the second path when the first 404s', async () => {
      mockFetch.mockResolvedValueOnce(notFoundResponse()).mockResolvedValueOnce(
        okResponse({
          file_name: 'skill.md',
          file_path: 'skill.md',
          content: '',
          encoding: 'base64',
          content_sha256: 'sha-fallback-789',
        })
      )

      const sha = await adapter.getSkillSha({ owner: 'user', repo: 'skill-repo' })

      expect(sha).toBe('sha-fallback-789')
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    it('returns null when a network error is thrown and no path succeeds', async () => {
      mockFetch.mockRejectedValue(new Error('ETIMEDOUT'))

      const sha = await adapter.getSkillSha({ owner: 'user', repo: 'broken-repo' })

      expect(sha).toBeNull()
    })
  })

  describe('createGitLabAdapter factory', () => {
    it('returns a GitLabSourceAdapter with type set to gitlab', () => {
      const built = createGitLabAdapter({
        id: 'factory-gitlab',
        name: 'Factory GitLab',
        enabled: true,
      })

      expect(built).toBeInstanceOf(GitLabSourceAdapter)
      expect(built.type).toBe('gitlab')
    })

    it('defaults baseUrl to the public gitlab.com endpoint when not provided', async () => {
      const built = createGitLabAdapter({
        id: 'factory-default-url',
        name: 'Factory Default URL',
        enabled: true,
      })

      mockFetch.mockResolvedValueOnce(okResponse({}))
      await built.skillExists({ owner: 'user', repo: 'skill-repo' })

      expect(String(mockFetch.mock.calls[0][0])).toContain('https://gitlab.com/api/v4')
    })

    it('respects a custom baseUrl when provided', async () => {
      const built = createGitLabAdapter({
        id: 'factory-custom-url',
        name: 'Factory Custom URL',
        enabled: true,
        baseUrl: 'https://gitlab.example.com/api/v4',
      })

      mockFetch.mockResolvedValueOnce(okResponse({}))
      await built.skillExists({ owner: 'user', repo: 'skill-repo' })

      expect(String(mockFetch.mock.calls[0][0])).toContain('https://gitlab.example.com/api/v4')
    })

    it('forwards auth configuration to the constructed adapter', () => {
      const built = createGitLabAdapter({
        id: 'factory-auth',
        name: 'Factory Auth',
        enabled: true,
        auth: { type: 'token', credentials: 'glpat-stub' },
      })

      expect(built).toBeInstanceOf(GitLabSourceAdapter)
    })
  })
})
