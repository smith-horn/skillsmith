/**
 * SMI-579: SearchService Helpers
 *
 * Helper functions for FTS5 search operations.
 */

import type { Skill, TrustTier, SearchResult } from '../types/skill.js'
import type { FTSRow } from './SearchService.types.js'

/**
 * Escape a single FTS token
 *
 * SMI-1034: Escape FTS5 special characters to prevent syntax errors.
 * FTS5 special characters include: . " ' ( ) [ ] { } * ^ -
 * The hyphen `-` is the NOT operator in FTS5, so it must be escaped too.
 * These are replaced with spaces to ensure queries don't fail.
 */
export function escapeFtsToken(token: string): string {
  return token
    .replace(/[."'()[\]{}*^-]/g, ' ') // Replace special chars with space (including hyphen)
    .replace(/\s+/g, ' ') // Collapse multiple spaces
    .trim()
}

/**
 * Build FTS5 query with proper escaping
 *
 * SMI-1034: Enhanced to filter empty tokens after escaping special characters.
 *
 * @param query - Raw search query
 * @returns Properly formatted FTS5 query string, or empty string if no valid tokens
 */
export function buildFtsQuery(query: string): string {
  // Handle special FTS5 syntax (advanced users can use raw FTS5 queries)
  // Only pass through if quotes are balanced (phrase query) and operators are space-separated
  const quoteCount = (query.match(/"/g) || []).length
  const hasBalancedQuotes = quoteCount > 0 && quoteCount % 2 === 0
  const hasOperators = query.includes(' AND ') || query.includes(' OR ') || query.includes(' NOT ')

  if (hasBalancedQuotes || hasOperators) {
    return query
  }

  // Split into tokens, escape each, and filter empty results
  const tokens = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => escapeFtsToken(t))
    .filter((t) => t.length > 0) // Remove empty tokens after escaping

  // Return empty string if no valid tokens remain
  if (tokens.length === 0) {
    return ''
  }

  return tokens.map((t) => t + '*').join(' ')
}

/**
 * Build cache key from search options
 */
export function buildCacheKey(options: object): string {
  return `search:${JSON.stringify(options)}`
}

/**
 * Convert database row to Skill object
 */
export function rowToSkill(row: FTSRow): Skill {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    author: row.author,
    repoUrl: row.repo_url,
    qualityScore: row.quality_score,
    trustTier: row.trust_tier as TrustTier,
    tags: JSON.parse(row.tags || '[]'),
    installable: row.installable ?? false,
    // SMI-825: Security scan fields
    riskScore: row.risk_score,
    securityFindingsCount: row.security_findings_count ?? 0,
    securityScannedAt: row.security_scanned_at,
    securityPassed: row.security_passed === null ? null : row.security_passed === 1,
    // SMI-2760: Compatibility tags
    compatibility:
      row.compatibility && row.compatibility !== '[]'
        ? (JSON.parse(row.compatibility) as string[])
        : undefined,
    // SMI-5327: SPDX license (null = unknown / not detected)
    license: row.license ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Build highlighted snippets for matched terms
 */
export function buildHighlights(skill: Skill, query: string): SearchResult['highlights'] {
  const highlights: SearchResult['highlights'] = {}

  // Extract query terms (ignoring operators)
  const terms = query
    .replace(/["()]/g, '')
    .split(/\s+/)
    .filter((t) => !['AND', 'OR', 'NOT'].includes(t.toUpperCase()))
    .map((t) => t.replace(/\*$/, '').toLowerCase())
    // An empty term (a trailing space, a lone "*", an empty query) would make the
    // alternation below `(foo|)` or `()`, which matches at every character boundary
    // and wraps the whole name in <mark></mark> pairs. Same shape as the log sweep's
    // empty-surface case (SMI-6744 A1.9b, PR #2923 retro G3): filter, then guard.
    .filter((t) => t.length > 0)

  // Build regex for matching
  if (terms.length === 0) return highlights

  const source = `(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`
  // Two objects on purpose: a global regex carries lastIndex across .test() calls. The
  // shipped code never saw a leaked lastIndex, but for three different reasons -- a
  // falsy name short-circuits before the first .test(), a failing name .test() resets
  // lastIndex itself, and only on a matching name did the interleaved .replace() do the
  // resetting (PR #2923 retro G4, measured: 11 reachable paths, none lost a highlight).
  // Depending on one of three coincidences is the hazard; two objects removes it. The
  // non-global one answers "does it match"; the global one does the replacement.
  const matcher = new RegExp(source, 'i')
  const replacer = new RegExp(source, 'gi')

  // Highlight in name
  if (skill.name && matcher.test(skill.name)) {
    highlights.name = skill.name.replace(replacer, '<mark>$1</mark>')
  }

  // Highlight in description
  if (skill.description && matcher.test(skill.description)) {
    // Find the first match and extract surrounding context
    const match = skill.description.match(matcher)
    if (match) {
      // `matcher` is non-global, so `.match()` returns the exec result and carries the
      // real offset into `skill.description`. Do NOT re-derive it from a lowercased
      // copy: `toLowerCase()` is context-sensitive (Greek final sigma, `Σ` -> `ς`) and
      // length-changing (U+0130), so an offset into the lowercased string is not an
      // offset into the original and the window can silently exclude the match
      // (governance F1 on the PR #2924 core commit). `?? 0` because
      // `RegExpMatchArray.index` is declared optional.
      const index = match.index ?? 0
      const start = Math.max(0, index - 50)
      const end = Math.min(skill.description.length, index + match[0].length + 50)

      let snippet = skill.description.slice(start, end)
      if (start > 0) snippet = '...' + snippet
      if (end < skill.description.length) snippet = snippet + '...'

      highlights.description = snippet.replace(replacer, '<mark>$1</mark>')
    }
  }

  return highlights
}

/**
 * Build a search result with highlights
 */
export function buildSearchResult(row: FTSRow, query: string): SearchResult {
  const skill = rowToSkill(row)
  const highlights = buildHighlights(skill, query)

  return {
    skill,
    rank: Math.abs(row.rank), // BM25 returns negative values
    highlights,
  }
}
