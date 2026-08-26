/**
 * Statement-timeout chunk-retry regression test (SMI-5968)
 * @module scripts/tests/indexer/batch-upsert-timeout-retry
 *
 * SMI-5934 chunked the batch upsert to a fixed `UPSERT_CHUNK_SIZE` (2000
 * rows) so a Postgres statement timeout would only cost one chunk instead
 * of the whole dispatch. That assumed row COUNT bounds query execution
 * time. It doesn't: per-row payload weight varies (long descriptions,
 * large `security_findings` JSONB, embeddings), so a sub-threshold chunk
 * can still hit PostgREST's 8s `statement_timeout` and lose the entire
 * chunk. Confirmed live 2026-08-09: a 1977-row `.claude/skills` chunk
 * (under the 2000-row threshold) timed out and was entirely discarded.
 *
 * The fix (`upsertChunkWithRetry` in indexer-runners.batch.ts): on a
 * statement-timeout error, halve the chunk and retry each half instead of
 * discarding it outright, bounded by `MAX_TIMEOUT_SPLIT_DEPTH` so a
 * systemic outage (every row timing out) can't balloon into an unbounded
 * number of sequential round trips.
 */

import { describe, it, expect } from 'vitest'
import { repositoryToSkill } from '../../indexer/skill-processor.ts'
import {
  flushUpsertAccumulator,
  type UpsertAccumulatorItem,
} from '../../indexer/indexer-runners.batch.ts'
import type { GitHubRepository } from '../../indexer/topic-search.ts'
import type { SupabaseClient } from '@supabase/supabase-js'

const STATEMENT_TIMEOUT_ERROR = {
  message: 'canceling statement due to statement timeout',
  details: '',
  hint: '',
  code: '57014',
}

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
    updatedAt: '2026-08-09T00:00:00.000Z',
    defaultBranch: 'main',
    installable: true,
    repoName: 'widget',
    ...overrides,
  }
}

function makeAccumulatorItem(n: number): UpsertAccumulatorItem {
  const repo = baseRepo({
    name: `skill-${n}`,
    repoName: `skill-${n}`,
    fullName: `acme/skill-${n}`,
    url: `https://github.com/acme/skill-${n}`,
  })
  return { repo, skillData: repositoryToSkill(repo) }
}

describe('flushUpsertAccumulator — statement-timeout chunk retry (SMI-5968)', () => {
  it('halves and retries a timing-out chunk until every row succeeds', async () => {
    const upsertCalls: number[] = []
    const fakeSupabase = {
      from: () => ({
        upsert: (payload: Record<string, unknown>[]) => ({
          select: () => {
            upsertCalls.push(payload.length)
            if (payload.length > 1) {
              return Promise.resolve({ data: null, error: STATEMENT_TIMEOUT_ERROR })
            }
            return Promise.resolve({
              data: [{ repo_url: payload[0].repo_url }],
              error: null,
            })
          },
        }),
        insert: () => Promise.resolve({ data: null, error: null }),
      }),
    } as unknown as SupabaseClient

    const accumulator = [1, 2, 3, 4].map(makeAccumulatorItem)
    const result = await flushUpsertAccumulator(fakeSupabase, accumulator, new Set(), 4)

    // Depth-first order (each half is awaited fully before the next starts):
    // 4 (fail) -> [1,2] half: 2 (fail) -> 1,1 (succeed) -> [3,4] half: 2
    // (fail) -> 1,1 (succeed). 7 calls total, vs. the pre-fix behavior of
    // exactly 1 call that would have discarded all 4 rows.
    expect(upsertCalls).toEqual([4, 2, 1, 1, 2, 1, 1])
    expect(result.indexed).toBe(4)
    expect(result.failed).toBe(0)
    expect(result.errors).toEqual([])
  })

  it('isolates a single pathologically oversized row instead of discarding the whole chunk', async () => {
    const badUrl = 'https://github.com/acme/skill-4'
    const fakeSupabase = {
      from: () => ({
        upsert: (payload: Record<string, unknown>[]) => ({
          select: () => {
            if (payload.length > 1) {
              return Promise.resolve({ data: null, error: STATEMENT_TIMEOUT_ERROR })
            }
            if (payload[0].repo_url === badUrl) {
              // Even alone, this one row times out (a genuinely oversized payload).
              return Promise.resolve({ data: null, error: STATEMENT_TIMEOUT_ERROR })
            }
            return Promise.resolve({
              data: [{ repo_url: payload[0].repo_url }],
              error: null,
            })
          },
        }),
        insert: () => Promise.resolve({ data: null, error: null }),
      }),
    } as unknown as SupabaseClient

    const accumulator = [1, 2, 3, 4].map(makeAccumulatorItem)
    const result = await flushUpsertAccumulator(fakeSupabase, accumulator, new Set(), 4)

    // The three healthy rows succeed; only the pathological row fails --
    // pre-fix, all 4 would have been discarded together.
    expect(result.indexed).toBe(3)
    expect(result.failed).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatch(/rows 3-3 of 4/)
    expect(result.errors[0]).toContain('statement timeout')
  })

  it('bounds retry recursion under a systemic (every-row) timeout instead of splitting to single rows', async () => {
    let calls = 0
    const fakeSupabase = {
      from: () => ({
        upsert: () => ({
          select: () => {
            calls++
            // Simulate a total outage: every attempt times out regardless of size.
            return Promise.resolve({ data: null, error: STATEMENT_TIMEOUT_ERROR })
          },
        }),
        insert: () => Promise.resolve({ data: null, error: null }),
      }),
    } as unknown as SupabaseClient

    const accumulator = Array.from({ length: 512 }, (_, i) => makeAccumulatorItem(i))
    const result = await flushUpsertAccumulator(fakeSupabase, accumulator, new Set(), 512)

    // MAX_TIMEOUT_SPLIT_DEPTH=8: 512 halved 8 times bottoms out at 256
    // depth-8 leaf chunks of 2 rows each (not 512 single-row calls) --
    // sum(2^0..2^8) = 511 total upsert attempts, all terminal failures.
    expect(calls).toBe(511)
    expect(result.failed).toBe(512)
    expect(result.indexed).toBe(0)
    expect(result.errors).toHaveLength(256)
    // Every terminal error covers a 2-row leaf, never a lone row, proving
    // the depth cap stopped the recursion before it reached length 1.
    for (const message of result.errors) {
      const match = message.match(/rows (\d+)-(\d+) of 512/)
      expect(match).not.toBeNull()
      const [, start, end] = match as RegExpMatchArray
      expect(Number(end) - Number(start)).toBe(1)
    }
  })

  it('SMI-5898 Wave 2 Step 6: upserts against onConflict repo_url_canonical, not repo_url', async () => {
    const upsertOptions: Array<Record<string, unknown> | undefined> = []
    const fakeSupabase = {
      from: () => ({
        upsert: (payload: Record<string, unknown>[], options?: Record<string, unknown>) => ({
          select: () => {
            upsertOptions.push(options)
            return Promise.resolve({ data: [{ repo_url: payload[0].repo_url }], error: null })
          },
        }),
        insert: () => Promise.resolve({ data: null, error: null }),
      }),
    } as unknown as SupabaseClient

    const accumulator = [makeAccumulatorItem(1)]
    await flushUpsertAccumulator(fakeSupabase, accumulator, new Set(), 1)

    expect(upsertOptions).toHaveLength(1)
    expect(upsertOptions[0]).toMatchObject({ onConflict: 'repo_url_canonical' })
  })
})
