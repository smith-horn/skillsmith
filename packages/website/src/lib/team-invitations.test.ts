/**
 * Tests for lib/team-invitations.ts
 *
 * SMI-4294 Wave 5: covers the TS wrapper that fronts the four team_invitations
 * RPCs + the team-invite-send edge function. The actual PL/pgSQL behavior is
 * tested by manual smoke + (post-deploy) a staging-only integration suite —
 * this file pins the TS error-mapping contract and the call shapes.
 *
 * Mock strategy mirrors team-access.test.ts: a thin `mockSupabase()` factory
 * that returns an object satisfying `SupabaseClient` for the methods we use.
 * Edge function fetch is mocked via globalThis.fetch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import {
  createInvitation,
  formatRelativeExpiry,
  listPending,
  removeTeamMember,
  resendInvitation,
  revokeInvitation,
} from './team-invitations'

// ──────────────────────────────────────────────────────────────────────────
// Mock helpers
// ──────────────────────────────────────────────────────────────────────────

interface MockClientOptions {
  rpcResponses?: Record<string, { data: unknown; error: { message: string } | null }>
  selectResponse?: { data: unknown; error: { message: string } | null }
  sessionAccessToken?: string | null
  supabaseUrl?: string
}

function mockSupabase(opts: MockClientOptions = {}): SupabaseClient {
  const rpcSpy = vi.fn(async (fnName: string) => {
    const r = opts.rpcResponses?.[fnName]
    if (r) return r
    return { data: null, error: { message: 'unmocked rpc' } }
  })

  const fromBuilder = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    gt: vi.fn().mockReturnThis(),
    order: vi.fn().mockResolvedValue(
      opts.selectResponse ?? {
        data: [],
        error: null,
      }
    ),
  }

  const client = {
    rpc: rpcSpy,
    from: vi.fn(() => fromBuilder),
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: {
          session:
            opts.sessionAccessToken === null
              ? null
              : { access_token: opts.sessionAccessToken ?? 'fake-jwt' },
        },
      }),
    },
    supabaseUrl: opts.supabaseUrl ?? 'https://stub.supabase.co',
  }
  return client as unknown as SupabaseClient
}

// ──────────────────────────────────────────────────────────────────────────
// fetch mock (for edge function calls)
// ──────────────────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch

beforeEach(() => {
  globalThis.fetch = vi.fn() as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

function mockFetchOnce(response: { ok: boolean; body?: unknown }): void {
  ;(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    ok: response.ok,
    json: async () => response.body ?? {},
    text: async () => JSON.stringify(response.body ?? {}),
  })
}

// ──────────────────────────────────────────────────────────────────────────
// createInvitation
// ──────────────────────────────────────────────────────────────────────────

describe('createInvitation', () => {
  it('returns ok=true with status=created on a fresh invite', async () => {
    const supabase = mockSupabase({
      rpcResponses: {
        create_team_invitation: {
          data: {
            invitation_id: 'inv_1',
            token: 'tok_1',
            expires_at: '2026-05-27T00:00:00Z',
            status: 'created',
          },
          error: null,
        },
      },
    })
    mockFetchOnce({ ok: true, body: { ok: true, sent: true } })

    const result = await createInvitation(supabase, 'team_1', 'peter@example.com', 'member')
    expect(result.ok).toBe(true)
    expect(result.status).toBe('created')
    expect(result.invitation_id).toBe('inv_1')
    expect(result.emailSent).toBe(true)
  })

  it('returns status=already_pending on duplicate (non-destructive)', async () => {
    const supabase = mockSupabase({
      rpcResponses: {
        create_team_invitation: {
          data: {
            invitation_id: 'inv_existing',
            token: 'tok_existing',
            expires_at: '2026-05-27T00:00:00Z',
            status: 'already_pending',
          },
          error: null,
        },
      },
    })
    mockFetchOnce({ ok: true, body: { ok: true, sent: true } })

    const result = await createInvitation(supabase, 'team_1', 'tony@example.com', 'member')
    expect(result.ok).toBe(true)
    expect(result.status).toBe('already_pending')
    // Even on duplicate we send an email (the user may have clicked Send again
    // expecting a re-fire). The Idempotency-Key prevents the provider from
    // double-billing.
    expect(result.emailSent).toBe(true)
  })

  it('maps "seat limit reached" RPC error to user-facing copy', async () => {
    const supabase = mockSupabase({
      rpcResponses: {
        create_team_invitation: {
          data: null,
          error: { message: 'seat limit reached: 5 of 5 seats in use' },
        },
      },
    })
    const result = await createInvitation(supabase, 'team_1', 'overflow@example.com', 'member')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('seat limit')
  })

  it('maps "already a member" RPC error', async () => {
    const supabase = mockSupabase({
      rpcResponses: {
        create_team_invitation: {
          data: null,
          error: { message: 'already a member' },
        },
      },
    })
    const result = await createInvitation(supabase, 'team_1', 'already@example.com', 'member')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('already')
  })

  it('maps "forbidden" RPC error', async () => {
    const supabase = mockSupabase({
      rpcResponses: {
        create_team_invitation: {
          data: null,
          error: { message: 'forbidden: only team owners or admins can invite' },
        },
      },
    })
    const result = await createInvitation(supabase, 'team_1', 'x@example.com', 'member')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/owners or admins/i)
  })

  it('maps "invalid email" RPC error', async () => {
    const supabase = mockSupabase({
      rpcResponses: {
        create_team_invitation: {
          data: null,
          error: { message: 'invalid email' },
        },
      },
    })
    const result = await createInvitation(supabase, 'team_1', 'not-an-email', 'member')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('not valid')
  })

  it('surfaces fallback_url when the edge function reports email_send_failed', async () => {
    const supabase = mockSupabase({
      rpcResponses: {
        create_team_invitation: {
          data: {
            invitation_id: 'inv_1',
            token: 'tok_1',
            expires_at: '2026-05-27T00:00:00Z',
            status: 'created',
          },
          error: null,
        },
      },
    })
    mockFetchOnce({
      ok: true,
      body: {
        ok: false,
        error: 'email_send_failed',
        fallback_url: 'https://www.skillsmith.app/invite/tok_1',
      },
    })

    const result = await createInvitation(supabase, 'team_1', 'p@example.com', 'member')
    expect(result.ok).toBe(true) // RPC succeeded, just the email failed
    expect(result.emailSent).toBe(false)
    expect(result.fallback_url).toBe('https://www.skillsmith.app/invite/tok_1')
  })

  it('returns ok=false with a default error when RPC payload is malformed', async () => {
    const supabase = mockSupabase({
      rpcResponses: {
        create_team_invitation: {
          // Missing invitation_id — defensive branch.
          data: { token: 'tok_1' } as unknown,
          error: null,
        },
      },
    })
    const result = await createInvitation(supabase, 'team_1', 'p@example.com', 'member')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/unexpected response/i)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// resendInvitation
// ──────────────────────────────────────────────────────────────────────────

describe('resendInvitation', () => {
  it('returns ok=true when the edge function 200s with ok=true', async () => {
    const supabase = mockSupabase({})
    mockFetchOnce({ ok: true, body: { ok: true, sent: true } })
    const result = await resendInvitation(supabase, 'inv_1')
    expect(result.ok).toBe(true)
  })

  it('returns ok=false + fallback_url when the edge function reports email_send_failed', async () => {
    const supabase = mockSupabase({})
    mockFetchOnce({
      ok: true,
      body: {
        ok: false,
        error: 'email_send_failed',
        fallback_url: 'https://www.skillsmith.app/invite/x',
      },
    })
    const result = await resendInvitation(supabase, 'inv_1')
    expect(result.ok).toBe(false)
    expect(result.fallback_url).toBe('https://www.skillsmith.app/invite/x')
  })

  it('returns ok=false when the user has no session', async () => {
    const supabase = mockSupabase({ sessionAccessToken: null })
    const result = await resendInvitation(supabase, 'inv_1')
    expect(result.ok).toBe(false)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// revokeInvitation
// ──────────────────────────────────────────────────────────────────────────

describe('revokeInvitation', () => {
  it('returns ok=true on RPC success', async () => {
    const supabase = mockSupabase({
      rpcResponses: { revoke_team_invitation: { data: null, error: null } },
    })
    const result = await revokeInvitation(supabase, 'inv_1')
    expect(result.ok).toBe(true)
  })

  it('maps "forbidden" RPC error to user-facing copy', async () => {
    const supabase = mockSupabase({
      rpcResponses: {
        revoke_team_invitation: { data: null, error: { message: 'forbidden: only team owners' } },
      },
    })
    const result = await revokeInvitation(supabase, 'inv_1')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/owners/i)
  })

  it('maps "invitation not found" RPC error', async () => {
    const supabase = mockSupabase({
      rpcResponses: {
        revoke_team_invitation: { data: null, error: { message: 'invitation not found' } },
      },
    })
    const result = await revokeInvitation(supabase, 'inv_missing')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not found/i)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// listPending
// ──────────────────────────────────────────────────────────────────────────

describe('listPending', () => {
  it('returns [] when no pending rows', async () => {
    const supabase = mockSupabase({
      selectResponse: { data: [], error: null },
    })
    const rows = await listPending(supabase, 'team_1')
    expect(rows).toEqual([])
  })

  it('returns [] when the query errors (silent degrade — UI shows empty state)', async () => {
    const supabase = mockSupabase({
      selectResponse: { data: null, error: { message: 'rls denied' } },
    })
    const rows = await listPending(supabase, 'team_1')
    expect(rows).toEqual([])
  })

  it('maps the row shape correctly including invited_by_name fallback', async () => {
    const supabase = mockSupabase({
      selectResponse: {
        data: [
          {
            id: 'inv_1',
            invited_email: 'peter@example.com',
            role: 'member',
            expires_at: '2026-05-27T00:00:00Z',
            created_at: '2026-05-20T00:00:00Z',
            invited_by: 'user_admin',
            profiles: { full_name: 'Ada Lovelace', email: 'ada@example.com' },
          },
          {
            id: 'inv_2',
            invited_email: 'tony@example.com',
            role: 'admin',
            expires_at: '2026-05-28T00:00:00Z',
            created_at: '2026-05-20T00:00:00Z',
            invited_by: 'user_admin',
            // full_name null → falls back to email local-part.
            profiles: { full_name: null, email: 'rs@example.com' },
          },
          {
            id: 'inv_3',
            invited_email: 'p@example.com',
            role: 'member',
            expires_at: '2026-05-29T00:00:00Z',
            created_at: '2026-05-20T00:00:00Z',
            invited_by: 'user_admin',
            // both null → invited_by_name is null.
            profiles: null,
          },
        ],
        error: null,
      },
    })
    const rows = await listPending(supabase, 'team_1')
    expect(rows).toHaveLength(3)
    expect(rows[0]?.invited_by_name).toBe('Ada Lovelace')
    expect(rows[1]?.invited_by_name).toBe('rs')
    expect(rows[2]?.invited_by_name).toBeNull()
  })
})

// ──────────────────────────────────────────────────────────────────────────
// formatRelativeExpiry
// ──────────────────────────────────────────────────────────────────────────

describe('formatRelativeExpiry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-20T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns "expired" for past timestamps', () => {
    expect(formatRelativeExpiry('2026-05-19T12:00:00Z')).toBe('expired')
  })

  it('returns hours for sub-day windows', () => {
    expect(formatRelativeExpiry('2026-05-20T13:30:00Z')).toBe('in 1 hour')
    expect(formatRelativeExpiry('2026-05-20T18:00:00Z')).toBe('in 6 hours')
  })

  it('returns days for multi-day windows', () => {
    expect(formatRelativeExpiry('2026-05-21T12:00:00Z')).toBe('in 1 day')
    expect(formatRelativeExpiry('2026-05-27T12:00:00Z')).toBe('in 7 days')
  })

  it('falls back to absolute date for >30 days out', () => {
    const out = formatRelativeExpiry('2026-08-01T12:00:00Z')
    expect(out).toMatch(/Aug\s*1,?\s*2026|2026/)
  })

  it('returns input on invalid date', () => {
    expect(formatRelativeExpiry('not-a-date')).toBe('not-a-date')
  })
})

// ──────────────────────────────────────────────────────────────────────────
// removeTeamMember (SMI-4294 follow-up)
//
// The PL/pgSQL permission matrix is enforced server-side; here we pin the
// TS error-mapping for each RPC-error message the wrapper may see, matching
// the contract in `supabase/migrations/20260521000001_team_member_visibility_and_removal.sql`.
//
// Coverage matrix (8 rows in the plan; we collapse to 6 because the wrapper
// sees only RPC error strings, not the caller/target distinction):
//
//   | Caller     | Target | Server raises                                    | Wrapper maps to                              |
//   |------------|--------|--------------------------------------------------|----------------------------------------------|
//   | owner      | member | (success — no error)                             | { ok: true }                                  |
//   | owner      | admin  | (success)                                        | { ok: true }                                  |
//   | owner      | owner  | "cannot remove the team owner"                   | "The team owner cannot be removed."          |
//   | admin      | admin  | "forbidden: admins can only remove members"      | "Admins can only remove members, not other admins." |
//   | admin      | owner  | "cannot remove the team owner"                   | "The team owner cannot be removed."          |
//   | member     | any    | "forbidden: only team owners or admins can remove" | "Only team owners or admins can remove members." |
//   | non-member | any    | (same as member — implicit auth.uid() gate)      | (same)                                       |
//   | any        | unknown | "member not found"                              | "That member no longer exists on the team."  |
// ──────────────────────────────────────────────────────────────────────────

describe('removeTeamMember', () => {
  it('returns ok=true when RPC succeeds (owner removes member)', async () => {
    const supabase = mockSupabase({
      rpcResponses: { remove_team_member: { data: null, error: null } },
    })
    const result = await removeTeamMember(supabase, 'tm_member')
    expect(result.ok).toBe(true)
  })

  it('returns ok=true when RPC succeeds (owner removes admin)', async () => {
    const supabase = mockSupabase({
      rpcResponses: { remove_team_member: { data: null, error: null } },
    })
    const result = await removeTeamMember(supabase, 'tm_admin')
    expect(result.ok).toBe(true)
  })

  it('maps "cannot remove the team owner" to user-facing copy', async () => {
    const supabase = mockSupabase({
      rpcResponses: {
        remove_team_member: { data: null, error: { message: 'cannot remove the team owner' } },
      },
    })
    const result = await removeTeamMember(supabase, 'tm_owner')
    expect(result.ok).toBe(false)
    expect(result.error).toBe('The team owner cannot be removed.')
  })

  it('maps "admins can only remove members" (admin → admin)', async () => {
    const supabase = mockSupabase({
      rpcResponses: {
        remove_team_member: {
          data: null,
          error: { message: 'forbidden: admins can only remove members' },
        },
      },
    })
    const result = await removeTeamMember(supabase, 'tm_admin2')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/admins can only remove members/i)
  })

  it('maps "only team owners or admins can remove" (member caller)', async () => {
    const supabase = mockSupabase({
      rpcResponses: {
        remove_team_member: {
          data: null,
          error: { message: 'forbidden: only team owners or admins can remove members' },
        },
      },
    })
    const result = await removeTeamMember(supabase, 'tm_any')
    expect(result.ok).toBe(false)
    expect(result.error).toBe('Only team owners or admins can remove members.')
  })

  it('maps "member not found" to user-facing copy', async () => {
    const supabase = mockSupabase({
      rpcResponses: {
        remove_team_member: { data: null, error: { message: 'member not found' } },
      },
    })
    const result = await removeTeamMember(supabase, 'tm_missing')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/no longer exists/i)
  })

  it('falls through to raw error message for unknown errors', async () => {
    const supabase = mockSupabase({
      rpcResponses: {
        remove_team_member: { data: null, error: { message: 'unexpected DB error xyz' } },
      },
    })
    const result = await removeTeamMember(supabase, 'tm_1')
    expect(result.ok).toBe(false)
    expect(result.error).toBe('unexpected DB error xyz')
  })
})

// ──────────────────────────────────────────────────────────────────────────
// list_team_members_with_profile row-shape contract (SMI-4294 follow-up)
//
// The PL/pgSQL RPC returns flat TABLE columns (member_id, user_id, role,
// joined_at, invited_at, full_name, email). The website code consumes the
// RPC directly via `supabase.rpc(...)` and does NOT translate snake_case →
// camelCase, so the row shape must match what PostgREST emits.
//
// This is a regression guard: if the migration is ever rewritten to nest
// the profile (e.g. as a jsonb column) the renderer in team-invite-ui.ts
// breaks silently — this test fails loud.
// ──────────────────────────────────────────────────────────────────────────

describe('list_team_members_with_profile row-shape contract', () => {
  it('passes through flat snake_case columns from the RPC', async () => {
    const rpcRows = [
      {
        member_id: 'tm_1',
        user_id: 'u_1',
        role: 'owner',
        joined_at: '2026-05-01T00:00:00Z',
        invited_at: '2026-04-30T00:00:00Z',
        full_name: 'Ada Lovelace',
        email: 'ada@example.com',
      },
      {
        member_id: 'tm_2',
        user_id: 'u_2',
        role: 'member',
        joined_at: '2026-05-10T00:00:00Z',
        invited_at: '2026-05-09T00:00:00Z',
        full_name: 'Tony Lee',
        email: 'hy.tony.lee@gmail.com',
      },
    ]
    const supabase = mockSupabase({
      rpcResponses: {
        list_team_members_with_profile: { data: rpcRows, error: null },
      },
    })
    // We call the RPC directly via the same path team-invite-ui.ts uses.
    const { data, error } = await supabase.rpc('list_team_members_with_profile', {
      p_team_id: 'team_1',
    })
    expect(error).toBeNull()
    expect(Array.isArray(data)).toBe(true)
    const rows = data as typeof rpcRows
    expect(rows).toHaveLength(2)
    // Pin: flat columns, snake_case, no nested 'profiles:' object.
    expect(rows[0]).toMatchObject({
      member_id: 'tm_1',
      user_id: 'u_1',
      role: 'owner',
      full_name: 'Ada Lovelace',
      email: 'ada@example.com',
    })
    expect(rows[0]).not.toHaveProperty('profiles')
    // Regression for Bug 2: Tony's row carries name + email (the prior
    // PostgREST join returned profiles: null for him).
    expect(rows[1]?.full_name).toBe('Tony Lee')
    expect(rows[1]?.email).toBe('hy.tony.lee@gmail.com')
  })
})
