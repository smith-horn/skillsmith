/**
 * @fileoverview MCP Search Tool for Claude Code skill discovery
 * @module @skillsmith/mcp-server/tools/search
 * @see {@link https://github.com/wrsmith108/skillsmith|Skillsmith Repository}
 * @see SMI-789: Wire search tool to SearchService
 *
 * Provides skill search functionality with support for:
 * - Full-text search across skill names, descriptions, and authors
 * - Category filtering (development, testing, devops, etc.)
 * - Trust tier filtering (verified, community, standard, unverified)
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
  type TrustTier as DBTrustTier,
  SkillsmithError,
  ErrorCodes,
} from '@skillsmith/core'
import type { ToolContext } from '../context.js'
import { extractCategoryFromTags } from '../utils/validation.js'

/**
 * Map MCP trust tier to database trust tier
 * MCP: verified, community, standard, unverified
 * DB:  verified, community, experimental, unknown
 */
function mapTrustTierToDb(mcpTier: TrustTier): DBTrustTier {
  switch (mcpTier) {
    case 'verified':
      return 'verified'
    case 'community':
      return 'community'
    case 'standard':
      return 'experimental'
    case 'unverified':
      return 'unknown'
  }
}

/**
 * Map database trust tier to MCP trust tier
 */
function mapTrustTierFromDb(dbTier: DBTrustTier): TrustTier {
  switch (dbTier) {
    case 'verified':
      return 'verified'
    case 'community':
      return 'community'
    case 'experimental':
      return 'standard'
    case 'unknown':
      return 'unverified'
  }
}

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
        enum: ['verified', 'community', 'standard', 'unverified'],
      },
      min_score: {
        type: 'number',
        description: 'Minimum quality score (0-100)',
        minimum: 0,
        maximum: 100,
      },
    },
    required: ['query'],
  },
}

/**
 * Input parameters for the search operation
 * @interface SearchInput
 */
export interface SearchInput {
  /** Search query string (minimum 2 characters) */
  query: string
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
 * Uses SearchService with FTS5/BM25 ranking for relevance-based results.
 * Results are sorted by BM25 rank and limited to specified count.
 *
 * @param input - Search parameters including query and optional filters
 * @param context - Tool context with database and services
 * @returns Promise resolving to search response with results and timing
 * @throws {SkillsmithError} When query is empty or less than 2 characters
 * @throws {SkillsmithError} When min_score is outside 0-100 range
 *
 * @example
 * // Search for commit-related skills
 * const response = await executeSearch({ query: 'commit' }, context);
 * console.log(`Found ${response.total} skills in ${response.timing.totalMs}ms`);
 *
 * @example
 * // Search with multiple filters
 * const response = await executeSearch({
 *   query: 'react',
 *   category: 'testing',
 *   min_score: 85
 * }, context);
 */
export async function executeSearch(
  input: SearchInput,
  context: ToolContext
): Promise<SearchResponse> {
  const startTime = performance.now()

  // Validate query
  if (!input.query || input.query.trim().length < 2) {
    throw new SkillsmithError(
      ErrorCodes.SEARCH_QUERY_EMPTY,
      'Search query must be at least 2 characters'
    )
  }

  const filters: SearchFilters = {}

  // Apply category filter
  if (input.category) {
    filters.category = input.category as SkillCategory
  }

  // Apply trust tier filter
  if (input.trust_tier) {
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

  // Map MCP trust tier to DB trust tier if provided
  const dbTrustTier = filters.trustTier ? mapTrustTierToDb(filters.trustTier) : undefined

  // Use SearchService for FTS5 search with BM25 ranking
  const searchResults = context.searchService.search({
    query: input.query.trim(),
    limit: 10,
    offset: 0,
    trustTier: dbTrustTier,
    minQualityScore: filters.minScore,
    category: filters.category,
  })

  const searchEnd = performance.now()

  // Convert SearchResult to SkillSearchResult format
  const results: SkillSearchResult[] = searchResults.items.map((item) => ({
    id: item.skill.id,
    name: item.skill.name,
    description: item.skill.description || '',
    author: item.skill.author || 'unknown',
    category: extractCategoryFromTags(item.skill.tags),
    trustTier: mapTrustTierFromDb(item.skill.trustTier),
    score: Math.round((item.skill.qualityScore ?? 0) * 100), // Convert 0-1 to 0-100
  }))

  const endTime = performance.now()

  return {
    results,
    total: searchResults.total,
    query: input.query,
    filters,
    timing: {
      searchMs: Math.round(searchEnd - searchStart),
      totalMs: Math.round(endTime - startTime),
    },
  }
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

/**
 * Get trust badge for display
 */
function getTrustBadge(tier: TrustTier): string {
  switch (tier) {
    case 'verified':
      return '[VERIFIED]'
    case 'community':
      return '[COMMUNITY]'
    case 'standard':
      return '[STANDARD]'
    case 'unverified':
      return '[UNVERIFIED]'
    default:
      return '[UNKNOWN]'
  }
}
