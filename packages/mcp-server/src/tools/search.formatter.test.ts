/**
 * SMI-5178: formatter coverage for the compatibility-hidden notice.
 * Asserts the "+ N more skill(s) hidden" line appears only when
 * compatibilityHidden > 0 (the restrictive cross-tool default / explicit filter).
 *
 * SMI-5327: license display in search results.
 */

import { describe, it, expect } from 'vitest'
import { formatSearchResults } from './search.formatter.js'
import { type MCPSearchResponse as SearchResponse, type SkillSearchResult } from '@skillsmith/core'

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

  // SMI-5556: when the tool-provided suggestion is present, it replaces the
  // hardcoded bullet list entirely.
  it('prefers response.suggestion over the hardcoded bullet list when present', () => {
    const out = formatSearchResults(
      baseResponse({
        results: [],
        total: 0,
        suggestion: 'Try a single-topic query per call instead.',
      })
    )
    expect(out).toContain('Try a single-topic query per call instead.')
    expect(out).not.toContain('Suggestions:')
  })
})

describe('formatSearchResults — license display (SMI-5327)', () => {
  it('renders the SPDX identifier verbatim when license is "MIT"', () => {
    const out = formatSearchResults(
      baseResponse({
        results: [
          {
            id: 'acme/skill',
            name: 'skill',
            description: 'a skill',
            author: 'acme',
            category: 'development',
            trustTier: 'community',
            score: 80,
            license: 'MIT',
          },
        ],
      })
    )
    expect(out).toContain('License: MIT')
    expect(out).not.toContain('License: Unknown')
  })

  it('renders "License: Unknown" when license is null', () => {
    const out = formatSearchResults(
      baseResponse({
        results: [
          {
            id: 'acme/skill',
            name: 'skill',
            description: 'a skill',
            author: 'acme',
            category: 'development',
            trustTier: 'community',
            score: 80,
            license: null,
          },
        ],
      })
    )
    expect(out).toContain('License: Unknown')
    // Must NOT imply any permissive conclusion for a null license
    expect(out).not.toContain('no license')
    expect(out).not.toContain('unrestricted')
    expect(out).not.toContain('freely usable')
    expect(out).not.toContain('public domain')
  })

  it('renders "License: Unknown" when license field is absent', () => {
    // baseResponse skill has no license field — same as undefined
    const out = formatSearchResults(baseResponse())
    expect(out).toContain('License: Unknown')
  })

  it('renders "License: Unknown" when license is an empty string', () => {
    const out = formatSearchResults(
      baseResponse({
        results: [
          {
            id: 'acme/skill',
            name: 'skill',
            description: 'a skill',
            author: 'acme',
            category: 'development',
            trustTier: 'community',
            score: 80,
            license: '',
          },
        ],
      })
    )
    expect(out).toContain('License: Unknown')
  })

  it('renders "License: Unknown" when license is whitespace-only', () => {
    const out = formatSearchResults(
      baseResponse({
        results: [
          {
            id: 'acme/skill',
            name: 'skill',
            description: 'a skill',
            author: 'acme',
            category: 'development',
            trustTier: 'community',
            score: 80,
            license: '   ',
          },
        ],
      })
    )
    expect(out).toContain('License: Unknown')
  })
})

/**
 * SMI-2734: Tests for installHint field in formatSearchResults
 * Verifies registry skills surface the owner/name install ID and local skills do not.
 *
 * Moved from search.test.ts during SMI-5556 to keep that file under the
 * 500-line gate after adding empty-result suggestion coverage.
 */
describe('SMI-2734: formatSearchResults installHint', () => {
  const baseSkill: SkillSearchResult = {
    id: 'a129e127-a82c-47e5-8bc5-09d7ba2e8734',
    name: 'performance',
    description: 'Web performance auditing skill',
    author: 'addyosmani',
    category: 'development',
    trustTier: 'verified',
    score: 84,
    source: 'registry',
  }

  const makeResponse = (results: SkillSearchResult[]) => ({
    results,
    total: results.length,
    query: 'performance',
    filters: {},
    timing: { searchMs: 10, totalMs: 12 },
  })

  it('should display Install line for a registry skill with installHint set', () => {
    const skill: SkillSearchResult = { ...baseSkill, installHint: 'addyosmani/performance' }
    const formatted = formatSearchResults(makeResponse([skill]))

    expect(formatted).toContain('Install: addyosmani/performance')
  })

  it('should not display Install line when installHint is absent', () => {
    const skill: SkillSearchResult = { ...baseSkill }
    // installHint intentionally not set (local skill or unknown author)
    const formatted = formatSearchResults(makeResponse([skill]))

    expect(formatted).not.toContain('Install:')
  })

  it('should display Install line only for skills that have installHint in a mixed result set', () => {
    const registrySkill: SkillSearchResult = {
      ...baseSkill,
      id: 'b1',
      name: 'commit',
      author: 'anthropic',
      installHint: 'anthropic/commit',
      source: 'registry',
    }
    const localSkill: SkillSearchResult = {
      ...baseSkill,
      id: 'b2',
      name: 'my-local-skill',
      author: 'local-user',
      source: 'local',
      // installHint intentionally absent for local skill
    }
    const formatted = formatSearchResults(makeResponse([registrySkill, localSkill]))

    expect(formatted).toContain('Install: anthropic/commit')
    // The local skill section should not contain an Install line
    // Split on blank lines between skill entries to isolate each block
    const sections = formatted.split('\n\n')
    const localSection = sections.find((s) => s.includes('my-local-skill'))
    expect(localSection).toBeDefined()
    expect(localSection).not.toContain('Install:')
  })
})

/**
 * SMI-2759: Tests for repository field in formatSearchResults
 *
 * Moved from search.test.ts during SMI-5556 to keep that file under the
 * 500-line gate after adding empty-result suggestion coverage.
 */
describe('SMI-2759: formatSearchResults repository', () => {
  const baseSkill: SkillSearchResult = {
    id: 'c1-repo-test',
    name: 'repo-skill',
    description: 'A skill with a source repository',
    author: 'testauthor',
    category: 'development',
    trustTier: 'community',
    score: 75,
    source: 'registry',
  }

  const makeResponse = (results: SkillSearchResult[]) => ({
    results,
    total: results.length,
    query: 'repo',
    filters: {},
    timing: { searchMs: 5, totalMs: 7 },
  })

  it('should display Repository line when repository is set', () => {
    const skill: SkillSearchResult = {
      ...baseSkill,
      repository: 'https://github.com/testauthor/repo-skill',
    }
    const formatted = formatSearchResults(makeResponse([skill]))
    expect(formatted).toContain('Repository: https://github.com/testauthor/repo-skill')
  })

  it('should not display Repository line when repository is absent', () => {
    const skill: SkillSearchResult = { ...baseSkill }
    const formatted = formatSearchResults(makeResponse([skill]))
    expect(formatted).not.toContain('Repository:')
  })
})
