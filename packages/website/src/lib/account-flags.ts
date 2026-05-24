/**
 * Shared client-side flags for the account email-change flow (SMI-5168).
 */

/**
 * sessionStorage key set by /auth/confirm after an `email_change` confirmation
 * and consumed once on the next authenticated /account load to trigger a
 * best-effort Stripe customer-email resync. Single source of truth so the setter
 * (confirm.astro) and consumer (account/index.astro) can never drift — the
 * cache-key round-trip lesson from SMI-4861.
 */
export const STRIPE_EMAIL_RESYNC_KEY = 'skillsmith:stripe-email-resync'
