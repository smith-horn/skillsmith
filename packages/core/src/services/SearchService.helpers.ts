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
 * Build highlighted snippets for matched terms.
 *
 * Returns HTML **fragments**: the <mark> tags are markup, but the surrounding text is
 * the skill's own un-escaped name/description. Callers rendering this into a DOM MUST
 * escape around the tags -- registry-sourced descriptions are attacker-influenced text
 * (SMI-6815 tracks escaping inside this function, which changes a published API's
 * output shape).
 */
export function buildHighlights(skill: Skill, query: string): SearchResult['highlights'] {
  const highlights: SearchResult['highlights'] = {}

  // Extract query terms (ignoring operators)
  const terms = query
    .replace(/["()]/g, '')
    .split(/\s+/)
    .filter((t) => !['AND', 'OR', 'NOT'].includes(t.toUpperCase()))
    // Strip the FTS prefix-match star only. The term is NOT lowercased: the `i` flag
    // below already folds case, and lowercasing would turn a query of U+0130 (İ) into
    // two code units that match nothing (PR #2924 retro C5's one irreducible miss).
    .map((t) => t.replace(/\*$/, ''))
    // An empty term (a trailing space, a lone "*", an empty query) would make the
    // alternation below `(foo|)` or `()`, which matches at every character boundary
    // and wraps the whole name in <mark></mark> pairs. Same shape as the log sweep's
    // empty-surface case (SMI-6744 A1.9b, PR #2923 retro G3): filter, then guard.
    .filter((t) => t.length > 0)

  // Build regex for matching
  if (terms.length === 0) return highlights

  const source = `(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`
  // Two objects on purpose: a global regex carries lastIndex across .test()/.exec() calls.
  // The code before PR #2924 used ONE global object for both .test() calls and both
  // .replace() calls and never saw a leaked lastIndex, but for three different reasons --
  // a falsy name short-circuited before the first .test(), a failing name .test() reset
  // lastIndex itself, and only on a matching name did the interleaved .replace() do the
  // resetting (PR #2923 retro G4, measured: 11 reachable paths, none lost a highlight).
  // Depending on one of three coincidences is the hazard; a non-global matcher for the
  // name .test() and the description .exec(), and a global replacer for .replace(), removes it.
  // `u` as well as `i`: without it, 32 BMP code points (the Kelvin sign, Ohm, Angstrom,
  // capital sharp s, the Greek capital theta symbol U+03F4, and the 27 iota-subscript
  // capitals) fail to match their own lowercase form (PR #2924 retro C5, full-BMP sweep:
  // 33 misses with `i`, 1 with `iu`, the one being U+0130, whose lowercase is two code
  // units). Every escaped metacharacter above is a legal identity escape under `u` -- the
  // escape class IS the ECMAScript SyntaxCharacter set (governance on the PR #2925 commit:
  // 674,140 constructions over every BMP code point in seven query shapes, every SMP code
  // point and lone surrogates; none throws).
  const matcher = new RegExp(source, 'iu')
  const replacer = new RegExp(source, 'giu')

  // Highlight in name
  if (skill.name && matcher.test(skill.name)) {
    highlights.name = skill.name.replace(replacer, '<mark>$1</mark>')
  }

  // Highlight in description. `exec()` alone on the non-global matcher: a preceding
  // `.test()` would be a second full scan whose answer `exec()` already carries, and the
  // two can never disagree on a stateless regex (governance on the PR #2925 commit, F7:
  // 134,871 query/subject pairs, 0 disagreements). `RegExpExecArray.index` is required, so
  // there is no fallback to write and a future global-flag regression cannot silently place
  // the window at 0 (PR #2924 retro C4). Do NOT re-derive the offset from a lowercased
  // copy: `toLowerCase()` is context-sensitive (Greek final sigma, `Σ` -> `ς`) and
  // length-changing (U+0130), so an offset into the lowercased string is not an offset
  // into the original and the window silently excluded the match (governance F1 on the
  // PR #2924 core commit).
  const match = skill.description ? matcher.exec(skill.description) : null
  if (match && skill.description) {
    const index = match.index
    // Clamp at 0: a negative start reaches String.slice(), which counts from the end,
    // and every early match in a long description would render as a bare "...".
    let start = Math.max(0, index - 50)
    let end = Math.min(skill.description.length, index + match[0].length + 50)
    // Snap both edges to code-point boundaries: slice() counts code units, so an astral
    // character (an emoji) straddling an edge would be cut into a lone surrogate -- the
    // same code-unit-vs-code-point axis the `u` flag fixes for matching (PR #2925 retro
    // F-B). Each edge moves outward only when the unit it steps onto is the other half of
    // a REAL pair: an already-lone surrogate in the description is left where it is rather
    // than joined by a second one (governance on f7ba25392, F2).
    if (
      start > 0 &&
      /[\uDC00-\uDFFF]/.test(skill.description[start]) &&
      /[\uD800-\uDBFF]/.test(skill.description[start - 1])
    )
      start -= 1
    if (
      end < skill.description.length &&
      /[\uD800-\uDBFF]/.test(skill.description[end - 1]) &&
      /[\uDC00-\uDFFF]/.test(skill.description[end])
    )
      end += 1

    // Replace first, then add the truncation markers, so a term of dots can only
    // match dots that are in the description (PR #2924 retro C3).
    let snippet = skill.description.slice(start, end).replace(replacer, '<mark>$1</mark>')
    if (start > 0) snippet = '...' + snippet
    if (end < skill.description.length) snippet = snippet + '...'

    highlights.description = snippet
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
