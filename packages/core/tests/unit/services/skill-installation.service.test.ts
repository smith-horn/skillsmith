/**
 * SMI-3483: SkillInstallationService Unit Tests
 *
 * Tests for the extracted install/uninstall service in @skillsmith/core.
 * Uses in-memory databases and mocked GitHub fetches.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { SkillInstallationService } from '../../../src/services/skill-installation.service.js'
import { SkillRepository } from '../../../src/repositories/SkillRepository.js'
import { SkillDependencyRepository } from '../../../src/repositories/SkillDependencyRepository.js'
import { createTestDatabase } from '../../helpers/database.js'
import type { Database } from '../../../src/db/database-interface.js'
import type { TrustTier } from '../../../src/types/skill.js'
import type {
  RegistryLookup,
  ProgressCallback,
} from '../../../src/services/skill-installation.types.js'

// ============================================================================
// Test Fixtures
// ============================================================================

const VALID_SKILL_MD = `---
name: test-skill
description: A test skill for unit testing
---

# Test Skill

This is a valid skill file with enough content to pass the 100-character minimum
validation threshold that the service checks during installation.

## Usage

Use this skill by saying "Use the test-skill skill to..."
`

const SHORT_SKILL_MD = '# Short\nToo short.'

// ============================================================================
// Test Helpers
// ============================================================================

let tmpDir: string
let skillsDir: string
let manifestPath: string

async function createTmpDirs(): Promise<void> {
  tmpDir = path.join(
    os.tmpdir(),
    'skillsmith-test-' + Date.now() + '-' + Math.random().toString(36).slice(2)
  )
  skillsDir = path.join(tmpDir, 'skills')
  manifestPath = path.join(tmpDir, 'manifest.json')
  await fs.mkdir(skillsDir, { recursive: true })
}

async function cleanupTmpDirs(): Promise<void> {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
}

function createMockRegistryLookup(
  skills: Record<
    string,
    {
      repoUrl: string
      name: string
      quarantined?: boolean
      trustTier?: TrustTier
      contentHash?: string
    }
  >
): RegistryLookup {
  return {
    async lookup(skillId: string) {
      const entry = skills[skillId]
      if (!entry) return null
      return {
        repoUrl: entry.repoUrl,
        name: entry.name,
        trustTier: entry.trustTier ?? ('community' as const),
        quarantined: entry.quarantined,
        contentHash: entry.contentHash,
      }
    },
  }
}

function createService(
  db: Database,
  overrides: Partial<ConstructorParameters<typeof SkillInstallationService>[0]> = {}
): SkillInstallationService {
  const skillRepo = new SkillRepository(db)
  const skillDependencyRepo = new SkillDependencyRepository(db)

  return new SkillInstallationService({
    db,
    skillRepo,
    skillDependencyRepo,
    skillsDir,
    manifestPath,
    ...overrides,
  })
}

// ============================================================================
// Tests
// ============================================================================

describe('SMI-3483: SkillInstallationService', () => {
  let db: Database

  beforeEach(async () => {
    db = createTestDatabase()
    await createTmpDirs()
  })

  afterEach(async () => {
    db.close()
    await cleanupTmpDirs()
    vi.restoreAllMocks()
  })

  // ==========================================================================
  // Install — Input Parsing
  // ==========================================================================

  describe('install — input parsing', () => {
    it('should reject invalid skill ID format', async () => {
      const service = createService(db)

      const result = await service.install('just-a-name')

      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid skill ID format')
    })

    it('should require registry lookup for 2-part IDs', async () => {
      // No registryLookup provided
      const service = createService(db)

      const result = await service.install('author/skill-name')

      expect(result.success).toBe(false)
      expect(result.error).toContain('Registry lookup not available')
    })

    it('should return not-found for registry ID with no match', async () => {
      const service = createService(db, {
        registryLookup: createMockRegistryLookup({}),
      })

      const result = await service.install('author/nonexistent')

      expect(result.success).toBe(false)
      expect(result.error).toContain('indexed for discovery only')
    })

    it('should block quarantined skills from registry', async () => {
      const service = createService(db, {
        registryLookup: createMockRegistryLookup({
          'author/bad-skill': {
            repoUrl: 'https://github.com/author/bad-skill',
            name: 'bad-skill',
            quarantined: true,
          },
        }),
      })

      const result = await service.install('author/bad-skill')

      expect(result.success).toBe(false)
      expect(result.error).toContain('quarantined')
    })

    it('should accept UUID skill IDs as registry lookups', async () => {
      const service = createService(db, {
        registryLookup: createMockRegistryLookup({}),
      })

      const result = await service.install('a129e127-a82c-47e5-8bc5-09d7ba2e8734')

      expect(result.success).toBe(false)
      // UUID routes through registry lookup which returns null
      expect(result.error).toContain('indexed for discovery only')
    })
  })

  // ==========================================================================
  // Install — GitHub Fetch (mocked)
  // ==========================================================================

  describe('install — fetch and validate', () => {
    beforeEach(() => {
      // Mock global fetch for GitHub raw content
      vi.stubGlobal('fetch', vi.fn())
    })

    it('should install a skill from a direct GitHub URL', async () => {
      const mockFetch = vi.mocked(fetch)
      mockFetch.mockImplementation(async (url) => {
        const urlStr = typeof url === 'string' ? url : url.toString()
        if (urlStr.includes('SKILL.md')) {
          return new Response(VALID_SKILL_MD, { status: 200 })
        }
        // Optional files return 404
        return new Response('Not found', { status: 404 })
      })

      const service = createService(db)
      const result = await service.install('https://github.com/test-owner/test-repo')

      expect(result.success).toBe(true)
      expect(result.skillId).toBe('https://github.com/test-owner/test-repo')
      expect(result.installPath).toContain('test-repo')

      // Verify SKILL.md was written
      const skillMdPath = path.join(skillsDir, 'test-repo', 'SKILL.md')
      const content = await fs.readFile(skillMdPath, 'utf-8')
      expect(content).toContain('test-skill')
    })

    it('should return error when SKILL.md not found', async () => {
      const mockFetch = vi.mocked(fetch)
      mockFetch.mockResolvedValue(new Response('Not found', { status: 404 }))

      const service = createService(db)
      const result = await service.install('https://github.com/owner/repo')

      expect(result.success).toBe(false)
      expect(result.error).toContain('Could not find SKILL.md')
    })

    it('should reject SKILL.md that is too short', async () => {
      const mockFetch = vi.mocked(fetch)
      mockFetch.mockImplementation(async (url) => {
        const urlStr = typeof url === 'string' ? url : url.toString()
        if (urlStr.includes('SKILL.md')) {
          return new Response(SHORT_SKILL_MD, { status: 200 })
        }
        return new Response('Not found', { status: 404 })
      })

      const service = createService(db)
      const result = await service.install('https://github.com/owner/repo')

      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid SKILL.md')
      expect(result.error).toContain('too short')
    })

    it('should prevent reinstall without force flag', async () => {
      const mockFetch = vi.mocked(fetch)
      mockFetch.mockImplementation(async (url) => {
        const urlStr = typeof url === 'string' ? url : url.toString()
        if (urlStr.includes('SKILL.md')) {
          return new Response(VALID_SKILL_MD, { status: 200 })
        }
        return new Response('Not found', { status: 404 })
      })

      const service = createService(db)

      // First install
      const first = await service.install('https://github.com/owner/test-repo')
      expect(first.success).toBe(true)

      // Second install without force
      const second = await service.install('https://github.com/owner/test-repo')
      expect(second.success).toBe(false)
      expect(second.error).toContain('already installed')
    })

    it('should allow reinstall with force flag', async () => {
      const mockFetch = vi.mocked(fetch)
      mockFetch.mockImplementation(async (url) => {
        const urlStr = typeof url === 'string' ? url : url.toString()
        if (urlStr.includes('SKILL.md')) {
          return new Response(VALID_SKILL_MD, { status: 200 })
        }
        return new Response('Not found', { status: 404 })
      })

      const service = createService(db)

      const first = await service.install('https://github.com/owner/test-repo')
      expect(first.success).toBe(true)

      const second = await service.install('https://github.com/owner/test-repo', { force: true })
      expect(second.success).toBe(true)
    })

    it('should skip security scan when skipScan is true (trusted tier)', async () => {
      // GAP-06: skipScan is now tier-restricted — use a verified-tier registry skill
      const mockFetch = vi.mocked(fetch)
      mockFetch.mockImplementation(async (url) => {
        const urlStr = typeof url === 'string' ? url : url.toString()
        if (urlStr.includes('SKILL.md')) {
          return new Response(VALID_SKILL_MD, { status: 200 })
        }
        return new Response('Not found', { status: 404 })
      })

      const service = createService(db, {
        registryLookup: createMockRegistryLookup({
          'author/skip-scan-skill': {
            repoUrl: 'https://github.com/author/skip-scan-skill',
            name: 'skip-scan-skill',
            trustTier: 'verified',
          },
        }),
      })
      const result = await service.install('author/skip-scan-skill', { skipScan: true })

      expect(result.success).toBe(true)
      expect(result.securityReport).toBeUndefined()
    })

    it('should include security report on successful install', async () => {
      const mockFetch = vi.mocked(fetch)
      mockFetch.mockImplementation(async (url) => {
        const urlStr = typeof url === 'string' ? url : url.toString()
        if (urlStr.includes('SKILL.md')) {
          return new Response(VALID_SKILL_MD, { status: 200 })
        }
        return new Response('Not found', { status: 404 })
      })

      const service = createService(db)
      const result = await service.install('https://github.com/owner/repo')

      expect(result.success).toBe(true)
      expect(result.securityReport).toBeDefined()
      expect(result.securityReport!.passed).toBe(true)
    })
  })

  // ==========================================================================
  // Install — Progress Callback
  // ==========================================================================

  describe('install — progress callback', () => {
    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn())
    })

    it('should invoke onProgress at each stage', async () => {
      const mockFetch = vi.mocked(fetch)
      mockFetch.mockImplementation(async (url) => {
        const urlStr = typeof url === 'string' ? url : url.toString()
        if (urlStr.includes('SKILL.md')) {
          return new Response(VALID_SKILL_MD, { status: 200 })
        }
        return new Response('Not found', { status: 404 })
      })

      const stages: string[] = []
      const onProgress: ProgressCallback = (stage) => stages.push(stage)

      const service = createService(db, { onProgress })
      await service.install('https://github.com/owner/repo', { skipOptimize: true })

      expect(stages).toContain('parse')
      expect(stages).toContain('fetch')
      expect(stages).toContain('validate')
      expect(stages).toContain('write')
      expect(stages).toContain('manifest')
      expect(stages).toContain('done')
    })
  })

  // ==========================================================================
  // Install — Manifest
  // ==========================================================================

  describe('install — manifest tracking', () => {
    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn())
    })

    it('should write manifest entry after install', async () => {
      const mockFetch = vi.mocked(fetch)
      mockFetch.mockImplementation(async (url) => {
        const urlStr = typeof url === 'string' ? url : url.toString()
        if (urlStr.includes('SKILL.md')) {
          return new Response(VALID_SKILL_MD, { status: 200 })
        }
        return new Response('Not found', { status: 404 })
      })

      const service = createService(db)
      await service.install('https://github.com/owner/test-repo', { skipOptimize: true })

      const manifestContent = await fs.readFile(manifestPath, 'utf-8')
      const manifest = JSON.parse(manifestContent)

      expect(manifest.installedSkills['test-repo']).toBeDefined()
      expect(manifest.installedSkills['test-repo'].id).toBe('https://github.com/owner/test-repo')
      expect(manifest.installedSkills['test-repo'].source).toBe('github:owner/test-repo')
    })
  })

  // ==========================================================================
  // Uninstall
  // ==========================================================================

  describe('uninstall', () => {
    it('should return not-installed for nonexistent skill', async () => {
      const service = createService(db)

      const result = await service.uninstall('nonexistent')

      expect(result.success).toBe(false)
      expect(result.message).toContain('not installed')
    })

    it('should detect orphan skill on disk without manifest', async () => {
      // Create skill directory without manifest
      const orphanDir = path.join(skillsDir, 'orphan-skill')
      await fs.mkdir(orphanDir, { recursive: true })
      await fs.writeFile(path.join(orphanDir, 'SKILL.md'), '# Orphan')

      const service = createService(db)

      // Without force, should warn
      const result = await service.uninstall('orphan-skill')
      expect(result.success).toBe(false)
      expect(result.message).toContain('not in manifest')

      // With force, should remove
      const forceResult = await service.uninstall('orphan-skill', { force: true })
      expect(forceResult.success).toBe(true)
      expect(forceResult.warning).toContain('not in the manifest')
    })
  })
})
