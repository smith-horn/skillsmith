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
  resendInvitation,
  revokeInvitation,
  type PendingInvitation,
} from './team-invitations'

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
    submitBtn.disabled = true
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
