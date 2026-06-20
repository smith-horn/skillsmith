/**
 * Backfill checkpoint dry-run hygiene tests (SMI-5319 W3)
 * @module scripts/tests/indexer/backfill-checkpoint.dry-run
 *
 * Covers the W3 additions to backfill-checkpoint.ts:
 *  - writeCheckpoint stamps dry_run: true/false into audit_logs.metadata
 *  - readLatestCheckpoint excludeDryRun: true applies the PostgREST .not() filter
 *  - excludeDryRun is NULL-safe: legacy rows with no dry_run field are NOT excluded
 *  - excludeDryRun: false (default) — dry-run rows are still returned
 *
 * Split from backfill-checkpoint.test.ts to stay under the 500-line CI gate.
 */

import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  writeCheckpoint,
  readLatestCheckpoint,
  type BackfillCheckpointPayload,
} from '../../indexer/backfill-checkpoint.ts'

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function makePayload(
  overrides: Partial<BackfillCheckpointPayload> = {}
): BackfillCheckpointPayload {
  return {
    run_id: 'run-dry-run-test',
    cursor: { path: 'test/path', facet: '2026-06-19', last_page: 1 },
    facets_completed: 2,
    facets_total: 8,
    cap_saturated: false,
    truncated_repo_count: 0,
    dry_run: false,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Insert mock (mirrors the shape in backfill-checkpoint.test.ts)
// ---------------------------------------------------------------------------

interface CapturedInsert {
  table: string
  payload: Record<string, unknown>
}

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

// ---------------------------------------------------------------------------
// Read mock with not() filter capture
// ---------------------------------------------------------------------------

type ReadQueryState = {
  row: { metadata: BackfillCheckpointPayload } | null
  error: { message: string } | null
  eqFilters: Record<string, string>
  /** Captures .or(filterString) calls for assertion. */
  orFilters: string[]
}

function makeReadMock(state: ReadQueryState): SupabaseClient {
  const chain = {
    eq: (key: string, value: string) => {
      state.eqFilters[key] = value
      return chain
    },
    or: (filter: string) => {
      state.orFilters.push(filter)
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
// writeCheckpoint: dry_run tag (SMI-5319 W3)
// ---------------------------------------------------------------------------

describe('writeCheckpoint — dry_run tag (SMI-5319 W3)', () => {
  it('stamps dry_run: true into audit_logs.metadata when payload.dry_run is true', async () => {
    const captured: CapturedInsert[] = []
    const supabase = makeInsertMock(captured)

    await writeCheckpoint(supabase, makePayload({ dry_run: true }))

    const metadata = captured[0].payload.metadata as Record<string, unknown>
    expect(metadata.dry_run).toBe(true)
  })

  it('stamps dry_run: false into audit_logs.metadata when payload.dry_run is false', async () => {
    const captured: CapturedInsert[] = []
    const supabase = makeInsertMock(captured)

    await writeCheckpoint(supabase, makePayload({ dry_run: false }))

    const metadata = captured[0].payload.metadata as Record<string, unknown>
    expect(metadata.dry_run).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// readLatestCheckpoint: excludeDryRun filter (SMI-5319 W3)
// ---------------------------------------------------------------------------

describe('readLatestCheckpoint — excludeDryRun (SMI-5319 W3)', () => {
  it('does NOT apply an or() filter when excludeDryRun is false (default)', async () => {
    const state: ReadQueryState = {
      row: { metadata: makePayload() },
      error: null,
      eqFilters: {},
      orFilters: [],
    }
    const supabase = makeReadMock(state)

    await readLatestCheckpoint(supabase, undefined, { excludeDryRun: false })

    expect(state.orFilters).toHaveLength(0)
  })

  it('does NOT apply an or() filter when options is omitted entirely', async () => {
    const state: ReadQueryState = {
      row: { metadata: makePayload() },
      error: null,
      eqFilters: {},
      orFilters: [],
    }
    const supabase = makeReadMock(state)

    // No options arg — default behaviour must be back-compat (no filter).
    await readLatestCheckpoint(supabase)

    expect(state.orFilters).toHaveLength(0)
  })

  it('applies a NULL-safe .or() (dry_run neq true OR is null) when excludeDryRun is true', async () => {
    const state: ReadQueryState = {
      row: { metadata: makePayload({ dry_run: false }) },
      error: null,
      eqFilters: {},
      orFilters: [],
    }
    const supabase = makeReadMock(state)

    await readLatestCheckpoint(supabase, undefined, { excludeDryRun: true })

    expect(state.orFilters).toHaveLength(1)
    expect(state.orFilters[0]).toBe('metadata->>dry_run.neq.true,metadata->>dry_run.is.null')
  })

  it('excludeDryRun: true — filter applied; mock returns the live (non-dry-run) row', async () => {
    // The DB has two rows: most recent is dry_run:true, prior is dry_run:false.
    // With the filter applied, the DB returns only the live row (mock simulates this).
    const livePayload = makePayload({ run_id: 'live-run', dry_run: false })
    const state: ReadQueryState = {
      row: { metadata: livePayload },
      error: null,
      eqFilters: {},
      orFilters: [],
    }
    const supabase = makeReadMock(state)

    const result = await readLatestCheckpoint(supabase, undefined, { excludeDryRun: true })

    expect(state.orFilters).toHaveLength(1)
    expect(result).not.toBeNull()
    expect(result?.run_id).toBe('live-run')
    expect(result?.dry_run).toBe(false)
  })

  it('excludeDryRun: false — returns a dry-run row when it is the latest', async () => {
    // A DRY_RUN dispatch resuming from the latest checkpoint should still
    // see dry-run checkpoints (to verify the resume loop end-to-end).
    const dryRunPayload = makePayload({ run_id: 'dry-run', dry_run: true })
    const state: ReadQueryState = {
      row: { metadata: dryRunPayload },
      error: null,
      eqFilters: {},
      orFilters: [],
    }
    const supabase = makeReadMock(state)

    const result = await readLatestCheckpoint(supabase, undefined, { excludeDryRun: false })

    // No or() filter applied.
    expect(state.orFilters).toHaveLength(0)
    expect(result?.run_id).toBe('dry-run')
    expect(result?.dry_run).toBe(true)
  })

  it('legacy row WITHOUT dry_run field is returned when excludeDryRun is true (NULL-safe)', async () => {
    // A legacy checkpoint row has no dry_run key in metadata (JSONB value is null).
    // The query uses `.or('metadata->>dry_run.neq.true,metadata->>dry_run.is.null')`,
    // which emits `metadata->>'dry_run' <> 'true' OR metadata->>'dry_run' IS NULL`.
    // The IS NULL branch includes legacy rows — they are NOT silently excluded.
    // A unit test can't exercise the DB predicate (the mock returns the row), so this
    // proves null-safety at the query-construction level: the .or() string carries the
    // explicit `is.null` branch (asserted below). DB-level behaviour is covered by the
    // live-dispatch verification (SMI-5319). Pre-SMI-5319 dry-run rows must still be
    // cleaned up by the operator pre-flight.
    const legacyPayload = makePayload({ run_id: 'legacy-live-run' })
    // Delete dry_run to simulate a pre-SMI-5319 row.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { dry_run, ...legacyWithoutDryRun } = legacyPayload
    const state: ReadQueryState = {
      row: { metadata: legacyWithoutDryRun as BackfillCheckpointPayload },
      error: null,
      eqFilters: {},
      orFilters: [],
    }
    const supabase = makeReadMock(state)

    const result = await readLatestCheckpoint(supabase, undefined, { excludeDryRun: true })

    // The NULL-safe .or() filter was applied — its `is.null` branch is what keeps
    // legacy rows; assert the exact null-inclusive form (proof, not a tautology).
    expect(state.orFilters).toHaveLength(1)
    expect(state.orFilters[0]).toContain('metadata->>dry_run.is.null')
    // The legacy checkpoint is returned — not dropped.
    expect(result).not.toBeNull()
    expect(result?.run_id).toBe('legacy-live-run')
    // dry_run is absent on legacy rows (undefined after the cast-back).
    expect((result as Record<string, unknown>)['dry_run']).toBeUndefined()
  })
})
