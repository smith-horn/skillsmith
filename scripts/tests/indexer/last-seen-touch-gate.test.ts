/**
 * SMI-5491 — 12h `last_seen_at` touch cutoff (Node twin).
 * @module scripts/tests/indexer/last-seen-touch-gate
 *
 * The Deno parent's equivalent lives in
 * supabase/functions/indexer/indexer-runners.test.ts
 * ("SMI-5278: batched last_seen_at touch respects the 12h cutoff"). This is
 * its Node-twin counterpart. It was first added to
 * runUpsertPhase.requarantine-e2e.test.ts (the existing runUpsertPhase-mocking
 * suite) but split into its own file to keep that suite under the <500-line
 * standard.
 *
 * SMI-5278 first widened the touch cutoff 1h -> 12h. SMI-5491 subsequently
 * removed `last_seen_at` from the `flushUpsertAccumulator` skinny UPDATE
 * entirely (it now writes only `repo_updated_at`, plus `tree_hash` /
 * `last_tree_hash_check` when provided) — so this 12h-gated batched touch
 * (`.update({ last_seen_at }).in('id', ids)`, run once per Phase-4 pass after
 * the accumulator flush) is now the SOLE writer of `last_seen_at` for
 * unchanged skills.
 *
 * A dedicated mock (`makeFreshnessGateDb`) is used instead of reusing the
 * e2e suite's `makeUpsertDb`: that double's `.select().in()` always resolves
 * to the same `existingRows` array regardless of which query issued it, which
 * is fine for the requarantine narrative (its fixtures never populate the
 * touch batch) but would misclassify the SMI-3540 quarantine probe
 * (`.select('id, security_findings').in('id', batch).eq('quarantined',
 * true)`) against rows with no `security_findings` field, corrupting the
 * stale-vs-touch split this suite depends on.
 */

import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { runUpsertPhase } from '../../indexer/indexer-runners.ts'
import { newRateLimitTelemetry } from '../../indexer/_shared/rate-limit.ts'
import type { GitHubRepository } from '../../indexer/topic-search.ts'

interface FreshnessGateRow {
  id: string
  repo_url: string
  content_hash: string | null
  last_seen_at: string | null
  repo_updated_at: string | null
}

function makeFreshnessGateDb(existingByUrl: Map<string, FreshnessGateRow>): {
  db: SupabaseClient
  touchedIds: string[]
  skinnyUpdates: Array<{ url: string; patch: Record<string, unknown> }>
} {
  const touchedIds: string[] = []
  const skinnyUpdates: Array<{ url: string; patch: Record<string, unknown> }> = []

  const skillsHandle = {
    select() {
      return {
        in(col: string, vals: string[]) {
          if (col === 'id') {
            // SMI-3540 quarantine probe: none of this suite's fixtures are
            // quarantined, so it always comes back empty and every queued id
            // lands in the plain (non-quarantined) touch branch.
            return { eq: () => Promise.resolve({ data: [], error: null }) }
          }
          // Initial prefetch (`.in('repo_url', repoUrls)`), read via batchedIn.
          const data = vals
            .map((u) => existingByUrl.get(u))
            .filter((r): r is FreshnessGateRow => r !== undefined)
          return Promise.resolve({ data })
        },
      }
    },
    upsert(payload: Record<string, unknown>[]) {
      // Every fixture in this suite hits the unchanged-skip prehash gate; a
      // real full upsert firing means the gate stopped matching as designed.
      throw new Error(`Unexpected full upsert in freshness-gate test: ${JSON.stringify(payload)}`)
    },
    update(patch: Record<string, unknown>) {
      return {
        // flushUpsertAccumulator's skinny per-row UPDATE (unchangedSkip rows).
        eq(_col: string, url: string) {
          skinnyUpdates.push({ url, patch })
          return Promise.resolve({ error: null })
        },
        // runUpsertPhase's post-batch 12h-gated touch (`.in('id', ids)`).
        in(_col: string, ids: string[]) {
          touchedIds.push(...ids)
          return Promise.resolve({ error: null })
        },
      }
    },
  }

  const db = {
    from(table: string) {
      if (table === 'audit_logs') {
        return { insert: () => Promise.resolve({ error: null }) }
      }
      return skillsHandle
    },
  }

  return { db: db as unknown as SupabaseClient, touchedIds, skinnyUpdates }
}

function freshnessGateRepo(url: string, updatedAt: string): GitHubRepository {
  return {
    owner: 'acme',
    name: 'skill-x',
    fullName: 'acme/skill-x',
    description: null,
    url,
    stars: 0,
    forks: 0,
    topics: [],
    updatedAt,
    defaultBranch: 'main',
    installable: true,
    repoName: 'skill-x',
    discoveryPath: 'topic_search:mcp',
  }
}

describe('SMI-5491 — 12h last_seen_at touch cutoff (Node twin)', () => {
  it('touches >12h-stale and never-seen ids, withholds a <12h-fresh id', async () => {
    const now = Date.now()
    const hoursAgo = (h: number) => new Date(now - h * 60 * 60 * 1000).toISOString()
    // Prehash gate fires when the existing row's `repo_updated_at` matches
    // `repoUpdatedAtKey(repo)` (== repo.updatedAt here) — every fixture below
    // takes the unchanged-skip path; last_seen_at then decides the touch.
    const repoUpdatedAt = '2026-06-25T00:00:00Z'

    const urlFresh = 'https://github.com/acme/fresh'
    const urlStale = 'https://github.com/acme/stale'
    const urlNever = 'https://github.com/acme/never'

    const existingByUrl = new Map<string, FreshnessGateRow>([
      [
        urlFresh,
        {
          id: 'id-fresh',
          repo_url: urlFresh,
          content_hash: 'h',
          last_seen_at: hoursAgo(2),
          repo_updated_at: repoUpdatedAt,
        },
      ],
      [
        urlStale,
        {
          id: 'id-stale',
          repo_url: urlStale,
          content_hash: 'h',
          last_seen_at: hoursAgo(14),
          repo_updated_at: repoUpdatedAt,
        },
      ],
      [
        urlNever,
        {
          id: 'id-never',
          repo_url: urlNever,
          content_hash: 'h',
          last_seen_at: null,
          repo_updated_at: repoUpdatedAt,
        },
      ],
    ])

    const { db, touchedIds, skinnyUpdates } = makeFreshnessGateDb(existingByUrl)
    const repos = [urlFresh, urlStale, urlNever].map((url) => freshnessGateRepo(url, repoUpdatedAt))

    const result = await runUpsertPhase(
      db,
      repos,
      new Map(), // highTrustSkillMap — none of these owners are high-trust
      new Map(), // validationCache — unused on the prehash-skip path
      false,
      newRateLimitTelemetry()
    )

    expect(result.errors).toEqual([])
    // All three took the unchanged-skip (prehash-match) path.
    expect(result.unchanged).toBe(3)
    // Every unchanged row still gets its skinny per-row UPDATE (repo_updated_at
    // reaffirmation) regardless of the touch-cutoff outcome.
    expect(skinnyUpdates).toHaveLength(3)

    // Only the >12h-stale and never-seen ids are queued for the batched
    // touch; the 2h-fresh id is withheld.
    expect([...touchedIds].sort()).toEqual(['id-never', 'id-stale'])
    expect(touchedIds).not.toContain('id-fresh')
  })

  it('a last_seen_at exactly at the 12h boundary is treated as fresh (strict < compare)', async () => {
    // The cutoff comparison is `lastSeen < cutoff` (strict). Freeze the clock
    // so the fixture's last_seen_at and runUpsertPhase's internal cutoff are
    // computed from the IDENTICAL `Date.now()` value — without this, real
    // time ticking forward between fixture setup and the function call would
    // always make the row read as "just over 12h old" and touch regardless
    // of strict-`<` vs `<=`, defeating the point of a boundary test.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-06-25T12:00:00.000Z'))
      const boundaryUrl = 'https://github.com/acme/boundary'
      const repoUpdatedAt = '2026-06-25T00:00:00Z'
      const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString()

      const existingByUrl = new Map<string, FreshnessGateRow>([
        [
          boundaryUrl,
          {
            id: 'id-boundary',
            repo_url: boundaryUrl,
            content_hash: 'h',
            last_seen_at: twelveHoursAgo,
            repo_updated_at: repoUpdatedAt,
          },
        ],
      ])

      const { db, touchedIds } = makeFreshnessGateDb(existingByUrl)
      const result = await runUpsertPhase(
        db,
        [freshnessGateRepo(boundaryUrl, repoUpdatedAt)],
        new Map(),
        new Map(),
        false,
        newRateLimitTelemetry()
      )

      expect(result.errors).toEqual([])
      expect(result.unchanged).toBe(1)
      // last_seen_at equals the cutoff exactly (same frozen `now` minus 12h);
      // strict `<` means an exact match is NOT stale enough to touch.
      expect(touchedIds).not.toContain('id-boundary')
    } finally {
      vi.useRealTimers()
    }
  })
})
