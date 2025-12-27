/**
 * @fileoverview MCP Search Tool for Claude Code skill discovery
 * @module @skillsmith/mcp-server/tools/search
 * @see {@link https://github.com/wrsmith108/skillsmith|Skillsmith Repository}
 *
 * Provides skill search functionality with support for:
 * - Full-text search across skill names, descriptions, and authors
 * - Category filtering (development, testing, devops, etc.)
 * - Trust tier filtering (verified, community, standard, unverified)
 * - Minimum quality score filtering
 *
 * @example
 * // Basic search
 * const results = await executeSearch({ query: 'commit' });
 *
 * @example
 * // Search with filters
 * const results = await executeSearch({
 *   query: 'test',
 *   category: 'testing',
 *   trust_tier: 'verified',
 *   min_score: 80
 * });
 */

import {
  type SkillSearchResult,
  type SearchFilters,
  type MCPSearchResponse as SearchResponse,
  type SkillCategory,
  type MCPTrustTier as TrustTier,
  SkillsmithError,
  ErrorCodes,
} from '@skillsmith/core'

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
 * Mock skill data for development
 * In production, this would query the SQLite database
 */
const mockSkills: SkillSearchResult[] = [
  {
    id: 'anthropic/commit',
    name: 'commit',
    description: 'Generate semantic commit messages following conventional commits',
    author: 'anthropic',
    category: 'development',
    trustTier: 'verified',
    score: 95,
  },
  {
    id: 'anthropic/review-pr',
    name: 'review-pr',
    description: 'Review pull requests with detailed code analysis',
    author: 'anthropic',
    category: 'development',
    trustTier: 'verified',
    score: 93,
  },
  {
    id: 'community/jest-helper',
    name: 'jest-helper',
    description: 'Generate Jest test cases for React components',
    author: 'community',
    category: 'testing',
    trustTier: 'community',
    score: 87,
  },
  {
    id: 'community/docker-compose',
    name: 'docker-compose',
    description: 'Generate and manage Docker Compose configurations',
    author: 'community',
    category: 'devops',
    trustTier: 'community',
    score: 84,
  },
  {
    id: 'community/api-docs',
    name: 'api-docs',
    description: 'Generate OpenAPI documentation from code',
    author: 'community',
    category: 'documentation',
    trustTier: 'standard',
    score: 78,
  },
]

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
 * Searches across skill names, descriptions, and authors. Results are
 * sorted by quality score (descending) and limited to top 10.
 *
 * @param input - Search parameters including query and optional filters
 * @returns Promise resolving to search response with results and timing
 * @throws {SkillsmithError} When query is empty or less than 2 characters
 * @throws {SkillsmithError} When min_score is outside 0-100 range
 *
 * @example
 * // Search for commit-related skills
 * const response = await executeSearch({ query: 'commit' });
 * console.log(`Found ${response.total} skills in ${response.timing.totalMs}ms`);
 *
 * @example
 * // Search with multiple filters
 * const response = await executeSearch({
 *   query: 'react',
 *   category: 'testing',
 *   min_score: 85
 * });
 */
export async function executeSearch(input: SearchInput): Promise<SearchResponse> {
  const startTime = performance.now()

  // Validate query
  if (!input.query || input.query.trim().length < 2) {
    throw new SkillsmithError(
      ErrorCodes.SEARCH_QUERY_EMPTY,
      'Search query must be at least 2 characters'
    )
  }

  const query = input.query.toLowerCase().trim()
  const filters: SearchFilters = {}

  // Apply category filter
  if (input.category) {
    filters.category = input.category as SkillCategory
  }

  // Apply trust tier filter
  if (input.trust_tier) {
    filters.trustTier = input.trust_tier as TrustTier
  }

  // Apply minimum score filter
  if (input.min_score !== undefined) {
    if (input.min_score < 0 || input.min_score > 100) {
      throw new SkillsmithError(
        ErrorCodes.VALIDATION_OUT_OF_RANGE,
        'min_score must be between 0 and 100',
        { details: { min_score: input.min_score } }
      )
    }
    filters.minScore = input.min_score
  }

  const searchStart = performance.now()

  // Filter and score results
  let results = mockSkills.filter((skill) => {
    // Text match
    const matchesQuery =
      skill.name.toLowerCase().includes(query) ||
      skill.description.toLowerCase().includes(query) ||
      skill.author.toLowerCase().includes(query)

    if (!matchesQuery) return false

    // Category filter
    if (filters.category && skill.category !== filters.category) {
      return false
    }

    // Trust tier filter
    if (filters.trustTier && skill.trustTier !== filters.trustTier) {
      return false
    }

    // Minimum score filter
    if (filters.minScore !== undefined && skill.score < filters.minScore) {
      return false
    }

    return true
  })

  // Sort by score (descending)
  results = results.sort((a, b) => b.score - a.score)

  // Limit to top 10
  results = results.slice(0, 10)

  const searchEnd = performance.now()
  const endTime = performance.now()

  return {
    results,
    total: results.length,
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
