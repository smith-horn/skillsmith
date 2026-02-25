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

  // Add timing info
  lines.push('---')
  lines.push(
    'Search: ' + response.timing.searchMs + 'ms | Total: ' + response.timing.totalMs + 'ms'
  )

  return lines.join('\n')
}
