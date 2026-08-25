/**
 * Email Address page data loading + form/text-building logic (M7).
 *
 * Extracted out of account/profile.astro's inline client script to keep the
 * page under the repo's 500-line-per-file standard (same extraction pattern
 * as account-nav.ts / team-access.ts / account-summary-data.ts /
 * account-overview-data.ts). DOM binding stays in the page's own script.
 *
 * @see docs/internal/implementation/account-dashboard-ux-consolidation.md
 */

import type { Session, SupabaseClient } from '@supabase/supabase-js'

export interface ProfileData {
  currentEmail: string
  pendingNewEmail: string
  provider: string
  hasPassword: boolean
}

/**
 * Resolve the signed-in user's current/pending email and whether their
 * account authenticates via password (vs. OAuth) — branches the page
 * between the password-change form and the OAuth-provider guidance card.
 */
export async function loadProfileData(
  supabase: SupabaseClient,
  session: Session
): Promise<ProfileData> {
  const user = session.user
  const currentEmail = user.email ?? ''
  const pendingNewEmail = (user as unknown as { new_email?: string }).new_email ?? ''

  const { data: prof } = await supabase
    .from('profiles')
    .select('auth_provider')
    .eq('id', user.id)
    .single()
  const provider = prof?.auth_provider ?? 'email'
  const hasPassword = provider === 'email'

  return { currentEmail, pendingNewEmail, provider, hasPassword }
}

/** Human-readable label for an OAuth provider identifier. */
export function providerLabelFor(provider: string): string {
  return provider === 'google' ? 'Google' : 'GitHub'
}

export interface OAuthGuidanceText {
  heading: string
  body: string
  step1: string
  step2: string
  step3: string
  syncButtonText: string
  syncHint: string
}

/** Build the OAuth-account guidance card's copy for the given provider label. */
export function buildOAuthGuidanceText(providerLabel: string): OAuthGuidanceText {
  return {
    heading: `Your email comes from ${providerLabel}`,
    body: `You sign in with ${providerLabel}, so Skillsmith uses the email from your ${providerLabel} account rather than a separate one. To change it:`,
    step1: `In ${providerLabel}, set your new address as your primary email and verify it.`,
    step2: `Sign out of Skillsmith and sign back in (this refreshes your ${providerLabel} details).`,
    step3: `Click 'Update my email from ${providerLabel}' below.`,
    syncButtonText: `Update my email from ${providerLabel}`,
    syncHint: `If you just changed your email at ${providerLabel}, sign out and back in first — otherwise this button will report no change.`,
  }
}

/** Validate an email address for the password-account change form. */
export function isEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)
}

export interface EmailChangeFormInput {
  newEmail: string
  confirmEmail: string
  password: string
  currentEmail: string
}

export interface EmailChangeFieldError {
  errorGroup: 'email' | 'password'
  focusTarget: 'newEmail' | 'confirmEmail' | 'password'
  message: string
}

/** Validate the password-account email-change form before submission. */
export function validateEmailChangeForm(input: EmailChangeFormInput): EmailChangeFieldError | null {
  const { newEmail, confirmEmail, password, currentEmail } = input
  if (!isEmail(newEmail)) {
    return { errorGroup: 'email', focusTarget: 'newEmail', message: 'Enter a valid email address.' }
  }
  if (newEmail.toLowerCase() !== confirmEmail.toLowerCase()) {
    return {
      errorGroup: 'email',
      focusTarget: 'confirmEmail',
      message: 'The two email addresses do not match.',
    }
  }
  if (newEmail.toLowerCase() === currentEmail.toLowerCase()) {
    return {
      errorGroup: 'email',
      focusTarget: 'newEmail',
      message: 'That is already your current email.',
    }
  }
  if (!password) {
    return {
      errorGroup: 'password',
      focusTarget: 'password',
      message: 'Enter your current password.',
    }
  }
  return null
}

export type EmailChangeSubmitResult =
  | { kind: 'success'; sentText: string }
  | { kind: 'field-error'; errorGroup: 'email' | 'password'; message: string }
  | { kind: 'generic-error' }

/**
 * Re-verify the current password (step-up auth), then initiate the email
 * change. With `double_confirm_changes` on, Supabase emails a confirmation
 * to both addresses; the change completes only after both are confirmed.
 */
export async function submitEmailChange(
  supabase: SupabaseClient,
  params: { currentEmail: string; newEmail: string; password: string }
): Promise<EmailChangeSubmitResult> {
  const { currentEmail, newEmail, password } = params
  try {
    const { error: reauthError } = await supabase.auth.signInWithPassword({
      email: currentEmail,
      password,
    })
    if (reauthError) {
      return {
        kind: 'field-error',
        errorGroup: 'password',
        message: 'Current password is incorrect.',
      }
    }

    const { error: updateError } = await supabase.auth.updateUser({ email: newEmail })
    if (updateError) {
      // Enumeration-resistant: do not reveal whether the target is registered.
      // The most common real failure is the address already being in use.
      return {
        kind: 'field-error',
        errorGroup: 'email',
        message:
          "We couldn't start that change. If that address is available, we've sent a confirmation link — check your inbox. Otherwise try a different address.",
      }
    }

    return {
      kind: 'success',
      sentText: `We've sent a confirmation link to your current address (${currentEmail}) and to ${newEmail}. Click the link in BOTH inboxes to finish changing your email.`,
    }
  } catch {
    return { kind: 'generic-error' }
  }
}
