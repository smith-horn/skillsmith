/**
 * @fileoverview Pure helpers for the MCP search tool (SMI-5178).
 * @module @skillsmith/mcp-server/tools/search.helpers
 *
 * Split from search.ts to keep it under the 500-line governance limit and to
 * isolate the cross-ecosystem compatibility logic. Imports only types + the
 * canonical slug map from @skillsmith/core — no import from search.ts, so there
 * is no circular dependency.
 */

import {
  type SkillSearchResult,
  type CompatibilityFilter,
  type ApiSearchResult,
  CLIENT_TO_COMPATIBILITY_SLUG,
  type SearchResult,
} from '@skillsmith/core'
import { extractCategoryFromTags, mapTrustTierFromDb } from '../utils/validation.js'
import { deriveSecuritySummaryFromApiSkill } from '../utils/security-summary.js'

/**
 * SMI-2760: Filter search results by compatibility tags.
 * Skills with no compatibility data are included (`[]`/absent = unknown/unscoped,
 * NOT incompatible — they may be compatible but simply haven't declared it).
 * Skills that HAVE declared compatibility must include at least one requested slug.
 */
export function filterByCompatibility(
  results: SkillSearchResult[],
  filter: CompatibilityFilter
): SkillSearchResult[] {
  const wanted = new Set([...(filter.ides ?? []), ...(filter.llms ?? [])])
  if (wanted.size === 0) return results
  return results.filter(
    (skill) =>
      !skill.compatibility ||
      skill.compatibility.length === 0 ||
      skill.compatibility.some((tag) => wanted.has(tag))
  )
}

/**
 * SMI-4954: Drop discovery-only skills when `installable_only` is requested.
 * A skill is installable when it has a registry install source (`repo_url`
 * present). Client-side filter applied to the merged result page, so an
 * `installable_only` search may return fewer than the page limit.
 *
 * SMI-5178 (C3): treat `installable === null` / absent as installable — the
 * stored column is frequently null for rows that DO have a repo_url. Only
 * explicitly `false` marks a discovery-only entry.
 */
export function filterInstallable(
  results: SkillSearchResult[],
  installableOnly: boolean | undefined
): SkillSearchResult[] {
  if (!installableOnly) return results
  return results.filter((skill) => skill.installable !== false)
}

/**
 * SMI-5178: Restrictive cross-tool default. Returns a CompatibilityFilter scoped
 * to the user's EXPLICITLY-set client, or `undefined` when unset.
 *
 * Gated on an explicit client value (e.g. `SKILLSMITH_CLIENT`) — NOT the resolved
 * client, which falls back to `claude-code` for unset users (`install/paths.ts`).
 * Keying off the fallback would silently hide cross-tool content from the unset
 * majority; unset MUST stay permissive (show-all + report hidden count).
 */
export function resolveDefaultCompatibility(
  explicitClient: string | undefined
): CompatibilityFilter | undefined {
  const client = explicitClient?.trim()
  if (!client) return undefined
  const slug = CLIENT_TO_COMPATIBILITY_SLUG[client]
  if (!slug) return undefined
  return { ides: [slug] }
}

/**
 * SMI-5563: Map an API search-result row (registry path) to the
 * SkillSearchResult wire format used by the MCP search tool.
 *
 * Extracted from search.ts to keep that file under the 500-line governance
 * limit. Mirrors mapLocalSkillToSearchResult below — added so the registry
 * path stops silently dropping `security` even though skills-search already
 * hydrates security_score/last_scanned_at/security_findings/quarantined
 * server-side (SMI-4251).
 *
 * SMI-1491: repository field for installation source transparency.
 * SMI-2734: installHint guarded on a real registry owner.
 * SMI-2760: compatibility tags (read via cast — see inline comment below).
 * SMI-5327: SPDX license.
 * SMI-5563: security summary via the shared deriveSecuritySummaryFromApiSkill helper.
 */
export function mapApiSkillToSearchResult(item: ApiSearchResult): SkillSearchResult {
  return {
    id: item.id,
    name: item.name,
    description: item.description || '',
    author: item.author || 'unknown',
    category: extractCategoryFromTags(item.tags),
    trustTier: mapTrustTierFromDb(item.trust_tier),
    score: Math.round((item.quality_score ?? 0) * 100),
    repository: item.repo_url || undefined,
    // SMI-5178: trust the authoritative `installable` column; repo_url heuristic only as fallback.
    installable: item.installable ?? Boolean(item.repo_url),
    // SMI-2734: 'author/name' install ID — valid for all registry API results
    installHint: item.author ? item.author + '/' + item.name : undefined,
    // SMI-2760 / SMI-5178: compatibility tags. `compatibility` is on ApiSkill
    // + the Zod schema (so it survives validation at runtime), but the built
    // ApiSearchResult type does not surface it through the api-client's
    // ApiResponse<T> at this call site (CI typecheck confirms), so it is read
    // via a cast — the value is present at runtime.
    compatibility: (item as unknown as { compatibility?: string[] }).compatibility,
    // SMI-5327: SPDX license from the edge function response.
    license: item.license ?? null,
    // SMI-5563: security summary — parity with mapLocalSkillToSearchResult
    // and get_skill (SMI-4240). undefined when the skill has never been scanned.
    security: deriveSecuritySummaryFromApiSkill(item),
  }
}

/**
 * SMI-5337 retro: Map a local SearchService result item to the SkillSearchResult
 * wire format used by the MCP search tool.
 *
 * Extracted from search.ts to keep that file under the 500-line governance limit.
 * Mirrors the API-path mapping in executeSearchImpl with parity on all fields
 * including the SMI-5327 license field.
 *
 * SMI-1491: repository field for installation source transparency.
 * SMI-825:  security summary.
 * SMI-2734: installHint guarded on real registry owner (not 'unknown').
 * SMI-2760: compatibility tags.
 * SMI-5327: SPDX license parity with the API path.
 */
export function mapLocalSkillToSearchResult(item: SearchResult): SkillSearchResult {
  return {
    id: item.skill.id,
    name: item.skill.name,
    description: item.skill.description || '',
    author: item.skill.author || 'unknown',
    category: extractCategoryFromTags(item.skill.tags),
    trustTier: mapTrustTierFromDb(item.skill.trustTier),
    score: Math.round((item.skill.qualityScore ?? 0) * 100), // Convert 0-1 to 0-100
    repository: item.skill.repoUrl || undefined,
    // SMI-4954: installable when the local DB row carries a repoUrl
    installable: Boolean(item.skill.repoUrl),
    // SMI-2734: Only set installHint when author is a real registry owner (not 'unknown')
    installHint:
      item.skill.author && item.skill.author !== 'unknown'
        ? item.skill.author + '/' + item.skill.name
        : undefined,
    // SMI-825: Security summary
    security: {
      passed: item.skill.securityPassed,
      riskScore: item.skill.riskScore,
      findingsCount: item.skill.securityFindingsCount,
      scannedAt: item.skill.securityScannedAt,
    },
    // SMI-2760: Compatibility tags
    compatibility: item.skill.compatibility,
    // SMI-5327: SPDX license — parity with API path's `item.license ?? null`
    license: item.skill.license ?? null,
  }
}

// ============================================================================
// Empty-Result Guidance (SMI-5556)
// ============================================================================

/**
 * Build a `suggestion` string for a zero-result search response, explaining
 * that matching is keyword-based (not semantic) and requires every query term
 * to co-occur, so multi-concept queries often return nothing even when a
 * relevant skill exists — plus any filter-specific hints.
 */
export function buildEmptySearchSuggestion(context: {
  discoveryOnlyHidden?: number
  compatibilityHidden?: number
}): string {
  const lines = [
    'No matches. Search is keyword-based (not semantic) and requires every query ' +
      "term to appear in a skill's indexed name/description/tags — multi-concept " +
      'queries (e.g. "Next.js Supabase testing") often return nothing even when a ' +
      'relevant skill exists.',
    'Try a single-topic query per call instead (e.g. "testing", then "supabase") ' +
      'and combine the results yourself.',
  ]
  if (context.discoveryOnlyHidden) {
    lines.push(
      `${context.discoveryOnlyHidden} discovery-only result(s) were hidden by the ` +
        'default installable_only filter — pass installable_only: false to include them.'
    )
  }
  if (context.compatibilityHidden) {
    lines.push(
      `${context.compatibilityHidden} result(s) were hidden by a compatibility filter ` +
        '— remove compatible_with to broaden the search.'
    )
  }
  return lines.join(' ')
}
