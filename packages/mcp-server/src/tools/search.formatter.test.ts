/**
 * SMI-5178: formatter coverage for the compatibility-hidden notice.
 * Asserts the "+ N more skill(s) hidden" line appears only when
 * compatibilityHidden > 0 (the restrictive cross-tool default / explicit filter).
 */

import { describe, it, expect } from 'vitest'
import { formatSearchResults } from './search.formatter.js'
import { type MCPSearchResponse as SearchResponse } from '@skillsmith/core'

function baseResponse(overrides: Partial<SearchResponse> = {}): SearchResponse {
  return {
    results: [
      {
        id: 'acme/skill',
        name: 'skill',
        description: 'a skill',
        author: 'acme',
        category: 'development',
        trustTier: 'community',
        score: 80,
      },
    ],
    total: 1,
    query: 'test',
    filters: {},
    timing: { searchMs: 1, totalMs: 2 },
    ...overrides,
  }
}

describe('formatSearchResults — compatibility-hidden notice (SMI-5178)', () => {
  it('shows the hidden notice when compatibilityHidden > 0', () => {
    const out = formatSearchResults(baseResponse({ compatibilityHidden: 3 }))
    expect(out).toContain('3 more skill(s) hidden')
    expect(out).toContain('compatible_with')
  })

  it('omits the notice when compatibilityHidden is 0', () => {
    const out = formatSearchResults(baseResponse({ compatibilityHidden: 0 }))
    expect(out).not.toContain('hidden — tagged for other tools')
  })

  it('omits the notice when compatibilityHidden is absent', () => {
    const out = formatSearchResults(baseResponse())
    expect(out).not.toContain('hidden — tagged for other tools')
  })
})
