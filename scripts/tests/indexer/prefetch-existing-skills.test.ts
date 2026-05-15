// Paginated prefetch tests (SMI-4861 — PostgREST max-rows cap fix)
//
// Regression context: post-Wave-1 telemetry showed the tree-hash cache hit
// ratio pinned near ~30%. RCA: the prefetch did one unbounded `.select()`,
// which PostgREST silently caps at `max-rows` (1000). With ~8400 eligible
// rows, the cache + skip-gate only ever saw the first 1000. Fix: walk the
// table in `max-rows`-sized pages via `.range()`.

import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  prefetchExistingSkills,
  PREFETCH_PAGE_SIZE,
} from '../../indexer/prefetch-existing-skills.ts'

interface Row {
  repo_url: string
  repo_updated_at: string | null
  skill_path: string | null
  tree_hash: string | null
  last_tree_hash_check: string | null
}

/**
 * Mock the supabase chain `.from().select().not().order().range(from,to)`.
 * `.range()` slices `dataset`, emulating PostgREST: a request never returns
 * more than `PREFETCH_PAGE_SIZE` rows even if the window is wider.
 */
function makeFakeSupabase(
  dataset: Row[],
  opts: { failOnPage?: number } = {}
): { client: SupabaseClient; rangeCalls: Array<[number, number]> } {
  const rangeCalls: Array<[number, number]> = []
  const client = {
    from: () => ({
      select: () => ({
        not: () => ({
          order: () => ({
            range: (from: number, to: number) => {
              rangeCalls.push([from, to])
              const page = rangeCalls.length - 1
              if (opts.failOnPage === page) {
                return Promise.resolve({ data: null, error: { message: 'pooler timeout' } })
              }
              // PostgREST max-rows: cap the slice at PREFETCH_PAGE_SIZE.
              const width = Math.min(to - from + 1, PREFETCH_PAGE_SIZE)
              return Promise.resolve({ data: dataset.slice(from, from + width), error: null })
            },
          }),
        }),
      }),
    }),
  } as unknown as SupabaseClient
  return { client, rangeCalls }
}

function makeRows(count: number, withHashEvery = 0): Row[] {
  return Array.from({ length: count }, (_, i) => ({
    repo_url: `https://github.com/owner/repo${String(i).padStart(6, '0')}/tree/main/skills/s${i}`,
    repo_updated_at: `2026-05-15T00:00:${String(i % 60).padStart(2, '0')}Z`,
    skill_path: `skills/s${i}`,
    tree_hash: withHashEvery && i % withHashEvery === 0 ? `blob${i}` : null,
    last_tree_hash_check: withHashEvery && i % withHashEvery === 0 ? '2026-05-15T16:00:00Z' : null,
  }))
}

describe('prefetchExistingSkills — paginated prefetch (SMI-4861)', () => {
  it('single page: loads all rows when corpus < page size', async () => {
    const { client, rangeCalls } = makeFakeSupabase(makeRows(250))
    const { existingRepoUpdatedAt, rowsScanned } = await prefetchExistingSkills(client, 'req-1')
    expect(rowsScanned).toBe(250)
    expect(existingRepoUpdatedAt.size).toBe(250)
    // One full request; loop stops because the page came back short.
    expect(rangeCalls).toHaveLength(1)
    expect(rangeCalls[0]).toEqual([0, PREFETCH_PAGE_SIZE - 1])
  })

  it('REGRESSION: walks past the 1000-row PostgREST cap', async () => {
    // 8400 rows ≈ the production corpus. A single .select() would yield 1000.
    const { client, rangeCalls } = makeFakeSupabase(makeRows(8400))
    const { existingRepoUpdatedAt, rowsScanned } = await prefetchExistingSkills(client, 'req-2')
    expect(rowsScanned).toBe(8400)
    expect(existingRepoUpdatedAt.size).toBe(8400)
    // 9 pages: 8 full (8000) + 1 partial (400).
    expect(rangeCalls).toHaveLength(9)
    expect(rangeCalls[8]).toEqual([8000, 8000 + PREFETCH_PAGE_SIZE - 1])
  })

  it('terminates on an exactly-divisible corpus (extra empty page)', async () => {
    const { client, rangeCalls } = makeFakeSupabase(makeRows(2 * PREFETCH_PAGE_SIZE))
    const { rowsScanned } = await prefetchExistingSkills(client, 'req-3')
    expect(rowsScanned).toBe(2 * PREFETCH_PAGE_SIZE)
    // 2 full pages return exactly PREFETCH_PAGE_SIZE → loop probes a 3rd.
    expect(rangeCalls).toHaveLength(3)
  })

  it('seeds treeHashCache with the bare-repo-URL + skill_path key', async () => {
    // Every 3rd row carries a tree_hash; spans 2 pages to prove cache rows
    // beyond the first 1000 are seeded too.
    const { client } = makeFakeSupabase(makeRows(1500, 3))
    const { treeHashCache } = await prefetchExistingSkills(client, 'req-4')
    expect(treeHashCache.size).toBe(Math.ceil(1500 / 3))
    // repo_url suffix `/tree/main/skills/sN` must be stripped for the key.
    const entry = treeHashCache.get('https://github.com/owner/repo000000:skills/s0')
    expect(entry).toEqual({ tree_hash: 'blob0', last_tree_hash_check: '2026-05-15T16:00:00Z' })
    // A row that appears only on page 2 (index 1002) is present.
    expect(treeHashCache.has('https://github.com/owner/repo001002:skills/s1002')).toBe(true)
  })

  it('non-fatal on a mid-walk error: returns the pages collected so far', async () => {
    const { client, rangeCalls } = makeFakeSupabase(makeRows(3000), { failOnPage: 1 })
    const { existingRepoUpdatedAt, rowsScanned } = await prefetchExistingSkills(client, 'req-5')
    // Page 0 loaded (1000), page 1 errored → break. Partial result, no throw.
    expect(rowsScanned).toBe(PREFETCH_PAGE_SIZE)
    expect(existingRepoUpdatedAt.size).toBe(PREFETCH_PAGE_SIZE)
    expect(rangeCalls).toHaveLength(2)
  })
})
