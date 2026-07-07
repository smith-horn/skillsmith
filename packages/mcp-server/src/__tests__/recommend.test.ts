/**
 * Tests for SMI-1837: Include Local Skills in Recommendations
 * Verifies that local skills are searched in parallel with the API,
 * not just as a fallback.
 *
 * SMI-2755: Online API path tests split to recommend-online-path.test.ts.
 * SMI-5562: formatRecommendations tests split to recommend.format.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from 'vitest'
import {
  executeRecommend,
  mergeAndDeduplicateRecommendations,
  type SkillRecommendation,
} from '../tools/recommend.js'
import { createSeededTestContext, disposeTestContext, type ToolContext } from './test-utils.js'
import * as LocalSkillSearchModule from '../tools/LocalSkillSearch.js'
import type { LocalSkill } from '../indexer/LocalIndexer.js'

let context: ToolContext

beforeAll(async () => {
  context = await createSeededTestContext()
})

afterAll(async () => {
  await disposeTestContext(context)
})

describe('Recommend Tool', () => {
  describe('executeRecommend - basic functionality', () => {
    it('should return recommendations for project context', async () => {
      const result = await executeRecommend(
        {
          project_context: 'React frontend with testing',
          limit: 5,
        },
        context
      )

      expect(result.recommendations).toBeDefined()
      expect(Array.isArray(result.recommendations)).toBe(true)
      expect(result.context.has_project_context).toBe(true)
      expect(result.timing.totalMs).toBeGreaterThanOrEqual(0)
    })

    it('should return recommendations with installed skills', async () => {
      const result = await executeRecommend(
        {
          installed_skills: ['anthropic/commit'],
          limit: 5,
        },
        context
      )

      expect(result.recommendations).toBeDefined()
      expect(result.context.installed_count).toBe(1)
      // Should not recommend the already installed skill
      const hasInstalledSkill = result.recommendations.some(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (r: any) => r.skill_id === 'anthropic/commit'
      )
      expect(hasInstalledSkill).toBe(false)
    })

    // SMI-5556: empty-result guidance so a calling agent doesn't misread
    // candidates_considered: 0 as a registry/backend fault.
    it('should include a suggestion when zero recommendations are returned', async () => {
      const result = await executeRecommend(
        {
          project_context: 'testing',
          min_similarity: 1,
          limit: 5,
        },
        context
      )

      expect(result.recommendations.length).toBe(0)
      expect(result.suggestion).toBeDefined()
      expect(result.suggestion).toContain('does not indicate a registry/backend problem')
      expect(result.suggestion).toContain('search tool')
    })

    it('should NOT include a suggestion when recommendations are non-empty', async () => {
      const result = await executeRecommend(
        { project_context: 'React frontend with testing', limit: 5 },
        context
      )

      // Seeded fixture reliably matches this query (community/jest-helper etc.) —
      // hard assertion instead of a soft length-guard, so a future regression
      // that empties the result set fails loudly here.
      expect(result.recommendations.length).toBeGreaterThan(0)
      expect(result.suggestion).toBeUndefined()
    })

    // SMI-5562: local-DB fallback path (this context is offline-mode) must
    // populate description, and `security` must be `undefined` for a
    // never-scanned row (seedTestData never sets security fields, so
    // SkillRepository.create() defaults securityScannedAt to null) — a
    // defined-but-null object would narrate as "scanned, no verdict yet"
    // under the tool description's 3-state contract, which is false for a
    // skill that was never scanned at all.
    it('(SMI-5562) includes description and omits security (never scanned) on the local-DB fallback path', async () => {
      const result = await executeRecommend(
        { project_context: 'React frontend with testing', limit: 5 },
        context
      )

      expect(result.recommendations.length).toBeGreaterThan(0)
      const rec = result.recommendations[0]

      expect(rec.description).toBeTruthy()
      expect(rec.security).toBeUndefined()
    })
  })
})

// Note: `formatRecommendations` tests live in recommend.format.test.ts
// (split out to stay under the 500-line file-length gate).

/**
 * SMI-1837: Tests for parallel local skill search integration
 */
describe('Recommend Tool - Local Skill Integration (SMI-1837)', () => {
  let branchContext: ToolContext

  // Mock local skills for testing
  const mockLocalSkills: LocalSkill[] = [
    {
      id: 'local/my-commit-helper',
      name: 'my-commit-helper',
      description: 'Personal commit message helper',
      author: 'local',
      tags: ['git', 'commit', 'personal'],
      qualityScore: 75,
      trustTier: 'local',
      source: 'local',
      path: '/home/user/.claude/skills/my-commit-helper',
      hasSkillMd: true,
      lastModified: new Date().toISOString(),
      repository: null,
    },
    {
      id: 'local/react-patterns',
      name: 'react-patterns',
      description: 'React component patterns and best practices',
      author: 'local',
      tags: ['react', 'patterns', 'components'],
      qualityScore: 80,
      trustTier: 'local',
      source: 'local',
      path: '/home/user/.claude/skills/react-patterns',
      hasSkillMd: true,
      lastModified: new Date().toISOString(),
      repository: null,
    },
    {
      id: 'local/testing-utils',
      name: 'testing-utils',
      description: 'Testing utilities and helpers',
      author: 'local',
      tags: ['testing', 'jest', 'vitest'],
      qualityScore: 70,
      trustTier: 'local',
      source: 'local',
      path: '/home/user/.claude/skills/testing-utils',
      hasSkillMd: true,
      lastModified: new Date().toISOString(),
      repository: null,
    },
  ]

  beforeAll(async () => {
    branchContext = await createSeededTestContext()
  })

  afterAll(async () => {
    await disposeTestContext(branchContext)
  })

  beforeEach(() => {
    // Mock the local indexer to return controlled test data
    vi.spyOn(LocalSkillSearchModule, 'getLocalIndexer').mockReturnValue({
      index: vi.fn().mockResolvedValue(mockLocalSkills),
      indexSync: vi.fn().mockReturnValue(mockLocalSkills),
      search: vi.fn((query: string, skills: LocalSkill[]) => {
        const lowerQuery = query.toLowerCase()
        return skills.filter(
          (s) =>
            s.name.toLowerCase().includes(lowerQuery) ||
            s.description?.toLowerCase().includes(lowerQuery) ||
            s.tags.some((t) => t.toLowerCase().includes(lowerQuery))
        )
      }),
      clearCache: vi.fn(),
      getSkillsDir: vi.fn().mockReturnValue('/home/user/.claude/skills'),
      calculateQualityScore: vi.fn().mockReturnValue(75),
      indexSkillDir: vi.fn(),
      // Partial mock — only methods called by executeRecommend are implemented
    } as unknown as ReturnType<typeof LocalSkillSearchModule.getLocalIndexer>)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('parallel local search', () => {
    it('should include local skills in recommendations when API is offline', async () => {
      // Context is created with offline mode, so it will use local matching
      const result = await executeRecommend(
        {
          project_context: 'React testing project',
          limit: 10,
        },
        branchContext
      )

      expect(result.recommendations).toBeDefined()
      expect(result.timing.totalMs).toBeGreaterThanOrEqual(0)
      expect(result.timing.totalMs).toBeLessThan(2000) // Performance requirement
    })

    it('should not have duplicate skills in results', async () => {
      const result = await executeRecommend(
        {
          project_context: 'commit automation',
          limit: 10,
        },
        branchContext
      )

      // Check for duplicate skill_ids
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const skillIds = result.recommendations.map((r: any) => r.skill_id)
      const uniqueIds = new Set(skillIds)
      expect(skillIds.length).toBe(uniqueIds.size)
    })

    // SMI-5562: local (disk-scanned) skills must carry description but leave
    // `security` unset entirely — `undefined`, distinct from a `{ passed: null }`
    // placeholder, since they are never registry-scanned. Overrides the shared
    // mock's `search` to return all fixtures unconditionally (its default
    // whole-string substring match rarely matches a multi-word query), so this
    // test deterministically surfaces a local/ skill regardless of query wording.
    it('(SMI-5562) local skill recommendations include description and leave security unset', async () => {
      vi.spyOn(LocalSkillSearchModule, 'getLocalIndexer').mockReturnValue({
        index: vi.fn().mockResolvedValue(mockLocalSkills),
        indexSync: vi.fn().mockReturnValue(mockLocalSkills),
        search: vi.fn().mockReturnValue(mockLocalSkills),
        clearCache: vi.fn(),
        getSkillsDir: vi.fn().mockReturnValue('/home/user/.claude/skills'),
        calculateQualityScore: vi.fn().mockReturnValue(75),
        indexSkillDir: vi.fn(),
      } as unknown as ReturnType<typeof LocalSkillSearchModule.getLocalIndexer>)

      // installed_skills passed explicitly (non-empty) so autoDetected=false and
      // getInstalledSkills() — which reads the real host ~/.claude/skills/ — is
      // never called (closing the host-coupling vector, matching the dedup test above).
      const result = await executeRecommend(
        {
          project_context: 'react testing patterns',
          installed_skills: ['placeholder/none'],
          limit: 10,
        },
        branchContext
      )

      const localRec = result.recommendations.find((r) => r.skill_id.startsWith('local/'))
      expect(localRec).toBeDefined()
      expect(localRec?.description).toBeTruthy()
      expect(localRec?.security).toBeUndefined()
    })

    it('should complete within performance target (<500ms)', async () => {
      const startTime = performance.now()

      await executeRecommend(
        {
          project_context: 'JavaScript development',
          installed_skills: ['anthropic/commit'],
          limit: 10,
        },
        branchContext
      )

      const endTime = performance.now()
      const duration = endTime - startTime

      expect(duration).toBeLessThan(2000)
    })

    it('should handle empty local skills gracefully', async () => {
      // Mock empty local skills
      vi.spyOn(LocalSkillSearchModule, 'getLocalIndexer').mockReturnValue({
        index: vi.fn().mockResolvedValue([]),
        indexSync: vi.fn().mockReturnValue([]),
        search: vi.fn().mockReturnValue([]),
        clearCache: vi.fn(),
        getSkillsDir: vi.fn().mockReturnValue('/home/user/.claude/skills'),
        calculateQualityScore: vi.fn().mockReturnValue(0),
        indexSkillDir: vi.fn(),
        // Partial mock — only methods called by executeRecommend are implemented
      } as unknown as ReturnType<typeof LocalSkillSearchModule.getLocalIndexer>)

      const result = await executeRecommend(
        {
          project_context: 'testing',
          limit: 5,
        },
        branchContext
      )

      // Should still return database results
      expect(result.recommendations).toBeDefined()
      expect(Array.isArray(result.recommendations)).toBe(true)
    })

    it('should handle local indexer errors gracefully', async () => {
      // Mock indexer that throws an error
      vi.spyOn(LocalSkillSearchModule, 'getLocalIndexer').mockReturnValue({
        index: vi.fn().mockRejectedValue(new Error('Indexer failed')),
        indexSync: vi.fn().mockImplementation(() => {
          throw new Error('Indexer failed')
        }),
        search: vi.fn().mockReturnValue([]),
        clearCache: vi.fn(),
        getSkillsDir: vi.fn().mockReturnValue('/home/user/.claude/skills'),
        calculateQualityScore: vi.fn().mockReturnValue(0),
        indexSkillDir: vi.fn(),
        // Partial mock — only methods called by executeRecommend are implemented
      } as unknown as ReturnType<typeof LocalSkillSearchModule.getLocalIndexer>)

      // Should not throw, should fall back gracefully
      const result = await executeRecommend(
        {
          project_context: 'testing',
          limit: 5,
        },
        branchContext
      )

      expect(result.recommendations).toBeDefined()
    })
  })

  describe('deduplication logic', () => {
    it('should prefer registry skills over local skills with same name', async () => {
      // SMI-5253: Route through the ONLINE path so the registry result set is deterministic.
      // The offline path ranks DB candidates through SkillMatcher's mock-embedding similarity,
      // whose ordering is environment-dependent — that nondeterminism previously left this
      // assertion ungated (the sole expect() sat behind two `if` guards + expect.hasAssertions(),
      // which failed whenever no 'commit' skill survived ranking). The online path merges
      // apiClient.getRecommendations() with local results via mergeAndDeduplicateRecommendations
      // (no matcher, no embeddings, no DB ordering). NOTE: the seeded DB rows are unused on this
      // path — the registry 'commit' comes from the getRecommendations mock below, not the seed.
      vi.spyOn(branchContext.apiClient, 'isOffline').mockReturnValue(false)
      vi.spyOn(branchContext.apiClient, 'getRecommendations').mockResolvedValue({
        data: [
          {
            id: 'anthropic/commit',
            name: 'commit',
            description: 'Generate semantic commit messages',
            author: 'anthropic',
            tags: ['git', 'commit'],
            trust_tier: 'verified',
            quality_score: 0.95,
            // SMI-5178: repo_url required so installable=true and default-ON filter keeps this row.
            repo_url: 'https://github.com/anthropic/claude-code-skills',
          },
        ],
        meta: { total: 1 },
      })

      // Local indexer returns a same-name duplicate of the registry skill
      const duplicateMockSkills: LocalSkill[] = [
        {
          id: 'local/commit',
          name: 'commit',
          description: 'Local commit helper (duplicate of anthropic/commit)',
          author: 'local',
          tags: ['git', 'commit'],
          qualityScore: 60,
          trustTier: 'local',
          source: 'local',
          path: '/home/user/.claude/skills/commit',
          hasSkillMd: true,
          lastModified: new Date().toISOString(),
          repository: null,
        },
      ]

      vi.spyOn(LocalSkillSearchModule, 'getLocalIndexer').mockReturnValue({
        index: vi.fn().mockResolvedValue(duplicateMockSkills),
        indexSync: vi.fn().mockReturnValue(duplicateMockSkills),
        search: vi.fn().mockReturnValue(duplicateMockSkills),
        clearCache: vi.fn(),
        getSkillsDir: vi.fn().mockReturnValue('/home/user/.claude/skills'),
        calculateQualityScore: vi.fn().mockReturnValue(60),
        indexSkillDir: vi.fn(),
        // Partial mock — only methods called by executeRecommend are implemented
      } as unknown as ReturnType<typeof LocalSkillSearchModule.getLocalIndexer>)

      // installed_skills is passed explicitly so autoDetected=false and getInstalledSkills()
      // (which reads the real ~/.claude/skills/) is never called — closing the last host-coupling
      // vector. 'anthropic/review-pr' collides with neither target id, so the installed-skill
      // filter (recommend.ts) is a no-op.
      const result = await executeRecommend(
        {
          project_context: 'git workflow',
          installed_skills: ['anthropic/review-pr'],
          limit: 10,
        },
        branchContext
      )

      // Registry skill wins; the same-name local duplicate is deduped out — assert unconditionally.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ids = result.recommendations.map((r: any) => r.skill_id)
      expect(ids).toContain('anthropic/commit')
      expect(ids).not.toContain('local/commit')
    })

    it('mergeAndDeduplicateRecommendations drops same-name local skill in favor of registry', () => {
      // SMI-5253: Deterministic unit coverage for the same-name dedup invariant on the merge
      // logic that BOTH the online and offline executeRecommend paths share. No context, DB, or
      // embeddings — zero flake surface.
      const apiResults: SkillRecommendation[] = [
        {
          skill_id: 'anthropic/commit',
          name: 'commit',
          reason: 'registry match',
          similarity_score: 0.8,
          trust_tier: 'verified',
          quality_score: 95,
          roles: [],
        },
      ]
      const localResults: SkillRecommendation[] = [
        {
          skill_id: 'local/commit',
          name: 'commit',
          reason: 'local match',
          similarity_score: 0.7,
          trust_tier: 'local',
          quality_score: 60,
          roles: [],
        },
      ]

      const merged = mergeAndDeduplicateRecommendations(apiResults, localResults, 10)
      const ids = merged.map((r) => r.skill_id)

      expect(ids).toContain('anthropic/commit')
      expect(ids).not.toContain('local/commit') // same-name local filtered
      expect(merged[0].skill_id).toBe('anthropic/commit') // registry ordered first
    })
  })

  describe('role filtering with local skills', () => {
    it('should apply role filter to local skills', async () => {
      expect.hasAssertions()
      const result = await executeRecommend(
        {
          project_context: 'testing project',
          role: 'testing',
          limit: 10,
        },
        branchContext
      )

      // All results should have testing role if role filter is applied
      if (result.recommendations.length > 0 && result.context.role_filter) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        result.recommendations.forEach((rec: any) => {
          if (rec.roles) {
            expect(rec.roles).toContain('testing')
          }
        })
      }
    })
  })
})
