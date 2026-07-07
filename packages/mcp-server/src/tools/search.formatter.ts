/**
 * @fileoverview Formatter for MCP search tool output
 * @module @skillsmith/mcp-server/tools/search.formatter
 * @see SMI-2759: Split from search.ts to maintain 500-line governance limit
 *
 * Provides human-readable formatting of search results for terminal/CLI display.
 */

import type { MCPSearchResponse as SearchResponse } from '@skillsmith/core'
import { getTrustBadge } from '../utils/validation.js'

/**
 * Format search results for terminal/CLI display.
 *
 * Produces a human-readable string with skill listings including
 * trust badges, scores, repository links, and timing information.
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
 * //    Repository: https://github.com/...
 */
export function formatSearchResults(response: SearchResponse): string {
  const lines: string[] = []

  lines.push('\n=== Search Results for "' + response.query + '" ===\n')

  if (response.results.length === 0) {
    lines.push('No skills found matching your query.')
    lines.push('')
    // SMI-5556: prefer the response's own suggestion (surfaced through the raw
    // MCP JSON too) over re-deriving the same guidance here.
    if (response.suggestion) {
      lines.push(response.suggestion)
    } else {
      lines.push('Suggestions:')
      lines.push('  - Try different keywords')
      lines.push('  - Remove filters to broaden the search')
      lines.push('  - Check spelling')
      // SMI-5178: hint that the default installable-only filter may be the cause.
      lines.push(
        '  - Discovery-only entries are hidden by default — pass installable_only: false to include them'
      )
    }
  } else {
    lines.push('Found ' + response.total + ' skill(s):\n')

    response.results.forEach((skill, index) => {
      const trustBadge = getTrustBadge(skill.trustTier)
      lines.push(index + 1 + '. ' + skill.name + ' ' + trustBadge)
      const securityStatus =
        skill.security?.passed === true
          ? 'PASS'
          : skill.security?.passed === false
            ? 'FAIL (' + (skill.security.riskScore ?? '?') + '/100)'
            : 'N/A'
      lines.push(
        '   Author: ' +
          skill.author +
          ' | Score: ' +
          skill.score +
          '/100 | Security: ' +
          securityStatus
      )
      lines.push('   ' + skill.description)
      lines.push('   ID: ' + skill.id)
      // SMI-5327: surface license so consumers can evaluate usage terms.
      // null / undefined / whitespace-only means the license was not detected —
      // render "Unknown" (NOT "no license", "unrestricted", or "freely usable").
      lines.push('   License: ' + (skill.license?.trim() || 'Unknown'))
      // SMI-4954: flag discovery-only entries so models don't try to install them
      if (skill.installable === false) {
        lines.push('   Installable: NO — discovery-only (install_skill cannot resolve this)')
      }
      // SMI-2734: Surface registry install ID so models can use owner/name directly
      if (skill.installHint) {
        lines.push('   Install: ' + skill.installHint)
      }
      // SMI-2759: Surface repository link for source transparency
      if (skill.repository) {
        lines.push('   Repository: ' + skill.repository)
      }
      lines.push('')
    })
  }

  // SMI-5178: surface how many results were hidden by the default installable filter
  // so the model/user knows discovery-only entries exist and how to include them.
  if (response.discoveryOnlyHidden && response.discoveryOnlyHidden > 0) {
    lines.push('')
    lines.push(
      '+ ' +
        response.discoveryOnlyHidden +
        ' discovery-only result(s) hidden — pass installable_only: false to include them.'
    )
  }

  // SMI-5178: surface how many results were hidden by the compatibility filter
  // (the restrictive cross-tool default or an explicit compatible_with) so the
  // model/user knows the view is scoped to their tool and can broaden it.
  if (response.compatibilityHidden && response.compatibilityHidden > 0) {
    lines.push('')
    lines.push(
      '+ ' +
        response.compatibilityHidden +
        ' more skill(s) hidden — tagged for other tools. Pass compatible_with to change the filter.'
    )
  }

  // Add timing info
  lines.push('---')
  lines.push(
    'Search: ' + response.timing.searchMs + 'ms | Total: ' + response.timing.totalMs + 'ms'
  )

  return lines.join('\n')
}
