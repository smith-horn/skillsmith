/**
 * Shared client-side flags for the account email-change flow (SMI-5168).
 */

/**
 * sessionStorage key set by /auth/confirm after an `email_change` confirmation
 * and consumed once on the next authenticated account-hub page load to trigger
 * a best-effort Stripe customer-email resync. Single source of truth so the
 * setter (confirm.astro) and consumers (account/index.astro, account/summary.astro)
 * can never drift — the cache-key round-trip lesson from SMI-4861.
 */
export const STRIPE_EMAIL_RESYNC_KEY = 'skillsmith:stripe-email-resync'

/**
 * Consume the resync flag (if set) and fire the best-effort Stripe
 * customer-email resync. Idempotent across the two hub pages that now both
 * call it post-consolidation (Team Overview and Summary) — whichever loads
 * first removes the sessionStorage key, so a same-session hop between them
 * (e.g. the Decision #4 `/account` -> `/account/summary` redirect) never
 * double-fires. Never throws — every failure mode here is non-fatal.
 */
export async function resyncStripeEmailIfPending(
  supabaseUrl: string,
  accessToken: string
): Promise<void> {
  try {
    if (!sessionStorage.getItem(STRIPE_EMAIL_RESYNC_KEY)) return
    sessionStorage.removeItem(STRIPE_EMAIL_RESYNC_KEY)
    await fetch(`${supabaseUrl}/functions/v1/sync-stripe-email`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    }).catch(() => {
      /* non-fatal */
    })
  } catch {
    /* sessionStorage unavailable — non-fatal */
  }
}
