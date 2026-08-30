/**
 * SMI-6246: unit coverage for indexer-backfill-autochain.yml's
 * checkpoint-recovery logic — must never resolve to a globally-"latest"
 * checkpoint (round-3 regression), only the exact completed run's own
 * checkpoint or its own skip-branch audit row.
 */
import { describe, it, expect, vi } from 'vitest'
import { resolveForProject } from '../../indexer/backfill-autochain-inputs.ts'

const dispatchInputs = {
  maxSkillsPerRepo: '50',
  pathPrefix: '',
  maxRanges: 50,
  minSizeBytes: 0,
  maxSkillsPerDispatch: 0,
  maxElapsedMinutes: 280,
  acceptTruncation: false,
  supabaseEnv: 'prod',
  tokenSource: 'backfill',
}

/**
 * Both `readLatestCheckpoint()` (event_type='indexer_backfill_checkpoint')
 * and this module's own audit-row fallback query (event_type='indexer:run')
 * resolve via `.maybeSingle()` — this mock discriminates by which
 * `event_type` was queried, since it's the only argument that tells the two
 * apart.
 */
function makeSupabase({
  checkpointRow,
  auditRow,
}: {
  checkpointRow?: { metadata: unknown } | null
  auditRow?: { metadata: unknown } | null
}) {
  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (table !== 'audit_logs') throw new Error(`unexpected table: ${table}`)
      let eventType: string | undefined
      const builder = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockImplementation((column: string, value: string) => {
          if (column === 'event_type') eventType = value
          return builder
        }),
        or: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockImplementation(() =>
          Promise.resolve({
            data: eventType === 'indexer:run' ? (auditRow ?? null) : (checkpointRow ?? null),
            error: null,
          })
        ),
      }
      return builder
    }),
  }
}

describe('SMI-6246: resolveForProject — exact-match checkpoint path', () => {
  it('resolves directly from the exact-run checkpoint when one exists', async () => {
    const supabase = makeSupabase({
      checkpointRow: {
        metadata: {
          run_id: 'run-42',
          cursor: { path: '', facet: 'f1', last_page: 1 },
          facets_completed: 1,
          facets_total: 10,
          cap_saturated: false,
          truncated_repo_count: 0,
          incomplete_results_ranges: 0,
          dry_run: false,
          dispatch_inputs: dispatchInputs,
        },
      },
    })
    const result = await resolveForProject(supabase as never, 'run-42', 'prod')
    expect(result).toEqual({
      supabaseEnv: 'prod',
      resumeFrom: 'run-42',
      dryRun: false,
      dispatchInputs,
      cursorDone: false,
    })
  })

  it('treats cursor.facet === "done" as campaign complete', async () => {
    const supabase = makeSupabase({
      checkpointRow: {
        metadata: {
          run_id: 'run-42',
          cursor: { path: '', facet: 'done', last_page: 1 },
          facets_completed: 10,
          facets_total: 10,
          cap_saturated: false,
          truncated_repo_count: 0,
          incomplete_results_ranges: 0,
          dry_run: false,
          dispatch_inputs: dispatchInputs,
        },
      },
    })
    const result = await resolveForProject(supabase as never, 'run-42', 'prod')
    expect(result?.cursorDone).toBe(true)
  })

  it('returns null (never defaults) when the exact-match checkpoint is missing dispatch_inputs', async () => {
    const supabase = makeSupabase({
      checkpointRow: {
        metadata: {
          run_id: 'run-42',
          cursor: { path: '', facet: 'f1', last_page: 1 },
          facets_completed: 1,
          facets_total: 10,
          cap_saturated: false,
          truncated_repo_count: 0,
          incomplete_results_ranges: 0,
          dry_run: false,
          // no dispatch_inputs — a pre-SMI-6246 checkpoint
        },
      },
    })
    const result = await resolveForProject(supabase as never, 'run-42', 'prod')
    expect(result).toBeNull()
  })
})

describe("SMI-6246: resolveForProject — fallback to the failed attempt's own audit row (round-3 fix)", () => {
  it('retries the exact same handoff a specific resumed_from named, never a global "latest" lookup', async () => {
    const supabase = makeSupabase({
      checkpointRow: null,
      auditRow: {
        metadata: {
          dry_run: true,
          meta: {
            status: 'skipped_lock',
            github_run_id: 'run-99',
            resumed_from: 'run-98',
            dispatch_inputs: dispatchInputs,
          },
        },
      },
    })
    const result = await resolveForProject(supabase as never, 'run-99', 'prod')
    expect(result).toMatchObject({
      resumeFrom: 'run-98', // the SAME prior checkpoint, not "latest"
      dryRun: true, // recovered from this exact failed attempt's own metadata.dry_run
      dispatchInputs,
    })
  })

  it("an unrelated older already-done campaign in the table does not affect a fresh campaign's first-attempt lock-skip", async () => {
    // resumed_from is the literal 'latest' (a genuinely fresh dispatch) — the
    // fallback must NOT go looking up "the latest checkpoint" (which could be
    // the unrelated older campaign); it has nothing to check cursorDone
    // against and should not claim the campaign is done.
    const supabase = makeSupabase({
      checkpointRow: null,
      auditRow: {
        metadata: {
          dry_run: false,
          meta: {
            status: 'skipped_lock',
            github_run_id: 'run-1',
            resumed_from: 'latest',
            dispatch_inputs: dispatchInputs,
          },
        },
      },
    })
    const result = await resolveForProject(supabase as never, 'run-1', 'prod')
    expect(result?.cursorDone).toBe(false)
    expect(result?.resumeFrom).toBe('latest')
  })

  it('fails closed (returns null) when the audit row itself is missing dispatch_inputs', async () => {
    const supabase = makeSupabase({
      checkpointRow: null,
      auditRow: { metadata: { meta: { status: 'skipped_lock' } } },
    })
    const result = await resolveForProject(supabase as never, 'run-1', 'prod')
    expect(result).toBeNull()
  })

  it('fails closed (returns null) when neither a checkpoint nor an audit row exists for this run at all', async () => {
    const supabase = makeSupabase({ checkpointRow: null, auditRow: null })
    const result = await resolveForProject(supabase as never, 'run-1', 'prod')
    expect(result).toBeNull()
  })
})
