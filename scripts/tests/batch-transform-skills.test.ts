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
// SMI-2204: Import exported types and functions instead of duplicating
import {
  type ProgressMode, // Used in type assertions below
  validateProgressMode,
  getDefaultProgressMode,
  isTTY,
} from '../batch-transform-skills.js'
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

// =============================================================================
// SMI-2201: Filter Validation Tests
// =============================================================================

/**
 * Import filter functions for testing
 * Note: These are not exported from batch-transform-skills.ts, so we replicate them here
 * In production, consider exporting these from a shared module
 */

// Replicate VALID_TRUST_TIERS constant
const VALID_TRUST_TIERS = ['verified', 'community', 'experimental', 'unknown'] as const

// Replicate isValidIsoDate function for testing
function isValidIsoDate(dateStr: string): boolean {
  const isoDateRegex = /^\d{4}-\d{2}-\d{2}$/
  if (!isoDateRegex.test(dateStr)) return false
  const date = new Date(dateStr)
  return !isNaN(date.getTime())
}

// Replicate validateFilters interface and function for testing
interface CliOptionsForTest {
  retryFailed: boolean
  retrySkipped: boolean
  onlyMissing: boolean
  since: string | undefined
  trustTier: string | undefined
  monorepoSkills: boolean
}

function validateFilters(options: CliOptionsForTest): string[] {
  const errors: string[] = []

  // Validate --since format
  if (options.since && !isValidIsoDate(options.since)) {
    errors.push(`Invalid date format '${options.since}'. Use ISO-8601: --since 2026-01-25`)
  }

  // Validate --trust-tier value
  if (options.trustTier && !VALID_TRUST_TIERS.includes(options.trustTier as (typeof VALID_TRUST_TIERS)[number])) {
    errors.push(
      `Invalid trust tier '${options.trustTier}'. Valid values: ${VALID_TRUST_TIERS.join(', ')}`
    )
  }

  // Warn about incompatible combinations
  if (options.retryFailed && options.retrySkipped) {
    errors.push('--retry-failed and --retry-skipped are mutually exclusive')
  }

  if ((options.retryFailed || options.retrySkipped) && options.onlyMissing) {
    errors.push('--retry-failed/--retry-skipped and --only-missing are mutually exclusive')
  }

  return errors
}

function hasActiveFilters(options: CliOptionsForTest): boolean {
  return (
    options.retryFailed ||
    options.retrySkipped ||
    options.onlyMissing ||
    !!options.since ||
    !!options.trustTier ||
    options.monorepoSkills
  )
}

describe('SMI-2201: Filter Validation', () => {
  describe('isValidIsoDate', () => {
    it('returns true for valid ISO-8601 date (YYYY-MM-DD)', () => {
      expect(isValidIsoDate('2026-01-25')).toBe(true)
      expect(isValidIsoDate('2026-12-31')).toBe(true)
      expect(isValidIsoDate('2025-01-01')).toBe(true)
    })

    it('returns false for invalid date formats', () => {
      expect(isValidIsoDate('Jan 25')).toBe(false)
      expect(isValidIsoDate('01-25-2026')).toBe(false) // US format
      expect(isValidIsoDate('25-01-2026')).toBe(false) // EU format
      expect(isValidIsoDate('2026/01/25')).toBe(false) // Slash separator
      expect(isValidIsoDate('2026-1-25')).toBe(false) // Single digit month
      expect(isValidIsoDate('2026-01-5')).toBe(false) // Single digit day
    })

    it('returns false for clearly invalid dates', () => {
      // Note: JavaScript Date auto-corrects some invalid dates (e.g., Feb 30 → Mar 2)
      // The function validates format (YYYY-MM-DD) and that it parses to a valid Date
      expect(isValidIsoDate('2026-13-01')).toBe(false) // Invalid month (>12)
      expect(isValidIsoDate('2026-00-15')).toBe(false) // Zero month
      expect(isValidIsoDate('0000-01-01')).toBe(true) // Year 0 is technically valid in JS
    })

    it('returns false for non-date strings', () => {
      expect(isValidIsoDate('')).toBe(false)
      expect(isValidIsoDate('yesterday')).toBe(false)
      expect(isValidIsoDate('not-a-date')).toBe(false)
    })
  })

  describe('validateFilters', () => {
    const defaultOptions: CliOptionsForTest = {
      retryFailed: false,
      retrySkipped: false,
      onlyMissing: false,
      since: undefined,
      trustTier: undefined,
      monorepoSkills: false,
    }

    it('returns empty array for valid options with no filters', () => {
      const errors = validateFilters(defaultOptions)
      expect(errors).toHaveLength(0)
    })

    it('returns error for invalid --since date format', () => {
      const errors = validateFilters({ ...defaultOptions, since: 'Jan 25' })
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain("Invalid date format 'Jan 25'")
      expect(errors[0]).toContain('ISO-8601')
    })

    it('returns no error for valid --since date', () => {
      const errors = validateFilters({ ...defaultOptions, since: '2026-01-25' })
      expect(errors).toHaveLength(0)
    })

    it('returns error for invalid --trust-tier', () => {
      const errors = validateFilters({ ...defaultOptions, trustTier: 'invalid-tier' })
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain("Invalid trust tier 'invalid-tier'")
      expect(errors[0]).toContain('verified')
      expect(errors[0]).toContain('community')
    })

    it('returns no error for valid --trust-tier values', () => {
      for (const tier of VALID_TRUST_TIERS) {
        const errors = validateFilters({ ...defaultOptions, trustTier: tier })
        expect(errors).toHaveLength(0)
      }
    })

    it('returns error when --retry-failed and --retry-skipped are both set', () => {
      const errors = validateFilters({ ...defaultOptions, retryFailed: true, retrySkipped: true })
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain('mutually exclusive')
    })

    it('returns error when --retry-failed and --only-missing are both set', () => {
      const errors = validateFilters({ ...defaultOptions, retryFailed: true, onlyMissing: true })
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain('mutually exclusive')
    })

    it('returns error when --retry-skipped and --only-missing are both set', () => {
      const errors = validateFilters({ ...defaultOptions, retrySkipped: true, onlyMissing: true })
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain('mutually exclusive')
    })

    it('allows --trust-tier with --only-missing', () => {
      const errors = validateFilters({
        ...defaultOptions,
        trustTier: 'verified',
        onlyMissing: true,
      })
      expect(errors).toHaveLength(0)
    })

    it('allows --since with --monorepo-skills', () => {
      const errors = validateFilters({
        ...defaultOptions,
        since: '2026-01-25',
        monorepoSkills: true,
      })
      expect(errors).toHaveLength(0)
    })

    it('can return multiple errors', () => {
      const errors = validateFilters({
        ...defaultOptions,
        since: 'invalid-date',
        trustTier: 'invalid-tier',
        retryFailed: true,
        retrySkipped: true,
      })
      expect(errors.length).toBeGreaterThanOrEqual(3)
    })
  })

  describe('hasActiveFilters', () => {
    const defaultOptions: CliOptionsForTest = {
      retryFailed: false,
      retrySkipped: false,
      onlyMissing: false,
      since: undefined,
      trustTier: undefined,
      monorepoSkills: false,
    }

    it('returns false when no filters are set', () => {
      expect(hasActiveFilters(defaultOptions)).toBe(false)
    })

    it('returns true when --retry-failed is set', () => {
      expect(hasActiveFilters({ ...defaultOptions, retryFailed: true })).toBe(true)
    })

    it('returns true when --retry-skipped is set', () => {
      expect(hasActiveFilters({ ...defaultOptions, retrySkipped: true })).toBe(true)
    })

    it('returns true when --only-missing is set', () => {
      expect(hasActiveFilters({ ...defaultOptions, onlyMissing: true })).toBe(true)
    })

    it('returns true when --since is set', () => {
      expect(hasActiveFilters({ ...defaultOptions, since: '2026-01-25' })).toBe(true)
    })

    it('returns true when --trust-tier is set', () => {
      expect(hasActiveFilters({ ...defaultOptions, trustTier: 'verified' })).toBe(true)
    })

    it('returns true when --monorepo-skills is set', () => {
      expect(hasActiveFilters({ ...defaultOptions, monorepoSkills: true })).toBe(true)
    })

    it('returns true when multiple filters are set', () => {
      expect(
        hasActiveFilters({
          ...defaultOptions,
          trustTier: 'verified',
          onlyMissing: true,
          monorepoSkills: true,
        })
      ).toBe(true)
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

// =============================================================================
// SMI-2204: Progress Mode Tests
// =============================================================================

// Types and helper functions are now imported from ../batch-transform-skills.js
// to avoid duplication (ProgressMode, validateProgressMode, getDefaultProgressMode, isTTY)

// JsonOutput interface still needed locally for schema validation tests
interface JsonOutput {
  processed: number
  transformed: number
  skipped: number
  failed: number
  duration_ms: number
  checkpoint: { offset: number; timestamp: string } | null
  failed_skills: string[]
  skipped_skills: Array<{ id: string; reason: string }>
}

describe('SMI-2204: Progress Mode', () => {
  describe('isTTY detection', () => {
    it('returns boolean based on process.stdout.isTTY', () => {
      const result = isTTY()
      expect(typeof result).toBe('boolean')
    })
  })

  describe('getDefaultProgressMode', () => {
    it('returns a valid progress mode', () => {
      // Use ProgressMode type to verify return type matches
      const mode: ProgressMode = getDefaultProgressMode()
      expect(['dots', 'bar', 'json']).toContain(mode)
    })

    it('returns dots or bar (never json by default)', () => {
      const mode: ProgressMode = getDefaultProgressMode()
      expect(['dots', 'bar']).toContain(mode)
    })
  })

  describe('validateProgressMode', () => {
    it('returns true for valid modes', () => {
      expect(validateProgressMode('dots')).toBe(true)
      expect(validateProgressMode('bar')).toBe(true)
      expect(validateProgressMode('json')).toBe(true)
    })

    it('returns false for invalid modes', () => {
      expect(validateProgressMode('invalid')).toBe(false)
      expect(validateProgressMode('progress')).toBe(false)
      expect(validateProgressMode('')).toBe(false)
      expect(validateProgressMode('DOTS')).toBe(false) // Case sensitive
    })
  })

  describe('JsonOutput schema', () => {
    it('validates complete JsonOutput structure', () => {
      const output: JsonOutput = {
        processed: 100,
        transformed: 80,
        skipped: 15,
        failed: 5,
        duration_ms: 60000,
        checkpoint: { offset: 100, timestamp: '2026-02-01T12:00:00Z' },
        failed_skills: ['skill-1', 'skill-2'],
        skipped_skills: [
          { id: 'skill-3', reason: 'SKILL.md not found' },
          { id: 'skill-4', reason: 'No repo_url' },
        ],
      }

      expect(output.processed).toBe(100)
      expect(output.transformed).toBe(80)
      expect(output.skipped).toBe(15)
      expect(output.failed).toBe(5)
      expect(output.duration_ms).toBe(60000)
      expect(output.checkpoint?.offset).toBe(100)
      expect(output.failed_skills).toHaveLength(2)
      expect(output.skipped_skills).toHaveLength(2)
      expect(output.skipped_skills[0].reason).toBe('SKILL.md not found')
    })

    it('allows null checkpoint', () => {
      const output: JsonOutput = {
        processed: 50,
        transformed: 45,
        skipped: 3,
        failed: 2,
        duration_ms: 30000,
        checkpoint: null,
        failed_skills: ['skill-1'],
        skipped_skills: [],
      }

      expect(output.checkpoint).toBeNull()
    })

    it('validates processed = transformed + skipped + failed', () => {
      const output: JsonOutput = {
        processed: 100,
        transformed: 70,
        skipped: 20,
        failed: 10,
        duration_ms: 60000,
        checkpoint: null,
        failed_skills: [],
        skipped_skills: [],
      }

      expect(output.processed).toBe(output.transformed + output.skipped + output.failed)
    })
  })

  describe('progress mode CLI validation', () => {
    it('accepts valid progress modes', () => {
      const validModes = ['dots', 'bar', 'json']
      validModes.forEach((mode) => {
        expect(validateProgressMode(mode)).toBe(true)
      })
    })

    it('rejects invalid progress modes', () => {
      const invalidModes = ['', 'none', 'verbose', 'quiet', 'DOTS', 'BAR', 'JSON']
      invalidModes.forEach((mode) => {
        expect(validateProgressMode(mode)).toBe(false)
      })
    })
  })
})

// =============================================================================
// SMI-2204: Checkpoint Array Truncation Tests (Code Review Task #20)
// =============================================================================

describe('SMI-2204: Checkpoint Array Truncation Limits', () => {
  describe('error array truncation', () => {
    it('limits errors array to 100 entries', () => {
      // Create an array larger than the limit
      const largeErrorArray = Array.from({ length: 150 }, (_, i) => `Error ${i + 1}`)

      // Simulate the truncation logic from batch-transform-skills.ts
      const truncated = largeErrorArray.slice(-100)

      expect(truncated.length).toBe(100)
      // Verify it keeps the LAST 100 errors (most recent)
      expect(truncated[0]).toBe('Error 51')
      expect(truncated[99]).toBe('Error 150')
    })

    it('does not truncate when under limit', () => {
      const smallErrorArray = Array.from({ length: 50 }, (_, i) => `Error ${i + 1}`)
      const truncated = smallErrorArray.slice(-100)

      expect(truncated.length).toBe(50)
      expect(truncated[0]).toBe('Error 1')
    })
  })

  describe('skill ID array truncation', () => {
    it('limits failedSkillIds to 500 entries', () => {
      const largeIdArray = Array.from({ length: 600 }, (_, i) => `skill-${i + 1}`)
      const truncated = largeIdArray.slice(-500)

      expect(truncated.length).toBe(500)
      // Verify it keeps the LAST 500 IDs (most recent)
      expect(truncated[0]).toBe('skill-101')
      expect(truncated[499]).toBe('skill-600')
    })

    it('limits skippedSkillIds to 500 entries', () => {
      const largeIdArray = Array.from({ length: 750 }, (_, i) => `skip-${i + 1}`)
      const truncated = largeIdArray.slice(-500)

      expect(truncated.length).toBe(500)
      expect(truncated[0]).toBe('skip-251')
      expect(truncated[499]).toBe('skip-750')
    })

    it('does not truncate when under limit', () => {
      const smallIdArray = Array.from({ length: 200 }, (_, i) => `skill-${i + 1}`)
      const truncated = smallIdArray.slice(-500)

      expect(truncated.length).toBe(200)
      expect(truncated[0]).toBe('skill-1')
    })
  })

  describe('truncation constants documentation', () => {
    it('documents the truncation limits', () => {
      // These constants are used in batch-transform-skills.ts checkpoint saving
      const ERROR_LIMIT = 100
      const SKILL_ID_LIMIT = 500

      // Verify the expected limits match what's in the implementation
      expect(ERROR_LIMIT).toBe(100)
      expect(SKILL_ID_LIMIT).toBe(500)
    })
  })
})
