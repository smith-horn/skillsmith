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
import { McpToolError } from '../mcp/McpToolError.js'
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

/** Demo-mode-on resolver (SMI-5288). */
const demoOn = () => true

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

  // --- SMI-5288: demo-only mock + TierDenied rethrow ---

  describe('TierDenied propagation (never mocked)', () => {
    it('search rethrows McpToolError TierDenied instead of returning mock', async () => {
      const searchFn = vi
        .fn()
        .mockRejectedValue(new McpToolError('search', 'TierDenied', 'requires the Team plan'))
      const client = createMockClient({ search: searchFn })
      // demo mode ON to prove TierDenied still wins over the mock branch
      service = new SkillService(client, demoOn)

      await expect(service.search('governance')).rejects.toMatchObject({
        code: 'TierDenied',
      })
    })

    it('getRichSkill rethrows McpToolError TierDenied instead of returning mock', async () => {
      const getSkillFn = vi
        .fn()
        .mockRejectedValue(new McpToolError('get_skill', 'TierDenied', 'requires the Team plan'))
      const client = createMockClient({ getSkill: getSkillFn })
      service = new SkillService(client, demoOn)

      await expect(service.getRichSkill('governance')).rejects.toMatchObject({
        code: 'TierDenied',
      })
    })
  })

  describe('offline + demo mode OFF (default)', () => {
    it('search returns empty results + isOffline true when MCP disconnected', async () => {
      const client = createMockClient({ isConnected: () => false })
      service = new SkillService(client) // demoMode defaults to off

      const { results, isOffline } = await service.search('governance')

      expect(isOffline).toBe(true)
      expect(results).toEqual([])
    })

    it('search returns empty on transport error (no mock leak)', async () => {
      const searchFn = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
      const client = createMockClient({ search: searchFn })
      service = new SkillService(client)

      const { results, isOffline } = await service.search('governance')

      expect(isOffline).toBe(true)
      expect(results).toEqual([])
    })

    it('getRichSkill throws McpToolError NotConnected when MCP disconnected', async () => {
      const client = createMockClient({ isConnected: () => false })
      service = new SkillService(client)

      await expect(service.getRichSkill('governance')).rejects.toMatchObject({
        code: 'NotConnected',
        message: 'Skillsmith server unavailable',
      })
    })

    it('getRichSkill throws NotConnected on transport error', async () => {
      const getSkillFn = vi.fn().mockRejectedValue(new Error('network error'))
      const client = createMockClient({ getSkill: getSkillFn })
      service = new SkillService(client)

      await expect(service.getRichSkill('governance')).rejects.toBeInstanceOf(McpToolError)
    })
  })

  describe('offline + demo mode ON', () => {
    it('search returns mock data + isOffline true when MCP disconnected', async () => {
      const client = createMockClient({ isConnected: () => false })
      service = new SkillService(client, demoOn)

      const { results, isOffline } = await service.search('governance')

      expect(isOffline).toBe(true)
      expect(results.length).toBeGreaterThan(0)
      expect(results.some((s) => s.id === 'governance')).toBe(true)
    })

    it('empty-query returns all MOCK_SKILLS in demo mode', async () => {
      const client = createMockClient({ isConnected: () => false })
      service = new SkillService(client, demoOn)

      const { results, isOffline } = await service.search('')

      expect(isOffline).toBe(true)
      expect(results).toHaveLength(MOCK_SKILLS.length)
    })

    it('getRichSkill returns mock data + isOffline true in demo mode', async () => {
      const getSkillFn = vi.fn().mockRejectedValue(new Error('network error'))
      const client = createMockClient({ getSkill: getSkillFn })
      service = new SkillService(client, demoOn)

      const { skill, isOffline } = await service.getRichSkill('governance')

      expect(isOffline).toBe(true)
      expect(skill.id).toBe('governance')
      expect(skill.version).toBeUndefined()
    })

    it('getSkill returns fallback (score 0, unverified) for unknown id in demo mode', async () => {
      const client = createMockClient({ isConnected: () => false })
      service = new SkillService(client, demoOn)

      const skill = await service.getSkill('nonexistent-skill-xyz')

      expect(skill.id).toBe('nonexistent-skill-xyz')
      expect(skill.trustTier).toBe('unverified')
      expect(skill.score).toBe(0)
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
    it('returns empty offline result when connection drops during search (demo off)', async () => {
      const searchFn = vi.fn().mockRejectedValue(new Error('MCP server disconnected'))
      const client = createMockClient({ search: searchFn })
      service = new SkillService(client)

      const { results, isOffline } = await service.search('governance')

      expect(isOffline).toBe(true)
      expect(results).toEqual([])
    })

    it('falls back to mock when connection drops mid-call in demo mode', async () => {
      const searchFn = vi.fn().mockRejectedValue(new Error('MCP server disconnected'))
      const client = createMockClient({ search: searchFn })
      service = new SkillService(client, demoOn)

      const { results, isOffline } = await service.search('governance')

      expect(isOffline).toBe(true)
      expect(results.length).toBeGreaterThan(0)
    })
  })

  describe('demo-mode filters (SMI-5304 plan-review #4)', () => {
    it('applies trustTier filter client-side to mock results', async () => {
      const client = createMockClient({ isConnected: () => false })
      service = new SkillService(client, demoOn)

      const unfiltered = await service.search('')
      const filtered = await service.search('', { trustTier: 'community' })

      // MOCK_SKILLS has a mix of tiers; the community filter must drop some.
      expect(filtered.results.length).toBeLessThan(unfiltered.results.length)
      expect(filtered.results.every((s) => s.trustTier.toLowerCase() === 'community')).toBe(true)
    })

    it('applies category filter case-insensitively (capitalized filter vs lowercase mock)', async () => {
      const client = createMockClient({ isConnected: () => false })
      service = new SkillService(client, demoOn)

      // Filter passes 'Testing'; mock data uses lowercase 'testing'.
      const { results } = await service.search('', { category: 'Testing' })
      expect(results.length).toBeGreaterThan(0)
      expect(results.every((s) => s.category.toLowerCase() === 'testing')).toBe(true)
    })

    it('applies minScore as an inclusive threshold to mock results', async () => {
      const client = createMockClient({ isConnected: () => false })
      service = new SkillService(client, demoOn)

      const { results } = await service.search('', { minScore: 90 })
      expect(results.length).toBeGreaterThan(0)
      expect(results.every((s) => s.score >= 90)).toBe(true)
    })

    it('filtered vs unfiltered same query yield different mock results', async () => {
      const client = createMockClient({ isConnected: () => false })
      service = new SkillService(client, demoOn)

      const unfiltered = await service.search('')
      const filtered = await service.search('', { minScore: 95 })
      expect(filtered.results.length).not.toBe(unfiltered.results.length)
    })
  })

  describe('cache key distinctness per options', () => {
    it('filtered + unfiltered same query are cached separately (distinct keys)', async () => {
      const searchFn = vi.fn().mockImplementation(async () => makeMcpSearchResponse())
      const client = createMockClient({ search: searchFn })
      service = new SkillService(client)

      await service.search('governance')
      await service.search('governance', { trustTier: 'verified' })

      // Distinct cache keys → both hit MCP (no collision).
      expect(searchFn).toHaveBeenCalledTimes(2)
      expect(searchFn).toHaveBeenNthCalledWith(1, 'governance', undefined)
      expect(searchFn).toHaveBeenNthCalledWith(2, 'governance', { trustTier: 'verified' })
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

  it('maps repository field when present', () => {
    const result = mapSearchResultToSkillData({
      id: 'smith-horn/governance',
      name: 'Governance',
      description: 'Enforces standards',
      author: 'smith-horn',
      category: 'development',
      trustTier: 'verified',
      score: 95,
      repository: 'https://github.com/smith-horn/governance',
    })

    expect(result.repository).toBe('https://github.com/smith-horn/governance')
  })

  it('maps undefined repository when not present', () => {
    const result = mapSearchResultToSkillData({
      id: 'test',
      name: 'Test',
      description: 'desc',
      author: 'auth',
      category: 'cat',
      trustTier: 'community',
      score: 70,
    })

    expect(result.repository).toBeUndefined()
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

  // SMI-3857: Security scan field mapping
  it('maps security scan data when present', () => {
    const response = makeMcpGetSkillResponse()
    response.skill.security = {
      passed: true,
      riskScore: 15,
      findingsCount: 0,
      scannedAt: '2026-04-03T12:00:00Z',
    }
    const result = mapSkillDetailsToExtendedSkillData(response)
    expect(result.securityPassed).toBe(true)
    expect(result.securityRiskScore).toBe(15)
    expect(result.securityScannedAt).toBe('2026-04-03T12:00:00Z')
  })

  it('maps null security scan data when not present', () => {
    const response = makeMcpGetSkillResponse()
    const result = mapSkillDetailsToExtendedSkillData(response)
    expect(result.securityPassed).toBeNull()
    expect(result.securityRiskScore).toBeNull()
    expect(result.securityScannedAt).toBeNull()
  })
})
