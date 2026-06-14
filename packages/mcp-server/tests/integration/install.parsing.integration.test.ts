/**
 * SMI-1491: Install Skill URL/ID parsing integration tests
 * Pure parsing logic split out of install.integration.test.ts (SMI-5263) — no
 * filesystem or module mocks; mirrors the parseRepoUrl / parseSkillId logic in
 * install.ts.
 */

import { describe, it, expect } from 'vitest'

describe('Install Skill Tool — URL/ID Parsing', () => {
  /**
   * SMI-1491: Tests for parseRepoUrl function
   * Tests parsing of various repo_url formats from registry
   */
  describe('SMI-1491: parseRepoUrl', () => {
    // Local implementation matching install.ts
    const parseRepoUrl = (
      repoUrl: string
    ): {
      owner: string
      repo: string
      path: string
      branch: string
    } => {
      const url = new URL(repoUrl)
      const parts = url.pathname.split('/').filter(Boolean)
      const owner = parts[0]
      const repo = parts[1]

      if (parts.length === 2) {
        return { owner, repo, path: '', branch: 'main' }
      }

      if (parts[2] === 'tree' || parts[2] === 'blob') {
        return {
          owner,
          repo,
          branch: parts[3],
          path: parts.slice(4).join('/'),
        }
      }

      return { owner, repo, path: parts.slice(2).join('/'), branch: 'main' }
    }

    it('should parse repo root URL', () => {
      const result = parseRepoUrl('https://github.com/owner/repo')
      expect(result).toEqual({
        owner: 'owner',
        repo: 'repo',
        path: '',
        branch: 'main',
      })
    })

    it('should parse tree URL with main branch', () => {
      const result = parseRepoUrl('https://github.com/owner/repo/tree/main/skills/commit')
      expect(result).toEqual({
        owner: 'owner',
        repo: 'repo',
        path: 'skills/commit',
        branch: 'main',
      })
    })

    it('should parse tree URL with custom branch', () => {
      const result = parseRepoUrl('https://github.com/owner/repo/tree/develop/path/to/skill')
      expect(result).toEqual({
        owner: 'owner',
        repo: 'repo',
        path: 'path/to/skill',
        branch: 'develop',
      })
    })

    it('should parse blob URL', () => {
      const result = parseRepoUrl('https://github.com/owner/repo/blob/main/SKILL.md')
      expect(result).toEqual({
        owner: 'owner',
        repo: 'repo',
        path: 'SKILL.md',
        branch: 'main',
      })
    })

    it('should handle deep nested paths', () => {
      const result = parseRepoUrl(
        'https://github.com/org/monorepo/tree/main/packages/skills/helper'
      )
      expect(result).toEqual({
        owner: 'org',
        repo: 'monorepo',
        path: 'packages/skills/helper',
        branch: 'main',
      })
    })
  })

  /**
   * SMI-1491: Tests for updated parseSkillId with isRegistryId flag
   */
  describe('SMI-1491: parseSkillId with isRegistryId', () => {
    // Local implementation matching install.ts
    const parseSkillId = (
      input: string
    ): {
      owner: string
      repo: string
      path: string
      isRegistryId: boolean
    } => {
      if (input.startsWith('https://github.com/')) {
        const url = new URL(input)
        const parts = url.pathname.split('/').filter(Boolean)
        return {
          owner: parts[0],
          repo: parts[1],
          path: parts.slice(2).join('/') || '',
          isRegistryId: false,
        }
      }

      if (input.includes('/')) {
        const parts = input.split('/')
        if (parts.length === 2) {
          return {
            owner: parts[0],
            repo: parts[1],
            path: '',
            isRegistryId: true,
          }
        }
        return {
          owner: parts[0],
          repo: parts[1],
          path: parts.slice(2).join('/'),
          isRegistryId: false,
        }
      }

      throw new Error('Invalid skill ID format')
    }

    it('should mark 2-part ID as registry ID', () => {
      const result = parseSkillId('anthropic/commit')
      expect(result.isRegistryId).toBe(true)
      expect(result.owner).toBe('anthropic')
      expect(result.repo).toBe('commit')
    })

    it('should mark 3-part ID as direct path (not registry)', () => {
      const result = parseSkillId('owner/repo/skill-path')
      expect(result.isRegistryId).toBe(false)
      expect(result.owner).toBe('owner')
      expect(result.repo).toBe('repo')
      expect(result.path).toBe('skill-path')
    })

    it('should mark full URL as not registry ID', () => {
      const result = parseSkillId('https://github.com/owner/repo/tree/main/skill')
      expect(result.isRegistryId).toBe(false)
      expect(result.owner).toBe('owner')
      expect(result.repo).toBe('repo')
    })
  })
})
