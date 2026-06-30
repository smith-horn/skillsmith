/**
 * @fileoverview Tests for the `search` command's remote-first helper.
 * @see SMI-5427 — remote-default search: autoSyncIfEmpty is removed.
 *
 * searchRemoteOrLocal() tries the API first, falling back to local on network
 * errors when the local index has rows, and returns typed outcomes so the
 * caller can branch cleanly (quota / auth / empty / results).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  SkillRepository,
  SkillsmithError,
  ErrorCodes,
  ApiClientError,
  type DatabaseType,
} from '@skillsmith/core'

// ---------------------------------------------------------------------------
// Mock @skillsmith/core API surface used by searchRemoteOrLocal
// ---------------------------------------------------------------------------

const mockSearch = vi.fn()
const mockGetSkill = vi.fn()
const mockIsOffline = vi.fn(() => false)

vi.mock('@skillsmith/core', async () => {
  const actual = await vi.importActual<typeof import('@skillsmith/core')>('@skillsmith/core')
  return {
    ...actual,
    createApiClient: vi.fn(() => ({
      search: mockSearch,
      getSkill: mockGetSkill,
      isOffline: mockIsOffline,
    })),
    loadStoredAccessToken: vi.fn<() => Promise<string | null>>().mockResolvedValue(null),
  }
})

// ora must no-op cleanly in the test environment (non-TTY).
vi.mock('ora', () => {
  const spinner = {
    start: vi.fn(() => spinner),
    succeed: vi.fn(() => spinner),
    warn: vi.fn(() => spinner),
    fail: vi.fn(() => spinner),
    stop: vi.fn(() => spinner),
    text: '',
  }
  return { default: vi.fn(() => spinner) }
})

import { openCliDatabase } from '../src/utils/open-database.js'
import { closeDatabase } from '@skillsmith/core'
import { searchRemoteOrLocal } from '../src/commands/search.helpers.js'

async function freshDb(): Promise<DatabaseType> {
  return openCliDatabase(':memory:')
}

/** Seed one skill so count() > 0. */
function seedSkill(db: DatabaseType): void {
  new SkillRepository(db).create({
    id: 'community/seed-skill',
    name: 'seed-skill',
    description: 'a pre-existing skill',
    trustTier: 'community',
  })
}

/** Minimal valid ApiSearchResult shape. */
function makeApiResult(id = 'community/test', name = 'test') {
  return {
    id,
    name,
    description: 'Test skill',
    author: 'community',
    repo_url: 'https://github.com/community/test',
    quality_score: 80,
    trust_tier: 'community',
    tags: [],
    stars: 10,
    installable: true,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  }
}

describe('SMI-5427: searchRemoteOrLocal', () => {
  let db: DatabaseType

  beforeEach(async () => {
    vi.clearAllMocks()
    mockIsOffline.mockReturnValue(false)
    db = await freshDb()
  })

  afterEach(() => {
    closeDatabase(db)
  })

  // -------------------------------------------------------------------------
  // Remote-first: happy path
  // -------------------------------------------------------------------------

  it('returns remote results when API responds successfully', async () => {
    const apiResult = makeApiResult()
    mockSearch.mockResolvedValue({ data: [apiResult], meta: { total: 1 } })

    const outcome = await searchRemoteOrLocal({ query: 'test', limit: 10 }, db)

    expect(mockSearch).toHaveBeenCalledTimes(1)
    expect(outcome.kind).toBe('results')
    if (outcome.kind === 'results') {
      expect(outcome.items).toHaveLength(1)
      expect(outcome.items[0]!.skill.name).toBe('test')
    }
  })

  it('sets hasMore=true when the page is full', async () => {
    const items = Array.from({ length: 10 }, (_, i) => makeApiResult(`c/s${i}`, `s${i}`))
    mockSearch.mockResolvedValue({ data: items, meta: { total: 10 } })

    const outcome = await searchRemoteOrLocal({ query: 'test', limit: 10 }, db)

    expect(outcome.kind).toBe('results')
    if (outcome.kind === 'results') {
      expect(outcome.hasMore).toBe(true)
    }
  })

  it('sets hasMore=false when the page is not full', async () => {
    mockSearch.mockResolvedValue({ data: [makeApiResult()], meta: { total: 1 } })

    const outcome = await searchRemoteOrLocal({ query: 'test', limit: 10 }, db)

    expect(outcome.kind).toBe('results')
    if (outcome.kind === 'results') {
      expect(outcome.hasMore).toBe(false)
    }
  })

  // -------------------------------------------------------------------------
  // Typed error outcomes
  // -------------------------------------------------------------------------

  it('returns kind:quota on NETWORK_QUOTA_EXCEEDED — no silent fallback', async () => {
    mockSearch.mockRejectedValue(
      new SkillsmithError(ErrorCodes.NETWORK_QUOTA_EXCEEDED, 'Quota exceeded.', {})
    )
    seedSkill(db) // Even with a populated local DB, quota must not fall back.

    const outcome = await searchRemoteOrLocal({ query: 'test', limit: 10 }, db)

    expect(outcome.kind).toBe('quota')
    if (outcome.kind === 'quota') {
      expect(outcome.message).toContain('Quota exceeded')
    }
  })

  it('returns kind:auth on ApiClientError 401', async () => {
    mockSearch.mockRejectedValue(new ApiClientError('Unauthorized', false, 401))
    seedSkill(db)

    const outcome = await searchRemoteOrLocal({ query: 'test', limit: 10 }, db)

    expect(outcome.kind).toBe('auth')
  })

  it('returns kind:auth on ApiClientError 403', async () => {
    mockSearch.mockRejectedValue(new ApiClientError('Forbidden', false, 403))
    seedSkill(db)

    const outcome = await searchRemoteOrLocal({ query: 'test', limit: 10 }, db)

    expect(outcome.kind).toBe('auth')
  })

  // -------------------------------------------------------------------------
  // Network error + local fallback
  // -------------------------------------------------------------------------

  it('falls back to local results when offline and count()>0', async () => {
    seedSkill(db)
    mockSearch.mockRejectedValue(new TypeError('fetch failed'))

    const outcome = await searchRemoteOrLocal({ query: 'seed', limit: 10 }, db)

    expect(outcome.kind).toBe('results')
    // mockSearch was called (attempted remote), then fell back.
    expect(mockSearch).toHaveBeenCalledTimes(1)
  })

  it('falls back to local on ECONNREFUSED error string', async () => {
    seedSkill(db)
    const err = new Error('connect ECONNREFUSED 127.0.0.1:443')
    mockSearch.mockRejectedValue(err)

    const outcome = await searchRemoteOrLocal({ query: 'seed', limit: 10 }, db)

    expect(outcome.kind).toBe('results')
  })

  it('returns kind:empty when offline AND local DB is empty', async () => {
    mockSearch.mockRejectedValue(new TypeError('fetch failed'))
    // No skills seeded — count() = 0.

    const outcome = await searchRemoteOrLocal({ query: 'test', limit: 10 }, db)

    expect(outcome.kind).toBe('empty')
  })

  it('returns kind:empty when API client is in offlineMode AND local is empty', async () => {
    mockIsOffline.mockReturnValue(true)
    // No skills seeded.

    const outcome = await searchRemoteOrLocal({ query: 'test', limit: 10 }, db)

    expect(outcome.kind).toBe('empty')
    expect(mockSearch).not.toHaveBeenCalled()
  })

  it('uses local when API client is in offlineMode AND local has rows', async () => {
    mockIsOffline.mockReturnValue(true)
    seedSkill(db)

    const outcome = await searchRemoteOrLocal({ query: 'seed', limit: 10 }, db)

    expect(outcome.kind).toBe('results')
    expect(mockSearch).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // --safe-only / --max-risk forwarded to API
  // -------------------------------------------------------------------------

  it('forwards safeOnly to apiClient.search()', async () => {
    mockSearch.mockResolvedValue({ data: [], meta: { total: 0 } })

    await searchRemoteOrLocal({ query: 'test', limit: 10, safeOnly: true }, db)

    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({ safeOnly: true }))
  })

  it('forwards maxRiskScore to apiClient.search()', async () => {
    mockSearch.mockResolvedValue({ data: [], meta: { total: 0 } })

    await searchRemoteOrLocal({ query: 'test', limit: 10, maxRiskScore: 25 }, db)

    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({ maxRiskScore: 25 }))
  })

  // -------------------------------------------------------------------------
  // toSkill() mapping via SkillsmithApiClient
  // -------------------------------------------------------------------------

  it('maps ApiSearchResult to SearchResult via SkillsmithApiClient.toSkill', async () => {
    const apiResult = makeApiResult('verified/cool', 'cool')
    mockSearch.mockResolvedValue({ data: [apiResult], meta: { total: 1 } })

    const outcome = await searchRemoteOrLocal({ query: 'cool', limit: 10 }, db)

    expect(outcome.kind).toBe('results')
    if (outcome.kind === 'results') {
      const skill = outcome.items[0]!.skill
      // SkillsmithApiClient.toSkill maps trust_tier → trustTier
      expect(skill).toMatchObject({
        id: 'verified/cool',
        name: 'cool',
      })
    }
  })
})

// ---------------------------------------------------------------------------
// autoSyncIfEmpty removal regression: it no longer exists
// ---------------------------------------------------------------------------

describe('autoSyncIfEmpty removal (SMI-5427)', () => {
  it('does NOT export autoSyncIfEmpty (removed in SMI-5427)', async () => {
    const helpers = await import('../src/commands/search.helpers.js')
    expect((helpers as Record<string, unknown>)['autoSyncIfEmpty']).toBeUndefined()
  })
})
