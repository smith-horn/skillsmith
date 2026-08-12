/**
 * @fileoverview MCP `search` tool's JSON schema definition.
 *
 * Split out of search.ts (SMI-5929's own fixes pushed it back over the
 * 500-line governance limit) — this is a self-contained, static object with
 * no logic dependency on the rest of search.ts.
 */

import { MIN_SEARCH_LIMIT, MAX_SEARCH_LIMIT, DEFAULT_SEARCH_LIMIT } from './search.helpers.js'

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
      // SMI-2760/SMI-5929: compatibility is a RANKING signal, not an exclusion
      // filter — declared-incompatible skills rank lower but are still returned.
      compatible_with: {
        type: 'object',
        description: 'Rank by IDE and/or LLM compatibility (deprioritizes, never excludes)',
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
      // SMI-5896: advertised in the description but absent here. Bounds are
      // advisory to the client only — resolveSearchLimit() enforces them.
      limit: {
        type: 'number',
        description: `Maximum results to return (default ${DEFAULT_SEARCH_LIMIT}). Out-of-range values are clamped, not rejected.`,
        minimum: MIN_SEARCH_LIMIT,
        maximum: MAX_SEARCH_LIMIT,
      },
    },
    required: [], // Query is optional if filters are provided
  },
}
