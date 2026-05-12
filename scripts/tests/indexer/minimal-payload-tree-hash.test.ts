// Skip-gate tree-hash backfill regression (SMI-4861 Wave 1 / SMI-4887)
//
// Wave 1 PR #1089 introduced a tree-hash TTL cache but the SMI-4846 skip-gate
// at indexer-runners.ts:280-298 short-circuits BEFORE repositoryToSkill is
// called. For 89% of skills, the upsert path uses minimalSkillPayload — which
// returned only {repo_url, last_seen_at, repo_updated_at}, so tree_hash never
// got backfilled and the cache never warmed.
//
// This test pins the fix: when repo.treeHash is set (from the wildcard Trees
// fetch), minimalSkillPayload must persist tree_hash + last_tree_hash_check
// alongside the existing fields. When repo.treeHash is undefined (plain-path
// without SKILLSMITH_TREE_HASH_PLAIN_PATH=true), behaviour is unchanged.

import { describe, it, expect } from 'vitest'
import { minimalSkillPayload } from '../../indexer/skill-processor.helpers.ts'
import type { GitHubRepository } from '../../indexer/topic-search.ts'

function makeRepo(overrides: Partial<GitHubRepository> = {}): GitHubRepository {
  return {
    owner: 'anthropics',
    name: 'foo',
    fullName: 'anthropics/foo',
    description: 'test skill',
    url: 'https://github.com/anthropics/skills/tree/main/skills/foo',
    stars: 0,
    forks: 0,
    topics: [],
    updatedAt: '2026-05-12T00:00:00Z',
    defaultBranch: 'main',
    installable: true,
    repoName: 'skills',
    skillPath: 'skills/foo',
    ...overrides,
  }
}

describe('minimalSkillPayload — tree_hash backfill (SMI-4887)', () => {
  it('without repo.treeHash: returns the original 3-field shape', () => {
    const payload = minimalSkillPayload(makeRepo({ treeHash: undefined }))
    expect(payload).toMatchObject({
      repo_url: 'https://github.com/anthropics/skills/tree/main/skills/foo',
      repo_updated_at: '2026-05-12T00:00:00Z',
    })
    expect(payload.last_seen_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect('tree_hash' in payload).toBe(false)
    expect('last_tree_hash_check' in payload).toBe(false)
  })

  it('with repo.treeHash: persists tree_hash + stamps last_tree_hash_check', () => {
    const before = Date.now()
    const payload = minimalSkillPayload(makeRepo({ treeHash: 'deadbeef1234' }))
    const after = Date.now()

    expect(payload.tree_hash).toBe('deadbeef1234')
    expect(payload.last_tree_hash_check).toBeDefined()
    // last_tree_hash_check is a fresh ISO timestamp from this call.
    const stamped = Date.parse(payload.last_tree_hash_check!)
    expect(stamped).toBeGreaterThanOrEqual(before)
    expect(stamped).toBeLessThanOrEqual(after)
    // Other fields preserved.
    expect(payload.repo_url).toBe('https://github.com/anthropics/skills/tree/main/skills/foo')
    expect(payload.repo_updated_at).toBe('2026-05-12T00:00:00Z')
  })

  it('with empty-string treeHash: treats as unset (no tree_hash key)', () => {
    // Defensive: an empty string is falsy, behaviour must match `undefined`.
    const payload = minimalSkillPayload(makeRepo({ treeHash: '' }))
    expect('tree_hash' in payload).toBe(false)
  })

  it('SMI-4861 Wave 1 cache warming: skip-gate hits now populate tree_hash', () => {
    // Models the production-failure case from SMI-4887: a wildcard-resolved
    // skill whose repo_updated_at matches the prior cron (skip-gate hit) AND
    // whose blob SHA was fetched fresh this run. Before the fix, the cache
    // never warmed; after the fix, the next cron can hit on this row.
    const skipGateRepo = makeRepo({
      treeHash: 'a1b2c3d4e5f6',
      updatedAt: '2026-05-11T12:00:00Z', // same as prior cron — skip-gate WILL hit
    })
    const payload = minimalSkillPayload(skipGateRepo)
    expect(payload.tree_hash).toBe('a1b2c3d4e5f6')
    // The UPSERT writes this row; next cron's prefetch reads tree_hash + checks
    // freshness against the current Trees blob SHA. Within 24h TTL, this row
    // contributes a cache hit instead of a miss.
  })
})
