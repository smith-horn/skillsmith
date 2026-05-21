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
