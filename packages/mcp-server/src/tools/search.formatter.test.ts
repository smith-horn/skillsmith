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

describe('formatSearchResults — discovery-only hidden notice (SMI-5178)', () => {
  it('shows discovery-only hidden line with installable_only: false token when discoveryOnlyHidden > 0', () => {
    const out = formatSearchResults(baseResponse({ discoveryOnlyHidden: 5 }))
    expect(out).toContain('5 discovery-only result(s) hidden')
    // Must emit the literal escape-hatch token
    expect(out).toContain('installable_only: false')
  })

  it('discovery-only notice is distinct from the compatibility notice in wording', () => {
    const out = formatSearchResults(
      baseResponse({ discoveryOnlyHidden: 2, compatibilityHidden: 3 })
    )
    expect(out).toContain('discovery-only result(s) hidden')
    expect(out).toContain('tagged for other tools')
    // The two lines must be different
    expect(out.indexOf('discovery-only result(s) hidden')).not.toBe(
      out.indexOf('tagged for other tools')
    )
  })

  it('omits the discovery-only notice when discoveryOnlyHidden is 0', () => {
    const out = formatSearchResults(baseResponse({ discoveryOnlyHidden: 0 }))
    expect(out).not.toContain('discovery-only result(s) hidden')
  })

  it('omits the discovery-only notice when discoveryOnlyHidden is absent', () => {
    const out = formatSearchResults(baseResponse())
    expect(out).not.toContain('discovery-only result(s) hidden')
  })

  it('zero-result branch mentions installable_only: false as a suggestion', () => {
    const out = formatSearchResults(baseResponse({ results: [], total: 0, discoveryOnlyHidden: 0 }))
    expect(out).toContain('installable_only: false')
  })
})
