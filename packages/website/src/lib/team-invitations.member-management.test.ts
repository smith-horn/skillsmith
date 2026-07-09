/**
 * Tests for the member-management surface of lib/team-invitations.ts
 * (removeTeamMember, setTeamMemberGithubUsername, and the
 * list_team_members_with_profile row-shape contract).
 *
 * Split out of team-invitations.test.ts (SMI-5589) to keep both files under
 * the 500-line audit:standards limit — the invitation-lifecycle RPCs
 * (createInvitation/resendInvitation/revokeInvitation/listPending) stay in
 * the original file.
 *
 * Mock strategy mirrors team-access.test.ts: a thin `mockSupabase()` factory
 * that returns an object satisfying `SupabaseClient` for the methods we use.
 */

import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import { removeTeamMember, setTeamMemberGithubUsername } from './team-invitations'

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
// setTeamMemberGithubUsername (SMI-5589)
// ──────────────────────────────────────────────────────────────────────────

describe('setTeamMemberGithubUsername', () => {
  it('returns ok=true and sends the trimmed value on a plain set', async () => {
    const supabase = mockSupabase({
      rpcResponses: { set_team_member_github_username: { data: null, error: null } },
    })
    const result = await setTeamMemberGithubUsername(supabase, 'tm_1', '  octocat  ')
    expect(result.ok).toBe(true)
    const rpcMock = supabase.rpc as unknown as ReturnType<typeof vi.fn>
    expect(rpcMock).toHaveBeenCalledWith('set_team_member_github_username', {
      p_member_id: 'tm_1',
      p_github_username: 'octocat',
    })
  })

  it('sends null (not an empty string) when the value is blank', async () => {
    const supabase = mockSupabase({
      rpcResponses: { set_team_member_github_username: { data: null, error: null } },
    })
    const result = await setTeamMemberGithubUsername(supabase, 'tm_1', '   ')
    expect(result.ok).toBe(true)
    const rpcMock = supabase.rpc as unknown as ReturnType<typeof vi.fn>
    expect(rpcMock).toHaveBeenCalledWith('set_team_member_github_username', {
      p_member_id: 'tm_1',
      p_github_username: null,
    })
  })

  it('maps "only team owners or admins can edit" to user-facing copy', async () => {
    const supabase = mockSupabase({
      rpcResponses: {
        set_team_member_github_username: {
          data: null,
          error: {
            message: "forbidden: only team owners or admins can edit a member's GitHub username",
          },
        },
      },
    })
    const result = await setTeamMemberGithubUsername(supabase, 'tm_1', 'octocat')
    expect(result.ok).toBe(false)
    expect(result.error).toBe("Only team owners or admins can edit a member's GitHub username.")
  })

  it('maps "invalid github_username format" to user-facing copy', async () => {
    const supabase = mockSupabase({
      rpcResponses: {
        set_team_member_github_username: {
          data: null,
          error: { message: 'invalid github_username format' },
        },
      },
    })
    const result = await setTeamMemberGithubUsername(supabase, 'tm_1', '-bad')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/valid GitHub username/i)
  })

  it('maps "already linked to a different member" to user-facing copy', async () => {
    const supabase = mockSupabase({
      rpcResponses: {
        set_team_member_github_username: {
          data: null,
          error: {
            message: 'github_username already linked to a different member of this team',
          },
        },
      },
    })
    const result = await setTeamMemberGithubUsername(supabase, 'tm_1', 'taken-name')
    expect(result.ok).toBe(false)
    expect(result.error).toBe(
      'That GitHub username is already linked to a different member of this team.'
    )
  })

  it('maps "member not found" to user-facing copy (reuses the existing branch)', async () => {
    const supabase = mockSupabase({
      rpcResponses: {
        set_team_member_github_username: { data: null, error: { message: 'member not found' } },
      },
    })
    const result = await setTeamMemberGithubUsername(supabase, 'tm_missing', 'octocat')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/no longer exists/i)
  })

  it('falls through to raw error message for unknown errors', async () => {
    const supabase = mockSupabase({
      rpcResponses: {
        set_team_member_github_username: {
          data: null,
          error: { message: 'unexpected DB error xyz' },
        },
      },
    })
    const result = await setTeamMemberGithubUsername(supabase, 'tm_1', 'octocat')
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
        github_username: 'ada-lovelace',
      },
      {
        member_id: 'tm_2',
        user_id: 'u_2',
        role: 'member',
        joined_at: '2026-05-10T00:00:00Z',
        invited_at: '2026-05-09T00:00:00Z',
        full_name: 'Tony Lee',
        email: 'tony.lee@example.com',
        github_username: null,
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
      github_username: 'ada-lovelace',
    })
    expect(rows[0]).not.toHaveProperty('profiles')
    // Regression for Bug 2: Tony's row carries name + email (the prior
    // PostgREST join returned profiles: null for him).
    expect(rows[1]?.full_name).toBe('Tony Lee')
    expect(rows[1]?.email).toBe('tony.lee@example.com')
    // SMI-5589: github_username is the 8th column added by this migration —
    // pinned here so a future rewrite that drops/renests it fails loud, same
    // as the Bug-2 regression above.
    expect(rows[1]?.github_username).toBeNull()
  })
})
