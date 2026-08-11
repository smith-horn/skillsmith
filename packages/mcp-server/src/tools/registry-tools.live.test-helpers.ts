/**
 * @fileoverview Shared fake-Supabase-client test fixtures for registry-tools.live.test.ts and
 * registry-tools.live.manage.test.ts (split from one file, SMI-5949 Wave 2, to stay under the
 * 500-line audit:standards gate).
 * @see SMI-5816: Private skill registry — real implementation (ADR-129)
 *
 * No `vi.mock()` calls live here — those must stay in each actual test file (vitest hoists them
 * per test-file module graph). This file only provides plain fixtures/helpers that assume the
 * importing test file has already called `vi.mock('../supabase-client.js', ...)` and
 * `vi.mock('./team-resolver.js', ...)`.
 */

import { vi } from 'vitest'
import type { ToolContext } from '../context.js'

export const RESOLVED_TEAM = 'team-alpha'
export const SAMPLE_CONTENT = { 'SKILL.md': '# My Skill\n\nDoes a useful thing.' }

// ============================================================================
// Fake Supabase client (recorder + scripted responses)
// ============================================================================

interface Recorded {
  table: string
  op: 'select' | 'insert' | 'update' | 'delete'
  filters: Array<{ column: string; value: unknown }>
  payload?: Record<string, unknown>
  selectCalled: boolean
}

type SingleResponder = () => { data: unknown; error: { code?: string; message?: string } | null }
type ThenResponder = () => {
  data: unknown[] | null
  error: { code?: string; message?: string } | null
}
type RpcResponder = (
  fn: string,
  params: Record<string, unknown>
) => { data: unknown; error: { code?: string; message?: string } | null }

interface FakeClientOptions {
  singleResponder?: SingleResponder
  thenResponder?: ThenResponder
  /**
   * Override the default RPC response for EITHER `get_private_registry_submissions` or
   * `review_private_registry_submission` (SMI-5949 D-5) — the callback receives `fn` to
   * distinguish them. Defaults (see `defaultRpc`/`defaultReviewRpc` below) cover the common
   * success shape for both, so most tests never need to set this; a test simulating an RPC
   * failure (not-admin `42501`, self-approval, terminal-state, missing `published_by` `23514`)
   * scripts one here, checking `fn` if it only wants to fail one of the two.
   */
  rpcResponder?: RpcResponder
}

export function createFakeClient(opts: FakeClientOptions = {}): {
  client: unknown
  calls: Recorded[]
  rpcCalls: Array<{ fn: string; params: Record<string, unknown> }>
} {
  const calls: Recorded[] = []
  const rpcCalls: Array<{ fn: string; params: Record<string, unknown> }> = []

  function makeQuery(table: string) {
    const record: Recorded = { table, op: 'select', filters: [], selectCalled: false }
    calls.push(record)
    const chain: Record<string, unknown> = {
      select: (_columns?: string) => {
        record.selectCalled = true
        return chain
      },
      eq: (column: string, value: unknown) => {
        record.filters.push({ column, value })
        return chain
      },
      insert: (row: Record<string, unknown>) => {
        record.op = 'insert'
        record.payload = row
        return chain
      },
      update: (row: Record<string, unknown>) => {
        record.op = 'update'
        record.payload = row
        return chain
      },
      single: async () => opts.singleResponder?.() ?? { data: null, error: null },
      then: (onFulfilled: (v: { data: unknown[] | null; error: unknown }) => unknown) => {
        // Mirrors real PostgREST: insert/update only return row data (`data`) when
        // .select() was chained (sets `Prefer: return=representation`) — without it,
        // `data` is null even on a successful mutation. A fake that always returns
        // the scripted response regardless of whether .select() was called would not
        // have caught the real bug this guards against (deprecate/undeprecate
        // originally omitted .select() and so always reported "not found").
        //
        // An error still surfaces on a representation-free write, though (SMI-5949 D-4(a),
        // empirically confirmed against staging): a genuine failure (e.g. unique_violation)
        // comes back with `error` set and `data: null` regardless of whether .select() was
        // requested — only the SUCCESS-path `data` is representation-dependent.
        if ((record.op === 'update' || record.op === 'insert') && !record.selectCalled) {
          const resp = opts.thenResponder?.() ?? { data: null, error: null }
          return Promise.resolve(onFulfilled({ data: null, error: resp.error }))
        }
        const resp = opts.thenResponder?.() ?? { data: [], error: null }
        return Promise.resolve(onFulfilled(resp))
      },
    }
    return chain
  }

  // SMI-5949 D-5: publish()'s read-back RPC. Default behavior derives the returned submission
  // row from the most recent insert, so a test that doesn't care about the read-back shape
  // (most of them) gets a row that actually matches what it just published, without scripting
  // its own fixture. `rpcResponder` lets a test override this to simulate an RPC failure.
  function defaultRpc(): { data: unknown; error: { code?: string; message?: string } | null } {
    const lastInsert = [...calls].reverse().find((c) => c.op === 'insert')
    if (!lastInsert?.payload) return { data: [], error: null }
    return {
      data: [
        {
          id: 'row-1',
          skill_id: lastInsert.payload.skill_id,
          version: lastInsert.payload.version,
          description: (lastInsert.payload.description as string | null | undefined) ?? null,
          approval_status: 'pending',
          approval_mode: 'review',
          published_by: 'user-fake-sub',
          published_at: '2026-07-24T00:00:00Z',
          approved_by: null,
          approved_at: null,
          review_note: null,
        },
      ],
      error: null,
    }
  }

  // SMI-5949 Wave 2 Step 4: review_private_registry_submission's default response echoes the
  // RPC's own request params back as the "decision" row — a test asserting a success path
  // (approve/reject) gets a row that actually reflects what it asked for, without scripting its
  // own fixture. `rpcResponder` overrides this the same way it overrides `defaultRpc` above.
  function defaultReviewRpc(params: Record<string, unknown>): {
    data: unknown
    error: { code?: string; message?: string } | null
  } {
    return {
      data: [
        {
          id: 'row-1',
          skill_id: params.p_skill_id,
          version: params.p_version,
          approval_status: params.p_decision,
          approved_by: 'user-fake-sub',
          approved_at: '2026-08-11T00:00:00Z',
          review_note: (params.p_note as string | null | undefined) ?? null,
        },
      ],
      error: null,
    }
  }

  const client = {
    from: (table: string) => makeQuery(table),
    rpc: async (fn: string, params: Record<string, unknown> = {}) => {
      rpcCalls.push({ fn, params })
      if (opts.rpcResponder) return opts.rpcResponder(fn, params)
      if (fn === 'get_private_registry_submissions') return defaultRpc()
      if (fn === 'review_private_registry_submission') return defaultReviewRpc(params)
      return { data: null, error: null }
    },
  }

  return { client, calls, rpcCalls }
}

export function makeContext(): ToolContext {
  return {} as unknown as ToolContext
}

/**
 * Point both client factories at one recorder.
 *
 * Since SMI-5822, deprecate/undeprecate run through the signed-in user's client while the
 * audit write still uses the service-role client, so a test touching those paths needs both.
 */
export async function mockBothClients(client: unknown): Promise<void> {
  const { getSupabaseAdminClient, getSupabaseUserClient } = await import('../supabase-client.js')
  vi.mocked(getSupabaseAdminClient).mockResolvedValue(client)
  vi.mocked(getSupabaseUserClient).mockResolvedValue(client)
}

export function publishedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    team_id: RESOLVED_TEAM,
    skill_id: 'myteam/skill-a',
    version: '1.0.0',
    description: null,
    content_hash: 'hash',
    deprecated: false,
    published_by: null,
    published_at: '2026-07-24T00:00:00Z',
    // SMI-5949 D-3: NOT NULL on the real table — list()/get() only ever return 'approved' rows
    // (the .eq('approval_status','approved') predicate), so that is the realistic default here.
    approval_status: 'approved',
    approval_mode: 'auto',
    ...overrides,
  }
}
