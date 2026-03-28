/**
 * Centralized skill data service with MCP-first + mock fallback
 * Accepts McpClient via constructor injection for testability.
 */
import type { McpClient } from '../mcp/McpClient.js'
import type { McpSkillSearchResult, McpGetSkillResponse } from '../mcp/types.js'
import {
  MOCK_SKILLS,
  getSkillById as getMockSkillById,
  searchSkills as searchMockSkills,
} from '../data/mockSkills.js'
import type { SkillData, ExtendedSkillData } from '../types/skill.js'

/** Search result with offline indicator */
export interface SearchResult {
  results: SkillData[]
  isOffline: boolean
}

/** Rich skill result with offline indicator */
export interface RichSkillResult {
  skill: ExtendedSkillData
  isOffline: boolean
}

/** Cache entry for search results */
interface CacheEntry {
  results: SkillData[]
  timestamp: number
}

export class SkillService {
  private searchCache = new Map<string, CacheEntry>()
  private static readonly CACHE_TTL_MS = 60_000

  constructor(private readonly client: McpClient) {}

  /**
   * Search for skills. MCP-first with mock fallback.
   * Empty query returns all mock skills in fallback mode.
   */
  async search(
    query: string,
    options?: { category?: string; trustTier?: string; minScore?: number }
  ): Promise<SearchResult> {
    const cacheKey = JSON.stringify({ query, ...options })
    const cached = this.searchCache.get(cacheKey)
    if (cached && Date.now() - cached.timestamp < SkillService.CACHE_TTL_MS) {
      return { results: cached.results, isOffline: false }
    }

    if (this.client.isConnected()) {
      try {
        const response = await this.client.search(query, options)
        const results = response.results.map(mapSearchResultToSkillData)
        this.searchCache.set(cacheKey, { results, timestamp: Date.now() })
        return { results, isOffline: false }
      } catch (error) {
        console.warn('[Skillsmith] MCP search failed, using fallback:', error)
      }
    }

    // Fallback: empty query returns all mock skills (browse-all mode)
    const results = query ? searchMockSkills(query) : [...MOCK_SKILLS]
    return { results, isOffline: true }
  }

  /**
   * Get rich skill details (ExtendedSkillData) with MCP-first fallback.
   */
  async getRichSkill(skillId: string): Promise<RichSkillResult> {
    if (this.client.isConnected()) {
      try {
        const response = await this.client.getSkill(skillId)
        return { skill: mapSkillDetailsToExtendedSkillData(response), isOffline: false }
      } catch (error) {
        console.warn('[Skillsmith] MCP get_skill failed, using fallback:', error)
      }
    }

    const mock = getMockSkillById(skillId)
    return {
      skill: {
        ...mock,
        version: undefined,
        tags: undefined,
        installCommand: undefined,
        scoreBreakdown: undefined,
      },
      isOffline: true,
    }
  }

  /**
   * Convenience wrapper returning basic SkillData.
   */
  async getSkill(skillId: string): Promise<SkillData> {
    const { skill } = await this.getRichSkill(skillId)
    return skill
  }

  /** Proxy for connection status */
  isConnected(): boolean {
    return this.client.isConnected()
  }

  /** Clear the search cache */
  clearCache(): void {
    this.searchCache.clear()
  }
}

/** Map MCP search result to SkillData */
export function mapSearchResultToSkillData(result: McpSkillSearchResult): SkillData {
  return {
    id: result.id,
    name: result.name,
    description: result.description,
    author: result.author,
    category: result.category,
    trustTier: result.trustTier,
    score: result.score,
  }
}

/** Map MCP get_skill response to ExtendedSkillData */
export function mapSkillDetailsToExtendedSkillData(
  response: McpGetSkillResponse
): ExtendedSkillData {
  const s = response.skill
  const result: ExtendedSkillData = {
    id: s.id,
    name: s.name,
    description: s.description,
    author: s.author,
    category: s.category,
    trustTier: s.trustTier,
    score: s.score,
    version: s.version,
    tags: s.tags,
    installCommand: response.installCommand,
    scoreBreakdown: s.scoreBreakdown,
    // SMI-3672: Map content from response top-level (not skill object)
    content: response.content,
  }
  if (s.repository !== undefined) {
    result.repository = s.repository
  }
  return result
}
