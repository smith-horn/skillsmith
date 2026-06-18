/**
 * SMI-4954: Tests for the `installable` signal and `installable_only` filter.
 *
 * `installable` is derived from a registry `repo_url` being present — discovery-only
 * entries (repo_url null, SMI-2723) cannot be resolved by `install_skill`. Covers
 * the online API path mapping, the `installable_only` filter, and the `search` /
 * `get_skill` formatter output. Split into its own file to keep search.test.ts
 * and get-skill.test.ts under the 500-line gate.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { executeSearch, formatSearchResults } from '../tools/search.js'
import { formatSkillDetails } from '../tools/get-skill.js'
import type { SkillSearchResult, GetSkillResponse } from '@skillsmith/core'
import { createTestContext, disposeTestContext, type ToolContext } from './test-utils.js'
import * as LocalSkillSearchModule from '../tools/LocalSkillSearch.js'

let onlineContext: ToolContext

beforeAll(async () => {
  onlineContext = await createTestContext()
})

afterAll(async () => {
  await disposeTestContext(onlineContext)
})

describe('SMI-4954: installable signal — online API path', () => {
  beforeEach(() => {
    // Suppress local skill search so the assertions only see registry results.
    vi.spyOn(LocalSkillSearchModule, 'searchLocalSkills').mockResolvedValue([])
    vi.spyOn(onlineContext.apiClient, 'isOffline').mockReturnValue(false)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const apiResults = [
    {
      id: 'getsentry/commit',
      name: 'commit',
      description: 'Commit helper',
      author: 'getsentry',
      tags: ['git'],
      trust_tier: 'verified' as const,
      quality_score: 0.95,
      repo_url: 'https://github.com/getsentry/commit',
    },
    {
      id: 'claude-plugins/discovery-only',
      name: 'discovery-only',
      description: 'A discovery-only registry entry',
      author: 'claude-plugins',
      tags: [],
      trust_tier: 'community' as const,
      quality_score: 0.6,
      repo_url: null,
    },
  ]

  it('derives installable from repo_url presence', async () => {
    vi.spyOn(onlineContext.apiClient, 'search').mockResolvedValue({
      data: apiResults,
      meta: { total: 2 },
    })

    // Pass installable_only: false so both rows are returned and we can inspect the signal.
    const result = await executeSearch({ query: 'commit', installable_only: false }, onlineContext)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(result.results.find((r: any) => r.name === 'commit')?.installable).toBe(true)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(result.results.find((r: any) => r.name === 'discovery-only')?.installable).toBe(false)
  })

  it('installable_only: true explicitly excludes discovery-only entries', async () => {
    vi.spyOn(onlineContext.apiClient, 'search').mockResolvedValue({
      data: apiResults,
      meta: { total: 2 },
    })

    const result = await executeSearch({ query: 'commit', installable_only: true }, onlineContext)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(result.results.every((r: any) => r.installable !== false)).toBe(true)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(result.results.find((r: any) => r.name === 'discovery-only')).toBeUndefined()
    // (C1) total reflects the filtered set, not the registry grand-total.
    expect(result.total).toBe(result.results.length)
    // discoveryOnlyHidden reports what was filtered.
    expect(result.discoveryOnlyHidden).toBe(1)
  })

  it('(SMI-5178) DEFAULT ON: without installable_only, discovery-only entries are filtered out', async () => {
    vi.spyOn(onlineContext.apiClient, 'search').mockResolvedValue({
      data: apiResults,
      meta: { total: 2 },
    })

    const result = await executeSearch({ query: 'commit' }, onlineContext)

    // Default is installable-only — discovery-only is hidden.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(result.results.find((r: any) => r.name === 'discovery-only')).toBeUndefined()
    // (C1) total equals the filtered count (not the grand total of 2).
    expect(result.total).toBe(result.results.length)
    // discoveryOnlyHidden tells callers how many were hidden.
    expect(result.discoveryOnlyHidden).toBe(1)
  })

  it('installable_only: false opts out — discovery-only entries are included', async () => {
    vi.spyOn(onlineContext.apiClient, 'search').mockResolvedValue({
      data: apiResults,
      meta: { total: 2 },
    })

    const result = await executeSearch({ query: 'commit', installable_only: false }, onlineContext)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(result.results.find((r: any) => r.name === 'discovery-only')).toBeDefined()
    // discoveryOnlyHidden is 0 when the filter is off.
    expect(result.discoveryOnlyHidden ?? 0).toBe(0)
  })

  // SMI-5178 ground-truth: API now returns the authoritative `installable` column.
  // A row with installable=false + repo_url present must be hidden by the default
  // filter (these are the 54 prod rows the fix is targeting).
  it('(SMI-5178) installable=false + repo_url present is DROPPED by default filter', async () => {
    vi.spyOn(onlineContext.apiClient, 'search').mockResolvedValue({
      data: [
        {
          id: 'getsentry/commit',
          name: 'commit',
          description: 'Commit helper',
          author: 'getsentry',
          tags: ['git'],
          trust_tier: 'verified' as const,
          quality_score: 0.95,
          repo_url: 'https://github.com/getsentry/commit',
          installable: true,
        },
        {
          id: 'acme/broken-skillmd',
          name: 'broken-skillmd',
          description: 'Repo exists but SKILL.md did not resolve at index time',
          author: 'acme',
          tags: [],
          trust_tier: 'community' as const,
          quality_score: 0.5,
          repo_url: 'https://github.com/acme/broken-skillmd', // non-null repo_url…
          installable: false, // …but indexer says not installable
        },
      ],
      meta: { total: 2 },
    })

    const result = await executeSearch({ query: 'commit' }, onlineContext)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(result.results.find((r: any) => r.name === 'broken-skillmd')).toBeUndefined()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(result.results.find((r: any) => r.name === 'commit')).toBeDefined()
    expect(result.discoveryOnlyHidden).toBe(1)
  })

  it('(SMI-5178) installable=false + repo_url present is INCLUDED when installable_only=false', async () => {
    vi.spyOn(onlineContext.apiClient, 'search').mockResolvedValue({
      data: [
        {
          id: 'acme/broken-skillmd',
          name: 'broken-skillmd',
          description: 'Repo exists but SKILL.md did not resolve',
          author: 'acme',
          tags: [],
          trust_tier: 'community' as const,
          quality_score: 0.5,
          repo_url: 'https://github.com/acme/broken-skillmd',
          installable: false,
        },
      ],
      meta: { total: 1 },
    })

    const result = await executeSearch({ query: 'broken', installable_only: false }, onlineContext)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const found = result.results.find((r: any) => r.name === 'broken-skillmd')
    expect(found).toBeDefined()
    expect(found?.installable).toBe(false)
    expect(result.discoveryOnlyHidden ?? 0).toBe(0)
  })

  it('(SMI-5178) API item without installable field falls back to repo_url heuristic', async () => {
    vi.spyOn(onlineContext.apiClient, 'search').mockResolvedValue({
      data: [
        {
          id: 'acme/old-api-skill',
          name: 'old-api-skill',
          description: 'Older API response without installable field',
          author: 'acme',
          tags: [],
          trust_tier: 'community' as const,
          quality_score: 0.7,
          repo_url: 'https://github.com/acme/old-api-skill',
          // installable field intentionally absent — simulates older API response
        },
      ],
      meta: { total: 1 },
    })

    const result = await executeSearch({ query: 'old', installable_only: false }, onlineContext)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const found = result.results.find((r: any) => r.name === 'old-api-skill')
    expect(found).toBeDefined()
    // Absent installable → fallback to Boolean(repo_url) → true
    expect(found?.installable).toBe(true)
  })
})

describe('SMI-4954: installable signal — formatters', () => {
  const baseSkill: SkillSearchResult = {
    id: 's1',
    name: 'sample',
    description: 'A sample skill',
    author: 'acme',
    category: 'development',
    trustTier: 'community',
    score: 70,
    source: 'registry',
  }

  const makeResponse = (results: SkillSearchResult[]) => ({
    results,
    total: results.length,
    query: 'sample',
    filters: {},
    timing: { searchMs: 1, totalMs: 2 },
  })

  it('formatSearchResults flags a discovery-only result', () => {
    const formatted = formatSearchResults(makeResponse([{ ...baseSkill, installable: false }]))
    expect(formatted).toContain('Installable: NO')
  })

  it('formatSearchResults does not flag an installable result', () => {
    const formatted = formatSearchResults(makeResponse([{ ...baseSkill, installable: true }]))
    expect(formatted).not.toContain('Installable: NO')
  })

  it('formatSkillDetails shows a discovery-only skill as not installable', () => {
    const response: GetSkillResponse = {
      skill: {
        id: 's1',
        name: 'sample',
        description: 'A sample skill',
        author: 'acme',
        category: 'development',
        trustTier: 'community',
        score: 70,
        tags: [],
        installable: false,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      installCommand: 'claude skill add s1',
      timing: { totalMs: 1 },
    }

    expect(formatSkillDetails(response)).toContain('Installable: NO')
  })

  it('formatSkillDetails shows an installable skill as installable', () => {
    const response: GetSkillResponse = {
      skill: {
        id: 's2',
        name: 'sample2',
        description: 'Another sample skill',
        author: 'acme',
        category: 'development',
        trustTier: 'verified',
        score: 90,
        tags: [],
        installable: true,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      installCommand: 'claude skill add s2',
      timing: { totalMs: 1 },
    }

    expect(formatSkillDetails(response)).toContain('Installable: yes')
  })
})
