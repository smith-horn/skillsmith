/**
 * @fileoverview Unit tests for the shared API-first / local-fallback skill
 *   resolver extracted for SMI-5896 (Wave 3, discovery-tool consistency).
 * @module @skillsmith/core/services/skill-resolution.test
 * @see SMI-5896 Wave 3 Step 1: `get_skill` and `skill_compare` both call
 *   `resolveSkillApiFirst` now — these tests exercise the resolver in
 *   isolation (no MCP tool wiring) with lightweight fakes for the API
 *   client and local repository surfaces it actually uses.
 */
import { describe, expect, it, vi } from 'vitest'

import { resolveSkillApiFirst } from './skill-resolution.js'
import { SkillsmithError } from '../errors.js'
// SMI-5896: ApiSearchResult must come from './client.js' — see the comment
// in skill-resolution.ts for why './types.js' is a different, incompatible
// type of the same name.
import type { SkillsmithApiClient, ApiSearchResult } from '../api/client.js'
import type { SkillRepository } from '../repositories/SkillRepository.js'
import type { Skill } from '../types/skill.js'

function makeApiSkill(overrides: Partial<ApiSearchResult> = {}): ApiSearchResult {
  return {
    id: 'anthropic/commit',
    name: 'commit',
    description: 'Generate semantic commit messages',
    author: 'anthropic',
    repo_url: 'https://github.com/anthropics/commit',
    quality_score: 0.9,
    trust_tier: 'verified',
    tags: ['git'],
    stars: 10,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeDbSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: 'local/only',
    name: 'only',
    description: 'A local-only skill',
    author: 'local',
    repoUrl: null,
    qualityScore: 0.5,
    trustTier: 'local',
    tags: [],
    installable: false,
    riskScore: null,
    securityFindingsCount: 0,
    securityScannedAt: null,
    securityPassed: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

/** Minimal fake covering only the surface resolveSkillApiFirst calls. */
function makeApiClient(opts: {
  offline?: boolean
  getSkill?: (id: string) => Promise<{ data: ApiSearchResult }>
}): SkillsmithApiClient {
  return {
    isOffline: () => opts.offline ?? false,
    getSkill: opts.getSkill ?? vi.fn(),
  } as unknown as SkillsmithApiClient
}

/** Minimal fake covering only the surface resolveSkillApiFirst calls. */
function makeSkillRepository(findById: (id: string) => Skill | null): SkillRepository {
  return { findById } as unknown as SkillRepository
}

describe('resolveSkillApiFirst (SMI-5896 Wave 3 Step 1)', () => {
  it('resolves via the API when online and the API has the skill', async () => {
    const apiSkill = makeApiSkill()
    const apiClient = makeApiClient({
      offline: false,
      getSkill: vi.fn().mockResolvedValue({ data: apiSkill }),
    })
    const skillRepository = makeSkillRepository(() => null)

    const result = await resolveSkillApiFirst('anthropic/commit', apiClient, skillRepository)

    expect(result).toEqual({ source: 'api', apiSkill })
  })

  it('passes includeContent through to apiClient.getSkill', async () => {
    const getSkill = vi.fn().mockResolvedValue({ data: makeApiSkill() })
    const apiClient = makeApiClient({ offline: false, getSkill })
    const skillRepository = makeSkillRepository(() => null)

    await resolveSkillApiFirst('anthropic/commit', apiClient, skillRepository, {
      includeContent: true,
    })

    expect(getSkill).toHaveBeenCalledWith('anthropic/commit', { includeContent: true })
  })

  it('defaults includeContent to false when options are omitted', async () => {
    const getSkill = vi.fn().mockResolvedValue({ data: makeApiSkill() })
    const apiClient = makeApiClient({ offline: false, getSkill })
    const skillRepository = makeSkillRepository(() => null)

    await resolveSkillApiFirst('anthropic/commit', apiClient, skillRepository)

    expect(getSkill).toHaveBeenCalledWith('anthropic/commit', { includeContent: false })
  })

  it('falls back to the local DB when the API client is offline', async () => {
    const dbSkill = makeDbSkill({ id: 'local/only' })
    const getSkill = vi.fn()
    const apiClient = makeApiClient({ offline: true, getSkill })
    const skillRepository = makeSkillRepository((id) => (id === 'local/only' ? dbSkill : null))

    const result = await resolveSkillApiFirst('local/only', apiClient, skillRepository)

    expect(result).toEqual({ source: 'local', dbSkill })
    // SMI-1183: never spend a network round trip when isOffline() is true.
    expect(getSkill).not.toHaveBeenCalled()
  })

  it('falls back to the local DB when the API call throws (network error, 404, etc)', async () => {
    const dbSkill = makeDbSkill({ id: 'anthropic/commit' })
    const apiClient = makeApiClient({
      offline: false,
      getSkill: vi.fn().mockRejectedValue(new Error('404 not found')),
    })
    const skillRepository = makeSkillRepository((id) =>
      id === 'anthropic/commit' ? dbSkill : null
    )

    const result = await resolveSkillApiFirst('anthropic/commit', apiClient, skillRepository)

    expect(result).toEqual({ source: 'local', dbSkill })
  })

  it('throws a normalized SKILL_NOT_FOUND error when neither source has the skill', async () => {
    const apiClient = makeApiClient({
      offline: false,
      getSkill: vi.fn().mockRejectedValue(new Error('404 not found')),
    })
    const skillRepository = makeSkillRepository(() => null)

    await expect(
      resolveSkillApiFirst('nobody/nothing', apiClient, skillRepository)
    ).rejects.toThrow(SkillsmithError)

    await expect(
      resolveSkillApiFirst('nobody/nothing', apiClient, skillRepository)
    ).rejects.toMatchObject({
      details: { id: 'nobody/nothing' },
    })
  })

  it('throws the same normalized error shape whether offline or online-but-404', async () => {
    const skillRepository = makeSkillRepository(() => null)

    const offlineClient = makeApiClient({ offline: true })
    const onlineFailClient = makeApiClient({
      offline: false,
      getSkill: vi.fn().mockRejectedValue(new Error('404')),
    })

    let offlineMessage = ''
    let onlineMessage = ''
    try {
      await resolveSkillApiFirst('x/y', offlineClient, skillRepository)
    } catch (error) {
      offlineMessage = (error as Error).message
    }
    try {
      await resolveSkillApiFirst('x/y', onlineFailClient, skillRepository)
    } catch (error) {
      onlineMessage = (error as Error).message
    }

    expect(offlineMessage).toBe(onlineMessage)
    expect(offlineMessage).toContain('x/y')
  })
})
