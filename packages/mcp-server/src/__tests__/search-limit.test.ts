/**
 * SMI-5896 Wave 3 Step 3: `limit` threading tests for MCP `search`.
 *
 * Before this fix, `search`'s own description text advertised a `limit`
 * parameter that didn't exist in the input schema/type — a caller-supplied
 * `limit` was silently dropped by MCP argument validation, and both the
 * API-path and local-fallback branches hardcoded `.slice(0, 10)`. Covers the
 * plan's required test matrix: API-path success, local-fallback path,
 * omitted `limit` (defaults to 10), out-of-range `limit` (clamped, not
 * rejected) — plus a schema/description-drift regression guard.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { executeSearch, searchToolSchema } from '../tools/search.js'
import {
  resolveSearchLimit,
  DEFAULT_SEARCH_LIMIT,
  MIN_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
} from '../tools/search.helpers.js'
import { createTestContext, disposeTestContext, type ToolContext } from './test-utils.js'
import * as LocalSkillSearchModule from '../tools/LocalSkillSearch.js'

let context: ToolContext

beforeAll(async () => {
  context = await createTestContext()

  // Seed 15 installable skills that all match the query "widget" so a
  // `limit` smaller than the total match count actually truncates results.
  for (let i = 0; i < 15; i++) {
    context.skillRepository.create({
      id: `local/widget-${i}`,
      name: `widget-${i}`,
      description: 'A widget-related test skill',
      author: 'local',
      repoUrl: `https://github.com/local/widget-${i}`,
      qualityScore: 0.8,
      trustTier: 'community',
      tags: ['widget'],
    })
  }
})

afterAll(async () => {
  await disposeTestContext(context)
})

afterEach(async () => {
  vi.restoreAllMocks()
})

describe('search `limit` — schema/description parity (SMI-5896 regression guard)', () => {
  it('advertises `limit` in the input schema, not just the description text', () => {
    // Guards the exact drift this wave fixed: the description already
    // claimed `limit` existed before the schema field was added.
    expect(searchToolSchema.description).toContain('limit')
    expect(searchToolSchema.inputSchema.properties).toHaveProperty('limit')
  })

  it('schema bounds match the resolver’s exported MIN/MAX/DEFAULT constants', () => {
    const limitSchema = searchToolSchema.inputSchema.properties.limit
    expect(limitSchema.minimum).toBe(MIN_SEARCH_LIMIT)
    expect(limitSchema.maximum).toBe(MAX_SEARCH_LIMIT)
    expect(limitSchema.description).toContain(String(DEFAULT_SEARCH_LIMIT))
  })
})

describe('resolveSearchLimit (unit)', () => {
  it('defaults to DEFAULT_SEARCH_LIMIT when omitted', () => {
    expect(resolveSearchLimit(undefined)).toBe(DEFAULT_SEARCH_LIMIT)
  })

  it('defaults to DEFAULT_SEARCH_LIMIT for NaN', () => {
    expect(resolveSearchLimit(Number.NaN)).toBe(DEFAULT_SEARCH_LIMIT)
  })

  it('clamps a value below MIN_SEARCH_LIMIT up to the minimum', () => {
    expect(resolveSearchLimit(-5)).toBe(MIN_SEARCH_LIMIT)
    expect(resolveSearchLimit(0)).toBe(MIN_SEARCH_LIMIT)
  })

  it('clamps a value above MAX_SEARCH_LIMIT down to the maximum', () => {
    expect(resolveSearchLimit(500)).toBe(MAX_SEARCH_LIMIT)
  })

  it('passes an in-range integer through unchanged', () => {
    expect(resolveSearchLimit(37)).toBe(37)
  })

  it('truncates a fractional value', () => {
    expect(resolveSearchLimit(4.9)).toBe(4)
  })

  // `tool-dispatch.ts` hands `search` its raw JSON args with a bare cast and
  // no runtime schema check, so resolveSearchLimit is the validation boundary
  // for `limit` — non-numeric JSON must resolve to the default rather than
  // propagating NaN into `.slice(0, limit)` (which silently returns nothing).
  it('falls back to the default for JSON null rather than clamping to 1', () => {
    expect(resolveSearchLimit(null)).toBe(DEFAULT_SEARCH_LIMIT)
  })

  it('falls back to the default for a non-numeric string', () => {
    expect(resolveSearchLimit('abc')).toBe(DEFAULT_SEARCH_LIMIT)
    expect(resolveSearchLimit('')).toBe(DEFAULT_SEARCH_LIMIT)
    expect(resolveSearchLimit('   ')).toBe(DEFAULT_SEARCH_LIMIT)
  })

  it('falls back to the default for non-number, non-string JSON values', () => {
    expect(resolveSearchLimit(true)).toBe(DEFAULT_SEARCH_LIMIT)
    expect(resolveSearchLimit([])).toBe(DEFAULT_SEARCH_LIMIT)
    expect(resolveSearchLimit({})).toBe(DEFAULT_SEARCH_LIMIT)
  })

  it('coerces a numeric string the way a JSON-RPC client might send it', () => {
    expect(resolveSearchLimit('25')).toBe(25)
  })

  it('clamps ±Infinity instead of falling back to the default', () => {
    expect(resolveSearchLimit(Number.POSITIVE_INFINITY)).toBe(MAX_SEARCH_LIMIT)
    expect(resolveSearchLimit(Number.NEGATIVE_INFINITY)).toBe(MIN_SEARCH_LIMIT)
  })
})

describe('search `limit` — unvalidated-boundary regression (SMI-5896)', () => {
  beforeEach(() => {
    vi.spyOn(LocalSkillSearchModule, 'searchLocalSkills').mockResolvedValue([])
  })

  it('returns the default page (not zero results) when a client sends limit: null', async () => {
    // Regression: an unhardened resolver turned `null` into 1 and a
    // non-numeric value into NaN, making `.slice(0, NaN)` return [].
    const result = await executeSearch(
      { query: 'widget', limit: null } as unknown as Parameters<typeof executeSearch>[0],
      context
    )
    expect(result.results.length).toBe(DEFAULT_SEARCH_LIMIT)
  })

  it('returns the default page when a client sends a non-numeric limit', async () => {
    const result = await executeSearch(
      { query: 'widget', limit: 'lots' } as unknown as Parameters<typeof executeSearch>[0],
      context
    )
    expect(result.results.length).toBe(DEFAULT_SEARCH_LIMIT)
  })
})

describe('search `limit` — local-fallback path (offline)', () => {
  beforeEach(() => {
    vi.spyOn(LocalSkillSearchModule, 'searchLocalSkills').mockResolvedValue([])
  })

  it('respects an explicit in-range limit', async () => {
    const result = await executeSearch({ query: 'widget', limit: 5 }, context)
    expect(result.results.length).toBe(5)
  })

  it('defaults to 10 when limit is omitted', async () => {
    const result = await executeSearch({ query: 'widget' }, context)
    expect(result.results.length).toBe(DEFAULT_SEARCH_LIMIT)
  })

  it('clamps an out-of-range limit instead of rejecting the request', async () => {
    const result = await executeSearch({ query: 'widget', limit: 1000 }, context)
    // Clamped to MAX_SEARCH_LIMIT (100), but only 15 fixtures exist.
    expect(result.results.length).toBe(15)
    expect(result.results.length).toBeLessThanOrEqual(MAX_SEARCH_LIMIT)
  })

  it('clamps a sub-minimum limit to 1 rather than rejecting or returning 0', async () => {
    const result = await executeSearch({ query: 'widget', limit: -3 }, context)
    expect(result.results.length).toBe(1)
  })
})

describe('search `limit` — API path (online)', () => {
  beforeEach(() => {
    vi.spyOn(LocalSkillSearchModule, 'searchLocalSkills').mockResolvedValue([])
    vi.spyOn(context.apiClient, 'isOffline').mockReturnValue(false)
  })

  it('forwards the resolved limit to apiClient.search', async () => {
    const searchSpy = vi.spyOn(context.apiClient, 'search').mockResolvedValue({
      data: Array.from({ length: 20 }, (_, i) => ({
        id: `registry/widget-${i}`,
        name: `widget-${i}`,
        description: 'Registry widget',
        author: 'registry',
        tags: ['widget'],
        trust_tier: 'verified' as const,
        quality_score: 0.9,
        repo_url: `https://github.com/registry/widget-${i}`,
      })),
      meta: { total: 20 },
    })

    const result = await executeSearch({ query: 'widget', limit: 7 }, context)

    expect(searchSpy).toHaveBeenCalledWith(expect.objectContaining({ limit: 7 }))
    expect(result.results.length).toBe(7)
  })

  it('defaults to 10 on the API path when limit is omitted', async () => {
    vi.spyOn(context.apiClient, 'search').mockResolvedValue({
      data: Array.from({ length: 20 }, (_, i) => ({
        id: `registry/widget-${i}`,
        name: `widget-${i}`,
        description: 'Registry widget',
        author: 'registry',
        tags: ['widget'],
        trust_tier: 'verified' as const,
        quality_score: 0.9,
        repo_url: `https://github.com/registry/widget-${i}`,
      })),
      meta: { total: 20 },
    })

    const result = await executeSearch({ query: 'widget' }, context)
    expect(result.results.length).toBe(DEFAULT_SEARCH_LIMIT)
  })

  it('clamps an out-of-range limit on the API path instead of rejecting', async () => {
    const searchSpy = vi.spyOn(context.apiClient, 'search').mockResolvedValue({
      data: [],
      meta: { total: 0 },
    })

    await executeSearch({ query: 'widget', limit: 250 }, context)

    expect(searchSpy).toHaveBeenCalledWith(expect.objectContaining({ limit: MAX_SEARCH_LIMIT }))
  })
})
