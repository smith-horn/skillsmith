/**
 * SMI-5358: Stale-threshold off-by-one boundary test.
 *
 * Both stale-quarantine paths use PostgREST's `.lt('last_seen_at', cutoff)` —
 * strict less-than. The landmine: flipping to `.lte()` would quarantine skills
 * seen exactly at the threshold, causing false-positive quarantines on any skill
 * refreshed exactly N days ago.
 *
 * Sources under test:
 *   scripts/indexer/stale-reconciliation.ts (reconcileStaleSkills)
 *     cutoff: new Date(); t.setDate(t.getDate() - clampedDays)
 *     filter: .lt('last_seen_at', cutoff.toISOString())
 *
 *   scripts/indexer/recheck.ts (loadRecheckCandidates)
 *     cutoff: new Date(Date.now() - thresholdDays * 86_400_000).toISOString()
 *     filter: .lt('last_seen_at', cutoff)          ← same operator, ms-precision
 *
 * BOUNDARY RULE (strict <, must NOT flip to <=):
 *   threshold-1 days old → last_seen_at > cutoff → NOT stale (fresh)
 *   threshold   days old → last_seen_at = cutoff → NOT stale (boundary, strict < excludes)
 *   threshold+1 days old → last_seen_at < cutoff → IS stale
 *
 * REGRESSION CATCH: flipping .lt() to .lte() in either source causes the mock's
 * applyFilters to use <= instead of <, so the "threshold days old" fixture appears
 * in results → the row-count and row-id assertions below fail immediately.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import { reconcileStaleSkills } from '../../indexer/stale-reconciliation.ts'
import { loadRecheckCandidates } from '../../indexer/recheck.ts'
import type { StaleQuarantinedRow } from '../../indexer/revalidate-stale-quarantines.ts'
import { makeRow } from './recheck.test-helpers.ts'

// scripts/tests/indexer → repo root is three levels up.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

// quarantineSkillsBatch is invoked by reconcileStaleSkills after the SELECT.
// Stub it so the test needs no real Supabase RPC surface.
vi.mock('../../indexer/_shared/quarantine.ts', () => ({
  quarantineSkillsBatch: vi.fn(async (_db: unknown, ids: string[]) => ({
    quarantined: ids.length,
    errors: 0,
  })),
  FINDING_STALE: {
    type: 'stale',
    severity: 'info',
    description: 'Skill repository not found during recent indexer runs',
    lineNumber: 0,
  },
}))

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ONE_DAY_MS = 86_400_000
/** Noon UTC on 2025-07-13 — avoids day-boundary timezone sensitivity. */
const FROZEN_NOW_MS = 1_752_393_600_000

// ---------------------------------------------------------------------------
// Row fixture for reconcileStaleSkills
// (it selects id, name, repo_url, last_seen_at; quarantined used only for filter)
// ---------------------------------------------------------------------------

interface ReconcileRow {
  id: string
  name: string
  repo_url: string
  last_seen_at: string
  quarantined: boolean
}

function makeReconcileRow(id: string, last_seen_at: string): ReconcileRow {
  return {
    id,
    name: `skill-${id}`,
    repo_url: `https://github.com/acme/${id}`,
    last_seen_at,
    quarantined: false,
  }
}

// ---------------------------------------------------------------------------
// Filtering mock DB — shared by both suites
// ---------------------------------------------------------------------------

interface MockCaptures {
  /** 'lt' or 'lte' for each last_seen_at filter call observed. */
  operators: string[]
  /** ISO cutoff string passed to each last_seen_at filter call. */
  cutoffs: string[]
}

interface MockHandle {
  db: SupabaseClient
  captures: MockCaptures
}

/**
 * Build a chainable Supabase double that simulates PostgREST's filter behavior.
 *
 * When .lt() is captured, range()/limit() apply strict `<`.
 * When .lte() is captured (regression scenario), they apply `<=`.
 *
 * This means: if the source changes .lt() → .lte(), the boundary fixture
 * (last_seen_at === cutoff) appears in results → assertions fail.
 */
function makeMockDb(allRows: (ReconcileRow | StaleQuarantinedRow)[]): MockHandle {
  const captures: MockCaptures = { operators: [], cutoffs: [] }

  function makeSelectChain() {
    let op: 'lt' | 'lte' = 'lt'
    let cutoffValue: string | null = null
    let quarantinedFilter: boolean | null = null

    function applyFilters(rows: (ReconcileRow | StaleQuarantinedRow)[]) {
      const cv = cutoffValue
      const qf = quarantinedFilter
      return rows.filter((r) => {
        // PostgREST .eq('quarantined', val) filter
        if (qf !== null && (r as ReconcileRow).quarantined !== qf) return false
        // PostgREST .lt / .lte filter on last_seen_at
        if (cv == null || r.last_seen_at == null) return true
        return op === 'lt' ? r.last_seen_at < cv : r.last_seen_at <= cv
      })
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- chainable test double
    const chain: any = {
      lt(col: string, val: string) {
        if (col === 'last_seen_at') {
          op = 'lt'
          cutoffValue = val
          captures.operators.push('lt')
          captures.cutoffs.push(val)
        }
        return chain
      },
      lte(col: string, val: string) {
        if (col === 'last_seen_at') {
          op = 'lte'
          cutoffValue = val
          captures.operators.push('lte')
          captures.cutoffs.push(val)
        }
        return chain
      },
      eq(col: string, val: unknown) {
        if (col === 'quarantined') quarantinedFilter = val as boolean
        return chain
      },
      ilike() {
        return chain
      },
      or() {
        return chain
      },
      order() {
        return chain
      },
      // Terminal for reconcileStaleSkills
      limit(n: number) {
        return Promise.resolve({ data: applyFilters(allRows).slice(0, n), error: null })
      },
      // Terminal for loadRecheckCandidates (pageCandidates)
      range(from: number, to: number) {
        return Promise.resolve({ data: applyFilters(allRows).slice(from, to + 1), error: null })
      },
    }
    return chain
  }

  const db = {
    from() {
      return {
        select: () => makeSelectChain(),
        update() {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double
          const ch: any = {
            eq() {
              return ch
            },
            select() {
              return Promise.resolve({ data: [], error: null })
            },
          }
          return ch
        },
      }
    },
  }

  return { db: db as unknown as SupabaseClient, captures }
}

// ---------------------------------------------------------------------------
// Suite 1: reconcileStaleSkills — Node-importable stale-quarantine path
// ---------------------------------------------------------------------------

describe('reconcileStaleSkills — stale-threshold boundary (strict <)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(FROZEN_NOW_MS)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  /**
   * Mirror the exact cutoff formula from reconcileStaleSkills:
   *   const staleThreshold = new Date()
   *   staleThreshold.setDate(staleThreshold.getDate() - clampedDays)
   * Returns the ISO string passed to .lt('last_seen_at', ...).
   */
  function reconcileCutoff(clampedDays: number): string {
    const t = new Date() // FROZEN_NOW_MS under fake timers
    t.setDate(t.getDate() - clampedDays)
    return t.toISOString()
  }

  it('only threshold+1 day row is quarantined; threshold and threshold-1 are excluded', async () => {
    const N = 7
    const cutoffMs = new Date(reconcileCutoff(N)).getTime()

    const rows = [
      makeReconcileRow('fresh', new Date(cutoffMs + ONE_DAY_MS).toISOString()),
      makeReconcileRow('boundary', new Date(cutoffMs).toISOString()),
      makeReconcileRow('stale', new Date(cutoffMs - ONE_DAY_MS).toISOString()),
    ]
    const { db } = makeMockDb(rows)

    const result = await reconcileStaleSkills(db, N)

    // Strict < → only the row older than the cutoff is stale.
    // Regression: if < flips to <=, staleQuarantined becomes 2 and quarantinedIds
    // includes 'boundary' — both assertions fail.
    expect(result.staleQuarantined).toBe(1)
    expect(result.quarantinedIds).toEqual(['stale'])
    expect(result.errors).toHaveLength(0)
  })

  it('boundary row at exactly the cutoff is NOT stale (strict < excludes it)', async () => {
    const N = 7
    const cutoffIso = reconcileCutoff(N)
    const rows = [makeReconcileRow('boundary', cutoffIso)]
    const { db } = makeMockDb(rows)

    const result = await reconcileStaleSkills(db, N)

    // A skill seen exactly at the cutoff must not be quarantined under strict <.
    // Regression: flipping to <= makes staleQuarantined = 1.
    expect(result.staleQuarantined).toBe(0)
    expect(result.quarantinedIds).toEqual([])
  })

  it('uses strict .lt() operator — not .lte() — for the last_seen_at filter', async () => {
    const N = 7
    const rows = [makeReconcileRow('r', reconcileCutoff(N))]
    const { db, captures } = makeMockDb(rows)

    await reconcileStaleSkills(db, N)

    expect(captures.operators.length).toBeGreaterThanOrEqual(1)
    expect(captures.operators.every((op) => op === 'lt')).toBe(true)
  })

  it('all three positions together — only the stale rows qualify', async () => {
    const N = 30 // different threshold to show boundary is not threshold-specific
    const cutoffMs = new Date(reconcileCutoff(N)).getTime()

    const rows = [
      makeReconcileRow('f1', new Date(cutoffMs + 2 * ONE_DAY_MS).toISOString()),
      makeReconcileRow('f2', new Date(cutoffMs + ONE_DAY_MS).toISOString()),
      makeReconcileRow('bnd', new Date(cutoffMs).toISOString()),
      makeReconcileRow('s1', new Date(cutoffMs - ONE_DAY_MS).toISOString()),
      makeReconcileRow('s2', new Date(cutoffMs - 2 * ONE_DAY_MS).toISOString()),
    ]
    const { db } = makeMockDb(rows)

    const result = await reconcileStaleSkills(db, N)

    expect(result.staleQuarantined).toBe(2)
    expect([...result.quarantinedIds].sort()).toEqual(['s1', 's2'])
  })
})

// ---------------------------------------------------------------------------
// Suite 2: loadRecheckCandidates — recheck.ts stale path (ms-precision cutoff)
// ---------------------------------------------------------------------------

describe('loadRecheckCandidates — stale-threshold boundary (strict <)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(FROZEN_NOW_MS)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  /**
   * Mirror the recheck.ts cutoff formula:
   *   new Date(Date.now() - thresholdDays * 86_400_000).toISOString()
   */
  function recheckCutoff(thresholdDays: number): string {
    return new Date(FROZEN_NOW_MS - thresholdDays * ONE_DAY_MS).toISOString()
  }

  it('only threshold+1 day row is returned; threshold and threshold-1 are excluded', async () => {
    const N = 5
    const cutoffMs = FROZEN_NOW_MS - N * ONE_DAY_MS

    const rows: StaleQuarantinedRow[] = [
      makeRow({
        id: 'fresh',
        last_seen_at: new Date(cutoffMs + ONE_DAY_MS).toISOString(),
        quarantined: false,
      }),
      makeRow({
        id: 'boundary',
        last_seen_at: new Date(cutoffMs).toISOString(),
        quarantined: false,
      }),
      makeRow({
        id: 'stale',
        last_seen_at: new Date(cutoffMs - ONE_DAY_MS).toISOString(),
        quarantined: false,
      }),
    ]
    const { db } = makeMockDb(rows)

    const result = await loadRecheckCandidates(db, { thresholdDays: N, cap: 100 })

    // Only the row older than the cutoff qualifies (strict <).
    // Regression: if < flips to <=, result length becomes 2 and 'boundary' appears.
    expect(result.map((r) => r.id)).toEqual(['stale'])
  })

  it('boundary row at exactly the cutoff is NOT a recheck candidate', async () => {
    const N = 5
    const rows: StaleQuarantinedRow[] = [
      makeRow({ id: 'boundary', last_seen_at: recheckCutoff(N), quarantined: false }),
    ]
    const { db, captures } = makeMockDb(rows)

    const result = await loadRecheckCandidates(db, { thresholdDays: N, cap: 100 })

    // Boundary row is excluded by strict <; flipping to <= would return it.
    expect(result).toHaveLength(0)
    expect(captures.operators.every((op) => op === 'lt')).toBe(true)
  })

  it('cutoff equals Date.now() - thresholdDays × 86400000 ms exactly', async () => {
    const N = 5
    const expected = recheckCutoff(N)
    const rows: StaleQuarantinedRow[] = [
      makeRow({ id: 'x', last_seen_at: expected, quarantined: false }),
    ]
    const { db, captures } = makeMockDb(rows)

    await loadRecheckCandidates(db, { thresholdDays: N, cap: 100 })

    // Every .lt() call (both passes) must receive the same exact cutoff.
    expect(captures.cutoffs.length).toBeGreaterThanOrEqual(1)
    expect(captures.cutoffs.every((c) => c === expected)).toBe(true)
  })

  it('multiple stale rows included; fresh and boundary rows excluded', async () => {
    const N = 5
    const cutoffMs = FROZEN_NOW_MS - N * ONE_DAY_MS

    const rows: StaleQuarantinedRow[] = [
      makeRow({
        id: 'f1',
        last_seen_at: new Date(cutoffMs + ONE_DAY_MS).toISOString(),
        quarantined: false,
      }),
      makeRow({ id: 'bnd', last_seen_at: new Date(cutoffMs).toISOString(), quarantined: false }),
      makeRow({
        id: 's1',
        last_seen_at: new Date(cutoffMs - ONE_DAY_MS).toISOString(),
        quarantined: false,
      }),
      makeRow({
        id: 's2',
        last_seen_at: new Date(cutoffMs - 2 * ONE_DAY_MS).toISOString(),
        quarantined: false,
      }),
    ]
    const { db } = makeMockDb(rows)

    const result = await loadRecheckCandidates(db, { thresholdDays: N, cap: 100 })

    expect(result.map((r) => r.id).sort()).toEqual(['s1', 's2'])
  })
})

// ---------------------------------------------------------------------------
// Deno-twin drift guard.
//
// The two importable production paths above (Node reconcile + recheck cron) are
// fully exercised. But the Deno indexer edge function
// (supabase/functions/indexer/stale-reconciliation.ts, runs 4x/day) imports
// from esm.sh and CANNOT be imported into a Node vitest suite, so a lt -> lte
// flip there would ship to prod with the suites above still green. This text
// drift guard closes that gap: it reads BOTH twins as source text and asserts
// each uses strict `.lt('last_seen_at'` and neither uses `.lte('last_seen_at'`.
// (git-crypt may leave the supabase/functions twin encrypted in some checkouts;
// the assertion is skipped for that file when the decrypted text is absent so
// the suite never false-fails on a locked tree.)
// ---------------------------------------------------------------------------
describe('stale-reconciliation twin parity — strict .lt(last_seen_at) (SMI-5358)', () => {
  const twins = [
    'scripts/indexer/stale-reconciliation.ts', // Node — never git-crypt encrypted
    'supabase/functions/indexer/stale-reconciliation.ts', // Deno — may be encrypted
  ]

  for (const rel of twins) {
    it(`${rel} uses strict .lt('last_seen_at' and never .lte`, () => {
      const src = readFileSync(resolve(REPO_ROOT, rel), 'utf8')
      // Skip the assertion if this file is a git-crypt blob in this checkout.
      if (src.includes('GITCRYPT')) {
        expect(src.includes('GITCRYPT')).toBe(true) // documents the skip
        return
      }
      expect(src).toContain(".lt('last_seen_at'")
      expect(src).not.toContain(".lte('last_seen_at'")
    })
  }
})
