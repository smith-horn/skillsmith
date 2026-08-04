/**
 * SMI-5896 Wave 3 Step 2: MCP `skill_recommend` empty-derived-stack guard.
 *
 * Before this fix, an empty derived stack (no installed_skills and no usable
 * project_context) reached the API call inside a `Promise.allSettled`, which
 * silently swallowed the resulting 400 into `console.warn` and returned
 * `candidates_considered: 0` with no explanation surfaced to the caller. The
 * fix detects the empty-stack case client-side first and returns the same
 * structured degraded result CLI `recommend`'s identical guard returns.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { executeRecommend } from '../tools/recommend.js'
import * as CoreModule from '@skillsmith/core'
import * as InstalledSkillsModule from '../utils/installed-skills.js'
import * as LocalSkillSearchModule from '../tools/LocalSkillSearch.js'
import { createTestContext, disposeTestContext, type ToolContext } from './test-utils.js'

let context: ToolContext

beforeEach(async () => {
  context = await createTestContext()
  // SMI-906 auto-detection reads the real ~/.claude/skills/ directory unless
  // mocked — stub it to [] so these tests hermetically hit the empty-stack
  // branch regardless of what's actually installed on the host/CI runner.
  vi.spyOn(InstalledSkillsModule, 'getInstalledSkills').mockResolvedValue([])
  // Local-skill search (only reached on the non-empty-stack path exercised
  // below) mocked to [] for hermeticity — mirrors recommend-online-path.test.ts.
  vi.spyOn(LocalSkillSearchModule, 'getLocalIndexer').mockReturnValue({
    index: vi.fn().mockResolvedValue([]),
    indexSync: vi.fn().mockReturnValue([]),
    search: vi.fn().mockReturnValue([]),
    clearCache: vi.fn(),
    getSkillsDir: vi.fn().mockReturnValue('/home/user/.claude/skills'),
    calculateQualityScore: vi.fn().mockReturnValue(0),
    indexSkillDir: vi.fn(),
  } as unknown as ReturnType<typeof LocalSkillSearchModule.getLocalIndexer>)
  // Force the online branch to be reachable so the assertions below (the
  // guard must short-circuit BEFORE any API call) are meaningful — with the
  // default offline test context, `getRecommendations` would never be
  // called anyway (guard or no guard), which would make the "not called"
  // assertions vacuous. `getRecommendations` itself defaults to a rejection
  // so an un-guarded regression fails fast instead of attempting a real
  // network call; the one test that legitimately reaches the API path
  // overrides this with its own `mockResolvedValue`.
  vi.spyOn(context.apiClient, 'isOffline').mockReturnValue(false)
  vi.spyOn(context.apiClient, 'getRecommendations').mockRejectedValue(
    new Error('[test] getRecommendations should not be called for an empty derived stack')
  )
})

afterEach(async () => {
  await disposeTestContext(context)
  vi.restoreAllMocks()
})

describe('executeRecommend — empty derived stack guard (SMI-5896)', () => {
  it('returns an empty-stack degraded result instead of hitting the API', async () => {
    const result = await executeRecommend({ installed_skills: [], limit: 5 }, context)

    expect(result.recommendations).toEqual([])
    expect(result.candidates_considered).toBe(0)
    expect(context.apiClient.getRecommendations).not.toHaveBeenCalled()
  })

  it('surfaces the shared empty-stack guidance under `suggestion`', async () => {
    const result = await executeRecommend({ installed_skills: [], limit: 5 }, context)

    expect(result.suggestion).toBe(
      'No technology stack could be derived for recommendations — this usually ' +
        'means a non-Node project, a stack with no production dependencies, or an ' +
        'unsupported language, not a backend or registry problem. Provide project ' +
        'context (a short description of the project or its tooling) or an ' +
        'explicit list of installed/currently-used skills, then try again.'
    )
  })

  it('reports discovery_only_hidden: 0 and role_filtered: 0 rather than omitting them', async () => {
    const result = await executeRecommend({ installed_skills: [], limit: 5 }, context)

    expect(result.discovery_only_hidden).toBe(0)
    expect(result.overlap_filtered).toBe(0)
    expect(result.role_filtered).toBe(0)
  })

  it('reflects auto_detected: true when installed_skills was omitted/empty', async () => {
    const result = await executeRecommend({ installed_skills: [], limit: 5 }, context)

    expect(result.context.auto_detected).toBe(true)
    expect(result.context.installed_count).toBe(0)
    expect(result.context.using_semantic_matching).toBe(false)
  })

  it('does not derive an empty stack when project_context supplies usable words', async () => {
    const apiSpy = vi
      .spyOn(context.apiClient, 'getRecommendations')
      .mockResolvedValue({ data: [], meta: { total: 0 } })

    const result = await executeRecommend(
      { installed_skills: [], project_context: 'react testing library', limit: 5 },
      context
    )

    // Non-empty stack — the guard must NOT fire, and the (mocked) API path runs.
    expect(apiSpy).toHaveBeenCalled()
    expect(result.suggestion).not.toContain('No technology stack could be derived')
  })

  it('tracks the recommend event with result_count: 0 when distinctId is set', async () => {
    const trackSpy = vi.spyOn(CoreModule, 'trackEvent').mockImplementation(() => {})
    const contextWithId: ToolContext = { ...context, distinctId: 'empty-stack-test-user' }

    await executeRecommend({ installed_skills: [], limit: 5 }, contextWithId)

    expect(trackSpy).toHaveBeenCalledWith(
      'empty-stack-test-user',
      'skill_recommend',
      expect.objectContaining({ result_count: 0, source: 'mcp' })
    )
  })
})
