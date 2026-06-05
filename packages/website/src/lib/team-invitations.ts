/**
 * Team invitation data layer.
 * @module lib/team-invitations
 *
 * SMI-4294: thin wrappers around the team_invitations RPCs + the
 * team-invite-send edge function. Extracted from members.astro to keep that
 * file under the 500-line gate and to make the data layer testable.
 *
 * All error strings are user-facing (consumed by alerts in members.astro);
 * keep them in sync with the plan's "Open UX copy" section.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface PendingInvitation {
  id: string
  invited_email: string
  role: 'admin' | 'member'
  expires_at: string
  created_at: string
  /** May be `null` if the inviter profile has no full_name. */
  invited_by_name: string | null
}

export interface CreateInvitationResult {
  ok: boolean
  invitation_id?: string
  status?: 'created' | 'already_pending'
  emailSent?: boolean
  /** Only present when emailSent === false; UI shows a copy-to-clipboard link. */
  fallback_url?: string
  /** User-visible error string when ok === false. */
  error?: string
}

export interface SimpleResult {
  ok: boolean
  error?: string
}

/**
 * Map an RPC error message into a user-facing string. Mirrors the plan's
 * "Open UX copy" section so members.astro and team-invitations.ts agree on
 * what each error class reads as.
 */
function mapRpcErrorToCopy(msg: string | undefined, maxMembers?: number): string {
  const m = (msg ?? '').toLowerCase()
  if (m.includes('already a member')) return 'That person is already a team member.'
  if (m.includes('seat limit reached')) {
    return maxMembers
      ? `Your team is at its seat limit (${maxMembers}). Revoke a pending invite or remove a member before sending more.`
      : 'Your team is at its seat limit. Revoke a pending invite or remove a member before sending more.'
  }
  if (m.includes('invalid email')) return 'That email address is not valid.'
  if (m.includes('cannot remove the team owner')) return 'The team owner cannot be removed.'
  if (m.includes('admins can only remove members'))
    return 'Admins can only remove members, not other admins.'
  if (m.includes('only team owners or admins can remove'))
    return 'Only team owners or admins can remove members.'
  if (m.includes('member not found')) return 'That member no longer exists on the team.'
  if (m.includes('forbidden')) return 'Only team owners or admins can invite.'
  if (m.includes('team not found')) return 'Team not found.'
  if (m.includes('invitation expired')) return 'The invitation has expired.'
  if (m.includes('invitation not pending')) return 'The invitation is no longer pending.'
  if (m.includes('invitation not found')) return 'Invitation not found.'
  return msg ?? 'Something went wrong.'
}

/**
 * Create a new (or non-destructively reuse) team invitation, then dispatch
 * the email via team-invite-send. Returns a structured result so the UI can
 * disambiguate "already pending" from "created" and surface a fallback link
 * if the email failed.
 */
export async function createInvitation(
  supabase: SupabaseClient,
  teamId: string,
  email: string,
  role: 'admin' | 'member'
): Promise<CreateInvitationResult> {
  const { data, error } = await supabase.rpc('create_team_invitation', {
    p_team_id: teamId,
    p_email: email,
    p_role: role,
  })

  if (error) {
    return { ok: false, error: mapRpcErrorToCopy(error.message) }
  }

  const payload = data as {
    invitation_id: string
    token: string
    expires_at: string
    status: 'created' | 'already_pending'
  } | null

  if (!payload?.invitation_id) {
    return { ok: false, error: 'Unexpected response from create_team_invitation.' }
  }

  const sendResult = await sendInviteEmail(supabase, payload.invitation_id)

  const result: CreateInvitationResult = {
    ok: true,
    invitation_id: payload.invitation_id,
    status: payload.status,
    emailSent: sendResult.ok,
  }
  if (sendResult.fallback_url !== undefined) {
    result.fallback_url = sendResult.fallback_url
  }
  return result
}

/**
 * Re-send the email for an existing invitation (uses the SAME token —
 * non-destructive). Calls the edge function directly; the function calls
 * resend_team_invitation_email_check internally for the permission check.
 */
export async function resendInvitation(
  supabase: SupabaseClient,
  invitationId: string
): Promise<SimpleResult & { fallback_url?: string }> {
  const result = await sendInviteEmail(supabase, invitationId)
  if (result.ok) return { ok: true }
  const out: SimpleResult & { fallback_url?: string } = {
    ok: false,
    error: 'Could not resend the email.',
  }
  if (result.fallback_url !== undefined) out.fallback_url = result.fallback_url
  return out
}

/**
 * Revoke a pending invitation. The RPC flips status to 'revoked' so the
 * existing token can no longer be redeemed.
 */
export async function revokeInvitation(
  supabase: SupabaseClient,
  invitationId: string
): Promise<SimpleResult> {
  const { error } = await supabase.rpc('revoke_team_invitation', {
    p_invitation_id: invitationId,
  })
  if (error) return { ok: false, error: mapRpcErrorToCopy(error.message) }
  return { ok: true }
}

/**
 * Remove a team member via the `remove_team_member` SECURITY DEFINER RPC.
 * Permission rules enforced server-side: only owner/admin may call; owner
 * row is never removable; admin cannot remove another admin. See SMI-4294
 * follow-up plan §Wave 1 step 1.
 */
export async function removeTeamMember(
  supabase: SupabaseClient,
  memberId: string
): Promise<SimpleResult> {
  const { error } = await supabase.rpc('remove_team_member', {
    p_member_id: memberId,
  })
  if (error) return { ok: false, error: mapRpcErrorToCopy(error.message) }
  return { ok: true }
}

/**
 * List non-expired pending invites for a team. The `.gt('expires_at', now)`
 * filter hides stale rows that have not yet been swept by the cron job
 * (SMI-5051 follow-up).
 */
export async function listPending(
  supabase: SupabaseClient,
  teamId: string
): Promise<PendingInvitation[]> {
  const nowIso = new Date().toISOString()
  const { data, error } = await supabase
    .from('team_invitations')
    .select(
      'id, invited_email, role, expires_at, created_at, invited_by, profiles:profiles!team_invitations_invited_by_fkey(full_name, email)'
    )
    .eq('team_id', teamId)
    .eq('status', 'pending')
    .gt('expires_at', nowIso)
    .order('created_at', { ascending: false })

  if (error || !data) return []

  return data.map((row) => {
    const profileRow = (Array.isArray(row.profiles) ? row.profiles[0] : row.profiles) as
      | { full_name: string | null; email: string | null }
      | null
      | undefined
    const invitedByName = profileRow?.full_name?.trim() || profileRow?.email?.split('@')[0] || null
    return {
      id: row.id as string,
      invited_email: row.invited_email as string,
      role: row.role as 'admin' | 'member',
      expires_at: row.expires_at as string,
      created_at: row.created_at as string,
      invited_by_name: invitedByName,
    }
  })
}

/**
 * Format an ISO timestamp into a relative-time string ("in 6 days") for the
 * pending-invites list. Falls back to absolute formatting for >30 days out.
 */
export function formatRelativeExpiry(isoTimestamp: string): string {
  const now = Date.now()
  const t = new Date(isoTimestamp).getTime()
  if (!Number.isFinite(t)) return isoTimestamp
  const diffMs = t - now
  if (diffMs <= 0) return 'expired'
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  if (diffDays === 0) {
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
    if (diffHours === 0) return 'in <1 hour'
    return diffHours === 1 ? 'in 1 hour' : `in ${diffHours} hours`
  }
  if (diffDays === 1) return 'in 1 day'
  if (diffDays <= 30) return `in ${diffDays} days`
  return new Date(isoTimestamp).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

// ────────────────────────────────────────────────────────────────────────────
// Internal: edge function call (kept local so resend + create share one path)
// ────────────────────────────────────────────────────────────────────────────

async function sendInviteEmail(
  supabase: SupabaseClient,
  invitationId: string
): Promise<{ ok: boolean; fallback_url?: string }> {
  const session = await supabase.auth.getSession()
  const accessToken = session.data.session?.access_token
  if (!accessToken) return { ok: false }

  // SUPABASE_URL is exposed as supabase.supabaseUrl on the client — use it to
  // build the function URL so we don't hardcode the project ref. The property
  // exists on the runtime client but isn't in the public type, so we narrow
  // through unknown.
  const baseUrl = (supabase as unknown as { supabaseUrl?: string }).supabaseUrl
  if (!baseUrl) return { ok: false }

  try {
    const res = await fetch(`${baseUrl}/functions/v1/team-invite-send`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ invitation_id: invitationId }),
    })

    if (res.ok) {
      const body = (await res.json()) as { ok?: boolean; fallback_url?: string }
      if (body.ok) return { ok: true }
      const failedOut: { ok: boolean; fallback_url?: string } = { ok: false }
      if (body.fallback_url !== undefined) failedOut.fallback_url = body.fallback_url
      return failedOut
    }
    return { ok: false }
  } catch {
    return { ok: false }
  }
}
