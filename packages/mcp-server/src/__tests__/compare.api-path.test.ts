/**
 * SMI-5896 Wave 3 Step 1: API-path tests for executeCompare.
 *
 * Before this wave, `skill_compare` only ever queried the local SQLite
 * cache (`skillRepository.findById()`), unlike `search`/`get_skill`, which
 * both already follow the "API first, local DB fallback" pattern (SMI-1183).
 * These tests exercise the `!context.apiClient.isOffline()` branch — now
 * wired through the same shared `resolveSkillApiFirst` resolver `get_skill`
 * uses — which the pre-existing compare.test.ts cannot reach (it seeds a
 * local SQLite context in offline mode).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { executeCompare } from '../tools/compare.js'
import { SkillsmithError } from '@skillsmith/core'
import { createTestContext, disposeTestContext, type ToolContext } from './test-utils.js'
import type { ApiSearchResult } from '@skillsmith/core'

let context: ToolContext | undefined

afterEach(async () => {
  if (context) {
    await disposeTestContext(context)
  }
  context = undefined
  vi.restoreAllMocks()
})

function apiFixture(overrides: Partial<ApiSearchResult> & { id: string }): ApiSearchResult {
  return {
    name: overrides.id.split('/').pop() ?? overrides.id,
    description: 'A registry skill',
    author: overrides.id.split('/')[0] ?? null,
    repo_url: `https://github.com/${overrides.id}`,
    quality_score: 0.8,
    trust_tier: 'community',
    tags: [],
    stars: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('executeCompare (API path, SMI-5896)', () => {
  it('resolves both skills via the API when neither exists in the local DB', async () => {
    context = await createTestContext()
    vi.spyOn(context.apiClient, 'isOffline').mockReturnValue(false)
    vi.spyOn(context.apiClient, 'getSkill').mockImplementation(async (id: string) => {
      if (id === 'anthropic/commit') {
        return { data: apiFixture({ id, quality_score: 0.95, trust_tier: 'verified' }) }
      }
      if (id === 'community/jest-helper') {
        return { data: apiFixture({ id, quality_score: 0.7, trust_tier: 'community' }) }
      }
      throw new Error(`[mock] Skill "${id}" not found`)
    })

    const result = await executeCompare(
      { skill_a: 'anthropic/commit', skill_b: 'community/jest-helper' },
      context
    )

    expect(result.comparison.a.name).toBe('commit')
    expect(result.comparison.b.name).toBe('jest-helper')
    expect(result.comparison.a.trust_tier).toBe('verified')
    expect(result.differences.length).toBeGreaterThan(0)
    expect(['a', 'b', 'tie']).toContain(result.winner)
  })

  it('resolves skill_a via the API and falls back to the local DB for skill_b', async () => {
    context = await createTestContext()
    context.skillRepository.create({
      id: 'local/only-skill',
      name: 'only-skill',
      description: 'Local-only skill absent from the registry',
      author: 'local',
      repoUrl: 'https://example.com/local/only-skill',
      qualityScore: 0.6,
      trustTier: 'local',
      tags: ['local'],
    })

    vi.spyOn(context.apiClient, 'isOffline').mockReturnValue(false)
    vi.spyOn(context.apiClient, 'getSkill').mockImplementation(async (id: string) => {
      if (id === 'anthropic/commit') {
        return { data: apiFixture({ id }) }
      }
      // SMI-5427: a real, searchable registry skill can be absent from the
      // local cache — but a genuinely local-only skill is absent from the
      // API too. resolveSkillApiFirst falls through to skillRepository here.
      throw new Error(`[mock] Skill "${id}" not found`)
    })

    const result = await executeCompare(
      { skill_a: 'anthropic/commit', skill_b: 'local/only-skill' },
      context
    )

    expect(result.comparison.a.name).toBe('commit')
    expect(result.comparison.b.name).toBe('only-skill')
  })

  it('reports SKILL_NOT_FOUND for skill_a when both API and local DB miss it', async () => {
    context = await createTestContext()
    vi.spyOn(context.apiClient, 'isOffline').mockReturnValue(false)
    vi.spyOn(context.apiClient, 'getSkill').mockRejectedValue(new Error('[mock] not found'))

    await expect(
      executeCompare({ skill_a: 'nobody/nothing', skill_b: 'also/nobody' }, context)
    ).rejects.toThrow(SkillsmithError)

    // SMI-5896: resolved sequentially (not Promise.all) so a not-found error
    // deterministically names skill_a first when both are missing — matching
    // this tool's pre-refactor behavior.
    await expect(
      executeCompare({ skill_a: 'nobody/nothing', skill_b: 'also/nobody' }, context)
    ).rejects.toMatchObject({
      details: { id: 'nobody/nothing' },
    })
  })
})
