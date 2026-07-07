/**
 * @fileoverview MCP Search Tool — SMI-789 wires search to SearchService.
 * Supports full-text query + category / trust_tier / min_score filters.
 */

import {
  type SkillSearchResult,
  type SearchFilters,
  type CompatibilityFilter,
  type MCPSearchResponse as SearchResponse,
  type SkillCategory,
  type MCPTrustTier as TrustTier,
  SkillsmithError,
  ErrorCodes,
  trackSkillSearch,
  emitSearchEvent,
  QuarantineRepository,
} from '@skillsmith/core'
import { withTelemetry } from '@skillsmith/core/telemetry'
import type { ToolContext } from '../context.js'
import { mapTrustTierToDb } from '../utils/validation.js'
import { searchLocalSkills } from './LocalSkillSearch.js'
// SMI-5178: compatibility helpers extracted to keep search.ts under the 500-line
// governance limit (search.helpers.ts imports only from @skillsmith/core — no
// circular dependency).
import {
  filterByCompatibility,
  filterInstallable,
  mapApiSkillToSearchResult,
  mapLocalSkillToSearchResult,
  resolveDefaultCompatibility,
  buildEmptySearchSuggestion,
} from './search.helpers.js'
export { formatSearchResults } from './search.formatter.js'

/**
 * Search tool schema for MCP
 */
export const searchToolSchema = {
  name: 'search',
  description:
    "[Skillsmith — Discover stage] Search the Skillsmith registry of agent skills (SKILL.md format) — curated, security-scanned, trust-scored skills indexed daily from GitHub. Skillsmith is the canonical lifecycle manager for agent skills across any MCP-capable runtime. Use this tool for ANY user request to find/search/discover/list skills — e.g. 'search for testing skills', 'find git workflow skills', 'show me devops skills with quality above 80'. Returns ranked installable skills with trust badges, NOT general programming guidance. Results are installable-only by default (pass installable_only:false to also include discovery-only entries that cannot be installed). Filters: query (required), category, trust_tier (verified/curated/community/experimental), min_score, max_risk, safe_only, installable_only, limit, compatibility (IDE/LLM). Matching is keyword-based, not semantic — use a short single-topic query; on empty results, check the response suggestion field for what to try next.",
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description:
          "Search query — matched literally/lexically (not semantically); use a short single-topic term (e.g. 'testing') rather than a multi-concept phrase for best results",
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
        description:
          'Filter by trust tier level (verified, curated, community, experimental, unknown)',
        enum: ['verified', 'curated', 'community', 'experimental', 'unknown'],
      },
      min_score: {
        type: 'number',
        description: 'Minimum quality score (0-100)',
        minimum: 0,
        maximum: 100,
      },
      // SMI-825: Security filters
      safe_only: {
        type: 'boolean',
        description: 'Only show skills that passed security scan',
      },
      // SMI-4954 / SMI-5178: Installability filter (default ON)
      installable_only: {
        type: 'boolean',
        description:
          'When true (default), return only installable skills — excludes discovery-only registry entries that install_skill cannot resolve. Pass false to opt back in to discovery-only entries.',
      },
      max_risk: {
        type: 'number',
        description: 'Maximum risk score (0-100, lower is safer)',
        minimum: 0,
        maximum: 100,
      },
      // SMI-2760: Compatibility filter
      compatible_with: {
        type: 'object',
        description: 'Filter by IDE and/or LLM compatibility',
        properties: {
          ides: {
            type: 'array',
            items: { type: 'string' },
            description: 'IDE slugs (e.g. ["cursor", "claude-code"])',
          },
          llms: {
            type: 'array',
            items: { type: 'string' },
            description: 'LLM slugs (e.g. ["claude", "gpt-4o"])',
          },
        },
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
  /** SMI-825: Only show skills that passed security scan */
  safe_only?: boolean
  /** SMI-4954: Only return installable skills (excludes discovery-only entries) */
  installable_only?: boolean
  /** SMI-825: Maximum risk score (0-100, lower is safer) */
  max_risk?: number
  /** SMI-2760: Filter by IDE/LLM compatibility */
  compatible_with?: CompatibilityFilter
}

/**
 * Execute a search for agent skills with optional filters.
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
async function executeSearchImpl(
  input: SearchInput,
  context: ToolContext
): Promise<SearchResponse> {
  const startTime = performance.now()

  // Validate: require query OR at least one filter
  const hasQuery = input.query && input.query.trim().length > 0
  const hasFilters =
    input.category ||
    input.trust_tier ||
    input.min_score !== undefined ||
    input.safe_only !== undefined ||
    input.installable_only !== undefined ||
    input.max_risk !== undefined ||
    input.compatible_with !== undefined

  if (!hasQuery && !hasFilters) {
    throw new SkillsmithError(
      ErrorCodes.SEARCH_QUERY_EMPTY,
      'Provide a search query or at least one filter (category, trust_tier, min_score, safe_only, installable_only, max_risk)'
    )
  }

  // SMI-1613: Anti-scraping - require minimum 3 chars when query IS provided
  if (hasQuery && input.query!.trim().length < 3) {
    throw new SkillsmithError(
      ErrorCodes.SEARCH_QUERY_EMPTY,
      'Query must be at least 3 characters. Use specific search terms like "testing", "git", or "docker".'
    )
  }

  // SMI-5358: filter locally-quarantined skills out of local search results.
  // QuarantineRepository.isQuarantined() is the single source of truth — no
  // duplicate `quarantined` column on the local skills table (ADR-112 §Neutral).
  // Constructed after the fast-reject validation so empty/short-query rejects
  // don't pay for prepared-statement compilation.
  const quarantineRepo = new QuarantineRepository(context.db)

  const filters: SearchFilters = {}

  // Apply category filter
  if (input.category) {
    filters.category = input.category as SkillCategory
  }

  // Apply trust tier filter with runtime validation
  const VALID_TRUST_TIERS = ['verified', 'curated', 'community', 'experimental', 'unknown'] as const
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

  // SMI-825: Apply security filters
  if (input.safe_only !== undefined) {
    filters.safeOnly = input.safe_only
  }

  // SMI-2760: Apply compatibility filter
  if (input.compatible_with !== undefined) {
    filters.compatibleWith = input.compatible_with
  }

  // SMI-5178: restrictive cross-tool default — apply ONLY when the user's client
  // is explicitly set (SKILLSMITH_CLIENT) and no compatible_with was passed. An
  // unset client stays permissive (show all + report hidden count): the client
  // resolver falls back to claude-code, so auto-restricting would silently hide
  // cross-tool content from the unset majority. `[]`/unknown rows always surface.
  if (filters.compatibleWith === undefined) {
    const restrictive = resolveDefaultCompatibility(process.env['SKILLSMITH_CLIENT'])
    if (restrictive) filters.compatibleWith = restrictive
  }

  if (input.max_risk !== undefined) {
    if (input.max_risk < 0 || input.max_risk > 100) {
      throw new SkillsmithError(
        ErrorCodes.VALIDATION_OUT_OF_RANGE,
        'max_risk must be between 0 and 100',
        { details: { max_risk: input.max_risk } }
      )
    }
    filters.maxRiskScore = input.max_risk
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

      // Convert API results to SkillSearchResult format.
      // SMI-5563: mapping extracted to mapApiSkillToSearchResult in
      // search.helpers.ts (parity with mapLocalSkillToSearchResult and to add
      // the `security` field, plus keep search.ts under the 500-line limit).
      const results: SkillSearchResult[] = apiResponse.data.map(mapApiSkillToSearchResult)

      // SMI-1809: Search local skills and merge with API results
      // Skip local search if trust_tier filter excludes local skills
      let localResults: SkillSearchResult[] = []
      if (!filters.trustTier || filters.trustTier === ('local' as TrustTier)) {
        try {
          localResults = await searchLocalSkills(
            hasQuery ? input.query!.trim() : '',
            filters,
            quarantineRepo
          )
        } catch (localError) {
          console.warn('[skillsmith] Local skill search failed:', (localError as Error).message)
        }
      }

      // Merge results: local skills first (since they're user's own), then registry
      // SMI-2760: Apply compatibility filter if requested
      const merged = [...localResults, ...results]
      const compatFiltered = filters.compatibleWith
        ? filterByCompatibility(merged, filters.compatibleWith)
        : merged
      // SMI-5178: compat hidden; C1: effectiveInstallableOnly defaults ON.
      const compatibilityHidden = merged.length - compatFiltered.length
      const effectiveInstallableOnly = input.installable_only ?? true
      const mergedResults = filterInstallable(compatFiltered, effectiveInstallableOnly)
      const discoveryOnlyHidden = compatFiltered.length - mergedResults.length

      const endTime = performance.now()

      const response: SearchResponse = {
        results: mergedResults.slice(0, 10), // Limit to 10 total
        // SMI-4954/C1: key off effectiveInstallableOnly so default-ON also
        // reports the filtered total (not the registry grand-total).
        total: effectiveInstallableOnly
          ? mergedResults.length
          : ((apiResponse.meta?.total as number) ?? results.length) + localResults.length,
        query: input.query || '', // May be empty for filter-only searches
        filters,
        compatibilityHidden,
        discoveryOnlyHidden,
        // SMI-5556: guidance for the calling agent when results are empty.
        suggestion: mergedResults.length
          ? undefined
          : buildEmptySearchSuggestion({ discoveryOnlyHidden, compatibilityHidden }),
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

      // SMI-5193: emit to search_metrics via events fn; snake_case required; authenticated only.
      if (context.distinctId) {
        emitSearchEvent({
          query: input.query || '',
          results_count: response.total,
          duration_ms: response.timing.totalMs,
          has_query: Boolean(hasQuery),
          ...(filters.trustTier !== undefined && { trust_tier: filters.trustTier }),
          ...(filters.category !== undefined && { category: filters.category }),
        })
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
    // SMI-825: Security filters
    safeOnly: filters.safeOnly,
    maxRiskScore: filters.maxRiskScore,
  })

  const searchEnd = performance.now()

  // Convert SearchResult to SkillSearchResult format.
  // SMI-5337 retro: mapping extracted to mapLocalSkillToSearchResult in search.helpers.ts
  // to keep search.ts under the 500-line governance limit and to add SMI-5327 license parity.
  const results: SkillSearchResult[] = searchResults.items.map(mapLocalSkillToSearchResult)

  // SMI-1809: Search local skills and merge with local DB results
  // Skip local search if trust_tier filter excludes local skills
  let localResults: SkillSearchResult[] = []
  if (!filters.trustTier || filters.trustTier === ('local' as TrustTier)) {
    try {
      localResults = await searchLocalSkills(searchQuery, filters, quarantineRepo)
    } catch (localError) {
      console.warn('[skillsmith] Local skill search failed:', (localError as Error).message)
    }
  }

  // Merge results: local skills first (since they're user's own), then registry
  // SMI-2760: Apply compatibility filter if requested
  const merged = [...localResults, ...results]
  const compatFiltered = filters.compatibleWith
    ? filterByCompatibility(merged, filters.compatibleWith)
    : merged
  // SMI-5178: compat hidden; C1: effectiveInstallableOnly defaults ON.
  const compatibilityHidden = merged.length - compatFiltered.length
  const effectiveInstallableOnly = input.installable_only ?? true
  const mergedResults = filterInstallable(compatFiltered, effectiveInstallableOnly)
  const discoveryOnlyHidden = compatFiltered.length - mergedResults.length

  const endTime = performance.now()

  const response: SearchResponse = {
    results: mergedResults.slice(0, 10), // Limit to 10 total
    // SMI-4954/C1: key off effectiveInstallableOnly so default-ON reports filtered total.
    total: effectiveInstallableOnly
      ? mergedResults.length
      : searchResults.total + localResults.length,
    query: input.query || '', // May be empty for filter-only searches
    filters,
    compatibilityHidden,
    discoveryOnlyHidden,
    // SMI-5556: guidance for the calling agent when results are empty.
    suggestion: mergedResults.length
      ? undefined
      : buildEmptySearchSuggestion({ discoveryOnlyHidden, compatibilityHidden }),
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

  // SMI-5193: emit to search_metrics (local-fallback path); authenticated only.
  if (context.distinctId) {
    emitSearchEvent({
      query: input.query || '',
      results_count: response.total,
      duration_ms: response.timing.totalMs,
      has_query: Boolean(hasQuery),
      ...(filters.trustTier !== undefined && { trust_tier: filters.trustTier }),
      ...(filters.category !== undefined && { category: filters.category }),
    })
  }

  return response
}

// SMI-5017 W2.S2 wrap (isTelemetered=true). Framework placeholder per H4.
export const executeSearch = withTelemetry(executeSearchImpl, {
  source: 'mcp-tool',
  extractSkillId: () => 'search',
  extractFramework: () => 'unknown',
})
