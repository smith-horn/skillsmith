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
  CLIENT_TO_COMPATIBILITY_SLUG,
} from '@skillsmith/core'

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
 */
export function filterInstallable(
  results: SkillSearchResult[],
  installableOnly: boolean | undefined
): SkillSearchResult[] {
  if (!installableOnly) return results
  return results.filter((skill) => skill.installable === true)
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
