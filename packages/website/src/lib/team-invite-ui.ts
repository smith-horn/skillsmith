/**
 * Browser-side UI wiring for the team-invite modal + pending-invites list.
 * @module lib/team-invite-ui
 *
 * SMI-4294: extracted from members.astro to keep that file under the 500-line
 * audit gate. This module is browser-only — it queries the DOM directly and
 * binds event listeners. The data-layer calls live in lib/team-invitations.ts.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

import {
  createInvitation,
  formatRelativeExpiry,
  listPending,
  removeTeamMember,
  resendInvitation,
  revokeInvitation,
  type PendingInvitation,
} from './team-invitations'

/**
 * Row shape returned by `list_team_members_with_profile(p_team_id)` RPC
 * (SMI-4294 follow-up). Flat columns — no nested `profiles:` object — because
 * the RPC is SECURITY DEFINER and reads `profiles` itself, bypassing the
 * profiles RLS that filtered out non-self rows in the previous PostgREST join.
 */
export interface TeamMemberRow {
  member_id: string
  user_id: string
  role: 'owner' | 'admin' | 'member'
  joined_at: string | null
  invited_at: string | null
  full_name: string | null
  email: string | null
}

/**
 * The viewer's role + auth id, used to decide whether to render per-row
 * Remove buttons. Resolved at page-load time from
 * `check_team_tier_access` (role) + `supabase.auth.getUser()` (user_id).
 */
export interface Viewer {
  role: 'owner' | 'admin' | 'member'
  userId: string | null
}

function escapeHtml(text: string): string {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}

function renderPendingRow(p: PendingInvitation): string {
  const inviter = p.invited_by_name ?? 'a team admin'
  const expiry = formatRelativeExpiry(p.expires_at)
  const expiryAbs = new Date(p.expires_at).toLocaleString()
  return `<div class="pending-row" data-invitation-id="${escapeHtml(p.id)}">
    <div class="pending-info">
      <span class="pending-email">${escapeHtml(p.invited_email)}</span>
      <span class="pending-meta">invited by ${escapeHtml(inviter)} · expires ${escapeHtml(expiry)} (${escapeHtml(expiryAbs)})</span>
    </div>
    <div class="pending-actions">
      <button class="btn btn-secondary" type="button" data-action="resend-invite">Resend Email</button>
      <button class="btn btn-secondary" type="button" data-action="revoke-invite">Revoke</button>
    </div>
  </div>`
}

export async function refreshPendingList(supabase: SupabaseClient, teamId: string): Promise<void> {
  const container = document.getElementById('pending-list')
  if (!container) return
  const rows = await listPending(supabase, teamId)
  if (rows.length === 0) {
    container.innerHTML = '<p class="empty-state">No pending invites.</p>'
    return
  }
  container.innerHTML = rows.map(renderPendingRow).join('')
}

function showModalAlert(kind: 'error' | 'success', html: string): void {
  const el = document.getElementById('invite-modal-alert') as HTMLDivElement | null
  if (!el) return
  el.className = `invite-modal__alert invite-modal__alert--${kind}`
  el.innerHTML = html
  el.style.display = 'block'
}

export function wireInviteFlow(supabase: SupabaseClient, teamId: string): void {
  const modal = document.getElementById('team-invite-modal') as HTMLDialogElement | null
  const form = document.getElementById('invite-form') as HTMLFormElement | null
  const submitBtn = document.getElementById('invite-submit') as HTMLButtonElement | null
  const inviteBtn = document.getElementById('invite-btn') as HTMLButtonElement | null
  if (!modal || !form || !submitBtn || !inviteBtn) return

  let invokingButton: HTMLElement | null = null

  function openModal(): void {
    invokingButton = document.activeElement as HTMLElement | null
    const alert = document.getElementById('invite-modal-alert') as HTMLDivElement | null
    if (alert) alert.style.display = 'none'
    form?.reset()
    modal?.showModal()
    ;(document.getElementById('invite-email') as HTMLInputElement | null)?.focus()
  }

  function closeModal(): void {
    modal?.close()
    invokingButton?.focus()
  }

  inviteBtn.addEventListener('click', openModal)
  modal.addEventListener('cancel', (e) => {
    e.preventDefault()
    closeModal()
  })
  document
    .querySelectorAll<HTMLButtonElement>('[data-action="close-invite-modal"]')
    .forEach((b) => b.addEventListener('click', closeModal))

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const data = new FormData(form)
    const email = String(data.get('email') ?? '').trim()
    const role = (String(data.get('role') ?? 'member') === 'admin' ? 'admin' : 'member') as
      | 'admin'
      | 'member'
    if (!email) return
    const originalText = submitBtn.textContent
    submitBtn.disabled = true
    submitBtn.textContent = 'Sending...'
    try {
      const result = await createInvitation(supabase, teamId, email, role)
      if (!result.ok) {
        showModalAlert('error', escapeHtml(result.error ?? 'Could not send invite.'))
        return
      }
      const safeEmail = escapeHtml(email)
      if (result.status === 'already_pending') {
        showModalAlert(
          'success',
          `Invitation already pending for ${safeEmail}. Use Resend Email if they need another copy.`
        )
      } else if (result.emailSent) {
        showModalAlert(
          'success',
          `Invitation sent to ${safeEmail}. They'll get an email with a link to join.`
        )
      } else if (result.fallback_url) {
        showModalAlert(
          'error',
          `Invitation created but email delivery failed. Share this link manually:<code>${escapeHtml(result.fallback_url)}</code>`
        )
      } else {
        showModalAlert('success', `Invitation sent to ${safeEmail}.`)
      }
      await refreshPendingList(supabase, teamId)
    } finally {
      submitBtn.disabled = false
      submitBtn.textContent = originalText ?? 'Send invite'
    }
  })

  document.getElementById('pending-list')?.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement | null
    if (!target) return
    const row = target.closest<HTMLElement>('.pending-row')
    if (!row) return
    const invitationId = row.dataset.invitationId
    if (!invitationId) return

    if (target.dataset.action === 'resend-invite') {
      target.setAttribute('disabled', 'true')
      const r = await resendInvitation(supabase, invitationId)
      target.removeAttribute('disabled')
      if (!r.ok && r.fallback_url) {
        window.alert(`Could not resend the email. Share this link instead:\n${r.fallback_url}`)
      }
      return
    }

    if (target.dataset.action === 'revoke-invite') {
      const email = row.querySelector('.pending-email')?.textContent ?? 'this invite'
      if (
        !window.confirm(`Revoke invite to ${email}? They won't be able to use the existing link.`)
      ) {
        return
      }
      target.setAttribute('disabled', 'true')
      const r = await revokeInvitation(supabase, invitationId)
      if (!r.ok) {
        window.alert(r.error ?? 'Could not revoke the invite.')
        target.removeAttribute('disabled')
        return
      }
      await refreshPendingList(supabase, teamId)
    }
  })
}

// ────────────────────────────────────────────────────────────────────────────
// Member list rendering + per-row Remove action (SMI-4294 follow-up)
// ────────────────────────────────────────────────────────────────────────────

function canRemove(viewer: Viewer, row: TeamMemberRow): boolean {
  if (viewer.role !== 'owner' && viewer.role !== 'admin') return false
  if (row.role === 'owner') return false
  if (viewer.userId !== null && row.user_id === viewer.userId) return false
  return true
}

/**
 * Render one `.member-card` row. Used by `refreshMembersList` and by the
 * initial page-load render in `members.astro` (which imports this directly
 * to avoid duplicating markup).
 */
export function renderMemberRow(row: TeamMemberRow, viewer: Viewer): string {
  const name = row.full_name || row.email?.split('@')[0] || 'Team member'
  const email = row.email ?? ''
  const initial = (name[0] || '?').toUpperCase()
  const joined = row.joined_at
    ? new Date(row.joined_at).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
      })
    : '—'
  const roleLower = String(row.role).toLowerCase()
  const roleLabel = roleLower.charAt(0).toUpperCase() + roleLower.slice(1)
  const removeBtn = canRemove(viewer, row)
    ? `<div class="member-actions">
        <button class="btn btn-secondary"
                type="button"
                data-action="remove-member"
                data-member-id="${escapeHtml(row.member_id)}"
                data-member-email="${escapeHtml(row.email ?? 'this member')}">
          Remove
        </button>
      </div>`
    : ''
  return `<div class="member-card" data-member-id="${escapeHtml(row.member_id)}">
    <div class="member-info">
      <div class="member-avatar">${escapeHtml(initial)}</div>
      <div class="member-details">
        <div class="member-name">${escapeHtml(name)}</div>
        <div class="member-email">${escapeHtml(email)}</div>
      </div>
    </div>
    <div class="member-meta">
      <span class="role-badge role-${escapeHtml(roleLower)}">${escapeHtml(roleLabel)}</span>
      <span class="member-joined">Joined ${escapeHtml(joined)}</span>
    </div>
    ${removeBtn}
  </div>`
}

/**
 * Re-fetch the members list via `list_team_members_with_profile` and re-render
 * both the rows and the Members count heading. Used by the initial load AND
 * after a successful member removal — full refresh (not surgical row delete)
 * so concurrent admin actions are reflected.
 */
export async function refreshMembersList(
  supabase: SupabaseClient,
  teamId: string,
  viewer: Viewer
): Promise<void> {
  const list = document.getElementById('member-list')
  const heading = document.getElementById('members-heading')
  if (!list || !heading) return

  const { data, error } = await supabase.rpc('list_team_members_with_profile', {
    p_team_id: teamId,
  })

  if (error) {
    heading.textContent = 'Members'
    list.innerHTML = '<p class="empty-state">Could not load members.</p>'
    return
  }

  const members = (data ?? []) as TeamMemberRow[]
  heading.textContent = `Members (${members.length})`
  if (members.length === 0) {
    list.innerHTML = '<p class="empty-state">No members yet.</p>'
    return
  }
  list.innerHTML = members.map((m) => renderMemberRow(m, viewer)).join('')
}

/**
 * Wire the click-delegation handler for per-row Remove buttons in the
 * `#member-list` container. Mirrors the revoke-invite pattern in
 * `wireInviteFlow`: window.confirm → disable button → RPC → refresh.
 */
export function wireMemberManagement(
  supabase: SupabaseClient,
  teamId: string,
  viewer: Viewer
): void {
  const container = document.getElementById('member-list')
  if (!container) return
  container.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement | null
    if (!target) return
    if (target.dataset.action !== 'remove-member') return

    const email = target.dataset.memberEmail ?? 'this member'
    if (!window.confirm(`Remove ${email} from the team? They'll lose access immediately.`)) {
      return
    }
    const memberId = target.dataset.memberId
    if (!memberId) return
    target.setAttribute('disabled', 'true')
    const r = await removeTeamMember(supabase, memberId)
    if (!r.ok) {
      window.alert(r.error ?? 'Could not remove member.')
      target.removeAttribute('disabled')
      return
    }
    await refreshMembersList(supabase, teamId, viewer)
  })
}
