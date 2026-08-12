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
  mergeRankAndPage,
  compatibilityWantedSlugs,
  computeLocalCompatFetchLimit,
  mapApiSkillToSearchResult,
  mapLocalSkillToSearchResult,
  resolveDefaultCompatibility,
  buildEmptySearchSuggestion,
  resolveSearchLimit,
} from './search.helpers.js'
// SMI-5929: DEFAULT_SEARCH_LIMIT/MIN_SEARCH_LIMIT/MAX_SEARCH_LIMIT moved with
// the schema to search.schema.ts (only referenced in this file's own JSDoc).
export { formatSearchResults } from './search.formatter.js'
// SMI-5929: schema split into search.schema.ts to stay under the 500-line gate.
export { searchToolSchema } from './search.schema.js'

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
  /**
   * SMI-5896: Maximum results to return. Defaults to `DEFAULT_SEARCH_LIMIT`
   * (10, see search.helpers.ts) when omitted; clamped (not rejected) to
   * [`MIN_SEARCH_LIMIT`, `MAX_SEARCH_LIMIT`] otherwise.
   */
  limit?: number
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

  // SMI-5896: hardcoded to 10 in both branches below despite the description
  // already advertising `limit` — it was simply never read. resolveSearchLimit
  // doubles as this parameter's validation boundary (args aren't validated).
  const limit = resolveSearchLimit(input.limit)

  const searchStart = performance.now()

  // SMI-1183: Try API first, fall back to local DB
  if (!context.apiClient.isOffline()) {
    try {
      // SMI-5929: forward wanted compat slugs so the edge fn can rank+widen
      // its DB fetch BEFORE its own LIMIT/OFFSET (see sortByCompatRank doc).
      const wantedCompat = [...compatibilityWantedSlugs(filters.compatibleWith)]
      const apiResponse = await context.apiClient.search({
        query: hasQuery ? input.query!.trim() : '',
        limit,
        offset: 0,
        trustTier: filters.trustTier ? mapTrustTierToDb(filters.trustTier) : undefined,
        minQualityScore: filters.minScore,
        category: filters.category,
        compatibility: wantedCompat.length > 0 ? wantedCompat : undefined,
      })

      const searchEnd = performance.now()

      // SMI-5563: API row → SkillSearchResult (mapApiSkillToSearchResult, search.helpers.ts).
      const results: SkillSearchResult[] = apiResponse.data.map(mapApiSkillToSearchResult)

      // SMI-1809: merge with local skills; skip if trust_tier excludes them.
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

      // Merge local-first, then registry — mergeRankAndPage compat-ranks each
      // bucket separately so local-first stays the OUTER key (an API result
      // can never outrank a local one; see its doc in search.helpers.ts).
      // SMI-5178/C1: effectiveInstallableOnly defaults ON.
      const effectiveInstallableOnly = input.installable_only ?? true
      const { pageResults, mergedTotal, discoveryOnlyHidden, compatibilityDeprioritized } =
        mergeRankAndPage({
          localResults,
          apiResults: results,
          compatibleWith: filters.compatibleWith,
          installableOnly: effectiveInstallableOnly,
          limit, // SMI-5896: was hardcoded to 10
        })

      const endTime = performance.now()

      const response: SearchResponse = {
        results: pageResults,
        // SMI-4954/C1: key off effectiveInstallableOnly so default-ON also
        // reports the filtered total (not the registry grand-total). SMI-5929:
        // mergedTotal now includes previously rank-2-excluded rows — an
        // intentional correction (this under-reported availability before).
        total: effectiveInstallableOnly
          ? mergedTotal
          : ((apiResponse.meta?.total as number) ?? results.length) + localResults.length,
        query: input.query || '', // May be empty for filter-only searches
        filters,
        compatibilityDeprioritized,
        discoveryOnlyHidden,
        // SMI-5556: guidance for the calling agent when results are empty.
        suggestion: pageResults.length
          ? undefined
          : buildEmptySearchSuggestion({ discoveryOnlyHidden }),
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

  // SMI-5929 code-review finding, MEDIUM: widen the local fetch when a
  // compat filter is active — the MCP tool never exposes `offset`, so
  // there's no cross-page consistency concern here, just a flat overfetch
  // (computeLocalCompatFetchLimit). mergeRankAndPage below still slices to
  // the true `limit`.
  const localCompatFilterActive = compatibilityWantedSlugs(filters.compatibleWith).size > 0
  const searchResults = context.searchService.search({
    query: searchQuery,
    limit: computeLocalCompatFetchLimit(limit, localCompatFilterActive),
    offset: 0,
    trustTier: dbTrustTier,
    minQualityScore: filters.minScore,
    category: filters.category,
    // SMI-825: Security filters
    safeOnly: filters.safeOnly,
    maxRiskScore: filters.maxRiskScore,
  })

  const searchEnd = performance.now()

  // SMI-5337 retro: local DB row → SkillSearchResult (mapLocalSkillToSearchResult, search.helpers.ts).
  const results: SkillSearchResult[] = searchResults.items.map(mapLocalSkillToSearchResult)

  // SMI-1809: merge with local skills; skip if trust_tier excludes them.
  let localResults: SkillSearchResult[] = []
  if (!filters.trustTier || filters.trustTier === ('local' as TrustTier)) {
    try {
      localResults = await searchLocalSkills(searchQuery, filters, quarantineRepo)
    } catch (localError) {
      console.warn('[skillsmith] Local skill search failed:', (localError as Error).message)
    }
  }

  // SMI-5929: offline branch never calls the edge fn — compat-rank runs
  // entirely client-side here via the same mergeRankAndPage helper.
  // SMI-5178/C1: effectiveInstallableOnly defaults ON.
  const effectiveInstallableOnly = input.installable_only ?? true
  const { pageResults, mergedTotal, discoveryOnlyHidden, compatibilityDeprioritized } =
    mergeRankAndPage({
      localResults,
      apiResults: results,
      compatibleWith: filters.compatibleWith,
      installableOnly: effectiveInstallableOnly,
      limit, // SMI-5896: was hardcoded to 10
    })

  const endTime = performance.now()

  const response: SearchResponse = {
    results: pageResults,
    // SMI-4954/C1/SMI-5929: see the API branch's identical comment above.
    total: effectiveInstallableOnly ? mergedTotal : searchResults.total + localResults.length,
    query: input.query || '', // May be empty for filter-only searches
    filters,
    compatibilityDeprioritized,
    discoveryOnlyHidden,
    // SMI-5556: guidance for the calling agent when results are empty.
    suggestion: pageResults.length
      ? undefined
      : buildEmptySearchSuggestion({ discoveryOnlyHidden }),
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
