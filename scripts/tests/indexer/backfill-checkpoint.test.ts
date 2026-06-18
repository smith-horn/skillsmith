/**
 * Backfill checkpoint read/write tests (SMI-5286 Wave 1b §#5)
 * @module scripts/tests/indexer/backfill-checkpoint
 *
 * Covers:
 *  - resolveTokenSource: app/pat detection from env vars
 *  - writeCheckpoint: insert shape, fail-soft on error/throw
 *  - readLatestCheckpoint: payload parsing, runId filter, null on no row/error
 *  - Round-trip: write then read back preserves cursor (path, facet, last_page)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  resolveTokenSource,
  writeCheckpoint,
  readLatestCheckpoint,
  cursorToFacetState,
  currentFacetRange,
  bisectCurrentFacet,
  advanceFacet,
  isFacetCrawlDone,
  facetStateToCursor,
  BACKFILL_CHECKPOINT_EVENT_TYPE,
  type BackfillCheckpointPayload,
  type FacetCrawlState,
} from '../../indexer/backfill-checkpoint.ts'
import { buildSizeFacets } from '../../indexer/code-search.facets.ts'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makePayload(
  overrides: Partial<BackfillCheckpointPayload> = {}
): BackfillCheckpointPayload {
  return {
    run_id: 'run-abc-123',
    cursor: { path: '.agents/skills', facet: '2026-06-01', last_page: 3 },
    facets_completed: 4,
    facets_total: 10,
    cap_saturated: false,
    truncated_repo_count: 2,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// resolveTokenSource
// ---------------------------------------------------------------------------

describe('resolveTokenSource', () => {
  let savedEnv: NodeJS.ProcessEnv

  beforeEach(() => {
    savedEnv = { ...process.env }
    delete process.env.GITHUB_APP_ID
    delete process.env.GITHUB_APP_INSTALLATION_ID
    delete process.env.GITHUB_APP_PRIVATE_KEY
  })

  afterEach(() => {
    process.env = savedEnv
  })

  it('returns "app" when all three GITHUB_APP_* vars are set and non-empty', () => {
    const env: NodeJS.ProcessEnv = {
      GITHUB_APP_ID: '12345',
      GITHUB_APP_INSTALLATION_ID: '67890',
      GITHUB_APP_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----\nABC\n-----END RSA PRIVATE KEY-----',
    }
    expect(resolveTokenSource(env)).toBe('app')
  })

  it('returns "pat" when GITHUB_APP_ID is missing', () => {
    const env: NodeJS.ProcessEnv = {
      GITHUB_APP_INSTALLATION_ID: '67890',
      GITHUB_APP_PRIVATE_KEY: 'key',
    }
    expect(resolveTokenSource(env)).toBe('pat')
  })

  it('returns "pat" when GITHUB_APP_INSTALLATION_ID is missing', () => {
    const env: NodeJS.ProcessEnv = {
      GITHUB_APP_ID: '12345',
      GITHUB_APP_PRIVATE_KEY: 'key',
    }
    expect(resolveTokenSource(env)).toBe('pat')
  })

  it('returns "pat" when GITHUB_APP_PRIVATE_KEY is missing', () => {
    const env: NodeJS.ProcessEnv = {
      GITHUB_APP_ID: '12345',
      GITHUB_APP_INSTALLATION_ID: '67890',
    }
    expect(resolveTokenSource(env)).toBe('pat')
  })

  it('returns "pat" when GITHUB_APP_ID is empty string', () => {
    const env: NodeJS.ProcessEnv = {
      GITHUB_APP_ID: '',
      GITHUB_APP_INSTALLATION_ID: '67890',
      GITHUB_APP_PRIVATE_KEY: 'key',
    }
    expect(resolveTokenSource(env)).toBe('pat')
  })

  it('returns "pat" when GITHUB_APP_PRIVATE_KEY is empty string', () => {
    const env: NodeJS.ProcessEnv = {
      GITHUB_APP_ID: '12345',
      GITHUB_APP_INSTALLATION_ID: '67890',
      GITHUB_APP_PRIVATE_KEY: '',
    }
    expect(resolveTokenSource(env)).toBe('pat')
  })

  it('returns "pat" when all three vars are absent', () => {
    expect(resolveTokenSource({})).toBe('pat')
  })

  it('reads from process.env by default (no explicit env arg)', () => {
    // All three absent from process.env (cleared in beforeEach)
    expect(resolveTokenSource()).toBe('pat')
  })

  it('reads "app" from process.env when all three are set on process.env', () => {
    process.env.GITHUB_APP_ID = 'fromenv'
    process.env.GITHUB_APP_INSTALLATION_ID = 'fromenv'
    process.env.GITHUB_APP_PRIVATE_KEY = 'fromenv'
    expect(resolveTokenSource()).toBe('app')
  })
})

// ---------------------------------------------------------------------------
// Supabase mock helpers
// ---------------------------------------------------------------------------

interface CapturedInsert {
  table: string
  payload: Record<string, unknown>
}

/**
 * Builds a minimal Supabase mock that captures insert calls and returns
 * the given error (null = success).
 */
function makeInsertMock(
  captured: CapturedInsert[],
  error: { message: string } | null = null
): SupabaseClient {
  return {
    from: (table: string) => ({
      insert: (payload: Record<string, unknown>) => {
        captured.push({ table, payload })
        return Promise.resolve({ data: null, error })
      },
    }),
  } as unknown as SupabaseClient
}

/**
 * Builds a mock that throws synchronously inside insert() so we test the
 * catch branch.
 */
function makeThrowingInsertMock(): SupabaseClient {
  return {
    from: () => ({
      insert: () => {
        throw new Error('network failure')
      },
    }),
  } as unknown as SupabaseClient
}

// ---------------------------------------------------------------------------
// writeCheckpoint
// ---------------------------------------------------------------------------

describe('writeCheckpoint', () => {
  it('inserts one row into audit_logs with correct event_type', async () => {
    const captured: CapturedInsert[] = []
    const supabase = makeInsertMock(captured)
    const payload = makePayload()

    const result = await writeCheckpoint(supabase, payload)

    expect(result).toBe(true)
    expect(captured).toHaveLength(1)
    expect(captured[0].table).toBe('audit_logs')
    expect(captured[0].payload.event_type).toBe(BACKFILL_CHECKPOINT_EVENT_TYPE)
  })

  it('sets actor="system", action="backfill_checkpoint", result="success"', async () => {
    const captured: CapturedInsert[] = []
    const supabase = makeInsertMock(captured)

    await writeCheckpoint(supabase, makePayload())

    expect(captured[0].payload.actor).toBe('system')
    expect(captured[0].payload.action).toBe('backfill_checkpoint')
    expect(captured[0].payload.result).toBe('success')
  })

  it('persists the cursor and all progress counters under metadata', async () => {
    const captured: CapturedInsert[] = []
    const supabase = makeInsertMock(captured)
    const payload = makePayload({
      run_id: 'run-xyz',
      cursor: { path: 'my/path', facet: '2026-01-01', last_page: 7 },
      facets_completed: 3,
      facets_total: 15,
      cap_saturated: true,
      truncated_repo_count: 5,
    })

    await writeCheckpoint(supabase, payload)

    const metadata = captured[0].payload.metadata as Record<string, unknown>
    expect(metadata.run_id).toBe('run-xyz')
    expect(metadata.cursor).toEqual({ path: 'my/path', facet: '2026-01-01', last_page: 7 })
    expect(metadata.facets_completed).toBe(3)
    expect(metadata.facets_total).toBe(15)
    expect(metadata.cap_saturated).toBe(true)
    expect(metadata.truncated_repo_count).toBe(5)
  })

  it('returns false (fail-soft) when supabase returns an error response', async () => {
    const captured: CapturedInsert[] = []
    const supabase = makeInsertMock(captured, { message: 'relation does not exist' })

    const result = await writeCheckpoint(supabase, makePayload())

    expect(result).toBe(false)
  })

  it('returns false (fail-soft) when insert throws', async () => {
    const supabase = makeThrowingInsertMock()

    const result = await writeCheckpoint(supabase, makePayload())

    expect(result).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// readLatestCheckpoint mock builder
// ---------------------------------------------------------------------------

type ReadQueryState = {
  /** Row returned by .maybeSingle(), or null if no row. */
  row: { metadata: BackfillCheckpointPayload } | null
  /** PostgREST error, or null if clean. */
  error: { message: string } | null
  /** Captures the filter applied via .eq() calls (key → value). */
  eqFilters: Record<string, string>
}

/**
 * Builds a Supabase mock whose `from('audit_logs').select().eq().order().limit().maybeSingle()`
 * chain returns the configured row/error pair and records eq() calls.
 */
function makeReadMock(state: ReadQueryState): SupabaseClient {
  const chain = {
    eq: (key: string, value: string) => {
      state.eqFilters[key] = value
      return chain
    },
    order: () => chain,
    limit: () => chain,
    maybeSingle: () =>
      Promise.resolve({
        data: state.row,
        error: state.error,
      }),
  }
  return {
    from: () => ({
      select: () => chain,
    }),
  } as unknown as SupabaseClient
}

// ---------------------------------------------------------------------------
// readLatestCheckpoint
// ---------------------------------------------------------------------------

describe('readLatestCheckpoint', () => {
  it('returns the parsed BackfillCheckpointPayload when a row exists', async () => {
    const payload = makePayload()
    const state: ReadQueryState = {
      row: { metadata: payload },
      error: null,
      eqFilters: {},
    }
    const supabase = makeReadMock(state)

    const result = await readLatestCheckpoint(supabase)

    expect(result).not.toBeNull()
    expect(result?.run_id).toBe('run-abc-123')
    expect(result?.cursor.path).toBe('.agents/skills')
    expect(result?.cursor.last_page).toBe(3)
    expect(result?.facets_completed).toBe(4)
    expect(result?.facets_total).toBe(10)
    expect(result?.cap_saturated).toBe(false)
    expect(result?.truncated_repo_count).toBe(2)
  })

  it('returns null when no row exists (cold start)', async () => {
    const state: ReadQueryState = { row: null, error: null, eqFilters: {} }
    const supabase = makeReadMock(state)

    expect(await readLatestCheckpoint(supabase)).toBeNull()
  })

  it('returns null when supabase returns an error', async () => {
    const state: ReadQueryState = {
      row: null,
      error: { message: 'permission denied' },
      eqFilters: {},
    }
    const supabase = makeReadMock(state)

    expect(await readLatestCheckpoint(supabase)).toBeNull()
  })

  it('applies run_id filter when a specific runId is given', async () => {
    const payload = makePayload({ run_id: 'specific-run' })
    const state: ReadQueryState = { row: { metadata: payload }, error: null, eqFilters: {} }
    const supabase = makeReadMock(state)

    await readLatestCheckpoint(supabase, 'specific-run')

    // The implementation filters via `metadata->>run_id`
    expect(state.eqFilters['metadata->>run_id']).toBe('specific-run')
  })

  it('does NOT apply a run_id filter when runId is undefined (reads latest across all runs)', async () => {
    const state: ReadQueryState = {
      row: { metadata: makePayload() },
      error: null,
      eqFilters: {},
    }
    const supabase = makeReadMock(state)

    await readLatestCheckpoint(supabase, undefined)

    expect(state.eqFilters['metadata->>run_id']).toBeUndefined()
  })

  it('does NOT apply a run_id filter when runId is empty string', async () => {
    const state: ReadQueryState = {
      row: { metadata: makePayload() },
      error: null,
      eqFilters: {},
    }
    const supabase = makeReadMock(state)

    await readLatestCheckpoint(supabase, '')

    expect(state.eqFilters['metadata->>run_id']).toBeUndefined()
  })

  it('does NOT apply a run_id filter when runId is "latest"', async () => {
    const state: ReadQueryState = {
      row: { metadata: makePayload() },
      error: null,
      eqFilters: {},
    }
    const supabase = makeReadMock(state)

    await readLatestCheckpoint(supabase, 'latest')

    expect(state.eqFilters['metadata->>run_id']).toBeUndefined()
  })

  it('always filters by event_type = BACKFILL_CHECKPOINT_EVENT_TYPE', async () => {
    const state: ReadQueryState = {
      row: { metadata: makePayload() },
      error: null,
      eqFilters: {},
    }
    const supabase = makeReadMock(state)

    await readLatestCheckpoint(supabase)

    expect(state.eqFilters['event_type']).toBe(BACKFILL_CHECKPOINT_EVENT_TYPE)
  })
})

// ---------------------------------------------------------------------------
// Round-trip: write then read back preserves cursor (SPARC AC)
// ---------------------------------------------------------------------------

describe('backfill checkpoint round-trip (SPARC AC §#5)', () => {
  it('cursor (path, facet, last_page) survives a write→read cycle', async () => {
    // Shared in-memory store acting as the audit_logs table
    let storedMetadata: BackfillCheckpointPayload | null = null

    const writeSupabase = {
      from: () => ({
        insert: (payload: Record<string, unknown>) => {
          storedMetadata = payload.metadata as {
            run_id: string
            cursor: object
          } as BackfillCheckpointPayload
          return Promise.resolve({ data: null, error: null })
        },
      }),
    } as unknown as SupabaseClient

    const originalPayload: BackfillCheckpointPayload = {
      run_id: 'roundtrip-run-001',
      cursor: { path: '.agents/skills', facet: '2026-06-17', last_page: 5 },
      facets_completed: 7,
      facets_total: 20,
      cap_saturated: true,
      truncated_repo_count: 3,
    }

    const writeOk = await writeCheckpoint(writeSupabase, originalPayload)
    expect(writeOk).toBe(true)
    expect(storedMetadata).not.toBeNull()

    // Read back via a mock that returns the row we just "stored"
    const readState: ReadQueryState = {
      row: storedMetadata ? { metadata: storedMetadata } : null,
      error: null,
      eqFilters: {},
    }
    const readSupabase = makeReadMock(readState)
    const readBack = await readLatestCheckpoint(readSupabase, 'roundtrip-run-001')

    expect(readBack).not.toBeNull()
    // SPARC AC: cursor fields survive intact
    expect(readBack?.cursor.path).toBe('.agents/skills')
    expect(readBack?.cursor.facet).toBe('2026-06-17')
    expect(readBack?.cursor.last_page).toBe(5)
    // Progress counters too
    expect(readBack?.facets_completed).toBe(7)
    expect(readBack?.facets_total).toBe(20)
    expect(readBack?.cap_saturated).toBe(true)
    expect(readBack?.truncated_repo_count).toBe(3)
    expect(readBack?.run_id).toBe('roundtrip-run-001')
  })
})

// ---------------------------------------------------------------------------
// SMI-5286 1c: facet driver state machine (cursor <-> crawl frontier)
// ---------------------------------------------------------------------------

describe('facet driver state machine (SMI-5286 1c)', () => {
  const FACETS = buildSizeFacets()

  it('cursorToFacetState cold-starts on null/undefined', () => {
    expect(cursorToFacetState(null)).toEqual({ facetIndex: 0, pendingSubranges: [], lastPage: 0 })
    expect(cursorToFacetState(undefined)).toEqual({
      facetIndex: 0,
      pendingSubranges: [],
      lastPage: 0,
    })
  })

  it('cursorToFacetState reconstructs facet_index, last_page, and pending_subranges', () => {
    const state = cursorToFacetState({
      path: '',
      facet: '0-63',
      last_page: 2,
      facet_index: 3,
      pending_subranges: [
        [0, 63],
        [64, 127],
      ],
    })
    expect(state.facetIndex).toBe(3)
    expect(state.lastPage).toBe(2)
    expect(state.pendingSubranges).toEqual([
      { lo: 0, hi: 63 },
      { lo: 64, hi: 127 },
    ])
  })

  it('cursorToFacetState maps a null upper bound back to Infinity', () => {
    const state = cursorToFacetState({
      path: '',
      facet: '16384+',
      last_page: 0,
      facet_index: 8,
      pending_subranges: [[16384, null]],
    })
    expect(state.pendingSubranges[0]).toEqual({ lo: 16384, hi: Number.POSITIVE_INFINITY })
  })

  it('currentFacetRange returns the top-level facet when the stack is empty', () => {
    const state: FacetCrawlState = { facetIndex: 0, pendingSubranges: [], lastPage: 0 }
    expect(currentFacetRange(state, FACETS)).toEqual(FACETS[0])
  })

  it('currentFacetRange returns the stack head (LIFO) when a bisection is in progress', () => {
    const state: FacetCrawlState = {
      facetIndex: 0,
      pendingSubranges: [
        { lo: 64, hi: 127 },
        { lo: 0, hi: 63 },
      ],
      lastPage: 0,
    }
    expect(currentFacetRange(state, FACETS)).toEqual({ lo: 0, hi: 63 })
  })

  it('currentFacetRange returns null once the ladder is exhausted', () => {
    const state: FacetCrawlState = {
      facetIndex: FACETS.length,
      pendingSubranges: [],
      lastPage: 0,
    }
    expect(currentFacetRange(state, FACETS)).toBeNull()
  })

  it('bisectCurrentFacet splits a top-level facet, lower half on top, page reset', () => {
    const state: FacetCrawlState = { facetIndex: 0, pendingSubranges: [], lastPage: 4 }
    const ok = bisectCurrentFacet(state, { lo: 0, hi: 127 })
    expect(ok).toBe(true)
    expect(state.pendingSubranges).toEqual([
      { lo: 64, hi: 127 },
      { lo: 0, hi: 63 },
    ])
    expect(currentFacetRange(state, FACETS)).toEqual({ lo: 0, hi: 63 }) // crawled next
    expect(state.lastPage).toBe(0)
    expect(state.facetIndex).toBe(0) // top-level index unchanged until the stack drains
  })

  it('bisectCurrentFacet replaces the stack head with its halves', () => {
    const state: FacetCrawlState = {
      facetIndex: 2,
      pendingSubranges: [{ lo: 0, hi: 63 }],
      lastPage: 1,
    }
    bisectCurrentFacet(state, { lo: 0, hi: 63 })
    expect(state.pendingSubranges).toEqual([
      { lo: 32, hi: 63 },
      { lo: 0, hi: 31 },
    ])
  })

  it('bisectCurrentFacet returns false for an unsplittable range (lo === hi)', () => {
    const state: FacetCrawlState = { facetIndex: 0, pendingSubranges: [], lastPage: 0 }
    expect(bisectCurrentFacet(state, { lo: 5, hi: 5 })).toBe(false)
    expect(state.pendingSubranges).toEqual([])
  })

  it('advanceFacet pops the stack when bisecting, else increments facetIndex', () => {
    const withStack: FacetCrawlState = {
      facetIndex: 1,
      pendingSubranges: [{ lo: 0, hi: 63 }],
      lastPage: 3,
    }
    advanceFacet(withStack)
    expect(withStack.pendingSubranges).toEqual([])
    expect(withStack.facetIndex).toBe(1) // unchanged — a sub-range finished, not the facet
    expect(withStack.lastPage).toBe(0)

    const noStack: FacetCrawlState = { facetIndex: 1, pendingSubranges: [], lastPage: 3 }
    advanceFacet(noStack)
    expect(noStack.facetIndex).toBe(2)
    expect(noStack.lastPage).toBe(0)
  })

  it('isFacetCrawlDone is true only when the ladder AND the bisection frontier are empty', () => {
    expect(
      isFacetCrawlDone({ facetIndex: FACETS.length, pendingSubranges: [], lastPage: 0 }, FACETS)
    ).toBe(true)
    expect(
      isFacetCrawlDone(
        { facetIndex: FACETS.length, pendingSubranges: [{ lo: 0, hi: 63 }], lastPage: 0 },
        FACETS
      )
    ).toBe(false)
    expect(isFacetCrawlDone({ facetIndex: 3, pendingSubranges: [], lastPage: 0 }, FACETS)).toBe(
      false
    )
  })

  it('facetStateToCursor → cursorToFacetState round-trips through JSON (Infinity survives as null)', () => {
    const state: FacetCrawlState = {
      facetIndex: 8,
      pendingSubranges: [{ lo: 16384, hi: Number.POSITIVE_INFINITY }],
      lastPage: 2,
    }
    const cursor = facetStateToCursor(state, '.agents/skills', FACETS)
    // The open-ended upper bound is persisted as null (JSON-safe).
    expect(cursor.pending_subranges).toEqual([[16384, null]])
    expect(cursor.path).toBe('.agents/skills')

    // Survive a real JSON round-trip (the audit_logs metadata path).
    const roundTripped = JSON.parse(JSON.stringify(cursor))
    const restored = cursorToFacetState(roundTripped)
    expect(restored).toEqual(state)
  })

  it("facetStateToCursor reports facet 'done' when the ladder is exhausted", () => {
    const cursor = facetStateToCursor(
      { facetIndex: FACETS.length, pendingSubranges: [], lastPage: 0 },
      '',
      FACETS
    )
    expect(cursor.facet).toBe('done')
    expect(cursor.facet_index).toBe(FACETS.length)
  })
})
