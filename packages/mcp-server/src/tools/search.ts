/**
 * @fileoverview MCP Search Tool for Claude Code skill discovery
 * @module @skillsmith/mcp-server/tools/search
 * @see {@link https://github.com/wrsmith108/skillsmith|Skillsmith Repository}
 * @see SMI-789: Wire search tool to SearchService
 *
 * Provides skill search functionality with support for:
 * - Full-text search across skill names, descriptions, and authors
 * - Category filtering (development, testing, devops, etc.)
 * - Trust tier filtering (verified, community, experimental, unknown)
 * - Minimum quality score filtering
 *
 * @example
 * // Basic search with context
 * const results = await executeSearch({ query: 'commit' }, context);
 *
 * @example
 * // Search with filters
 * const results = await executeSearch({
 *   query: 'test',
 *   category: 'testing',
 *   trust_tier: 'verified',
 *   min_score: 80
 * }, context);
 */

import {
  type SkillSearchResult,
  type SearchFilters,
  type MCPSearchResponse as SearchResponse,
  type SkillCategory,
  type MCPTrustTier as TrustTier,
  SkillsmithError,
  ErrorCodes,
  trackSkillSearch,
} from '@skillsmith/core'
import type { ToolContext } from '../context.js'
import {
  extractCategoryFromTags,
  mapTrustTierToDb,
  mapTrustTierFromDb,
  getTrustBadge,
} from '../utils/validation.js'

/**
 * Search tool schema for MCP
 */
export const searchToolSchema = {
  name: 'search',
  description: 'Search for Claude Code skills by query with optional filters',
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'Search query for finding skills',
      },
      category: {
        type: 'string',
        description: 'Filter by skill category',
        enum: [
          'development',
          'testing',
          'documentation',
          'devops',
          'database',
          'security',
          'productivity',
          'integration',
          'ai-ml',
          'other',
        ],
      },
      trust_tier: {
        type: 'string',
        description: 'Filter by trust tier level',
        enum: ['verified', 'community', 'experimental', 'unknown'],
      },
      min_score: {
        type: 'number',
        description: 'Minimum quality score (0-100)',
        minimum: 0,
        maximum: 100,
      },
    },
    required: [], // Query is optional if filters are provided
  },
}

/**
 * Input parameters for the search operation
 * @interface SearchInput
 */
export interface SearchInput {
  /** Search query string (optional if filters provided) */
  query?: string
  /** Filter by skill category */
  category?: string
  /** Filter by trust tier level */
  trust_tier?: string
  /** Minimum quality score (0-100) */
  min_score?: number
}

/**
 * Execute a search for Claude Code skills with optional filters.
 *
 * SMI-1183: Uses API as primary source with local DB fallback.
 * - Tries live API first (api.skillsmith.app)
 * - Falls back to local SearchService if API is offline or fails
 *
 * @param input - Search parameters including query and optional filters
 * @param context - Tool context with API client and local services
 * @returns Promise resolving to search response with results and timing
 * @throws {SkillsmithError} When no query and no filters are provided
 * @throws {SkillsmithError} When min_score is outside 0-100 range
 *
 * @example
 * // Search for commit-related skills
 * const response = await executeSearch({ query: 'commit' }, context);
 * console.log(`Found ${response.total} skills in ${response.timing.totalMs}ms`);
 */
export async function executeSearch(
  input: SearchInput,
  context: ToolContext
): Promise<SearchResponse> {
  const startTime = performance.now()

  // Validate: require query OR at least one filter
  const hasQuery = input.query && input.query.trim().length > 0
  const hasFilters = input.category || input.trust_tier || input.min_score !== undefined

  if (!hasQuery && !hasFilters) {
    throw new SkillsmithError(
      ErrorCodes.SEARCH_QUERY_EMPTY,
      'Provide a search query or at least one filter (category, trust_tier, min_score)'
    )
  }

  // SMI-1613: Anti-scraping - require minimum 3 chars when query IS provided
  if (hasQuery && input.query!.trim().length < 3) {
    throw new SkillsmithError(
      ErrorCodes.SEARCH_QUERY_EMPTY,
      'Query must be at least 3 characters. Use specific search terms like "testing", "git", or "docker".'
    )
  }

  const filters: SearchFilters = {}

  // Apply category filter
  if (input.category) {
    filters.category = input.category as SkillCategory
  }

  // Apply trust tier filter with runtime validation
  const VALID_TRUST_TIERS = ['verified', 'community', 'experimental', 'unknown'] as const
  if (input.trust_tier) {
    if (!VALID_TRUST_TIERS.includes(input.trust_tier as (typeof VALID_TRUST_TIERS)[number])) {
      throw new SkillsmithError(
        ErrorCodes.VALIDATION_INVALID_TYPE,
        `Invalid trust_tier: ${input.trust_tier}. Must be one of: ${VALID_TRUST_TIERS.join(', ')}`,
        { details: { trust_tier: input.trust_tier, allowed: VALID_TRUST_TIERS } }
      )
    }
    filters.trustTier = input.trust_tier as TrustTier
  }

  // Apply minimum score filter (convert 0-100 to 0-1 for database)
  if (input.min_score !== undefined) {
    if (input.min_score < 0 || input.min_score > 100) {
      throw new SkillsmithError(
        ErrorCodes.VALIDATION_OUT_OF_RANGE,
        'min_score must be between 0 and 100',
        { details: { min_score: input.min_score } }
      )
    }
    filters.minScore = input.min_score / 100 // Convert to 0-1 scale for DB
  }

  const searchStart = performance.now()

  // SMI-1183: Try API first, fall back to local DB
  if (!context.apiClient.isOffline()) {
    try {
      const apiResponse = await context.apiClient.search({
        query: hasQuery ? input.query!.trim() : '',
        limit: 10,
        offset: 0,
        trustTier: filters.trustTier ? mapTrustTierToDb(filters.trustTier) : undefined,
        minQualityScore: filters.minScore,
        category: filters.category,
      })

      const searchEnd = performance.now()

      // Convert API results to SkillSearchResult format
      // SMI-1491: Added repository field for transparency
      const results: SkillSearchResult[] = apiResponse.data.map((item) => ({
        id: item.id,
        name: item.name,
        description: item.description || '',
        author: item.author || 'unknown',
        category: extractCategoryFromTags(item.tags),
        trustTier: mapTrustTierFromDb(item.trust_tier),
        score: Math.round((item.quality_score ?? 0) * 100),
        repository: item.repo_url || undefined,
      }))

      const endTime = performance.now()

      const response: SearchResponse = {
        results,
        total: (apiResponse.meta?.total as number) ?? results.length,
        query: input.query || '', // May be empty for filter-only searches
        filters,
        timing: {
          searchMs: Math.round(searchEnd - searchStart),
          totalMs: Math.round(endTime - startTime),
        },
      }

      // SMI-1184: Track search event (silent on failure)
      if (context.distinctId) {
        trackSkillSearch(
          context.distinctId,
          input.query || '',
          response.total,
          response.timing.totalMs,
          {
            trustTier: filters.trustTier,
            category: filters.category,
          }
        )
      }

      return response
    } catch (error) {
      // Log and fall through to local search
      console.warn(
        '[skillsmith] API search failed, using local database:',
        (error as Error).message
      )
    }
  }

  // Fallback: Use local SearchService for FTS5 search with BM25 ranking
  const dbTrustTier = filters.trustTier ? mapTrustTierToDb(filters.trustTier) : undefined

  // Local search fallback - pass empty string if no query
  const searchQuery = hasQuery ? input.query!.trim() : ''

  const searchResults = context.searchService.search({
    query: searchQuery,
    limit: 10,
    offset: 0,
    trustTier: dbTrustTier,
    minQualityScore: filters.minScore,
    category: filters.category,
  })

  const searchEnd = performance.now()

  // Convert SearchResult to SkillSearchResult format
  // SMI-1491: Added repository field for transparency
  const results: SkillSearchResult[] = searchResults.items.map((item) => ({
    id: item.skill.id,
    name: item.skill.name,
    description: item.skill.description || '',
    author: item.skill.author || 'unknown',
    category: extractCategoryFromTags(item.skill.tags),
    trustTier: mapTrustTierFromDb(item.skill.trustTier),
    score: Math.round((item.skill.qualityScore ?? 0) * 100), // Convert 0-1 to 0-100
    repository: item.skill.repoUrl || undefined,
  }))

  const endTime = performance.now()

  const response: SearchResponse = {
    results,
    total: searchResults.total,
    query: input.query || '', // May be empty for filter-only searches
    filters,
    timing: {
      searchMs: Math.round(searchEnd - searchStart),
      totalMs: Math.round(endTime - startTime),
    },
  }

  // SMI-1184: Track search event (silent on failure)
  if (context.distinctId) {
    trackSkillSearch(
      context.distinctId,
      input.query || '',
      response.total,
      response.timing.totalMs,
      {
        trustTier: filters.trustTier,
        category: filters.category,
      }
    )
  }

  return response
}

/**
 * Format search results for terminal/CLI display.
 *
 * Produces a human-readable string with skill listings including
 * trust badges, scores, and timing information.
 *
 * @param response - Search response from executeSearch
 * @returns Formatted string suitable for terminal output
 *
 * @example
 * const response = await executeSearch({ query: 'test' });
 * console.log(formatSearchResults(response));
 * // Output:
 * // === Search Results for "test" ===
 * // Found 3 skill(s):
 * // 1. jest-helper [COMMUNITY]
 * //    Author: community | Score: 87/100
 * //    Generate Jest test cases...
 */
export function formatSearchResults(response: SearchResponse): string {
  const lines: string[] = []

  lines.push('\n=== Search Results for "' + response.query + '" ===\n')

  if (response.results.length === 0) {
    lines.push('No skills found matching your query.')
    lines.push('')
    lines.push('Suggestions:')
    lines.push('  - Try different keywords')
    lines.push('  - Remove filters to broaden the search')
    lines.push('  - Check spelling')
  } else {
    lines.push('Found ' + response.total + ' skill(s):\n')

    response.results.forEach((skill, index) => {
      const trustBadge = getTrustBadge(skill.trustTier)
      lines.push(index + 1 + '. ' + skill.name + ' ' + trustBadge)
      lines.push('   Author: ' + skill.author + ' | Score: ' + skill.score + '/100')
      lines.push('   ' + skill.description)
      lines.push('   ID: ' + skill.id)
      lines.push('')
    })
  }

  // Add timing info
  lines.push('---')
  lines.push(
    'Search: ' + response.timing.searchMs + 'ms | Total: ' + response.timing.totalMs + 'ms'
  )

  return lines.join('\n')
}
