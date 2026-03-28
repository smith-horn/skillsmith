/**
 * Unit tests for SkillService
 * Uses constructor-injected mock McpClient (no vi.mock).
 */
import { describe, it, expect, vi } from 'vitest'
import {
  SkillService,
  mapSearchResultToSkillData,
  mapSkillDetailsToExtendedSkillData,
} from '../services/SkillService.js'
import type { McpClient } from '../mcp/McpClient.js'
import type { McpSearchResponse, McpGetSkillResponse } from '../mcp/types.js'
import { MOCK_SKILLS } from '../data/mockSkills.js'

/** Create a mock McpClient with optional overrides */
function createMockClient(
  overrides: Partial<Pick<McpClient, 'isConnected' | 'search' | 'getSkill'>> = {}
): McpClient {
  return {
    isConnected: () => true,
    search: vi.fn(),
    getSkill: vi.fn(),
    ...overrides,
  } as unknown as McpClient
}

/** Fixture: MCP search response */
function makeMcpSearchResponse(partial?: Partial<McpSearchResponse>): McpSearchResponse {
  return {
    results: [
      {
        id: 'governance',
        name: 'Governance',
        description: 'Enforces engineering standards',
        author: 'skillsmith',
        category: 'development',
        trustTier: 'verified',
        score: 95,
      },
    ],
    total: 1,
    query: 'governance',
    filters: {},
    timing: { searchMs: 10, totalMs: 20 },
    ...partial,
  }
}

/** Fixture: MCP get_skill response */
function makeMcpGetSkillResponse(partial?: Partial<McpGetSkillResponse>): McpGetSkillResponse {
  return {
    skill: {
      id: 'governance',
      name: 'Governance',
      description: 'Enforces engineering standards',
      author: 'skillsmith',
      category: 'development',
      trustTier: 'verified',
      score: 95,
      repository: 'https://github.com/skillsmith/governance-skill',
      version: '1.2.0',
      tags: ['quality', 'standards'],
      scoreBreakdown: {
        quality: 95,
        popularity: 80,
        maintenance: 90,
        security: 88,
        documentation: 92,
      },
    },
    installCommand: 'npx @skillsmith/cli install governance',
    timing: { totalMs: 15 },
    ...partial,
  }
}

describe('SkillService', () => {
  let service: SkillService

  // --- Happy path (connected) ---

  describe('connected search', () => {
    it('returns mapped SkillData[] from MCP when connected', async () => {
      const searchFn = vi.fn().mockResolvedValue(makeMcpSearchResponse())
      const client = createMockClient({ search: searchFn })
      service = new SkillService(client)

      const { results, isOffline } = await service.search('governance')

      expect(isOffline).toBe(false)
      expect(results).toHaveLength(1)
      expect(results[0]!.id).toBe('governance')
      expect(results[0]!.name).toBe('Governance')
      expect(searchFn).toHaveBeenCalledWith('governance', undefined)
    })

    it('passes options (category, trustTier, minScore) to MCP', async () => {
      const searchFn = vi.fn().mockResolvedValue(makeMcpSearchResponse())
      const client = createMockClient({ search: searchFn })
      service = new SkillService(client)

      const options = { category: 'development', trustTier: 'verified', minScore: 80 }
      await service.search('test', options)

      expect(searchFn).toHaveBeenCalledWith('test', options)
    })
  })

  describe('connected getRichSkill', () => {
    it('returns ExtendedSkillData with version/tags/scoreBreakdown', async () => {
      const getSkillFn = vi.fn().mockResolvedValue(makeMcpGetSkillResponse())
      const client = createMockClient({ getSkill: getSkillFn })
      service = new SkillService(client)

      const { skill, isOffline } = await service.getRichSkill('governance')

      expect(isOffline).toBe(false)
      expect(skill.version).toBe('1.2.0')
      expect(skill.tags).toEqual(['quality', 'standards'])
      expect(skill.scoreBreakdown?.quality).toBe(95)
      expect(skill.installCommand).toBe('npx @skillsmith/cli install governance')
    })
  })

  describe('connected getSkill', () => {
    it('returns basic SkillData from MCP', async () => {
      const getSkillFn = vi.fn().mockResolvedValue(makeMcpGetSkillResponse())
      const client = createMockClient({ getSkill: getSkillFn })
      service = new SkillService(client)

      const skill = await service.getSkill('governance')

      expect(skill.id).toBe('governance')
      expect(skill.name).toBe('Governance')
    })
  })

  // --- Fallback behavior ---

  describe('fallback on disconnect', () => {
    it('returns mock data + isOffline: true when MCP disconnected', async () => {
      const client = createMockClient({ isConnected: () => false })
      service = new SkillService(client)

      const { results, isOffline } = await service.search('governance')

      expect(isOffline).toBe(true)
      expect(results.length).toBeGreaterThan(0)
      // Results come from searchMockSkills
      expect(results.some((s) => s.id === 'governance')).toBe(true)
    })

    it('empty-query fallback returns all MOCK_SKILLS (not empty)', async () => {
      const client = createMockClient({ isConnected: () => false })
      service = new SkillService(client)

      const { results, isOffline } = await service.search('')

      expect(isOffline).toBe(true)
      expect(results).toHaveLength(MOCK_SKILLS.length)
    })
  })

  describe('getRichSkill fallback on MCP error', () => {
    it('returns mock data + isOffline: true when MCP errors', async () => {
      const getSkillFn = vi.fn().mockRejectedValue(new Error('network error'))
      const client = createMockClient({ getSkill: getSkillFn })
      service = new SkillService(client)

      const { skill, isOffline } = await service.getRichSkill('governance')

      expect(isOffline).toBe(true)
      expect(skill.id).toBe('governance')
      expect(skill.version).toBeUndefined()
    })
  })

  describe('unknown skill ID fallback', () => {
    it('returns fallback object with score 0 and unverified tier', async () => {
      const client = createMockClient({ isConnected: () => false })
      service = new SkillService(client)

      const skill = await service.getSkill('nonexistent-skill-xyz')

      expect(skill.id).toBe('nonexistent-skill-xyz')
      expect(skill.trustTier).toBe('unverified')
      expect(skill.score).toBe(0)
    })
  })

  // --- Edge cases ---

  describe('malformed MCP response', () => {
    it('falls back gracefully without crashing', async () => {
      const searchFn = vi
        .fn()
        .mockRejectedValue(new TypeError('Cannot read properties of undefined'))
      const client = createMockClient({ search: searchFn })
      service = new SkillService(client)

      const { results, isOffline } = await service.search('test')

      expect(isOffline).toBe(true)
      expect(Array.isArray(results)).toBe(true)
    })
  })

  describe('concurrent search calls', () => {
    it('do not corrupt cache or results', async () => {
      let callCount = 0
      const searchFn = vi.fn().mockImplementation(async (query: string) => {
        callCount++
        // Simulate varying response times
        await new Promise((r) => setTimeout(r, callCount * 5))
        return makeMcpSearchResponse({
          query,
          results: [
            {
              id: `skill-${query}`,
              name: query,
              description: 'desc',
              author: 'author',
              category: 'cat',
              trustTier: 'verified',
              score: 90,
            },
          ],
        })
      })
      const client = createMockClient({ search: searchFn })
      service = new SkillService(client)

      const [r1, r2] = await Promise.all([service.search('alpha'), service.search('beta')])

      expect(r1.results[0]!.id).toBe('skill-alpha')
      expect(r2.results[0]!.id).toBe('skill-beta')
    })
  })

  describe('connection state transition mid-call', () => {
    it('falls back gracefully when connection drops during search', async () => {
      const searchFn = vi.fn().mockRejectedValue(new Error('MCP server disconnected'))
      const client = createMockClient({ search: searchFn })
      service = new SkillService(client)

      const { results, isOffline } = await service.search('governance')

      expect(isOffline).toBe(true)
      expect(results.length).toBeGreaterThan(0)
    })
  })

  describe('cache TTL', () => {
    it('returns cached results within TTL without re-calling MCP', async () => {
      const searchFn = vi.fn().mockResolvedValue(makeMcpSearchResponse())
      const client = createMockClient({ search: searchFn })
      service = new SkillService(client)

      // First call — hits MCP
      const r1 = await service.search('governance')
      expect(r1.isOffline).toBe(false)
      expect(searchFn).toHaveBeenCalledTimes(1)

      // Second call — should use cache
      const r2 = await service.search('governance')
      expect(r2.isOffline).toBe(false)
      expect(r2.results).toEqual(r1.results)
      expect(searchFn).toHaveBeenCalledTimes(1) // No additional call
    })
  })
})

// --- Mapper unit tests ---

describe('mapSearchResultToSkillData', () => {
  it('maps all fields correctly', () => {
    const result = mapSearchResultToSkillData({
      id: 'test',
      name: 'Test',
      description: 'desc',
      author: 'auth',
      category: 'cat',
      trustTier: 'verified',
      score: 90,
    })

    expect(result).toEqual({
      id: 'test',
      name: 'Test',
      description: 'desc',
      author: 'auth',
      category: 'cat',
      trustTier: 'verified',
      score: 90,
    })
  })
})

describe('mapSkillDetailsToExtendedSkillData', () => {
  it('maps all fields including extended data', () => {
    const result = mapSkillDetailsToExtendedSkillData(makeMcpGetSkillResponse())

    expect(result.id).toBe('governance')
    expect(result.version).toBe('1.2.0')
    expect(result.tags).toEqual(['quality', 'standards'])
    expect(result.installCommand).toBe('npx @skillsmith/cli install governance')
    expect(result.scoreBreakdown?.quality).toBe(95)
  })

  // SMI-3672: Content mapping tests
  it('maps content from response top-level', () => {
    const response = makeMcpGetSkillResponse({ content: '# My Skill\n\nDoes things.' })
    const result = mapSkillDetailsToExtendedSkillData(response)
    expect(result.content).toBe('# My Skill\n\nDoes things.')
  })

  it('maps undefined content when not present', () => {
    const response = makeMcpGetSkillResponse()
    const result = mapSkillDetailsToExtendedSkillData(response)
    expect(result.content).toBeUndefined()
  })
})
