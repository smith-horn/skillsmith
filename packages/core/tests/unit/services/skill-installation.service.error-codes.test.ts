/**
 * SMI-4795: errorCode taxonomy on install failures
 *
 * Each failing return path inside install() must populate `errorCode` with
 * a code from InstallErrorCode. Telemetry (emitInstallEvent) reads this
 * field; without it the install funnel cannot classify failures.
 *
 * Split out of skill-installation.service.test.ts (CLAUDE.md's 500-line
 * file cap) after SMI-5894 Wave 1 added its own multi-client suite there —
 * this block predates that change and is unrelated to it, but moving it
 * out (rather than the newly-added block alone) was the smallest change
 * that got the original file back under the cap.
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
import type { RegistryLookup } from '../../../src/services/skill-installation.types.js'

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

describe('SMI-4795: install failures populate errorCode', () => {
  let db: Database

  beforeEach(async () => {
    db = await createTestDatabase()
    await createTmpDirs()
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(async () => {
    db.close()
    await cleanupTmpDirs()
    vi.restoreAllMocks()
  })

  it('REGISTRY_LOOKUP_UNAVAILABLE when registry id supplied without lookup adapter', async () => {
    const service = createService(db) // no registryLookup
    const result = await service.install('author/some-skill')

    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('REGISTRY_LOOKUP_UNAVAILABLE')
  })

  it('REGISTRY_SKILL_NOT_FOUND when registry returns null', async () => {
    const service = createService(db, {
      registryLookup: createMockRegistryLookup({}), // empty registry
    })
    const result = await service.install('author/missing-skill')

    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('REGISTRY_SKILL_NOT_FOUND')
  })

  it('QUARANTINED when registry flags the skill', async () => {
    const service = createService(db, {
      registryLookup: createMockRegistryLookup({
        'author/quarantined-skill': {
          repoUrl: 'https://github.com/author/quarantined-skill',
          name: 'quarantined-skill',
          quarantined: true,
          trustTier: 'community',
        },
      }),
    })
    const result = await service.install('author/quarantined-skill')

    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('QUARANTINED')
    expect(result.trustTier).toBe('community')
  })

  it('FETCH_FAILED when SKILL.md is unreachable', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch.mockResolvedValue(new Response('Not found', { status: 404 }))

    const service = createService(db)
    const result = await service.install('https://github.com/owner/missing-repo')

    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('FETCH_FAILED')
  })

  it('VALIDATION_FAILED when SKILL.md is malformed/short', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch.mockImplementation(async (url) => {
      const urlStr = typeof url === 'string' ? url : url.toString()
      if (urlStr.includes('SKILL.md')) {
        return new Response(SHORT_SKILL_MD, { status: 200 })
      }
      return new Response('Not found', { status: 404 })
    })

    const service = createService(db)
    const result = await service.install('https://github.com/owner/short-repo')

    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('VALIDATION_FAILED')
  })

  it('ALREADY_INSTALLED on repeat install without force', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch.mockImplementation(async (url) => {
      const urlStr = typeof url === 'string' ? url : url.toString()
      if (urlStr.includes('SKILL.md')) {
        return new Response(VALID_SKILL_MD, { status: 200 })
      }
      return new Response('Not found', { status: 404 })
    })

    const service = createService(db)
    const first = await service.install('https://github.com/owner/dup-repo')
    expect(first.success).toBe(true)

    const second = await service.install('https://github.com/owner/dup-repo')
    expect(second.success).toBe(false)
    expect(second.errorCode).toBe('ALREADY_INSTALLED')
  })

  it('SKIP_SCAN_FORBIDDEN when skipScan requested on unknown tier', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch.mockImplementation(async (url) => {
      const urlStr = typeof url === 'string' ? url : url.toString()
      if (urlStr.includes('SKILL.md')) {
        return new Response(VALID_SKILL_MD, { status: 200 })
      }
      return new Response('Not found', { status: 404 })
    })

    // Direct GitHub URL → trust tier defaults to 'unknown', skipScan disallowed
    const service = createService(db)
    const result = await service.install('https://github.com/owner/skip-repo', {
      skipScan: true,
    })

    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('SKIP_SCAN_FORBIDDEN')
    expect(result.trustTier).toBe('unknown')
  })

  it('successful install does NOT carry errorCode', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch.mockImplementation(async (url) => {
      const urlStr = typeof url === 'string' ? url : url.toString()
      if (urlStr.includes('SKILL.md')) {
        return new Response(VALID_SKILL_MD, { status: 200 })
      }
      return new Response('Not found', { status: 404 })
    })

    const service = createService(db)
    const result = await service.install('https://github.com/owner/ok-repo')

    expect(result.success).toBe(true)
    expect(result.errorCode).toBeUndefined()
  })
})
