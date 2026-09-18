/**
 * @fileoverview Tests for install.helpers.ts functions
 * @module @skillsmith/mcp-server/tests/unit/install-helpers
 *
 * SMI-1721: Comprehensive tests to improve coverage from 36% to 80%+
 *
 * Registry-lookup + GitHub-fetch coverage split out to
 * install-helpers.registry.test.ts (SMI-5582) to stay under the
 * 500-line/file cap.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import { existsSync, mkdirSync, rmSync } from 'fs'
import {
  parseSkillId,
  parseRepoUrl,
  validateSkillMd,
  generateTips,
  loadManifest,
  saveManifest,
  updateManifestSafely,
  assertNotEncrypted,
} from '../../src/tools/install.helpers.js'
import { MANIFEST_PATH, SKILLSMITH_DIR } from '../../src/tools/install.types.js'

// Mock fs module. SMI-6735: `updateManifestSafely()` now locks via
// `withFileLock` (`@skillsmith/core`'s owned-lock primitive), which takes a
// REAL cross-process lock through synchronous `node:fs` — independent of
// this mock, which only replaces `fs/promises`. See the `updateManifestSafely`
// describe block below for how that's accounted for.
vi.mock('fs/promises')

describe('install.helpers', () => {
  describe('parseSkillId', () => {
    it('parses full GitHub URL', () => {
      const result = parseSkillId('https://github.com/owner/repo')
      expect(result).toEqual({
        owner: 'owner',
        repo: 'repo',
        path: '',
        isRegistryId: false,
      })
    })

    it('parses GitHub URL with path', () => {
      const result = parseSkillId('https://github.com/owner/repo/tree/main/skills/my-skill')
      expect(result).toEqual({
        owner: 'owner',
        repo: 'repo',
        path: 'tree/main/skills/my-skill',
        isRegistryId: false,
      })
    })

    it('parses 2-part registry ID', () => {
      const result = parseSkillId('author/skill-name')
      expect(result).toEqual({
        owner: 'author',
        repo: 'skill-name',
        path: '',
        isRegistryId: true,
      })
    })

    it('parses 3-part direct reference', () => {
      const result = parseSkillId('owner/repo/skills/my-skill')
      expect(result).toEqual({
        owner: 'owner',
        repo: 'repo',
        path: 'skills/my-skill',
        isRegistryId: false,
      })
    })

    it('throws for invalid format', () => {
      expect(() => parseSkillId('invalid')).toThrow('Invalid skill ID format')
    })

    // SMI-2722: UUID skill IDs returned by the search tool must be accepted
    it('returns isRegistryId: true for UUID skill IDs', () => {
      const result = parseSkillId('a129e127-a82c-47e5-8bc5-09d7ba2e8734')
      expect(result).toEqual({
        owner: '',
        repo: '',
        path: '',
        isRegistryId: true,
      })
    })

    it('accepts UUID regardless of hex case', () => {
      const result = parseSkillId('A129E127-A82C-47E5-8BC5-09D7BA2E8734')
      expect(result).toEqual({
        owner: '',
        repo: '',
        path: '',
        isRegistryId: true,
      })
    })

    it('does not match partial UUID-like strings as registry IDs', () => {
      // Short hyphenated strings (e.g., slug-based IDs) must not be confused with UUIDs
      // UUID regex requires exact 8-4-4-4-12 hex structure
      expect(() => parseSkillId('abc-def-ghi')).toThrow('Invalid skill ID format')
    })
  })

  describe('parseRepoUrl', () => {
    it('parses simple GitHub URL', () => {
      const result = parseRepoUrl('https://github.com/owner/repo')
      expect(result).toEqual({
        owner: 'owner',
        repo: 'repo',
        path: '',
        branch: 'main',
      })
    })

    it('parses GitHub URL with tree path', () => {
      const result = parseRepoUrl('https://github.com/owner/repo/tree/develop/src/skills')
      expect(result).toEqual({
        owner: 'owner',
        repo: 'repo',
        path: 'src/skills',
        branch: 'develop',
      })
    })

    it('parses GitHub URL with blob path', () => {
      const result = parseRepoUrl('https://github.com/owner/repo/blob/feature/path/file.md')
      expect(result).toEqual({
        owner: 'owner',
        repo: 'repo',
        path: 'path/file.md',
        branch: 'feature',
      })
    })

    it('rejects non-GitHub hosts', () => {
      expect(() => parseRepoUrl('https://gitlab.com/owner/repo')).toThrow('Invalid repository host')
    })

    it('rejects malicious hosts', () => {
      expect(() => parseRepoUrl('https://evil.com/owner/repo')).toThrow('Invalid repository host')
    })

    it('accepts www.github.com', () => {
      const result = parseRepoUrl('https://www.github.com/owner/repo')
      expect(result.owner).toBe('owner')
      expect(result.repo).toBe('repo')
    })
  })

  describe('validateSkillMd', () => {
    it('validates valid SKILL.md', () => {
      const content = `# My Skill

This is a skill that does something useful. It has enough content to pass validation.

## Usage
Use this skill to do things.
`
      const result = validateSkillMd(content)
      expect(result.valid).toBe(true)
      expect(result.errors).toEqual([])
    })

    it('rejects missing title', () => {
      const content =
        'This is content without a heading. It is long enough but has no title marker.'
      const result = validateSkillMd(content)
      expect(result.valid).toBe(false)
      expect(result.errors).toContain('Missing title (# heading)')
    })

    it('rejects too short content', () => {
      const content = '# Title\n\nToo short.'
      const result = validateSkillMd(content)
      expect(result.valid).toBe(false)
      expect(result.errors).toContain('SKILL.md is too short (minimum 100 characters)')
    })

    it('collects multiple errors', () => {
      const content = 'No title, too short'
      const result = validateSkillMd(content)
      expect(result.valid).toBe(false)
      expect(result.errors.length).toBe(2)
    })
  })

  describe('generateTips', () => {
    it('generates tips with skill name', () => {
      const tips = generateTips('my-skill')
      expect(tips).toHaveLength(4)
      expect(tips[0]).toContain('my-skill')
      expect(tips[0]).toContain('installed successfully')
    })

    it('includes usage instructions', () => {
      const tips = generateTips('test-skill')
      expect(tips.some((t) => t.includes('Use the test-skill skill'))).toBe(true)
    })

    it('includes ls command', () => {
      const tips = generateTips('any-skill')
      expect(tips.some((t) => t.includes('ls ~/.claude/skills/'))).toBe(true)
    })

    it('includes uninstall hint', () => {
      const tips = generateTips('any-skill')
      expect(tips.some((t) => t.includes('uninstall_skill'))).toBe(true)
    })
  })

  // ============================================================================
  // SMI-1721: New tests for async/file system functions
  // ============================================================================

  // SMI-6735: `acquireManifestLock()`/`releaseManifestLock()` were removed —
  // locking moved onto the shared `withFileLock` (owned-lock) primitive,
  // which no longer has an age-based EEXIST/mtime retry protocol for this
  // suite's `fs/promises` mocks to drive (`fs.writeFile` with `{flag:'wx'}`,
  // `fs.stat().mtimeMs` staleness, `fs.unlink` on reclaim). That mechanism's
  // own EEXIST-retry, dead-holder-reclaim, and non-retryable-error-propagation
  // behavior is now exercised directly, against the REAL synchronous
  // `node:fs` calls it actually makes, by `owned-lock.test.ts`'s own suite
  // (e.g. its items 2, 6, 7, and 14 cover contended-lock timeout, dead-owner
  // reclaim, live-owner refusal, and a non-EEXIST creation failure failing
  // closed with no lock file left behind) — so this is a coverage
  // *relocation*, not a loss. What genuinely cannot be reproduced here is the
  // exact former scenario of "a `fs/promises.writeFile` call for the lock
  // file rejects with EACCES": the new lock file is created via synchronous
  // `node:fs` (`openSync`/`linkSync`) internal to `@skillsmith/core`, which
  // this file's `vi.mock('fs/promises')` cannot see or drive. The
  // `updateManifestSafely` block below is rewritten to account for
  // `withFileLock` taking a REAL lock outside this mock.

  describe('loadManifest', () => {
    const mockReadFile = vi.mocked(fs.readFile)

    beforeEach(() => {
      vi.clearAllMocks()
    })

    it('loads existing manifest', async () => {
      const manifest = {
        version: '1.0.0',
        installedSkills: {
          'test/skill': {
            id: 'test/skill',
            name: 'test-skill',
            version: '1.0.0',
            source: 'github',
            installPath: '/path/to/skill',
            installedAt: '2024-01-01',
            lastUpdated: '2024-01-01',
          },
        },
      }

      mockReadFile.mockResolvedValueOnce(JSON.stringify(manifest))

      const result = await loadManifest()
      expect(result).toEqual(manifest)
    })

    it('returns empty manifest when file does not exist', async () => {
      mockReadFile.mockRejectedValueOnce(new Error('ENOENT'))

      const result = await loadManifest()
      expect(result).toEqual({
        version: '1.0.0',
        installedSkills: {},
      })
    })

    it('returns empty manifest on parse error', async () => {
      mockReadFile.mockResolvedValueOnce('invalid json {{{')

      const result = await loadManifest()
      expect(result).toEqual({
        version: '1.0.0',
        installedSkills: {},
      })
    })
  })

  describe('saveManifest', () => {
    const mockMkdir = vi.mocked(fs.mkdir)
    const mockWriteFile = vi.mocked(fs.writeFile)
    const mockRename = vi.mocked(fs.rename)

    beforeEach(() => {
      vi.clearAllMocks()
    })

    it('saves manifest with atomic write', async () => {
      mockMkdir.mockResolvedValueOnce(undefined)
      mockWriteFile.mockResolvedValueOnce(undefined)
      mockRename.mockResolvedValueOnce(undefined)

      const manifest = {
        version: '1.0.0',
        installedSkills: {},
      }

      await saveManifest(manifest)

      expect(mockMkdir).toHaveBeenCalledWith(expect.any(String), { recursive: true })
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('.tmp.'),
        JSON.stringify(manifest, null, 2)
      )
      expect(mockRename).toHaveBeenCalled()
    })
  })

  describe('updateManifestSafely', () => {
    const mockReadFile = vi.mocked(fs.readFile)
    const mockMkdir = vi.mocked(fs.mkdir)
    const mockWriteFile = vi.mocked(fs.writeFile)
    const mockRename = vi.mocked(fs.rename)

    beforeEach(() => {
      vi.clearAllMocks()
      // SMI-6735: withFileLock takes a REAL cross-process lock through
      // synchronous node:fs, independent of this file's `fs/promises` mock —
      // the sandboxed $HOME directory the lock file lives under must
      // physically exist on disk (this file's mocked fs.mkdir is a no-op and
      // never creates it for real).
      mkdirSync(SKILLSMITH_DIR, { recursive: true })
    })

    afterEach(() => {
      rmSync(MANIFEST_PATH + '.lock', { force: true })
    })

    it('acquires lock, updates, and releases lock', async () => {
      // Mock load
      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({
          version: '1.0.0',
          installedSkills: {},
        })
      )
      // Mock save
      mockMkdir.mockResolvedValueOnce(undefined)
      mockWriteFile.mockResolvedValueOnce(undefined)
      mockRename.mockResolvedValueOnce(undefined)

      const updateFn = vi.fn((m) => ({
        ...m,
        installedSkills: { 'new/skill': { id: 'new/skill' } },
      }))

      await updateManifestSafely(updateFn)

      expect(updateFn).toHaveBeenCalled()
      // Lock released: withFileLock's release unlinks the REAL owned-lock
      // file it created — a mocked fs/promises.unlink can't observe this,
      // since that lock lives outside this file's mock (see beforeEach).
      expect(existsSync(MANIFEST_PATH + '.lock')).toBe(false)
    })

    it('releases lock after loadManifest recovers a read failure into an empty manifest (does NOT exercise the release-on-throw path)', async () => {
      // Mock load - throw error
      mockReadFile.mockRejectedValueOnce(new Error('Read error'))
      // loadManifest's own catch-all (install.helpers.manifest.ts) turns
      // ANY readFile rejection into an empty manifest rather than
      // propagating it, so `updateFn` below is called normally and save()
      // still runs — this test never reaches withFileLock's `finally`
      // release with an in-flight exception. That contract (release on an
      // actual throw from inside the locked callback) has its own dedicated
      // coverage: packages/core/src/config/file-lock.test.ts (SMI-6735
      // adversarial-review finding 2b) — this test was previously titled
      // "releases lock even on error" and read as if it covered that case;
      // it does not.
      mockMkdir.mockResolvedValueOnce(undefined)
      mockWriteFile.mockResolvedValueOnce(undefined)
      mockRename.mockResolvedValueOnce(undefined)

      const updateFn = vi.fn((m) => m)

      await expect(updateManifestSafely(updateFn)).resolves.toBeUndefined()
      expect(updateFn).toHaveBeenCalled()
      expect(existsSync(MANIFEST_PATH + '.lock')).toBe(false)
    })
  })

  // ==========================================================================
  // SMI-3221: git-crypt encrypted content detection
  // ==========================================================================

  describe('assertNotEncrypted', () => {
    it('does not throw for normal markdown content', () => {
      expect(() => assertNotEncrypted('# My Skill\n\nThis is a skill.', 'SKILL.md')).not.toThrow()
    })

    it('does not throw for empty content', () => {
      expect(() => assertNotEncrypted('', 'SKILL.md')).not.toThrow()
    })

    it('throws for git-crypt encrypted content', () => {
      // git-crypt magic header: \x00GITCRYPT followed by encrypted bytes
      const encrypted = '\x00GITCRYPT\x00\x12\x34\x56'
      expect(() => assertNotEncrypted(encrypted, 'SKILL.md')).toThrow('git-crypt encrypted')
    })

    it('includes file path in error message', () => {
      const encrypted = '\x00GITCRYPT\x00'
      expect(() => assertNotEncrypted(encrypted, '.claude/skills/my-skill/SKILL.md')).toThrow(
        '.claude/skills/my-skill/SKILL.md'
      )
    })

    it('includes cp -r workaround in error message', () => {
      const encrypted = '\x00GITCRYPT\x00'
      expect(() => assertNotEncrypted(encrypted, 'SKILL.md')).toThrow('cp -r')
    })
  })
})
