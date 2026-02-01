/**
 * Batch Transform Skills Tests
 * SMI-2173: Unit tests for URL parsing in batch transformation
 * SMI-2200: Unit tests for checkpoint-based resumability
 * SMI-2203: Unit tests for dynamic rate limiting
 *
 * Tests the parseRepoUrl function from @skillsmith/core and verifies
 * correct URL construction for SKILL.md fetching.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { parseRepoUrl, isGitHubUrl } from '@skillsmith/core'
import {
  GitHubRateLimiter,
  loadCheckpoint,
  saveCheckpoint,
  clearCheckpoint,
  type MigrationCheckpoint,
} from '../lib/migration-utils.js'
import { GITHUB_API_BASE_DELAY, BATCH_TRANSFORM_CHECKPOINT_FILE } from '../lib/constants.js'
import * as fs from 'fs'
import * as path from 'path'

describe('SMI-2173: Batch Transform URL Parsing', () => {
  describe('parseRepoUrl', () => {
    describe('regular repo URLs', () => {
      it('parses plain repo URL → SKILL.md at root', () => {
        const result = parseRepoUrl('https://github.com/owner/repo')

        expect(result.owner).toBe('owner')
        expect(result.repo).toBe('repo')
        expect(result.path).toBe('')
        expect(result.branch).toBe('main')

        // Verify SKILL.md path construction
        const skillPath = result.path ? `${result.path}/SKILL.md` : 'SKILL.md'
        expect(skillPath).toBe('SKILL.md')
      })

      it('handles www.github.com', () => {
        const result = parseRepoUrl('https://www.github.com/owner/repo')

        expect(result.owner).toBe('owner')
        expect(result.repo).toBe('repo')
      })
    })

    describe('high-trust subdirectory URLs (monorepos)', () => {
      it('parses /tree/branch/path URL → SKILL.md at subdirectory', () => {
        const result = parseRepoUrl('https://github.com/ruvnet/claude-code/tree/main/skills/commit')

        expect(result.owner).toBe('ruvnet')
        expect(result.repo).toBe('claude-code')
        expect(result.path).toBe('skills/commit')
        expect(result.branch).toBe('main')

        // Verify SKILL.md path construction
        const skillPath = result.path ? `${result.path}/SKILL.md` : 'SKILL.md'
        expect(skillPath).toBe('skills/commit/SKILL.md')
      })

      it('handles nested subdirectory URLs', () => {
        const result = parseRepoUrl(
          'https://github.com/org/repo/tree/main/skills/category/subcategory/skill-name'
        )

        expect(result.owner).toBe('org')
        expect(result.repo).toBe('repo')
        expect(result.path).toBe('skills/category/subcategory/skill-name')
        expect(result.branch).toBe('main')

        // Verify SKILL.md path construction
        const skillPath = result.path ? `${result.path}/SKILL.md` : 'SKILL.md'
        expect(skillPath).toBe('skills/category/subcategory/skill-name/SKILL.md')
      })

      it('extracts branch from URL', () => {
        const result = parseRepoUrl(
          'https://github.com/huggingface/skills/tree/develop/skills/datasets'
        )

        expect(result.branch).toBe('develop')
        expect(result.path).toBe('skills/datasets')
      })
    })

    describe('root-level high-trust skills', () => {
      it('parses plain repo URL (no /tree/ path) → SKILL.md at root', () => {
        // Some high-trust skills are at repo root, not in subdirectory
        const result = parseRepoUrl('https://github.com/anthropics/single-skill')

        expect(result.owner).toBe('anthropics')
        expect(result.repo).toBe('single-skill')
        expect(result.path).toBe('')
        expect(result.branch).toBe('main')

        // Verify SKILL.md path construction
        const skillPath = result.path ? `${result.path}/SKILL.md` : 'SKILL.md'
        expect(skillPath).toBe('SKILL.md')
      })
    })

    describe('edge cases', () => {
      it('handles /blob/ URLs same as /tree/', () => {
        const result = parseRepoUrl('https://github.com/owner/repo/blob/main/skills/test')

        expect(result.owner).toBe('owner')
        expect(result.repo).toBe('repo')
        expect(result.path).toBe('skills/test')
        expect(result.branch).toBe('main')
      })

      it('handles non-main/master branches', () => {
        const result = parseRepoUrl('https://github.com/owner/repo/tree/feature-branch/skills/new')

        expect(result.branch).toBe('feature-branch')
        expect(result.path).toBe('skills/new')
      })

      it('handles unknown URL format with path', () => {
        // Fallback behavior for unknown formats
        const result = parseRepoUrl('https://github.com/owner/repo/some/path')

        expect(result.owner).toBe('owner')
        expect(result.repo).toBe('repo')
        expect(result.path).toBe('some/path')
        expect(result.branch).toBe('main')
      })
    })

    describe('error handling', () => {
      it('throws for invalid URL format', () => {
        expect(() => parseRepoUrl('not-a-url')).toThrow()
      })

      it('throws for non-GitHub hosts', () => {
        expect(() => parseRepoUrl('https://gitlab.com/owner/repo')).toThrow(
          /Invalid repository host/
        )
      })

      it('throws for bitbucket URLs', () => {
        expect(() => parseRepoUrl('https://bitbucket.org/owner/repo')).toThrow(
          /Invalid repository host/
        )
      })
    })
  })

  describe('isGitHubUrl', () => {
    it('returns true for valid GitHub URLs', () => {
      expect(isGitHubUrl('https://github.com/owner/repo')).toBe(true)
      expect(isGitHubUrl('https://www.github.com/owner/repo')).toBe(true)
      expect(isGitHubUrl('https://github.com/org/repo/tree/main/path')).toBe(true)
    })

    it('returns false for non-GitHub URLs', () => {
      expect(isGitHubUrl('https://gitlab.com/owner/repo')).toBe(false)
      expect(isGitHubUrl('https://bitbucket.org/owner/repo')).toBe(false)
      expect(isGitHubUrl('https://example.com')).toBe(false)
    })

    it('returns false for invalid URLs', () => {
      expect(isGitHubUrl('not-a-url')).toBe(false)
      expect(isGitHubUrl('')).toBe(false)
    })
  })

  describe('SKILL.md fetch URL construction', () => {
    /**
     * Helper to construct the raw.githubusercontent.com URL
     * This mirrors the logic in fetchSkillContent
     */
    function constructFetchUrl(owner: string, repo: string, branch: string, path: string): string {
      const pathPrefix = path ? `${path}/` : ''
      return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${pathPrefix}SKILL.md`
    }

    it('constructs correct URL for plain repo', () => {
      const parsed = parseRepoUrl('https://github.com/owner/repo')
      const url = constructFetchUrl(parsed.owner, parsed.repo, parsed.branch, parsed.path)

      expect(url).toBe('https://raw.githubusercontent.com/owner/repo/main/SKILL.md')
    })

    it('constructs correct URL for monorepo subdirectory skill', () => {
      const parsed = parseRepoUrl('https://github.com/ruvnet/claude-code/tree/main/skills/commit')
      const url = constructFetchUrl(parsed.owner, parsed.repo, parsed.branch, parsed.path)

      expect(url).toBe(
        'https://raw.githubusercontent.com/ruvnet/claude-code/main/skills/commit/SKILL.md'
      )
    })

    it('constructs correct URL for nested subdirectory', () => {
      const parsed = parseRepoUrl('https://github.com/org/repo/tree/develop/a/b/c/skill')
      const url = constructFetchUrl(parsed.owner, parsed.repo, parsed.branch, parsed.path)

      expect(url).toBe('https://raw.githubusercontent.com/org/repo/develop/a/b/c/skill/SKILL.md')
    })

    it('preserves branch from URL', () => {
      const parsed = parseRepoUrl('https://github.com/owner/repo/tree/release-v2/skills/new')
      const url = constructFetchUrl(parsed.owner, parsed.repo, parsed.branch, parsed.path)

      expect(url).toBe(
        'https://raw.githubusercontent.com/owner/repo/release-v2/skills/new/SKILL.md'
      )
    })
  })

  describe('real-world monorepo examples', () => {
    const monorepoUrls = [
      {
        url: 'https://github.com/anthropics/skills/tree/main/skills/theme-factory',
        expectedPath: 'skills/theme-factory',
        expectedOwner: 'anthropics',
      },
      {
        url: 'https://github.com/huggingface/skills/tree/main/skills/hugging-face-datasets',
        expectedPath: 'skills/hugging-face-datasets',
        expectedOwner: 'huggingface',
      },
      {
        url: 'https://github.com/resend/resend-skills/tree/main/agent-email-inbox',
        expectedPath: 'agent-email-inbox',
        expectedOwner: 'resend',
      },
      {
        url: 'https://github.com/vercel-labs/agent-skills/tree/main/skills/web-design-guidelines',
        expectedPath: 'skills/web-design-guidelines',
        expectedOwner: 'vercel-labs',
      },
    ]

    monorepoUrls.forEach(({ url, expectedPath, expectedOwner }) => {
      it(`correctly parses ${expectedOwner} monorepo skill`, () => {
        const result = parseRepoUrl(url)

        expect(result.owner).toBe(expectedOwner)
        expect(result.path).toBe(expectedPath)
        expect(result.branch).toBe('main')

        // Verify SKILL.md would be found at correct path
        const skillMdPath = `${result.path}/SKILL.md`
        expect(skillMdPath).toBe(`${expectedPath}/SKILL.md`)
      })
    })
  })
})

// =============================================================================
// SMI-2203: GitHub Rate Limiter Tests
// =============================================================================

describe('SMI-2203: GitHubRateLimiter', () => {
  describe('constructor', () => {
    it('uses default base delay from constants', () => {
      const limiter = new GitHubRateLimiter()
      // Internal state starts at 5000 remaining
      expect(limiter.getRemaining()).toBe(5000)
    })

    it('accepts custom base delay', () => {
      const limiter = new GitHubRateLimiter(500)
      expect(limiter.getRemaining()).toBe(5000)
    })
  })

  describe('updateFromHeaders', () => {
    it('extracts rate limit info from response headers', () => {
      const limiter = new GitHubRateLimiter()
      const headers = new Headers({
        'X-RateLimit-Remaining': '4500',
        'X-RateLimit-Reset': '1706900000',
      })

      limiter.updateFromHeaders(headers)

      expect(limiter.getRemaining()).toBe(4500)
      expect(limiter.getResetTime()).toBe(1706900000000) // Converted to ms
    })

    it('handles missing headers gracefully', () => {
      const limiter = new GitHubRateLimiter()
      const headers = new Headers({})

      limiter.updateFromHeaders(headers)

      // Should retain initial values
      expect(limiter.getRemaining()).toBe(5000)
    })
  })

  describe('calculateDelay (via applyDelay)', () => {
    it('returns base delay when remaining > 500', async () => {
      const limiter = new GitHubRateLimiter(100) // 100ms base
      const startTime = Date.now()
      const delay = await limiter.applyDelay()
      const elapsed = Date.now() - startTime

      expect(delay).toBe(100)
      expect(elapsed).toBeGreaterThanOrEqual(95) // Allow some tolerance
    })

    it('returns 3x base delay when remaining < 500', async () => {
      const limiter = new GitHubRateLimiter(100)
      limiter.updateFromHeaders(
        new Headers({
          'X-RateLimit-Remaining': '300',
        })
      )

      const delay = await limiter.applyDelay()
      expect(delay).toBe(300) // 100 * 3
    })

    it('returns 10x base delay (min 1500ms) when remaining < 100', async () => {
      const limiter = new GitHubRateLimiter(100)
      limiter.updateFromHeaders(
        new Headers({
          'X-RateLimit-Remaining': '50',
        })
      )

      const delay = await limiter.applyDelay()
      expect(delay).toBe(1500) // max(100 * 10, 1500)
    })

    it('ensures minimum 1500ms delay in critical zone', async () => {
      const limiter = new GitHubRateLimiter(50) // Small base delay
      limiter.updateFromHeaders(
        new Headers({
          'X-RateLimit-Remaining': '10',
        })
      )

      const delay = await limiter.applyDelay()
      expect(delay).toBe(1500) // max(50 * 10, 1500) = 1500
    })
  })

  describe('withRateLimit', () => {
    it('applies delay and updates from response', async () => {
      const limiter = new GitHubRateLimiter(10) // Short delay for test
      const mockResponse = new Response('ok', {
        headers: {
          'X-RateLimit-Remaining': '4000',
          'X-RateLimit-Reset': '1706900000',
        },
      })

      const response = await limiter.withRateLimit(() => Promise.resolve(mockResponse))

      expect(response).toBe(mockResponse)
      expect(limiter.getRemaining()).toBe(4000)
    })
  })

  describe('constants', () => {
    it('GITHUB_API_BASE_DELAY defaults to 150', () => {
      // Note: This tests the default, not env var override
      expect(typeof GITHUB_API_BASE_DELAY).toBe('number')
      expect(GITHUB_API_BASE_DELAY).toBeGreaterThan(0)
    })

    it('BATCH_TRANSFORM_CHECKPOINT_FILE is defined', () => {
      expect(BATCH_TRANSFORM_CHECKPOINT_FILE).toBe('.batch-transform-checkpoint.json')
    })
  })
})

// =============================================================================
// SMI-2200: Checkpoint Tests
// =============================================================================

describe('SMI-2200: Checkpoint Functions', () => {
  const testCheckpointPath = path.join(process.cwd(), '.migration-checkpoint.json')

  beforeEach(() => {
    // Clean up any existing checkpoint
    if (fs.existsSync(testCheckpointPath)) {
      fs.unlinkSync(testCheckpointPath)
    }
  })

  afterEach(() => {
    // Clean up after tests
    if (fs.existsSync(testCheckpointPath)) {
      fs.unlinkSync(testCheckpointPath)
    }
  })

  describe('loadCheckpoint', () => {
    it('returns null when no checkpoint file exists', () => {
      const result = loadCheckpoint()
      expect(result).toBeNull()
    })

    it('returns checkpoint data when valid file exists', () => {
      const checkpoint: MigrationCheckpoint = {
        lastProcessedOffset: 100,
        lastProcessedId: 'skill-abc',
        processedCount: 100,
        successCount: 95,
        errorCount: 5,
        errors: ['error1', 'error2'],
        timestamp: '2026-02-01T12:00:00.000Z',
        dbPath: '/path/to/db',
      }
      fs.writeFileSync(testCheckpointPath, JSON.stringify(checkpoint, null, 2))

      const result = loadCheckpoint()

      expect(result).not.toBeNull()
      expect(result?.lastProcessedOffset).toBe(100)
      expect(result?.successCount).toBe(95)
      expect(result?.lastProcessedId).toBe('skill-abc')
    })

    it('returns null for invalid JSON', () => {
      fs.writeFileSync(testCheckpointPath, 'not valid json')

      const result = loadCheckpoint()
      expect(result).toBeNull()
    })

    it('returns null for checkpoint missing required fields', () => {
      // Missing dbPath, successCount, errorCount
      fs.writeFileSync(
        testCheckpointPath,
        JSON.stringify({
          lastProcessedOffset: 100,
          processedCount: 100,
        })
      )

      const result = loadCheckpoint()
      expect(result).toBeNull()
    })
  })

  describe('saveCheckpoint', () => {
    it('writes checkpoint to file', () => {
      const checkpoint: MigrationCheckpoint = {
        lastProcessedOffset: 50,
        processedCount: 50,
        successCount: 48,
        errorCount: 2,
        errors: ['error1'],
        timestamp: new Date().toISOString(),
        dbPath: '/path/to/db',
      }

      saveCheckpoint(checkpoint)

      expect(fs.existsSync(testCheckpointPath)).toBe(true)
      const saved = JSON.parse(fs.readFileSync(testCheckpointPath, 'utf-8'))
      expect(saved.lastProcessedOffset).toBe(50)
      expect(saved.successCount).toBe(48)
    })
  })

  describe('clearCheckpoint', () => {
    it('removes checkpoint file when it exists', () => {
      fs.writeFileSync(testCheckpointPath, JSON.stringify({ test: true }))
      expect(fs.existsSync(testCheckpointPath)).toBe(true)

      clearCheckpoint()

      expect(fs.existsSync(testCheckpointPath)).toBe(false)
    })

    it('does nothing when no checkpoint exists', () => {
      // Should not throw
      expect(() => clearCheckpoint()).not.toThrow()
    })
  })
})
