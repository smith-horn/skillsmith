/**
 * SMI-6284: real-DB-executed correctness test for the staged
 * fuzzy_search_skills() rewrite (migration 20260831120000). Existing
 * coverage for this RPC family is entirely mocked (skills-recommend's
 * `.rpc()` calls are stubbed in `skills-recommend/index.test.ts`), so
 * nothing exercises the real PL/pgSQL body -- this test does, against a
 * genuinely live Postgres, per plan-review finding #3 (required, not
 * optional).
 *
 * Requires a live local Supabase instance (`supabase start`). Skipped by
 * default -- opt in with SKILLSMITH_FUZZY_SEARCH_RPC_TEST=1
 * (guards-and-opt-outs.md registered name/value convention). Runtime-
 * enforced, independent of any CI/env configuration: SUPABASE_URL is
 * caller-supplied and could theoretically point anywhere, and cleanup
 * below performs real deletes with a service-role key -- this file
 * hard-fails unless the host resolves to loopback, matching
 * grant-reactivate-concurrency.test.ts's precedent (SMI-6093).
 *
 * Not yet wired into an automated CI workflow -- doing so needs a new
 * ephemeral-Postgres GitHub Actions workflow (the SMI-6093 precedent's
 * shape), which is itself an ADR-109-gated infra change requiring its own
 * SPARC + plan-review pass, out of scope for this fix. Tracked as
 * SMI-6314. Run locally:
 *   supabase start
 *   SKILLSMITH_FUZZY_SEARCH_RPC_TEST=1 SUPABASE_SERVICE_ROLE_KEY=<local-key> \
 *     npx vitest run tests/integration/fuzzy-search-skills-staged.test.ts
 */

import { afterAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'

const LIVE_DB = process.env.SKILLSMITH_FUZZY_SEARCH_RPC_TEST === '1'
const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321'
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

function assertLoopbackUrl(url: string): void {
  const hostname = new URL(url).hostname
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new Error(
      `SKILLSMITH_FUZZY_SEARCH_RPC_TEST=1 refuses to run against a non-loopback SUPABASE_URL ` +
        `host "${hostname}" -- this test performs real inserts/deletes with a service-role key ` +
        `and must only ever target a local ephemeral instance, never staging/prod.`
    )
  }
}

// Fixed, distinctive markers (not per-run random) -- collision risk is
// negligible for a loopback-only local test, and afterAll always cleans up
// by these exact names regardless of pass/fail.
const NAME_MARKER = 'smi6284fzstg'
const DESC_MARKER = 'smi6284fzdsc'
const WEAK_MARKER = 'smi6284fzwk'

type ScratchRow = { name: string; description?: string; quarantined?: boolean }

describe.skipIf(!LIVE_DB)('SMI-6284: fuzzy_search_skills staged rewrite', () => {
  // NOTE: describe.skipIf still EXECUTES this callback body to register the
  // suite -- it only skips running the it() blocks. Env-dependent setup
  // must not throw/construct eagerly when LIVE_DB is false.
  if (LIVE_DB && !SERVICE_ROLE_KEY) {
    throw new Error(
      'SKILLSMITH_FUZZY_SEARCH_RPC_TEST=1 requires SUPABASE_SERVICE_ROLE_KEY ' +
        '(no fallback -- this test must never silently hit the wrong project)'
    )
  }
  if (LIVE_DB) {
    assertLoopbackUrl(SUPABASE_URL)
  }

  const adminClient = LIVE_DB
    ? createClient(SUPABASE_URL, SERVICE_ROLE_KEY as string, {
        auth: { autoRefreshToken: false, persistSession: false },
      })
    : (null as unknown as ReturnType<typeof createClient>)

  const insertedIds: string[] = []

  async function seed(rows: ScratchRow[]): Promise<string[]> {
    const { data, error } = await adminClient
      .from('skills')
      .insert(rows.map((r) => ({ quarantined: false, ...r })))
      .select('id')
    expect(error, `seed insert failed: ${error?.message}`).toBeNull()
    const ids = (data || []).map((r) => r.id as string)
    insertedIds.push(...ids)
    return ids
  }

  afterAll(async () => {
    if (insertedIds.length === 0) return
    const { error } = await adminClient.from('skills').delete().in('id', insertedIds)
    if (error) {
      console.error(
        `SMI-6284 fuzzy_search_skills test: cleanup for ${insertedIds.length} scratch row(s) failed:`,
        error.message
      )
    }
  })

  it('stage 1 alone fills the limit and stage 2 never runs (deterministic vs. the old global-ranking function)', async () => {
    // 25 WEAK name-arm matches (a mutated prefix, verified live via
    // `SELECT word_similarity('smi6284fzstg', 'smi6284fzst')` to score
    // ~0.846 -- passes the 0.5 floor but is not a perfect match) + 1
    // description-only row that scores a PERFECT 1.0. This makes the test
    // genuinely discriminating (confirmation-review finding #3): under the
    // OLD monolithic function (global top-N by GREATEST(name-sim,
    // desc-sim)), the perfect-1.0 desc-only row would outrank every 0.846
    // name row and appear in the top 20. Under the STAGED function, stage 1
    // alone (25 rows >= limit 20) fills the limit and stage 2 never runs,
    // so that row can never appear -- a real behavioral difference, not
    // just "both happen to return 20 rows."
    const nameRows: ScratchRow[] = Array.from({ length: 25 }, (_, i) => ({
      name: `smi6284fzst-name-${i}`, // weak match, ~0.846 -- see comment above
    }))
    const perfectDescOnlyRow: ScratchRow[] = [
      {
        name: 'unrelated-perfect-desc',
        description: `exact word match ${NAME_MARKER} embedded here`, // scores 1.0
      },
    ]
    const perfectDescId = (await seed(perfectDescOnlyRow))[0]
    await seed(nameRows)

    const { data, error } = await adminClient.rpc('fuzzy_search_skills', {
      search_query: NAME_MARKER,
      similarity_threshold: 0.3,
      limit_count: 20,
    })

    expect(error, `RPC failed: ${error?.message}`).toBeNull()
    expect(data).toHaveLength(20)
    const returnedIds = (data as Array<{ id: string }>).map((r) => r.id)
    expect(
      returnedIds,
      'the perfect-scoring description-only row must not appear -- if it does, stage 2 ran when it should not have (or the old global-ranking behavior silently came back)'
    ).not.toContain(perfectDescId)
  })

  it('stage 2 tops up when stage 1 under-fills, with no duplicate rows across stages', async () => {
    // 3 name-only matches + 2 OVERLAP matches (marker in BOTH name and
    // description) + 8 description-only matches -- stage 2 must run
    // (5 total name-arm matches < limit 20) and contribute up to
    // (limit - 5) rows. Confirmation-review finding #2: the original
    // version of this test had NO row matching both arms, so the SQL's
    // `NOT (search_query <% s.name)` dedup guard could be silently
    // deleted and this test would still pass. The 2 overlap rows close
    // that gap -- they MUST appear in the response, and exactly once,
    // which only holds if stage 2 correctly excludes rows stage 1 already
    // returned.
    const nameOnlyRows: ScratchRow[] = Array.from({ length: 3 }, (_, i) => ({
      name: `${DESC_MARKER}-name-${i}`,
    }))
    const overlapRows: ScratchRow[] = Array.from({ length: 2 }, (_, i) => ({
      name: `${DESC_MARKER}-overlap-${i}`,
      description: `also mentions ${DESC_MARKER} in the description`,
    }))
    const descOnlyRows: ScratchRow[] = Array.from({ length: 8 }, (_, i) => ({
      name: `unrelated-desc-${i}`,
      description: `mentions ${DESC_MARKER} in the body text only`,
    }))
    const nameOnlyIds = new Set(await seed(nameOnlyRows))
    const overlapIds = await seed(overlapRows)
    const descOnlyIds = new Set(await seed(descOnlyRows))

    const { data, error } = await adminClient.rpc('fuzzy_search_skills', {
      search_query: DESC_MARKER,
      similarity_threshold: 0.3,
      limit_count: 20,
    })

    expect(error, `RPC failed: ${error?.message}`).toBeNull()
    const rows = data as Array<{ id: string }>
    // 3 name-only + 2 overlap (both returned once, by stage 1) + 8 desc-only
    // (returned by stage 2, overlap rows excluded since stage 1 already has
    // them) = 13 total, not 15 -- if this were 15, the dedup guard is broken
    // and the overlap rows leaked into stage 2 as well.
    expect(rows.length).toBe(13)

    const returnedIds = rows.map((r) => r.id)
    expect(new Set(returnedIds).size).toBe(returnedIds.length) // no duplicates anywhere

    for (const id of nameOnlyIds) expect(returnedIds).toContain(id)
    for (const id of overlapIds) {
      const occurrences = returnedIds.filter((r) => r === id).length
      expect(
        occurrences,
        `overlap row ${id} must appear exactly once, not ${occurrences} times`
      ).toBe(1)
    }
    for (const id of descOnlyIds) expect(returnedIds).toContain(id)
  })

  it('excludes quarantined rows on both stage 1 and stage 2', async () => {
    const marker = `${NAME_MARKER}q`
    await seed([
      { name: `${marker}-quarantined-name`, quarantined: true },
      { name: `${marker}-clean-name` },
      { name: 'unrelated-q1', description: `has ${marker} in description`, quarantined: true },
      { name: 'unrelated-q2', description: `has ${marker} in description` },
    ])

    const { data, error } = await adminClient.rpc('fuzzy_search_skills', {
      search_query: marker,
      similarity_threshold: 0.3,
      limit_count: 20,
    })

    expect(error, `RPC failed: ${error?.message}`).toBeNull()
    const names = (data as Array<{ name: string }>).map((r) => r.name)
    expect(names).not.toContain(`${marker}-quarantined-name`)
    expect(names).toContain(`${marker}-clean-name`)
    expect(names).toContain('unrelated-q2')
    expect(names).not.toContain('unrelated-q1')
  })

  it('rejects a search_query over 100 characters (SMI-5522 guard retained)', async () => {
    const tooLong = 'x'.repeat(101)
    const { data, error } = await adminClient.rpc('fuzzy_search_skills', {
      search_query: tooLong,
      similarity_threshold: 0.3,
      limit_count: 20,
    })

    expect(error, `RPC failed: ${error?.message}`).toBeNull()
    expect(data).toHaveLength(0)
  })

  it('floors the caller-supplied threshold at 0.5 (SMI-5532 guard retained)', async () => {
    // weakName is NOT a generic "marker + suffix" concatenation -- that
    // shape scores ~0.93-1.0 (pg_trgm still recognizes the full marker as
    // an exact-match substring). This specific truncated-prefix-plus-
    // garbage-suffix string was verified live via `SELECT word_similarity(
    // 'smi6284fzwk', 'smi62xyzabcqqq')` during authoring to score ~0.42 --
    // below the 0.5 floor but above the very low nominal threshold this
    // test passes, so it only fails to appear if the floor is genuinely
    // applied. Do not "clean up" this literal into a WEAK_MARKER-derived
    // template -- the low score depends on this exact truncation.
    const weakName = 'smi62xyzabcqqq'
    await seed([{ name: weakName }])

    const { data, error } = await adminClient.rpc('fuzzy_search_skills', {
      search_query: WEAK_MARKER,
      similarity_threshold: 0.05, // nominally very permissive
      limit_count: 20,
    })

    expect(error, `RPC failed: ${error?.message}`).toBeNull()
    const names = (data as Array<{ name: string }>).map((r) => r.name)
    // The function floors GREATEST(0.05, 0.5) = 0.5 regardless of the
    // caller's low nominal threshold -- a weak/distant match must not
    // survive even though the caller asked for near-zero selectivity.
    expect(names).not.toContain(weakName)
  })
})
