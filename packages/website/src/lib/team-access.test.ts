import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  checkTeamAccess,
  parseTeamAccessResult,
  resolveGateRedirect,
  type TeamAccessResult,
} from './team-access'

/**
 * Narrow helper: build a fake SupabaseClient whose only behavior is .rpc().
 */
function mockSupabase(rpcReturn: { data: unknown; error: unknown | null }): SupabaseClient {
  return {
    rpc: vi.fn().mockResolvedValue(rpcReturn),
  } as unknown as SupabaseClient
}

describe('parseTeamAccessResult (DB → TS shape pinning)', () => {
  it('maps the ok=true RPC response (team_id → teamId)', () => {
    // Exactly the JSON shape the PL/pgSQL RPC returns.
    const raw = { ok: true, reason: null, team_id: 'team_abc123', tier: 'team' }
    expect(parseTeamAccessResult(raw)).toEqual<TeamAccessResult>({
      ok: true,
      reason: null,
      teamId: 'team_abc123',
      tier: 'team',
    })
  })

  it('maps each reason code faithfully', () => {
    const reasons = [
      'not_authenticated',
      'not_team_tier',
      'no_active_subscription',
      'subscription_paused',
      'not_member',
    ] as const
    for (const reason of reasons) {
      const raw = { ok: false, reason, team_id: null, tier: 'community' }
      const parsed = parseTeamAccessResult(raw)
      expect(parsed.ok).toBe(false)
      expect(parsed.reason).toBe(reason)
      expect(parsed.teamId).toBeNull()
    }
  })

  it('rejects unknown reason codes (closes an injection vector)', () => {
    const raw = { ok: false, reason: 'attacker_injected', team_id: null, tier: 'community' }
    const parsed = parseTeamAccessResult(raw)
    expect(parsed.reason).toBeNull()
  })

  it('degrades to not_authenticated for null / malformed input', () => {
    expect(parseTeamAccessResult(null)).toMatchObject({ ok: false, reason: 'not_authenticated' })
    expect(parseTeamAccessResult('string')).toMatchObject({
      ok: false,
      reason: 'not_authenticated',
    })
    expect(parseTeamAccessResult(42)).toMatchObject({ ok: false, reason: 'not_authenticated' })
  })

  it('coerces missing tier to community', () => {
    const raw = { ok: false, reason: 'not_team_tier', team_id: null }
    expect(parseTeamAccessResult(raw).tier).toBe('community')
  })
})

describe('checkTeamAccess', () => {
  it('returns ok=true when the RPC returns success', async () => {
    const supabase = mockSupabase({
      data: { ok: true, reason: null, team_id: 't1', tier: 'team' },
      error: null,
    })
    const result = await checkTeamAccess(supabase)
    expect(result).toEqual<TeamAccessResult>({
      ok: true,
      reason: null,
      teamId: 't1',
      tier: 'team',
    })
  })

  it('returns not_authenticated when the RPC returns 401', async () => {
    const supabase = mockSupabase({
      data: null,
      error: { status: 401, message: 'JWT expired' },
    })
    const result = await checkTeamAccess(supabase)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('not_authenticated')
  })

  it('returns not_authenticated when the error message contains "jwt" (older clients)', async () => {
    const supabase = mockSupabase({
      data: null,
      error: { message: 'Invalid JWT signature' },
    })
    const result = await checkTeamAccess(supabase)
    expect(result.reason).toBe('not_authenticated')
  })

  it('closed-defaults to not_authenticated on unknown RPC failure', async () => {
    const supabase = mockSupabase({
      data: null,
      error: { message: 'Kaboom' },
    })
    const result = await checkTeamAccess(supabase)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('not_authenticated')
  })

  it('closed-defaults to not_authenticated when the RPC promise throws', async () => {
    const supabase = {
      rpc: vi.fn().mockRejectedValue(new Error('network down')),
    } as unknown as SupabaseClient
    const result = await checkTeamAccess(supabase)
    expect(result.reason).toBe('not_authenticated')
  })

  it('forwards the full not_team_tier response', async () => {
    const supabase = mockSupabase({
      data: {
        ok: false,
        reason: 'not_team_tier',
        team_id: null,
        tier: 'individual',
      },
      error: null,
    })
    const result = await checkTeamAccess(supabase)
    expect(result).toEqual<TeamAccessResult>({
      ok: false,
      reason: 'not_team_tier',
      teamId: null,
      tier: 'individual',
    })
  })
})

describe('resolveGateRedirect', () => {
  const path = '/account/team'

  it('returns null when ok=true', () => {
    expect(
      resolveGateRedirect({ ok: true, reason: null, teamId: 't1', tier: 'team' }, path)
    ).toBeNull()
  })

  it('redirects not_authenticated to /login with the current path preserved', () => {
    const url = resolveGateRedirect(
      { ok: false, reason: 'not_authenticated', teamId: null, tier: 'community' },
      path
    )
    expect(url).toBe('/login?redirect=%2Faccount%2Fteam')
  })

  it('returns null for not_member so the page can render inline state', () => {
    expect(
      resolveGateRedirect({ ok: false, reason: 'not_member', teamId: null, tier: 'team' }, path)
    ).toBeNull()
  })

  it('redirects the other reasons to /account/subscription?gated=<reason>', () => {
    const mapping: Array<[TeamAccessResult['reason'], string]> = [
      ['not_team_tier', '/account/subscription?gated=not_team_tier'],
      ['no_active_subscription', '/account/subscription?gated=no_active_subscription'],
      ['subscription_paused', '/account/subscription?gated=subscription_paused'],
    ]
    for (const [reason, expected] of mapping) {
      expect(
        resolveGateRedirect({ ok: false, reason, teamId: null, tier: 'community' }, path)
      ).toBe(expected)
    }
  })
})
