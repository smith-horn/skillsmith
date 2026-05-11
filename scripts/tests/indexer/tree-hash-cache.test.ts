// Tree-hash TTL cache helper tests (SMI-4861 Wave 1)
//
// Pins the cache-hit predicate used by Phase 1 to skip the per-skill
// raw.githubusercontent.com fetch when the prior cron's stored tree_hash
// matches the current Trees API blob SHA AND the cached check was <24h ago.
//
// These are unit-level tests of the pure helper. End-to-end behaviour
// (Phase 1 wildcard branch skipping checkSkillMdExists on cache hit) is
// covered by the existing integration tests that exercise indexHighTrustRepository.

import { describe, it, expect } from 'vitest'
import {
  TREE_HASH_CACHE_TTL_MS,
  treeHashCacheHit,
  treeHashCacheKey,
  type TreeHashCache,
} from '../../indexer/high-trust-indexer.ts'

const NOW = Date.parse('2026-05-12T18:00:00Z')

function freshCache(): TreeHashCache {
  return new Map<string, { tree_hash: string; last_tree_hash_check: string | null }>()
}

describe('treeHashCacheKey — tuple builder', () => {
  it('joins repo_url + skill_path verbatim', () => {
    expect(treeHashCacheKey('https://github.com/anthropics/skills', 'skills/foo')).toBe(
      'https://github.com/anthropics/skills:skills/foo'
    )
  })

  it('treats undefined skill_path as empty (matches migration 055 CHECK)', () => {
    expect(treeHashCacheKey('https://github.com/anthropics/skills', undefined)).toBe(
      'https://github.com/anthropics/skills:'
    )
  })

  it('treats empty-string skill_path as empty (matches skill-processor.ts:496 fallback)', () => {
    expect(treeHashCacheKey('https://github.com/anthropics/skills', '')).toBe(
      'https://github.com/anthropics/skills:'
    )
  })
})

describe('treeHashCacheHit — cache predicate (SMI-4861 Wave 1)', () => {
  const REPO = 'https://github.com/anthropics/skills'
  const PATH = 'skills/foo'
  const KEY = treeHashCacheKey(REPO, PATH)
  const BLOB = 'a1b2c3d4e5f6'

  it('cache hit: blob SHA matches AND last check < 24h → true', () => {
    const cache = freshCache()
    cache.set(KEY, {
      tree_hash: BLOB,
      last_tree_hash_check: new Date(NOW - 60 * 60 * 1000).toISOString(), // 1h ago
    })
    expect(treeHashCacheHit(cache, KEY, BLOB, NOW)).toBe(true)
  })

  it('cache miss (no row): no prior entry → false', () => {
    const cache = freshCache()
    expect(treeHashCacheHit(cache, KEY, BLOB, NOW)).toBe(false)
  })

  it('cache stale: last check > 24h ago → false (forces refresh)', () => {
    const cache = freshCache()
    cache.set(KEY, {
      tree_hash: BLOB,
      last_tree_hash_check: new Date(NOW - TREE_HASH_CACHE_TTL_MS - 60_000).toISOString(),
    })
    expect(treeHashCacheHit(cache, KEY, BLOB, NOW)).toBe(false)
  })

  it('tree_hash mismatch: blob SHA differs → false (file changed)', () => {
    const cache = freshCache()
    cache.set(KEY, {
      tree_hash: 'old-sha-99',
      last_tree_hash_check: new Date(NOW - 60 * 60 * 1000).toISOString(),
    })
    expect(treeHashCacheHit(cache, KEY, BLOB, NOW)).toBe(false)
  })

  it('no blob SHA available: returns false even with fresh cache entry', () => {
    // SMI-4861 Wave 1 staged-rollout: plain-path repos default to undefined
    // blob SHA (SKILLSMITH_TREE_HASH_PLAIN_PATH=false). Cache predicate must
    // safely fall through so behavior is unchanged for non-wildcard repos.
    const cache = freshCache()
    cache.set(KEY, {
      tree_hash: BLOB,
      last_tree_hash_check: new Date(NOW).toISOString(),
    })
    expect(treeHashCacheHit(cache, KEY, undefined, NOW)).toBe(false)
  })

  it('no cache provided: returns false (cache disabled / not wired)', () => {
    expect(treeHashCacheHit(undefined, KEY, BLOB, NOW)).toBe(false)
  })

  it('last_tree_hash_check is null: returns false (legacy row, never indexed under SMI-4861)', () => {
    const cache = freshCache()
    cache.set(KEY, { tree_hash: BLOB, last_tree_hash_check: null })
    expect(treeHashCacheHit(cache, KEY, BLOB, NOW)).toBe(false)
  })

  it('last_tree_hash_check is malformed: returns false (defensive parse)', () => {
    const cache = freshCache()
    cache.set(KEY, { tree_hash: BLOB, last_tree_hash_check: 'not-a-timestamp' })
    expect(treeHashCacheHit(cache, KEY, BLOB, NOW)).toBe(false)
  })

  it('boundary: exactly TTL ago counts as STALE (strictly <24h)', () => {
    const cache = freshCache()
    cache.set(KEY, {
      tree_hash: BLOB,
      last_tree_hash_check: new Date(NOW - TREE_HASH_CACHE_TTL_MS).toISOString(),
    })
    expect(treeHashCacheHit(cache, KEY, BLOB, NOW)).toBe(false)
  })

  it('boundary: 1ms inside TTL counts as FRESH', () => {
    const cache = freshCache()
    cache.set(KEY, {
      tree_hash: BLOB,
      last_tree_hash_check: new Date(NOW - TREE_HASH_CACHE_TTL_MS + 1).toISOString(),
    })
    expect(treeHashCacheHit(cache, KEY, BLOB, NOW)).toBe(true)
  })
})

describe('TREE_HASH_CACHE_TTL_MS — 24h default (SMI-4872 will A/B 7d)', () => {
  it('equals 24 hours in milliseconds', () => {
    expect(TREE_HASH_CACHE_TTL_MS).toBe(24 * 60 * 60 * 1000)
  })
})
