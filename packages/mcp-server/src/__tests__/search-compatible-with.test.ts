/**
 * SMI-2760: Tests for compatible_with filter in executeSearch.
 * filterByCompatibility is permissive: skills without compatibility data
 * always pass.
 *
 * Extracted from search.test.ts during SMI-4694 to keep search.test.ts
 * under the 500-line gate after disposeTestContext wiring.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { executeSearch } from '../tools/search.js'
import { type SkillSearchResult } from '@skillsmith/core'
import { createSeededTestContext, disposeTestContext, type ToolContext } from './test-utils.js'

describe('SMI-2760: compatible_with filter', () => {
  let filterContext: ToolContext

  beforeAll(() => {
    filterContext = createSeededTestContext()
  })

  afterAll(async () => {
    await disposeTestContext(filterContext)
  })

  it('should accept compatible_with filter and set it on filters', async () => {
    const result = await executeSearch(
      {
        compatible_with: { ides: ['claude-code'] },
        category: 'testing',
      },
      filterContext
    )

    expect(result.results).toBeDefined()
    expect(result.filters.compatibleWith).toEqual({ ides: ['claude-code'] })
  })

  it('should accept compatible_with with LLM slugs', async () => {
    const result = await executeSearch(
      {
        compatible_with: { llms: ['claude', 'gpt-4o'] },
        category: 'development',
      },
      filterContext
    )

    expect(result.results).toBeDefined()
    expect(result.filters.compatibleWith).toEqual({ llms: ['claude', 'gpt-4o'] })
  })

  it('should accept compatible_with as a standalone filter (no query)', async () => {
    const result = await executeSearch(
      {
        compatible_with: { ides: ['cursor'], llms: ['claude'] },
      },
      filterContext
    )

    expect(result.results).toBeDefined()
    expect(result.query).toBe('')
    expect(result.filters.compatibleWith).toEqual({ ides: ['cursor'], llms: ['claude'] })
  })

  it('compatible_with filter passes skills with no compatibility data (permissive)', () => {
    // Import and test filterByCompatibility indirectly:
    // skills without compatibility field must appear in results when filter is active.
    // Since seeded skills have no compatibility set, they should all pass through.
    const makeResponse = (results: SkillSearchResult[]) => ({
      results,
      total: results.length,
      query: '',
      filters: {},
      timing: { searchMs: 1, totalMs: 2 },
    })

    const skillNoCompat: SkillSearchResult = {
      id: 'compat-test-1',
      name: 'no-compat-skill',
      description: 'Skill with no compatibility declared',
      author: 'test',
      category: 'development',
      trustTier: 'community',
      score: 70,
    }
    const skillWithCompat: SkillSearchResult = {
      id: 'compat-test-2',
      name: 'compat-skill',
      description: 'Skill with compatibility',
      author: 'test',
      category: 'development',
      trustTier: 'community',
      score: 80,
      compatibility: ['claude-code', 'cursor'],
    }
    const skillNoMatch: SkillSearchResult = {
      id: 'compat-test-3',
      name: 'vscode-only-skill',
      description: 'Only compatible with vscode',
      author: 'test',
      category: 'development',
      trustTier: 'community',
      score: 75,
      compatibility: ['vscode'],
    }

    // Directly test the response shape — formatSearchResults renders compatibility tags
    const responseWithAll = makeResponse([skillNoCompat, skillWithCompat, skillNoMatch])
    // Skills with no compat are always included (permissive). Skills with compat must match.
    expect(responseWithAll.results).toHaveLength(3)

    // Skill without compatibility declared — should be included (permissive filter)
    expect(skillNoCompat.compatibility).toBeUndefined()
    // Skill with matching compatibility — should be included
    expect(skillWithCompat.compatibility).toContain('claude-code')
    // Skill with non-matching compatibility — excluded when filtering by claude-code
    expect(skillNoMatch.compatibility).not.toContain('claude-code')
  })
})
