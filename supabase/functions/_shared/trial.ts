/**
 * Shared trial-period utilities
 * @module _shared/trial
 *
 * SMI-2738: 14-day free trial for Individual and Team plans
 *
 * Centralises trial eligibility and active-trial detection so that
 * checkout, stripe-webhook, and future Wave-2 additions all share
 * identical logic.
 */

/** Paid tiers that are eligible for the 14-day free trial. */
export const TRIAL_TIERS = new Set(['individual', 'team'])

/** Length of the free trial in days. */
export const TRIAL_DAYS = 14

/**
 * Returns true when the given tier qualifies for a free trial.
 *
 * @param tier - The subscription tier string (e.g. 'individual', 'team', 'enterprise')
 */
export function isTrialEligible(tier: string): boolean {
  return TRIAL_TIERS.has(tier)
}

/**
 * Returns true when a Stripe trial_end timestamp is in the future,
 * meaning the user is still within their trial window and must NOT
 * be downgraded or have their license revoked yet.
 *
 * @param trialEnd - Stripe trial_end epoch seconds, or null if no trial
 */
export function isTrialStillActive(trialEnd: number | null): boolean {
  return trialEnd !== null && trialEnd > Math.floor(Date.now() / 1000)
}
