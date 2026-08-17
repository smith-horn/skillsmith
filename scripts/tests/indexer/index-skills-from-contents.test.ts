/**
 * Tree-hash cache round-trip integration test (SMI-4878)
 * @module scripts/tests/indexer/index-skills-from-contents
 *
 * Exercises `indexSkillsFromContents` end-to-end with `vi.fn()` HTTP mocks to
 * pin the SMI-4861 Wave 1 plain-path tree-hash cache gate: a warm cache entry
 * whose blob SHA matches the current Trees API SHA must increment
 * `cacheCounters.hits` AND skip the per-skill `raw.githubusercontent.com`
 * SKILL.md fetch (the expensive call the cache exists to avoid).
 *
 * `tree-hash-cache.test.ts` already covers the pure `treeHashCacheHit`
 * predicate in isolation. This file covers the wiring: that
 * `indexSkillsFromContents` reads `plainPathBlobShas`, builds the right cache
 * key, and short-circuits before `checkSkillMdExists` on a hit. SMI-4879's
 * `fetchPlainPathTreeMap` Trees-API parsing is exercised here too, since the
 * blob-SHA map it produces is the input to the cache gate.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { indexSkillsFromContents, type RepoData } from '../../indexer/index-skills-from-contents.ts'
import { fetchPlainPathTreeMap } from '../../indexer/trees-search.ts'
import { newRateLimitTelemetry } from '../../indexer/_shared/rate-limit.ts'
import type { SkillMdValidation } from '../../indexer/skill-processor.ts'
import type { HighTrustAuthor } from '../../indexer/high-trust-authors.ts'
import {
  treeHashCacheKey,
  type TreeHashCache,
  type TreeHashCacheCounters,
} from '../../indexer/tree-hash-cache.ts'
// SMI-5436 Wave 2: each SKILL.md validation now also fires one CDN fetch per BUNDLED_SCAN_FILES
// entry (sibling scan). All return null from the undefined mock — fail-open, skill not quarantined.
import { BUNDLED_SCAN_FILES } from '../../indexer/skill-processor.security.ts'
// SMI-6033 Wave 2: the extended scan surface memoizes its Trees API call per
// (owner, repo, branch) at module scope — reset between tests so each one's
// fetch-call count is its own.
import { resetRepoTreeFetchState } from '../../indexer/skill-processor.security.tree.ts'

const AUTHOR: HighTrustAuthor = {
  owner: 'anthropics',
  repo: 'skills',
  license: 'Apache-2.0',
  baseQualityScore: 90,
  description: 'Official Anthropic skills',
}

const REPO_DATA: RepoData = {
  default_branch: 'main',
  stargazers_count: 1000,
  forks_count: 50,
  description: 'Anthropic skills',
  topics: ['claude-code-skill'],
}

const REPO_URL = 'https://github.com/anthropics/skills'
const BASE_PATH = 'skills'
const SKILL_DIR = 'web-search'
const SKILL_PATH = `${BASE_PATH}/${SKILL_DIR}`
const BLOB_SHA = 'a1b2c3d4e5f6'

/** A Contents API directory-listing response with one skill subdirectory. */
function contentsListingResponse(): Response {
  return new Response(JSON.stringify([{ name: SKILL_DIR, type: 'dir', path: SKILL_PATH }]), {
    status: 200,
    headers: { 'x-ratelimit-remaining': '4900' },
  })
}

/** A valid SKILL.md raw-content response (passes structural validation). */
function skillMdResponse(): Response {
  return new Response(
    [
      '---',
      'name: web-search',
      'description: Search the web for current information and return summarized results to the user.',
      '---',
      '',
      '# Web Search',
      '',
      'A skill that searches the web and returns summarized, current results.',
    ].join('\n'),
    { status: 200, headers: { 'content-type': 'text/plain' } }
  )
}

function freshCache(): TreeHashCache {
  return new Map()
}

function freshCounters(): TreeHashCacheCounters {
  return { hits: 0, misses: 0 }
}

describe('indexSkillsFromContents — tree-hash cache round-trip (SMI-4878)', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let originalFetch: typeof global.fetch

  beforeEach(() => {
    originalFetch = global.fetch
    fetchMock = vi.fn()
    // SMI-6033 Wave 2 (Gap 8): scanSkillBundle now also issues one recursive
    // Trees API call per (owner, repo, branch) for its extended
    // operational-code scan surface. Left to the bare vi.fn(), that call
    // resolves to `undefined`, which throws inside the Trees fetch and burns
    // the full 1s+2s+4s retry backoff. A default 404 for the Trees URL keeps
    // that path fast and deterministic while leaving every OTHER unmatched
    // call resolving to `undefined` exactly as before (mockResolvedValueOnce
    // queues still take precedence over a default implementation).
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = typeof input === 'string' ? input : String(input)
      if (url.includes('/git/trees/')) return new Response('', { status: 404 })
      return undefined as unknown as Response
    })
    // @ts-expect-error overriding global for test
    global.fetch = fetchMock
  })

  afterEach(() => {
    global.fetch = originalFetch
    resetRepoTreeFetchState()
    vi.unstubAllEnvs()
  })

  it('cache HIT: warm entry increments cacheCounters.hits and skips the SKILL.md fetch', async () => {
    // Only the Contents API listing is mocked. A second fetch (the
    // raw.githubusercontent.com SKILL.md GET) would throw "no mock" — proving
    // the cache gate short-circuits before checkSkillMdExists.
    fetchMock.mockResolvedValueOnce(contentsListingResponse())

    const cache = freshCache()
    cache.set(treeHashCacheKey(REPO_URL, SKILL_PATH), {
      tree_hash: BLOB_SHA,
      last_tree_hash_check: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1h ago
    })
    const counters = freshCounters()
    const plainPathBlobShas = new Map<string, string>([[SKILL_PATH, BLOB_SHA]])

    const result = await indexSkillsFromContents(
      AUTHOR,
      BASE_PATH,
      REPO_DATA,
      new Map<string, SkillMdValidation>(),
      {},
      newRateLimitTelemetry(),
      cache,
      counters,
      plainPathBlobShas
    )

    expect(counters.hits).toBe(1)
    expect(counters.misses).toBe(0)
    // Exactly one fetch — the Contents listing. The SKILL.md raw fetch was skipped.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toContain('api.github.com/repos/anthropics/skills/contents')
    // A cache hit yields no emitted skill (the prior cron already indexed it).
    expect(result.skills).toHaveLength(0)
    expect(result.errors).toHaveLength(0)
  })

  it('cache HIT records a tree-hash touch entry for the post-Phase-1 batch refresh', async () => {
    fetchMock.mockResolvedValueOnce(contentsListingResponse())

    const cache = freshCache()
    cache.set(treeHashCacheKey(REPO_URL, SKILL_PATH), {
      tree_hash: BLOB_SHA,
      last_tree_hash_check: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    })
    const counters = freshCounters()
    const touches: { repo_url: string; skill_path: string }[] = []

    await indexSkillsFromContents(
      AUTHOR,
      BASE_PATH,
      REPO_DATA,
      new Map<string, SkillMdValidation>(),
      {},
      newRateLimitTelemetry(),
      cache,
      counters,
      new Map<string, string>([[SKILL_PATH, BLOB_SHA]]),
      touches
    )

    expect(counters.hits).toBe(1)
    expect(touches).toHaveLength(1)
    expect(touches[0].skill_path).toBe(SKILL_PATH)
    expect(touches[0].repo_url).toBe(`https://github.com/anthropics/skills/tree/main/${SKILL_PATH}`)
  })

  it('cache MISS: stale blob SHA falls through to checkSkillMdExists and fetches SKILL.md', async () => {
    // Contents listing, then the raw SKILL.md GET — both mocked, proving the
    // miss path made the second fetch the hit path skips.
    fetchMock
      .mockResolvedValueOnce(contentsListingResponse())
      .mockResolvedValueOnce(skillMdResponse())

    const cache = freshCache()
    // Cached SHA differs from the current blob SHA → predicate returns false.
    cache.set(treeHashCacheKey(REPO_URL, SKILL_PATH), {
      tree_hash: 'stale-old-sha-99',
      last_tree_hash_check: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    })
    const counters = freshCounters()
    const plainPathBlobShas = new Map<string, string>([[SKILL_PATH, BLOB_SHA]])

    const result = await indexSkillsFromContents(
      AUTHOR,
      BASE_PATH,
      REPO_DATA,
      new Map<string, SkillMdValidation>(),
      {},
      newRateLimitTelemetry(),
      cache,
      counters,
      plainPathBlobShas
    )

    expect(counters.hits).toBe(0)
    // SHA was present + cache wired → the fall-through increments misses.
    expect(counters.misses).toBe(1)
    // Fetches: Contents listing + SKILL.md + BUNDLED_SCAN_FILES.length sibling CDN
    // probes (SMI-5436 Wave 2; all return null from the exhausted mock — fail-open)
    // + 1 recursive Trees API call for the extended operational-code scan
    // surface (SMI-6033 Wave 2; 404 here, so no extended targets, no retry).
    expect(fetchMock).toHaveBeenCalledTimes(2 + BUNDLED_SCAN_FILES.length + 1)
    expect(fetchMock.mock.calls[1][0]).toContain(
      'raw.githubusercontent.com/anthropics/skills/main/skills/web-search/SKILL.md'
    )
    // The SKILL.md validated → one skill emitted, carrying the fresh blob SHA.
    expect(result.skills).toHaveLength(1)
    expect(result.skills[0].skillPath).toBe(SKILL_PATH)
    expect(result.skills[0].treeHash).toBe(BLOB_SHA)
  })

  it('no cache wired: behavior unchanged — every skill falls through to the fetch path', async () => {
    fetchMock
      .mockResolvedValueOnce(contentsListingResponse())
      .mockResolvedValueOnce(skillMdResponse())

    // No treeHashCache / cacheCounters / plainPathBlobShas passed at all.
    const result = await indexSkillsFromContents(
      AUTHOR,
      BASE_PATH,
      REPO_DATA,
      new Map<string, SkillMdValidation>(),
      {},
      newRateLimitTelemetry()
    )

    // Fetches: Contents listing + SKILL.md + BUNDLED_SCAN_FILES.length sibling CDN
    // probes (SMI-5436 Wave 2; all return null from the exhausted mock — fail-open)
    // + 1 recursive Trees API call for the extended operational-code scan
    // surface (SMI-6033 Wave 2; 404 here, so no extended targets, no retry).
    expect(fetchMock).toHaveBeenCalledTimes(2 + BUNDLED_SCAN_FILES.length + 1)
    expect(result.skills).toHaveLength(1)
    expect(result.skills[0].skillPath).toBe(SKILL_PATH)
  })
})

describe('fetchPlainPathTreeMap — Trees API response parsing (SMI-4878)', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let originalFetch: typeof global.fetch

  beforeEach(() => {
    originalFetch = global.fetch
    fetchMock = vi.fn()
    // SMI-6033 Wave 2 (Gap 8): scanSkillBundle now also issues one recursive
    // Trees API call per (owner, repo, branch) for its extended
    // operational-code scan surface. Left to the bare vi.fn(), that call
    // resolves to `undefined`, which throws inside the Trees fetch and burns
    // the full 1s+2s+4s retry backoff. A default 404 for the Trees URL keeps
    // that path fast and deterministic while leaving every OTHER unmatched
    // call resolving to `undefined` exactly as before (mockResolvedValueOnce
    // queues still take precedence over a default implementation).
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = typeof input === 'string' ? input : String(input)
      if (url.includes('/git/trees/')) return new Response('', { status: 404 })
      return undefined as unknown as Response
    })
    // @ts-expect-error overriding global for test
    global.fetch = fetchMock
  })

  afterEach(() => {
    global.fetch = originalFetch
    resetRepoTreeFetchState()
  })

  it('parses a Trees API response into a (skillPath → blobSha) map', async () => {
    // The recursive Trees API response: blob entries for SKILL.md files plus
    // non-SKILL.md blobs and tree entries that must be ignored.
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          sha: 'tree-root-sha',
          url: 'https://api.github.com/repos/anthropics/skills/git/trees/main',
          truncated: false,
          tree: [
            { path: 'skills', mode: '040000', type: 'tree', sha: 'dir-sha', url: 'u' },
            {
              path: 'skills/web-search/SKILL.md',
              mode: '100644',
              type: 'blob',
              sha: BLOB_SHA,
              url: 'u',
            },
            {
              path: 'skills/pdf-fill/SKILL.md',
              mode: '100644',
              type: 'blob',
              sha: 'ffeeddccbbaa',
              url: 'u',
            },
            // A non-SKILL.md blob — must be ignored.
            {
              path: 'skills/web-search/README.md',
              mode: '100644',
              type: 'blob',
              sha: 'rs',
              url: 'u',
            },
          ],
        }),
        { status: 200, headers: { 'x-ratelimit-remaining': '4800' } }
      )
    )

    const result = await fetchPlainPathTreeMap(
      'anthropics',
      'skills',
      'main',
      newRateLimitTelemetry()
    )

    expect(result.fetchFailed).toBe(false)
    expect(result.treesApiCallCount).toBe(1)
    // The map is keyed by SKILL.md PARENT directory, valued by the blob SHA.
    expect(result.blobShas.get('skills/web-search')).toBe(BLOB_SHA)
    expect(result.blobShas.get('skills/pdf-fill')).toBe('ffeeddccbbaa')
    // README.md and the tree entry are excluded.
    expect(result.blobShas.size).toBe(2)
  })

  it('returns an empty map with fetchFailed=true on a Trees API HTTP error', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not found', { status: 404 }))

    const result = await fetchPlainPathTreeMap(
      'anthropics',
      'missing-repo',
      'main',
      newRateLimitTelemetry()
    )

    expect(result.fetchFailed).toBe(true)
    expect(result.treesApiCallCount).toBe(1)
    expect(result.blobShas.size).toBe(0)
  })

  it('round-trip: a fetchPlainPathTreeMap SHA feeds a matching tree-hash cache key', async () => {
    // Proves the producer (fetchPlainPathTreeMap) and consumer
    // (treeHashCacheKey lookup inside indexSkillsFromContents) agree on the
    // path-keyed shape — the SMI-4861 cache-key round-trip invariant.
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          sha: 'tree-root-sha',
          url: 'u',
          truncated: false,
          tree: [
            {
              path: 'skills/web-search/SKILL.md',
              mode: '100644',
              type: 'blob',
              sha: BLOB_SHA,
              url: 'u',
            },
          ],
        }),
        { status: 200 }
      )
    )

    const { blobShas } = await fetchPlainPathTreeMap(
      'anthropics',
      'skills',
      'main',
      newRateLimitTelemetry()
    )

    const producedSha = blobShas.get(SKILL_PATH)
    expect(producedSha).toBe(BLOB_SHA)
    // The same skillPath the producer keyed by must build the cache key the
    // consumer (indexSkillsFromContents) looks up.
    expect(treeHashCacheKey(REPO_URL, SKILL_PATH)).toBe(`${REPO_URL}:skills/web-search`)
  })
})
