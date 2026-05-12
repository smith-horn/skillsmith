/**
 * Null-name regression test (SMI-4858)
 * @module scripts/tests/indexer/null-name-regression
 *
 * Pins the invariant that `repositoryToSkill` never returns `name: null`,
 * `name: undefined`, or `name: ''` for any `GitHubRepository` shape produced
 * by the discovery paths (high-trust Trees-API, high-trust Contents-API,
 * topic-search, code-search, subdirectory-search).
 *
 * Regression: 2026-05-11 09:32 UTC cron run 25661917928 produced
 * `failed=376` with the error
 *   `null value in column "name" of relation "skills" violates not-null
 *    constraint`
 * Root cause was a column-union NULL propagation in the batch upsert
 * (`indexer-runners.batch.ts:flushUpsertAccumulator`) where skinny
 * `minimalSkillPayload` rows and full `repositoryToSkill` payloads were
 * batched together. PostgREST unified the column set, sending `name: null`
 * for every skinny row.
 *
 * The split-batch fix in `flushUpsertAccumulator` is the primary defense;
 * the defense-in-depth fallback chain in `repositoryToSkill` is the
 * secondary defense and is what this test exercises directly. The split-
 * batch behavior is covered by integration coverage in indexer-runners
 * tests.
 */

import { describe, it, expect } from 'vitest'
import { repositoryToSkill, sanitizeSkillName } from '../../indexer/skill-processor.ts'
import { minimalSkillPayload } from '../../indexer/skill-processor.helpers.ts'
import {
  flushUpsertAccumulator,
  type UpsertAccumulatorItem,
} from '../../indexer/indexer-runners.batch.ts'
import type { GitHubRepository } from '../../indexer/topic-search.ts'
import type { SupabaseClient } from '@supabase/supabase-js'

function baseRepo(overrides: Partial<GitHubRepository> = {}): GitHubRepository {
  return {
    owner: 'acme',
    name: 'widget',
    fullName: 'acme/widget',
    description: 'A widget',
    url: 'https://github.com/acme/widget',
    stars: 10,
    forks: 2,
    topics: ['claude-code-skill'],
    updatedAt: '2026-05-11T09:32:00.000Z',
    defaultBranch: 'main',
    installable: true,
    repoName: 'widget',
    ...overrides,
  }
}

describe('repositoryToSkill — name fallback (SMI-4858)', () => {
  it('returns a non-empty name when repo.name is the canonical identifier', () => {
    const skillData = repositoryToSkill(baseRepo())
    expect(skillData.name).toBeTypeOf('string')
    expect(skillData.name).not.toBe('')
    expect(skillData.name).toBe('widget')
  })

  it('falls back to repoName when repo.name is undefined (high-trust Trees-API shape)', () => {
    // High-trust Trees-API discovery can synthesize a repository where the
    // `name` field is the SKILL.md directory and `repoName` is preserved;
    // simulate the worst case where `name` was dropped from the construction.
    const repo = baseRepo({ name: undefined as unknown as string })
    const skillData = repositoryToSkill(repo)
    expect(skillData.name).toBeTypeOf('string')
    expect(skillData.name).not.toBe('')
    expect(skillData.name).not.toBeNull()
    // Should resolve from repoName='widget'.
    expect(skillData.name).toBe('widget')
  })

  it('falls back to fullName parse when both name and repoName are missing', () => {
    const repo = baseRepo({
      name: undefined as unknown as string,
      repoName: undefined as unknown as string,
    })
    const skillData = repositoryToSkill(repo)
    expect(skillData.name).toBeTypeOf('string')
    expect(skillData.name).not.toBe('')
    expect(skillData.name).toBe('widget')
  })

  it('returns sentinel "unnamed-skill" when every fallback is empty', () => {
    const repo = baseRepo({
      name: undefined as unknown as string,
      repoName: undefined as unknown as string,
      fullName: '' as unknown as string,
    })
    const skillData = repositoryToSkill(repo)
    expect(skillData.name).toBe('unnamed-skill')
  })

  it('returns a sanitized non-empty name when sanitizer would otherwise collapse to empty', () => {
    // Purely-special-char name. sanitizeSkillName('___') → '' (all stripped).
    // The defense-in-depth fallback must replace empty with the sentinel or
    // a sanitized fallback derived from repoName/fullName.
    expect(sanitizeSkillName('___')).toBe('')
    const repo = baseRepo({ name: '___', repoName: 'real-name' })
    const skillData = repositoryToSkill(repo)
    expect(skillData.name).not.toBe('')
    expect(skillData.name).toBe('real-name')
  })

  it('honors validation metadata name when provided (frontmatter override)', () => {
    const repo = baseRepo({ name: 'widget' })
    const skillData = repositoryToSkill(repo, undefined, {
      valid: true,
      errors: [],
      metadata: { name: 'Front Matter Name' },
    })
    expect(skillData.name).toBe('front-matter-name')
  })

  it('never sends a skinny minimalSkillPayload through the batch upsert path (SMI-4858)', async () => {
    // Build a mixed accumulator: 2 skinny (unchangedSkip:true) + 1 full.
    // Assert that:
    //   1. .update().eq() is called exactly twice (once per skinny row).
    //   2. .upsert() is called exactly once, with payload.length === 1
    //      (the full row), NOT 3 — so PostgREST never sees a heterogeneous
    //      column union that would NULL-out the `name` column.
    const updateCalls: Array<{ url: string; patch: Record<string, unknown> }> = []
    const upsertCalls: Array<{ payload: Record<string, unknown>[] }> = []

    const fakeSupabase = {
      from: () => ({
        update: (patch: Record<string, unknown>) => ({
          eq: (_col: string, url: string) => {
            void _col
            updateCalls.push({ url, patch })
            return Promise.resolve({ data: null, error: null })
          },
        }),
        upsert: (payload: Record<string, unknown>[]) => ({
          select: () => {
            upsertCalls.push({ payload })
            return Promise.resolve({
              data: payload.map((p) => ({ repo_url: p.repo_url })),
              error: null,
            })
          },
        }),
        insert: () => Promise.resolve({ data: null, error: null }),
      }),
    } as unknown as SupabaseClient

    const skinnyRepoA = baseRepo({ name: 'a', repoName: 'a', url: 'https://github.com/x/a' })
    const skinnyRepoB = baseRepo({ name: 'b', repoName: 'b', url: 'https://github.com/x/b' })
    const fullRepoC = baseRepo({ name: 'c', repoName: 'c', url: 'https://github.com/x/c' })

    const accumulator: UpsertAccumulatorItem[] = [
      { repo: skinnyRepoA, skillData: minimalSkillPayload(skinnyRepoA), unchangedSkip: true },
      { repo: skinnyRepoB, skillData: minimalSkillPayload(skinnyRepoB), unchangedSkip: true },
      { repo: fullRepoC, skillData: repositoryToSkill(fullRepoC) },
    ]

    const result = await flushUpsertAccumulator(
      fakeSupabase,
      accumulator,
      new Set([skinnyRepoA.url, skinnyRepoB.url]) // both skinny rows pre-exist
    )

    // No row should have `name: null` make it into the batch upsert.
    expect(upsertCalls).toHaveLength(1)
    expect(upsertCalls[0].payload).toHaveLength(1)
    expect(upsertCalls[0].payload[0].name).toBe('c')
    expect(upsertCalls[0].payload[0].name).not.toBeNull()

    // Skinny rows went through direct UPDATE, one per row.
    expect(updateCalls).toHaveLength(2)
    for (const call of updateCalls) {
      expect(call.patch).toHaveProperty('last_seen_at')
      expect(call.patch).toHaveProperty('repo_updated_at')
      expect(call.patch).not.toHaveProperty('name')
    }

    // Counters: only the full row counts as `indexed` (URL not in existingUrls).
    // Wait — actually fullRepoC.url is NOT in existingUrls, so this is `indexed`.
    expect(result.indexed).toBe(1)
    expect(result.updated).toBe(0)
    expect(result.failed).toBe(0)
    expect(result.errors).toEqual([])
  })

  it('skinny UPDATE propagates tree_hash + last_tree_hash_check when present (SMI-4887 follow-up)', async () => {
    // Regression guard for the 2026-05-12 18:00 UTC cron: minimalSkillPayload
    // was extended to include tree_hash but the skinny UPDATE in
    // flushUpsertAccumulator only picked out last_seen_at/repo_updated_at,
    // dropping the cache columns. Cache never warmed (2 of 8344 rows had
    // tree_hash after 3 post-Wave-1 crons). Fix: thread tree_hash through.
    const updateCalls: Array<{ url: string; patch: Record<string, unknown> }> = []

    const fakeSupabase = {
      from: () => ({
        update: (patch: Record<string, unknown>) => ({
          eq: (_col: string, url: string) => {
            void _col
            updateCalls.push({ url, patch })
            return Promise.resolve({ data: null, error: null })
          },
        }),
        upsert: () => ({
          select: () => Promise.resolve({ data: [], error: null }),
        }),
      }),
    } as unknown as SupabaseClient

    const wildcardRepo = baseRepo({
      name: 'web-search',
      repoName: 'skills',
      url: 'https://github.com/anthropics/skills/tree/main/skills/web-search',
      treeHash: 'a1b2c3d4e5f6',
    })

    const payload = minimalSkillPayload(wildcardRepo)
    expect(payload.tree_hash).toBe('a1b2c3d4e5f6')
    expect(payload.last_tree_hash_check).toBeDefined()

    const accumulator: UpsertAccumulatorItem[] = [
      { repo: wildcardRepo, skillData: payload, unchangedSkip: true },
    ]

    await flushUpsertAccumulator(fakeSupabase, accumulator, new Set([wildcardRepo.url]))

    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0].patch.tree_hash).toBe('a1b2c3d4e5f6')
    expect(updateCalls[0].patch.last_tree_hash_check).toBeDefined()
    expect(updateCalls[0].patch.last_seen_at).toBeDefined()
    expect(updateCalls[0].patch.repo_updated_at).toBeDefined()
  })

  it('skinny UPDATE OMITS tree_hash when repo has no blob SHA (no overwrite of prior cache)', async () => {
    // When SKILLSMITH_TREE_HASH_PLAIN_PATH=false (default) and the repo isn't
    // wildcard-resolved, repo.treeHash is undefined. The skinny UPDATE must
    // NOT send tree_hash: null — that would clobber a prior cron's cached SHA.
    const updateCalls: Array<{ url: string; patch: Record<string, unknown> }> = []

    const fakeSupabase = {
      from: () => ({
        update: (patch: Record<string, unknown>) => ({
          eq: (_col: string, url: string) => {
            void _col
            updateCalls.push({ url, patch })
            return Promise.resolve({ data: null, error: null })
          },
        }),
        upsert: () => ({
          select: () => Promise.resolve({ data: [], error: null }),
        }),
      }),
    } as unknown as SupabaseClient

    const plainRepo = baseRepo({
      name: 'plain',
      repoName: 'plain',
      url: 'https://github.com/x/plain',
      // no treeHash
    })

    const accumulator: UpsertAccumulatorItem[] = [
      { repo: plainRepo, skillData: minimalSkillPayload(plainRepo), unchangedSkip: true },
    ]

    await flushUpsertAccumulator(fakeSupabase, accumulator, new Set([plainRepo.url]))

    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0].patch).not.toHaveProperty('tree_hash')
    expect(updateCalls[0].patch).not.toHaveProperty('last_tree_hash_check')
  })

  it('never returns null or undefined for name across all branches', () => {
    const shapes: GitHubRepository[] = [
      baseRepo(),
      baseRepo({ name: undefined as unknown as string }),
      baseRepo({ name: '' }),
      baseRepo({ name: '___' }),
      baseRepo({ name: 'a.b.c-d_e' }),
      baseRepo({ name: undefined as unknown as string, repoName: 'fallback' }),
      baseRepo({ stars: 100000, forks: 5000 }),
      baseRepo({ topics: [] }),
      baseRepo({ installable: false }),
    ]
    for (const repo of shapes) {
      const skillData = repositoryToSkill(repo)
      expect(skillData.name, `name was null/empty for ${repo.fullName}`).toBeTruthy()
      expect(typeof skillData.name).toBe('string')
      expect((skillData.name as string).length).toBeGreaterThan(0)
    }
  })
})
