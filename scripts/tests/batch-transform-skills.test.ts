/**
 * Batch Transform Skills Tests
 * SMI-2173: Unit tests for URL parsing in batch transformation
 *
 * Tests the parseRepoUrl function from @skillsmith/core and verifies
 * correct URL construction for SKILL.md fetching.
 */

import { describe, it, expect } from 'vitest'
import { parseRepoUrl, isGitHubUrl } from '@skillsmith/core'

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
