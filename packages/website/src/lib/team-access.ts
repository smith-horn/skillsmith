/**
 * Team tier-gate helper (SMI-4321).
 *
 * Wraps the `check_team_tier_access` RPC (migration 078) and returns a
 * normalized result for the three /account/team/** pages to consume.
 *
 * Why client-side: per ADR-111, SSR auth is unreliable through Cloudflare.
 * The authority is still the database — the RPC is SECURITY DEFINER and
 * reads live profiles/subscriptions/team_members at request time, so a
 * stale session cookie cannot grant access. See SMI-4321 plan.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export type TeamGateReason =
  | 'not_authenticated'
  | 'not_team_tier'
  | 'no_active_subscription'
  | 'subscription_paused'
  | 'not_member'

export interface TeamAccessResult {
  ok: boolean
  reason: TeamGateReason | null
  teamId: string | null
  tier: string
}

const VALID_REASONS: ReadonlySet<TeamGateReason> = new Set([
  'not_authenticated',
  'not_team_tier',
  'no_active_subscription',
  'subscription_paused',
  'not_member',
])

const NOT_AUTHENTICATED: TeamAccessResult = {
  ok: false,
  reason: 'not_authenticated',
  teamId: null,
  tier: 'community',
}

/**
 * Map a raw RPC JSON response to TeamAccessResult. Exported for test-only
 * use so shape drift between the DB and the TS interface is pinned.
 */
export function parseTeamAccessResult(raw: unknown): TeamAccessResult {
  if (raw == null || typeof raw !== 'object') {
    return NOT_AUTHENTICATED
  }
  const obj = raw as Record<string, unknown>
  const ok = obj.ok === true
  const rawReason = typeof obj.reason === 'string' ? obj.reason : null
  const reason =
    rawReason && VALID_REASONS.has(rawReason as TeamGateReason)
      ? (rawReason as TeamGateReason)
      : null
  const teamId = typeof obj.team_id === 'string' ? obj.team_id : null
  const tier = typeof obj.tier === 'string' ? obj.tier : 'community'
  return { ok, reason: ok ? null : reason, teamId, tier }
}

/**
 * Call `check_team_tier_access` and return the normalized gate result.
 *
 * Error handling: a 401 from the RPC (stale JWT mid-session) maps to
 * `not_authenticated` so the caller can treat it identically to a missing
 * session. Other errors also degrade to `not_authenticated` — this is the
 * safest closed-default for a tier-gate.
 */
export async function checkTeamAccess(supabase: SupabaseClient): Promise<TeamAccessResult> {
  try {
    const { data, error } = await supabase.rpc('check_team_tier_access')
    if (error) {
      // supabase-js exposes HTTP status on error.status in recent versions.
      // Fall back to string match for older releases.
      const status = (error as { status?: number }).status
      if (status === 401 || /jwt|unauthorized/i.test(error.message)) {
        return NOT_AUTHENTICATED
      }
      // Unknown error — closed-default. Page will redirect to /login.
      return NOT_AUTHENTICATED
    }
    return parseTeamAccessResult(data)
  } catch {
    return NOT_AUTHENTICATED
  }
}

/**
 * Given a gate result, return the URL to redirect to (or null if the
 * page should render its own inline state instead of redirecting).
 *
 * - ok=true → null (page renders normally)
 * - not_authenticated → /login?redirect=<currentPath>
 * - not_member → null (page renders inline "not a member" notice)
 * - everything else → /account/subscription?gated=<reason>
 */
export function resolveGateRedirect(result: TeamAccessResult, currentPath: string): string | null {
  if (result.ok) return null
  if (result.reason === 'not_authenticated') {
    return `/login?redirect=${encodeURIComponent(currentPath)}`
  }
  if (result.reason === 'not_member') return null
  return `/account/subscription?gated=${result.reason ?? 'unknown'}`
}
