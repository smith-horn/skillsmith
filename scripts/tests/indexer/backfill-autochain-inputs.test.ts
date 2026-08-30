/**
 * SMI-6246: unit coverage for indexer-backfill-autochain.yml's
 * checkpoint-recovery logic — must never resolve to a globally-"latest"
 * checkpoint (round-3 regression), only the exact completed run's own
 * checkpoint or its own skip-branch audit row.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  resolveForProject,
  countConsecutiveSkipsForResumeFrom,
  buildRetryCapOutcome,
} from '../../indexer/backfill-autochain-inputs.ts'

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
 *
 * SMI-6246 (pr-reviewer round-1 finding): the audit-row branch's data is
 * gated behind the EXACT `metadata->meta->>github_run_id` column path — a
 * regression back to the wrong `metadata->>github_run_id` path (queried in
 * round 1's original, broken implementation) makes this mock return null
 * instead of `auditRow`, failing any test that expects a real result.
 */
function makeSupabase({
  checkpointRow,
  auditRow,
}: {
  checkpointRow?: { metadata: unknown } | null
  auditRow?: { metadata: unknown } | null
}) {
  const eqCalls: Array<[string, string]> = []
  const supabase = {
    from: vi.fn().mockImplementation((table: string) => {
      if (table !== 'audit_logs') throw new Error(`unexpected table: ${table}`)
      let eventType: string | undefined
      let correctAuditPathQueried = false
      const builder = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockImplementation((column: string, value: string) => {
          eqCalls.push([column, value])
          if (column === 'event_type') eventType = value
          if (column === 'metadata->meta->>github_run_id') correctAuditPathQueried = true
          return builder
        }),
        or: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockImplementation(() =>
          Promise.resolve({
            data:
              eventType === 'indexer:run'
                ? correctAuditPathQueried
                  ? (auditRow ?? null)
                  : null // wrong/missing column path never matches, regardless of fixture
                : (checkpointRow ?? null),
            error: null,
          })
        ),
      }
      return builder
    }),
  }
  return { supabase, eqCalls }
}

describe('SMI-6246: resolveForProject — exact-match checkpoint path', () => {
  it('resolves directly from the exact-run checkpoint when one exists', async () => {
    const { supabase } = makeSupabase({
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
      isRetry: false,
    })
  })

  it('treats cursor.facet === "done" as campaign complete', async () => {
    const { supabase } = makeSupabase({
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
    expect(result?.isRetry).toBe(false)
  })

  it('returns null (never defaults) when the exact-match checkpoint is missing dispatch_inputs', async () => {
    const { supabase } = makeSupabase({
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
    const { supabase, eqCalls } = makeSupabase({
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
      isRetry: true,
    })
    // pr-reviewer round-1 finding, closed: the query must use the nested path.
    expect(eqCalls).toContainEqual(['metadata->meta->>github_run_id', 'run-99'])
    expect(eqCalls).not.toContainEqual(['metadata->>github_run_id', 'run-99'])
  })

  it("an unrelated older already-done campaign in the table does not affect a fresh campaign's first-attempt lock-skip", async () => {
    // resumed_from is the literal 'latest' (a genuinely fresh dispatch) — the
    // fallback must NOT go looking up "the latest checkpoint" (which could be
    // the unrelated older campaign); it has nothing to check cursorDone
    // against and should not claim the campaign is done.
    const { supabase } = makeSupabase({
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
    expect(result?.isRetry).toBe(true)
  })

  it('fails closed (returns null) when the audit row itself is missing dispatch_inputs', async () => {
    const { supabase } = makeSupabase({
      checkpointRow: null,
      auditRow: { metadata: { meta: { status: 'skipped_lock' } } },
    })
    const result = await resolveForProject(supabase as never, 'run-1', 'prod')
    expect(result).toBeNull()
  })

  it('fails closed (returns null) when neither a checkpoint nor an audit row exists for this run at all', async () => {
    const { supabase } = makeSupabase({ checkpointRow: null, auditRow: null })
    const result = await resolveForProject(supabase as never, 'run-1', 'prod')
    expect(result).toBeNull()
  })
})

describe('SMI-6246 change #4c: countConsecutiveSkipsForResumeFrom', () => {
  function makeAuditRowsMock(rows: Array<{ metadata: unknown }>) {
    return {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({ data: rows, error: null }),
      }),
    }
  }

  it('counts consecutive skips against the same resume_from', async () => {
    const supabase = makeAuditRowsMock([
      { metadata: { meta: { status: 'skipped_lock', resumed_from: 'run-1' } } },
      { metadata: { meta: { status: 'skipped_lock', resumed_from: 'run-1' } } },
      { metadata: { meta: { status: 'skipped_lock', resumed_from: 'run-1' } } },
    ])
    const count = await countConsecutiveSkipsForResumeFrom(supabase as never, 'run-1')
    expect(count).toBe(3)
  })

  it('stops counting at the first row for a DIFFERENT resume_from (a new campaign/chunk succeeded)', async () => {
    const supabase = makeAuditRowsMock([
      { metadata: { meta: { status: 'skipped_lock', resumed_from: 'run-2' } } },
      { metadata: { meta: { status: 'skipped_lock', resumed_from: 'run-2' } } },
      // Older rows reference a DIFFERENT (now-superseded) resume_from.
      { metadata: { meta: { status: 'skipped_lock', resumed_from: 'run-1' } } },
      { metadata: { meta: { status: 'skipped_lock', resumed_from: 'run-1' } } },
    ])
    const count = await countConsecutiveSkipsForResumeFrom(supabase as never, 'run-2')
    expect(count).toBe(2)
  })

  it('ignores interleaved cron discovery/maintenance/recheck rows entirely (they carry no resumed_from)', async () => {
    const supabase = makeAuditRowsMock([
      { metadata: { meta: { status: 'skipped_lock', resumed_from: 'run-1' } } },
      // A scheduled maintenance run's own row, unrelated to backfill — must
      // not break the "consecutive" streak just because it's chronologically
      // interleaved in the same audit_logs table.
      { metadata: { meta: { status: 'success', run_type: 'maintenance' } } },
      { metadata: { meta: { status: 'skipped_lock', resumed_from: 'run-1' } } },
      { metadata: { meta: { status: 'skipped_lock', resumed_from: 'run-1' } } },
    ])
    const count = await countConsecutiveSkipsForResumeFrom(supabase as never, 'run-1')
    expect(count).toBe(3)
  })

  it('returns 0 when the query errors (fails open — never blocks a real dispatch on this alone)', async () => {
    const supabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({ data: null, error: { message: 'boom' } }),
      }),
    }
    const count = await countConsecutiveSkipsForResumeFrom(supabase as never, 'run-1')
    expect(count).toBe(0)
  })

  it('returns 0 when no rows exist at all', async () => {
    const supabase = makeAuditRowsMock([])
    const count = await countConsecutiveSkipsForResumeFrom(supabase as never, 'run-1')
    expect(count).toBe(0)
  })
})

// pr-reviewer round-1 finding, verification-checklist gap closed: the plan
// and runbook documented a 5-consecutive-skip retry cap as already shipped,
// but nothing tested the exact threshold it trips at. buildRetryCapOutcome
// is the pure decision extracted from main() specifically to make this
// testable without mocking a Supabase client end-to-end.
describe('SMI-6246 change #4c: buildRetryCapOutcome', () => {
  it('does not trip below the cap', () => {
    expect(buildRetryCapOutcome(4, 'run-1')).toBeNull()
  })

  it('trips at exactly the cap (5)', () => {
    const outcome = buildRetryCapOutcome(5, 'run-1')
    expect(outcome).toEqual({
      skip: 'true',
      retry_cap_exceeded: 'true',
      skip_reason: expect.stringContaining('5 consecutive lock-skips against resume_from=run-1'),
    })
  })

  it('still trips past the cap, not only exactly at it', () => {
    expect(buildRetryCapOutcome(6, 'run-1')).not.toBeNull()
  })

  it('names the exact resume_from in the skip_reason so an operator can find the stuck campaign', () => {
    const outcome = buildRetryCapOutcome(5, 'run-42')
    expect(outcome?.skip_reason).toContain('resume_from=run-42')
  })
})
