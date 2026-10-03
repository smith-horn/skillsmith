/**
 * SMI-6114 retro F3: pin the `audit_logs` select shape `loadTeamOverviewData` uses for the team
 * activity feed. `team-activity-format.ts`'s formatter treats a missing `result` as "not
 * success" — this test guards the other half: the select that must keep supplying it. Nothing
 * imports or exercises this module's data-fetch path anywhere else in the test suite.
 */
import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadTeamOverviewData } from './account-overview-data'

/**
 * A minimal recording fake: every `.from(table)` call returns a chainable, thenable query
 * builder. `.select()` is recorded per table; every other chain method just returns the same
 * builder (or, for the awaited terminal position, a safe empty/well-shaped result) so
 * `loadTeamOverviewData` can run to completion without a real Supabase client.
 */
function createFakeSupabase(onSelect: (table: string, columns: string) => void): SupabaseClient {
  const resolveValueFor = (table: string): { data: unknown; error: null } => {
    if (table === 'teams') {
      return { data: { name: 'Test Team', slug: 'test-team', max_members: 5 }, error: null }
    }
    return { data: [], error: null }
  }

  function builder(table: string) {
    const api: Record<string, (...args: unknown[]) => unknown> = {
      select: (columns: unknown) => {
        onSelect(table, String(columns))
        return api
      },
      eq: () => api,
      order: () => api,
      limit: () => Promise.resolve(resolveValueFor(table)),
      single: () => Promise.resolve(resolveValueFor(table)),
      then: (onFulfilled?: unknown, onRejected?: unknown) =>
        Promise.resolve(resolveValueFor(table)).then(
          onFulfilled as (v: unknown) => unknown,
          onRejected as (e: unknown) => unknown
        ),
    }
    return api
  }

  return {
    from: (table: string) => builder(table),
    rpc: (name: string) => {
      if (name === 'get_team_usage_for_period') return Promise.resolve({ data: null, error: null })
      return Promise.resolve({ data: [], error: null })
    },
  } as unknown as SupabaseClient
}

describe('loadTeamOverviewData — audit_logs select shape (SMI-6114 retro F3)', () => {
  it('selects `result` for the team activity feed', async () => {
    const selects: Array<{ table: string; columns: string }> = []
    const supabase = createFakeSupabase((table, columns) => selects.push({ table, columns }))

    await loadTeamOverviewData(supabase, 'team-1')

    const auditLogsSelects = selects.filter((s) => s.table === 'audit_logs')
    // Denominator first: a fake that never reached the audit_logs select would make the
    // per-select assertion below vacuous.
    expect(auditLogsSelects.length).toBeGreaterThan(0)
    for (const { columns } of auditLogsSelects) {
      const fields = columns.split(',').map((c) => c.trim())
      expect(fields).toContain('result')
    }
  })
})
